import {
  authSessionAuthor,
  CommandId,
  EnvironmentAuthorizationError,
  type OrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { TerminalManager } from "../terminal/Manager.ts";
import { SetupProcessJournal } from "../terminal/SetupProcessJournal.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  authorizeOrchestrationCommand,
  replayAuthorizedOrchestrationCommand,
} from "../auth/CommandReceiptAccess.ts";
import { RepositoryAccess, type RepositoryActor } from "../auth/RepositoryAccess.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type DeletionPreconditions,
  type OrchestrationDispatchOptions,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadPreparationReactor } from "./ThreadPreparationReactor.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

type DeleteCommand = Extract<
  OrchestrationCommand,
  { type: "thread.delete" | "project.delete" | "thread.archive" }
>;

/** A fresh create may retry old cleanup, but only the engine can accept reuse. */
export const makeCreationDispatcher = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const deletion = yield* ThreadDeletionReactor;
  const access = yield* RepositoryAccess;
  const receiptContext = yield* Effect.context<
    OrchestrationCommandReceiptRepository | OrchestrationEventStore | ProjectionThreadRepository
  >();
  return Effect.fn("dispatchCreationAfterCleanup")(function* (
    actor: RepositoryActor,
    command: Extract<OrchestrationCommand, { type: "thread.create" | "thread.prompt.enqueue" }>,
    options?: OrchestrationDispatchOptions,
  ) {
    const replay = yield* access.withFence(
      Effect.gen(function* () {
        const replay = yield* replayAuthorizedOrchestrationCommand(actor, command);
        if (Option.isNone(replay)) yield* authorizeOrchestrationCommand(actor, command);
        return replay;
      }),
    );
    if (Option.isSome(replay)) return replay.value;
    yield* deletion.drainThrough(yield* engine.latestSequence, command.threadId, command.commandId);
    return yield* access.withFence(
      authorizeOrchestrationCommand(actor, command).pipe(
        Effect.andThen(engine.dispatch(command, options)),
      ),
    );
  }, Effect.provide(receiptContext));
});

