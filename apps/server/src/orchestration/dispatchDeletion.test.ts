import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthorizationError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { RepositoryAccess, type RepositoryAccessShape } from "../auth/RepositoryAccess.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { makeCreationDispatcher, makeDeletionDispatcher } from "./dispatchDeletion.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { ThreadPreparationReactor } from "./ThreadPreparationReactor.ts";

const createdAt = "2026-09-28T00:00:00.000Z";
const projectId = ProjectId.make("delete-project");
const actor = { user: { userId: "teammate", displayName: null, imageUrl: null } };
function makeTestLayer(failRejectedCommandId?: CommandId) {
  const receiptLayer =
    failRejectedCommandId === undefined
      ? OrchestrationCommandReceiptRepositoryLive
      : Layer.effect(
          OrchestrationCommandReceiptRepository,
          Effect.gen(function* () {
            const receipts = yield* OrchestrationCommandReceiptRepository;
            return {
              ...receipts,
              upsert: (receipt: Parameters<typeof receipts.upsert>[0]) =>
                receipt.commandId === failRejectedCommandId && receipt.status === "rejected"
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.receipt",
                        detail: "Receipt disk unavailable",
                      }),
                    )
                  : receipts.upsert(receipt),
            };
          }),
        ).pipe(Layer.provide(OrchestrationCommandReceiptRepositoryLive));
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(receiptLayer),
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provide(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-delete-dispatch-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}
const testLayer = makeTestLayer();

const makeHarness = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const sql = yield* SqlClient.SqlClient;
  const baseAccess = yield* RepositoryAccess;
  const fence = yield* Semaphore.make(1);
  const allowed = yield* Ref.make(true);
  const authorizations: string[] = [];
  const requireAccess = Ref.get(allowed).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              message: "Repository grant removed",
              requiredScope: AuthOrchestrationReadScope,
            }),
          ),
    ),
  );
  const access: RepositoryAccessShape = {
    ...baseAccess,
    status: Effect.succeed({ enabled: true, ready: true, revision: 1 }),
    withFence: fence.withPermit,
    requirePersistedProject: () => requireAccess,
    requireCommand: (_actor, command) =>
      Effect.sync(() => {
        authorizations.push(command.type);
      }).pipe(Effect.andThen(requireAccess)),
  };
  const drains = yield* Queue.unbounded<{
    threadId: ThreadId;
    attemptId: CommandId;
    sequence: number;
  }>();
  const drainHandler = yield* Ref.make<ThreadPreparationReactor["Service"]["drainAttemptThrough"]>(
    () => Effect.void,
  );
  const dispatch = yield* makeDeletionDispatcher.pipe(
    Effect.provideService(RepositoryAccess, access),
    Effect.provideService(ThreadPreparationReactor, {
      start: () => Effect.void,
      drain: Effect.void,
      drainAttemptThrough: (threadId, attemptId, sequence) =>
        Queue.offer(drains, { threadId, attemptId, sequence }).pipe(
          Effect.andThen(Ref.get(drainHandler)),
          Effect.flatMap((handler) => handler(threadId, attemptId, sequence)),
        ),
    }),
  );
  const cleanupDrains = yield* Queue.unbounded<{
    sequence: number;
    threadId: ThreadId | undefined;
  }>();
  const cleanupHandler = yield* Ref.make<ThreadDeletionReactor["Service"]["drainThrough"]>(
    () => Effect.void,
  );
  const create = yield* makeCreationDispatcher.pipe(
    Effect.provideService(RepositoryAccess, access),
    Effect.provideService(ThreadDeletionReactor, {
      start: () => Effect.void,
      drainThrough: (sequence, threadId) =>
        Queue.offer(cleanupDrains, { sequence, threadId }).pipe(
          Effect.andThen(Ref.get(cleanupHandler)),
          Effect.flatMap((handler) => handler(sequence, threadId)),
        ),
    }),
  );
  const clearCleanup = (threadId: ThreadId, sequence: number) =>
    sql`DELETE FROM thread_cleanup_fences WHERE thread_id = ${threadId}
      AND deletion_sequence <= ${sequence}`.pipe(Effect.asVoid, Effect.orDie);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId,
    title: "Delete setup",
    workspaceRoot: "/tmp/delete-setup",
    createdAt,
  });
  const read = (threadId: ThreadId) =>
    query
      .getCommandReadModel()
      .pipe(
        Effect.map((snapshot) =>
          Option.getOrThrow(
            Option.fromNullishOr(snapshot.threads.find((thread) => thread.id === threadId)),
          ),
        ),
      );
  const seed = Effect.fn("TestDeletion.seed")(function* (name: string, archived = false) {
    const threadId = ThreadId.make(name);
    const attemptId = CommandId.make(`accept-${name}`);
    const create = {
      projectId,
      title: name,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdAt,
    };
    if (archived) {
      yield* engine.dispatch({
        ...create,
        type: "thread.create",
        threadId,
        commandId: CommandId.make(`create-${name}`),
      });
      yield* engine.dispatch({
        type: "thread.archive",
        threadId,
        commandId: CommandId.make(`archive-${name}`),
      });
      // An interrupted legacy setup can belong to an archived thread too.
      yield* engine.dispatch({
        type: "thread.preparation.update",
        threadId,
        commandId: attemptId,
        createdAt,
        expectedRevision: null,
        preparation: {
          originalCommandId: attemptId,
          attemptId,
          revision: 0,
          state: "running",
          settled: false,
          recipe: { projectCwd: "/tmp/delete-setup", runSetupScript: true },
        },
      });
    } else {
      yield* engine.dispatch({
        type: "thread.prompt.enqueue",
        commandId: attemptId,
        threadId,
        createdAt,
        runtimeMode: "full-access",
        interactionMode: "default",
        message: {
          messageId: MessageId.make(`message-${name}`),
          text: "Keep accepted work",
          attachments: [],
        },
        bootstrap: { createThread: create, runSetupScript: true },
      });
      const setup = (yield* read(threadId)).promptQueue!.preparation!;
      yield* engine.dispatch({
        type: "thread.preparation.update",
        threadId,
        commandId: CommandId.make(`running-${name}`),
        createdAt,
        expectedRevision: setup.revision,
        preparation: { ...setup, revision: setup.revision + 1, state: "running", settled: false },
      });
    }
    return threadId;
  });
  let settlement = 0;
  const settle = Effect.fn("TestDeletion.settle")(function* (
    threadId: ThreadId,
    confirmed: boolean,
  ) {
    const preparation = (yield* read(threadId)).promptQueue!.preparation!;
    yield* engine.dispatch({
      type: "thread.preparation.update",
      commandId: CommandId.make(`settled-${++settlement}`),
      threadId,
      createdAt,
      expectedRevision: preparation.revision,
      preparation: {
        ...preparation,
        revision: preparation.revision + 1,
        state: "failed",
        settled: confirmed,
        failure: {
          reason: "cancelled",
          detail: confirmed ? "Stopped" : "Setup process exit could not be confirmed",
        },
      },
    });
  });
  return {
    engine,
    query,
    receipts,
    dispatch,
    seed,
    read,
    settle,
    access,
    allowed,
    authorizations,
    drains,
    drainHandler,
    create,
    cleanupDrains,
    cleanupHandler,
    clearCleanup,
  };
});

