import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
  isThreadSessionRunning,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { serverEnvironment } from "./server";
import {
  retainSharedPromptSubmission,
  forgetSharedPromptSubmission,
  rejectSharedPromptSubmission,
} from "../sharedPromptSubmissionStore";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const baseThreadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
// The journal owns a shared prompt until the server acknowledges durable acceptance.
// Retry uses the captured command and message IDs, including after a renderer restart.
export const threadEnvironment: typeof baseThreadEnvironment = {
  ...baseThreadEnvironment,
  startTurn: {
    ...baseThreadEnvironment.startTurn,
    run: (async (registry, value) => {
      if (
        registry.get(serverEnvironment.configValueAtom(value.environmentId))?.environment
          .capabilities.sharedPromptQueue !== true
      ) {
        return baseThreadEnvironment.startTurn.run(registry, value);
      }
      try {
        const supportsPreparation =
          registry.get(serverEnvironment.configValueAtom(value.environmentId))?.environment
            .capabilities.sharedPreparation === true;
        const pending = retainSharedPromptSubmission(
          value.environmentId,
          value.input,
          supportsPreparation,
        );
        if (pending.command.type !== "thread.turn.start") throw new Error("Invalid saved prompt.");
        const result = await baseThreadEnvironment.enqueuePrompt.run(registry, {
          ...value,
          input: pending.command,
        });
        if (result._tag === "Success") {
          try {
            forgetSharedPromptSubmission(pending.command.commandId);
          } catch {
            /* The receipt reconciles a failed cleanup. */
          }
        } else {
          const receipt = await baseThreadEnvironment.getCommandReceipt.run(registry, {
            environmentId: value.environmentId,
            input: {
              threadId: pending.command.threadId,
              commandId: pending.command.commandId,
              ...(pending.command.bootstrap?.createThread
                ? { projectId: pending.command.bootstrap.createThread.projectId }
                : {}),
            },
          });
          if (
            receipt._tag === "Success" &&
            receipt.value.status === "accepted" &&
            receipt.value.sequence !== undefined
          ) {
            try {
              forgetSharedPromptSubmission(pending.command.commandId);
            } catch {
              /* Reconcile on reconnect. */
            }
            return AsyncResult.success({ sequence: receipt.value.sequence });
          }
          const error = squashAtomCommandFailure(result);
          if (receipt._tag === "Success" && receipt.value.status === "rejected")
            rejectSharedPromptSubmission(
              pending.command.commandId,
              receipt.value.detail ?? "The server rejected this prompt.",
            );
          else if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error))
            rejectSharedPromptSubmission(
              pending.command.commandId,
              error instanceof Error
                ? error.message
                : "The server rejected this prompt before acceptance.",
            );
        }
        return result;
      } catch (error) {
        return AsyncResult.failure(Cause.die(error));
      }
    }) satisfies typeof baseThreadEnvironment.startTurn.run,
  },
};
const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}

type KeptThreads = ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>;

// True once a thread's own stream no longer needs to stay open: it is in sync
// and shows a settled session, or it cannot progress (deleted or failed). A
// stream that is still loading or reconnecting keeps waiting for the stop.
function isDetailDone<E>(result: AsyncResult.AsyncResult<EnvironmentThreadState, E>): boolean {
  if (!AsyncResult.isSuccess(result)) return true;
  const { status, data, error } = result.value;
  if (status === "deleted" || Option.isSome(error)) return true;
  return (
    status === "live" && !Option.exists(data, (thread) => isThreadSessionRunning(thread.session))
  );
}

/**
 * Keeps the thread state atom mounted for each running thread in the listed
 * environments. Mount the result; its value is only bookkeeping.
 *
 * The shell and detail streams are independent, so the shell can report a
 * stop before the detail loads or catches up. A stopped thread stays mounted
 * until its own detail is live and shows the stop too. Then the stream closes
 * and saves the settled state to disk.
 */
export function createRunningThreadKeepAliveAtom<E>(input: {
  readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "session">>>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
}) {
  // Keeps its identity until a thread starts or stops, so ordinary shell
  // updates do not rebuild the keep-alive set.
  const runningThreadIdsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ThreadId> = [];
    return Atom.make((get) => {
      const running = get(input.threadsAtom(environmentId)).flatMap((thread) =>
        isThreadSessionRunning(thread.session) ? [thread.id] : [],
      );
      if (arrayElementsEqual(previous, running)) return previous;
      previous = running;
      return running;
    }).pipe(Atom.withLabel(`web-running-thread-ids:${environmentId}`));
  });

  return Atom.make((get): KeptThreads => {
    const previous = Option.getOrUndefined(get.self<KeptThreads>());
    const kept = new Map<EnvironmentId, ReadonlySet<ThreadId>>();
    // An environment that leaves the list is not visited, so its mounts drop.
    for (const environmentId of get(input.environmentIdsAtom)) {
      const threadIds = new Set(get(runningThreadIdsAtom(environmentId)));
      for (const threadId of previous?.get(environmentId) ?? []) {
        if (threadIds.has(threadId)) continue;
        const stateAtom = input.stateAtom(environmentId, threadId);
        // `once`, not `get`: a dependency on a stopped thread would hold its
        // stream open until some other change rebuilds this atom.
        if (isDetailDone(get.once(stateAtom))) continue;
        threadIds.add(threadId);
        // Rebuild when this detail is done, not on each update.
        get.subscribe(stateAtom, (state) => {
          if (isDetailDone(state)) get.refreshSelf();
        });
      }
      for (const threadId of threadIds) get.mount(input.stateAtom(environmentId, threadId));
      kept.set(environmentId, threadIds);
    }
    return kept;
  }).pipe(Atom.withLabel("web-running-thread-keep-alive"));
}

/** Mounted by `RunningThreadKeepAlive` on desktop, for every enabled environment. */
export const runningThreadKeepAliveAtom = createRunningThreadKeepAliveAtom({
  environmentIdsAtom: Atom.map(environmentCatalog.catalogValueAtom, (catalog) => [
    ...enabledEnvironmentIds(catalog),
  ]),
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  stateAtom: environmentThreads.stateAtom,
});