/** Both transports use this preflight. Shutdown never holds the global policy fence. */
export const makeDeletionDispatcher = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const preparation = yield* ThreadPreparationReactor;
  const journal = yield* SetupProcessJournal;
  const terminal = yield* TerminalManager;
  const access = yield* RepositoryAccess;
  const receiptContext = yield* Effect.context<
    OrchestrationCommandReceiptRepository | OrchestrationEventStore | ProjectionThreadRepository
  >();

  return Effect.fn("dispatchDeletion")(function* (
    actor: RepositoryActor,
    command: DeleteCommand,
    options?: OrchestrationDispatchOptions,
  ) {
    const authorizeProjectThreads = Effect.fnUntraced(function* (
      threads: ReadonlyArray<{ readonly id: ThreadId }>,
    ) {
      if (command.type !== "project.delete") return;
      for (const thread of threads)
        yield* access
          .requireCommand(actor, {
            type: "thread.delete",
            commandId: command.commandId,
            threadId: thread.id,
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "portable-thread"
                ? new EnvironmentAuthorizationError({
                    ...error,
                    message:
                      "Delete this project's managed threads through Launchpad Connect before deleting the project.",
                  })
                : error,
            ),
          );
    });
    const captured = yield* access.withFence(
      Effect.gen(function* () {
        const replay = yield* replayAuthorizedOrchestrationCommand(actor, command);
        if (Option.isSome(replay)) return { replay: replay.value } as const;
        yield* authorizeOrchestrationCommand(actor, command);
        const snapshot = yield* query.getCommandReadModel();
        const threads = snapshot.threads.filter(
          (thread) =>
            thread.deletedAt === null &&
            (command.type !== "project.delete"
              ? thread.id === command.threadId
              : thread.projectId === command.projectId),
        );
        const projectId =
          command.type === "project.delete" ? command.projectId : threads[0]?.projectId;
        // Preserve the decider's ordinary missing-aggregate / nonempty-project rejection.
        if (
          projectId === undefined ||
          (command.type === "project.delete" && !command.force && threads.length > 0)
        )
          return {
            replay: yield* engine.dispatch(command, { ...options, directClientCommand: true }),
          } as const;
        // Check every captured thread before pausing any setup. A project command
        // has no thread ID, so it cannot inherit the ordinary portable-thread guard.
        yield* authorizeProjectThreads(threads);
        const preconditions: DeletionPreconditions = {
          projectId,
          snapshotSequence: snapshot.snapshotSequence,
          threads: yield* Effect.forEach(threads, (thread) =>
            journal.owners(thread.id).pipe(
              Effect.map((owners) => ({
                threadId: thread.id,
                preparationAttemptId: thread.promptQueue?.preparation?.attemptId ?? null,
                worktreePath: thread.worktreePath,
                cleanupAttemptIds: [
                  ...new Set([
                    ...owners.map((owner) => owner.attemptId),
                    ...(thread.promptQueue?.preparation?.script
                      ? [thread.promptQueue.preparation.attemptId]
                      : []),
                  ]),
                ],
              })),
            ),
          ),
        };
        return { preconditions, threads } as const;
      }),
    );
    if ("replay" in captured) return captured.replay;
    const guarded = {
      ...options,
      directClientCommand: true,
      deletionPreconditions: captured.preconditions,
    } satisfies OrchestrationDispatchOptions;
    const stopped = yield* Effect.gen(function* () {
      for (const thread of captured.threads) {
        const setup = thread.promptQueue?.preparation;
        const ownerAttempts = captured.preconditions.threads.find(
          (entry) => entry.threadId === thread.id,
        )!.cleanupAttemptIds!;
        if (!setup && ownerAttempts.length === 0) continue;
        if (
          (setup && (setup.state === "pending" || setup.state === "running" || !setup.settled)) ||
          ownerAttempts.length > 0
        ) {
          const stop = {
            type: "thread.queue.pause" as const,
            commandId: CommandId.make(
              `${command.type === "thread.archive" ? "archive" : "delete"}-stop:${command.commandId}:${thread.id}`,
            ),
            threadId: thread.id,
            createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            ...(actor.user ? { author: authSessionAuthor(actor.user) } : {}),
          };
          const receipt = yield* access.withFence(
            authorizeOrchestrationCommand(actor, stop).pipe(
              Effect.andThen(engine.dispatch(stop, guarded)),
            ),
          );
          if (setup) {
            yield* preparation.drainAttemptThrough(thread.id, setup.attemptId, receipt.sequence);
            const current = yield* query.getCommandReadModel();
            const settled = current.threads.find(
              (candidate) => candidate.id === thread.id && candidate.deletedAt === null,
            )?.promptQueue?.preparation;
            if (!settled || settled.attemptId !== setup.attemptId || !settled.settled)
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Cannot change '${thread.title}': ${
                  settled?.failure?.detail ??
                  "Setup could not be confirmed stopped. The task is paused. Choose Stop setup, then Delete again."
                }`,
              });
          }
        }
        // A ready/settled command can still own previews. Historical unresolved owners count too.
        for (const attemptId of ownerAttempts) {
          const proof = yield* journal.cleanup({
            threadId: thread.id,
            attemptId,
            commandId: `${command.type === "thread.archive" ? "archive" : "delete"}-stop:${command.commandId}:${thread.id}`,
          });
          yield* terminal.closeOwned({ ...proof, receipt: proof });
          if (!(yield* journal.confirmed({ threadId: thread.id, attemptId })))
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Setup cleanup was not confirmed. Choose Stop setup, then retry.",
            });
        }
      }
      return yield* access.withFence(
        Effect.gen(function* () {
          yield* authorizeOrchestrationCommand(actor, command);
          yield* authorizeProjectThreads(captured.threads);
          return yield* engine.dispatch(command, { ...guarded, requireSetupCleanup: true });
        }),
      );
    }).pipe(Effect.result);
    if (stopped._tag === "Success") return stopped.success;
    // The queue decides races with duplicate accepted/rejected commands. A later
    // process exit cannot revive this lifecycle request; a new click supplies a new ID.
    return yield* engine.dispatch(command, {
      ...guarded,
      rejection: { projectId: captured.preconditions.projectId, detail: stopped.failure.message },
    });
  }, Effect.provide(receiptContext));
});
