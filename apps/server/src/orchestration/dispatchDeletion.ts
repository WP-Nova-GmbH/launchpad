import { authSessionAuthor } from "@t3tools/contracts";
import { CommandId, type OrchestrationCommand } from "@t3tools/contracts";
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

type DeleteCommand = Extract<OrchestrationCommand, { type: "thread.delete" | "project.delete" }>;

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
    yield* deletion.drainThrough(yield* engine.latestSequence, command.threadId);
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
  const access = yield* RepositoryAccess;
  const receiptContext = yield* Effect.context<
    OrchestrationCommandReceiptRepository | OrchestrationEventStore | ProjectionThreadRepository
  >();

  return Effect.fn("dispatchDeletion")(function* (
    actor: RepositoryActor,
    command: DeleteCommand,
    options?: OrchestrationDispatchOptions,
  ) {
    const captured = yield* access.withFence(
      Effect.gen(function* () {
        const replay = yield* replayAuthorizedOrchestrationCommand(actor, command);
        if (Option.isSome(replay)) return { replay: replay.value } as const;
        yield* authorizeOrchestrationCommand(actor, command);
        const snapshot = yield* query.getCommandReadModel();
        const threads = snapshot.threads.filter(
          (thread) =>
            thread.deletedAt === null &&
            (command.type === "thread.delete"
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
          return { replay: yield* engine.dispatch(command, options) } as const;
        const preconditions: DeletionPreconditions = {
          projectId,
          snapshotSequence: snapshot.snapshotSequence,
          threads: threads.map((thread) => ({
            threadId: thread.id,
            preparationAttemptId: thread.promptQueue?.preparation?.attemptId ?? null,
          })),
        };
        return { preconditions, threads } as const;
      }),
    );
    if ("replay" in captured) return captured.replay;
    const guarded = { ...options, deletionPreconditions: captured.preconditions };
    const stopped = yield* Effect.gen(function* () {
      for (const thread of captured.threads) {
        const setup = thread.promptQueue?.preparation;
        if (!setup || (setup.state !== "pending" && setup.state !== "running" && setup.settled))
          continue;
        const stop = {
          type: "thread.queue.pause" as const,
          commandId: CommandId.make(`delete-stop:${command.commandId}:${thread.id}`),
          threadId: thread.id,
          createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          ...(actor.user ? { author: authSessionAuthor(actor.user) } : {}),
        };
        const receipt = yield* access.withFence(
          authorizeOrchestrationCommand(actor, stop).pipe(
            Effect.andThen(engine.dispatch(stop, guarded)),
          ),
        );
        yield* preparation.drainAttemptThrough(thread.id, setup.attemptId, receipt.sequence);
        const current = yield* query.getCommandReadModel();
        const settled = current.threads.find(
          (candidate) => candidate.id === thread.id && candidate.deletedAt === null,
        )?.promptQueue?.preparation;
        if (!settled || settled.attemptId !== setup.attemptId || !settled.settled)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Cannot delete '${thread.title}': ${
              settled?.failure?.detail ??
              "Setup could not be confirmed stopped. The task is paused. Choose Stop setup, then Delete again."
            }`,
          });
      }
      return yield* access.withFence(
        authorizeOrchestrationCommand(actor, command).pipe(
          Effect.andThen(engine.dispatch(command, guarded)),
        ),
      );
    }).pipe(Effect.result);
    if (stopped._tag === "Success") return stopped.success;
    // The queue decides races with duplicate accepted/rejected commands. A later
    // process exit cannot revive this delete; a new click supplies a new ID.
    return yield* engine.dispatch(command, {
      ...guarded,
      rejection: { projectId: captured.preconditions.projectId, detail: stopped.failure.message },
    });
  }, Effect.provide(receiptContext));
});