const deleteThread = (
  threadId: ThreadId,
  id: string,
): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
  type: "thread.delete",
  threadId,
  commandId: CommandId.make(id),
});

const createThread = (
  threadId: ThreadId,
  id: string,
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(id),
  threadId,
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt,
});

describe("creation dispatch cleanup fence", () => {
  it.effect("waits for captured deletion cleanup before accepting a fresh incarnation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = ThreadId.make("recreate-after-cleanup");
      const original = createThread(threadId, "original-create");
      const accepted = yield* h.engine.dispatch(original);
      const deleted = yield* h.engine.dispatch(deleteThread(threadId, "delete-original"));
      const blocked = yield* h.engine
        .dispatch(createThread(threadId, "unguarded-recreate"))
        .pipe(Effect.flip);
      expect(blocked.message).toContain("Previous task processes");
      // Replaying accepted work must not drive a new cleanup or recreate it.
      expect(yield* h.create(actor, original)).toEqual(accepted);
      expect(yield* Queue.size(h.cleanupDrains)).toBe(0);
      expect((yield* h.read(threadId)).deletedAt).not.toBeNull();

      const confirmed = yield* Deferred.make<void>();
      yield* Ref.set(h.cleanupHandler, (sequence, capturedId) => {
        expect(capturedId).toBe(threadId);
        expect(sequence).toBe(deleted.sequence);
        return Deferred.await(confirmed).pipe(Effect.andThen(h.clearCleanup(threadId, sequence)));
      });
      const fresh = createThread(threadId, "fresh-recreate");
      const creating = yield* h.create(actor, fresh).pipe(Effect.forkChild);
      expect(yield* Queue.take(h.cleanupDrains)).toEqual({ threadId, sequence: deleted.sequence });
      expect((yield* h.read(threadId)).deletedAt).not.toBeNull();
      expect(Option.isNone(yield* h.receipts.getByCommandId({ commandId: fresh.commandId }))).toBe(
        true,
      );
      yield* Deferred.succeed(confirmed, undefined);
      yield* Fiber.join(creating);
      expect((yield* h.read(threadId)).deletedAt).toBeNull();
      expect(
        Option.getOrThrow(yield* h.receipts.getByCommandId({ commandId: fresh.commandId })).status,
      ).toBe("accepted");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releases the policy fence during cleanup and reauthorizes before creation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = ThreadId.make("recreate-policy-change");
      yield* h.engine.dispatch(createThread(threadId, "create-before-delete"));
      yield* h.engine.dispatch(deleteThread(threadId, "delete-before-revoke"));
      const confirmed = yield* Deferred.make<void>();
      yield* Ref.set(h.cleanupHandler, (sequence) =>
        Deferred.await(confirmed).pipe(Effect.andThen(h.clearCleanup(threadId, sequence))),
      );
      const fresh = createThread(threadId, "recreate-after-revoke");
      const creating = yield* h.create(actor, fresh).pipe(Effect.result, Effect.forkChild);
      yield* Queue.take(h.cleanupDrains);
      yield* h.access.withFence(Ref.set(h.allowed, false));
      yield* Deferred.succeed(confirmed, undefined);
      const result = yield* Fiber.join(creating);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("Repository grant removed");
      expect(h.authorizations).toEqual(["thread.create", "thread.create"]);
      expect((yield* h.read(threadId)).deletedAt).not.toBeNull();
      expect(Option.isNone(yield* h.receipts.getByCommandId({ commandId: fresh.commandId }))).toBe(
        true,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("deletion dispatch preflight", () => {
  it.effect("deduplicates overlapping Delete requests after the same scoped shutdown", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = yield* h.seed("duplicate-delete");
      const stopped = yield* Deferred.make<void>();
      yield* Ref.set(h.drainHandler, () => Deferred.await(stopped));
      const command = deleteThread(threadId, "duplicate-delete-command");
      const first = yield* h.dispatch(actor, command).pipe(Effect.forkChild);
      const firstDrain = yield* Queue.take(h.drains);
      const second = yield* h.dispatch(actor, command).pipe(Effect.forkChild);
      const secondDrain = yield* Queue.take(h.drains);
      expect(secondDrain).toEqual(firstDrain);
      yield* h.settle(threadId, true);
      yield* Deferred.succeed(stopped, undefined);
      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
      const events = yield* h.engine.readEvents(0).pipe(Stream.runCollect);
      expect(
        events.filter((event) => event.type === "thread.deleted" && event.aggregateId === threadId),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects the old Delete when a teammate retries setup during its wait", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = yield* h.seed("retried-during-delete");
      const stopped = yield* Deferred.make<void>();
      yield* Ref.set(h.drainHandler, () => Deferred.await(stopped));
      const command = deleteThread(threadId, "delete-before-retry");
      const pending = yield* h.dispatch(actor, command).pipe(Effect.result, Effect.forkChild);
      yield* Queue.take(h.drains);
      yield* h.settle(threadId, true);
      const queue = (yield* h.read(threadId)).promptQueue!;
      const retryId = CommandId.make("teammate-retry");
      yield* h.engine.dispatch({
        type: "thread.preparation.retry",
        threadId,
        commandId: retryId,
        createdAt,
        expectedRevision: queue.preparation!.revision,
        expectedControlRevision: queue.revision,
      });
      yield* Deferred.succeed(stopped, undefined);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      const current = yield* h.read(threadId);
      expect(current.deletedAt).toBeNull();
      expect(current.promptQueue?.enabled).toBe(true);
      expect(current.promptQueue?.preparation).toMatchObject({
        attemptId: retryId,
        state: "pending",
      });
      expect(
        Option.getOrThrow(yield* h.receipts.getByCommandId({ commandId: command.commandId }))
          .status,
      ).toBe("rejected");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not report a durable rejection when receipt persistence fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = yield* h.seed("receipt-failure");
      yield* Ref.set(h.drainHandler, (id) => h.settle(id, false).pipe(Effect.orDie));
      const command = deleteThread(threadId, "unpersisted-delete");
      const error = yield* h.dispatch(actor, command).pipe(Effect.flip);
      expect(error._tag).toBe("PersistenceSqlError");
      expect(
        Option.isNone(yield* h.receipts.getByCommandId({ commandId: command.commandId })),
      ).toBe(true);
      expect((yield* h.read(threadId)).deletedAt).toBeNull();
      expect((yield* h.read(threadId)).promptQueue?.enabled).toBe(false);
    }).pipe(Effect.provide(makeTestLayer(CommandId.make("unpersisted-delete")))),
  );

  it.effect("deletes an archived setup after its first confirmed shutdown", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const archived = yield* h.seed("archived-success", true);
      yield* Ref.set(h.drainHandler, (id) => h.settle(id, true).pipe(Effect.orDie));
      yield* h.dispatch(actor, {
        type: "project.delete",
        projectId,
        force: true,
        commandId: CommandId.make("delete-project-archived-success"),
      });
      expect((yield* h.read(archived)).deletedAt).not.toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains paused work on failed shutdown; late exit and old receipt replay never delete it",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const threadId = yield* h.seed("required-setup");
        yield* Ref.set(h.drainHandler, (id) => h.settle(id, false).pipe(Effect.orDie));
        const command = deleteThread(threadId, "first-delete");
        const failure = yield* h.dispatch(actor, command).pipe(Effect.flip);
        expect(failure.message).toContain("exit could not be confirmed");
        const paused = yield* h.read(threadId);
        expect(paused.promptQueue?.enabled).toBe(false);
        expect(paused.promptQueue?.entries).toHaveLength(1);
        expect(paused.promptQueue?.preparation?.settled).toBe(false);
        expect(
          Option.getOrThrow(yield* h.receipts.getByCommandId({ commandId: command.commandId })),
        ).toMatchObject({ status: "rejected", projectId });
        const stop = yield* Queue.take(h.drains);
        expect(stop.attemptId).toBe(CommandId.make("accept-required-setup"));
        expect(stop.sequence).toBeGreaterThan(0);

        yield* h.settle(threadId, true);
        expect((yield* h.read(threadId)).deletedAt).toBeNull();
        const replay = yield* h.dispatch(actor, command).pipe(Effect.flip);
        expect(replay._tag).toBe("OrchestrationCommandPreviouslyRejectedError");
        expect((yield* h.read(threadId)).deletedAt).toBeNull();
        const fresh = yield* h.dispatch(actor, deleteThread(threadId, "explicit-second-delete"));
        expect(Option.isNone(yield* h.query.getThreadDetailById(threadId))).toBe(true);
        expect(yield* h.dispatch(actor, deleteThread(threadId, "explicit-second-delete"))).toEqual(
          fresh,
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a forced project cascade atomic when an archived task cannot stop", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const active = yield* h.seed("active");
      const archived = yield* h.seed("archived", true);
      yield* Ref.set(h.drainHandler, (id) => h.settle(id, id !== archived).pipe(Effect.orDie));
      const command = {
        type: "project.delete" as const,
        projectId,
        force: true,
        commandId: CommandId.make("delete-project-blocked"),
      };
      yield* h.dispatch(actor, command).pipe(Effect.flip);
      for (const id of [active, archived]) {
        const thread = yield* h.read(id);
        expect(thread.deletedAt).toBeNull();
        expect(thread.promptQueue?.enabled).toBe(false);
      }
      expect((yield* h.read(archived)).archivedAt).not.toBeNull();
      const snapshot = yield* h.query.getCommandReadModel();
      expect(snapshot.projects.find((project) => project.id === projectId)?.deletedAt).toBeNull();
      expect(
        Option.getOrThrow(yield* h.receipts.getByCommandId({ commandId: command.commandId }))
          .status,
      ).toBe("rejected");
      yield* h.settle(archived, true);
      yield* h.dispatch(actor, command).pipe(Effect.flip);
      yield* h.dispatch(actor, { ...command, commandId: CommandId.make("delete-project-again") });
      for (const id of [active, archived])
        expect(Option.isNone(yield* h.query.getThreadDetailById(id))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releases the policy fence during shutdown and reauthorizes before deletion", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const threadId = yield* h.seed("permission-race");
      const stopped = yield* Deferred.make<void>();
      yield* Ref.set(h.drainHandler, (id) =>
        Deferred.await(stopped).pipe(Effect.andThen(h.settle(id, true)), Effect.orDie),
      );
      const command = deleteThread(threadId, "delete-with-policy-change");
      const pending = yield* h.dispatch(actor, command).pipe(Effect.result, Effect.forkChild);
      yield* Queue.take(h.drains);
      // A held global fence would deadlock this policy mutation behind setup exit.
      yield* h.access.withFence(Ref.set(h.allowed, false));
      const unrelated = yield* h.seed("unrelated-work");
      expect((yield* h.read(unrelated)).promptQueue?.enabled).toBe(true);
      yield* Deferred.succeed(stopped, undefined);
      const outcome = yield* Fiber.join(pending);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure.message).toContain("Repository grant removed");
      expect(h.authorizations).toEqual(["thread.delete", "thread.queue.pause", "thread.delete"]);
      expect((yield* h.read(threadId)).deletedAt).toBeNull();
      expect((yield* h.read(threadId)).promptQueue?.enabled).toBe(false);
      expect(
        Option.getOrThrow(yield* h.receipts.getByCommandId({ commandId: command.commandId })),
      ).toMatchObject({ status: "rejected", projectId });
    }).pipe(Effect.provide(testLayer)),
  );
});
