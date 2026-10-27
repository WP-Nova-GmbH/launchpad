import type { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import { assert, describe, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import type { RelayThreadInboxEntry, RelayThreadPersistedReceipt } from "@t3tools/contracts/relay";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeThreadExecutionRelay, ThreadExecutionRelayError } from "./ThreadExecutionRelay.ts";
import {
  makeThreadCommandSync,
  ThreadCommandSyncError,
  type ThreadCommandTransport,
} from "./ThreadCommandSync.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeCommandJson = Schema.decodeEffect(Schema.fromJsonString(OrchestrationCommand));
const testLayer = OrchestrationLayerLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-inbox-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("thread");
const projectId = ProjectId.make("project");
const createdAt = "2026-10-02T09:00:00.000Z";
const actor = { userId: "owner", displayName: "Stefan", imageUrl: null };
const enrollment = {
  threadId,
  projectId,
  environmentId: "environment",
  relayUrl: "https://relay.test",
  generation: 1,
  operationId: "enroll",
};
const entry = (id: string, position = 1): RelayThreadInboxEntry => ({
  threadId,
  commandId: id,
  position,
  acceptedGeneration: 1,
  actor,
  receipt: null,
  command: { type: "thread.meta.update", commandId: CommandId.make(id), threadId, title: id },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const snapshot = yield* ProjectionSnapshotQuery;
  const fence = makeThreadExecutionFence(sql);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/inbox-test",
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread-create"),
    threadId,
    projectId,
    title: "Original",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  yield* fence.prepare(enrollment);
  yield* fence.activate(enrollment);
  const inbox: RelayThreadInboxEntry[] = [];
  const acknowledged = new Map<string, RelayThreadPersistedReceipt>();
  const work = new Map<string, boolean>();
  const authority = {
    admit: (input: { workId: string }) =>
      Effect.sync(() => {
        const prior = work.has(input.workId);
        if (!prior) work.set(input.workId, false);
        return { newlyAdmitted: !prior, completed: work.get(input.workId)! };
      }),
    complete: (input: { workId: string }) =>
      Effect.sync(() => {
        work.set(input.workId, true);
      }),
  };
  const execution = makeThreadExecutionRelay(sql, authority);
  const transport: ThreadCommandTransport = {
    next: () => Effect.sync(() => inbox.find((item) => !acknowledged.has(item.commandId)) ?? null),
    acknowledge: (_owner, commandId, receipt) =>
      Effect.sync(() => {
        acknowledged.set(commandId, receipt);
      }),
  };
  let normalizations = 0;
  const normalize = (command: ClientOrchestrationCommand) =>
    Effect.sync(() => {
      normalizations++;
    }).pipe(Effect.andThen(decodeCommand(command).pipe(Effect.orDie)));
  const make = (overrides: Partial<ThreadCommandTransport> = {}) =>
    makeThreadCommandSync(
      sql,
      engine,
      receipts,
      execution,
      { ...transport, ...overrides },
      normalize,
    );
  return {
    sql,
    engine,
    receipts,
    snapshot,
    fence,
    inbox,
    acknowledged,
    work,
    authority,
    execution,
    transport,
    normalize,
    make,
    normalizations: () => normalizations,
  };
});
describe("portable relay inbox delivery", () => {
  it.effect("attributes an issue approval to its authenticated relay actor", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const normalizerContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof normalizeDispatchCommand>>>();
      f.inbox.push({
        ...entry("approve-issue"),
        command: {
          type: "thread.approval.respond",
          commandId: CommandId.make("approve-issue"),
          threadId,
          requestId: ApprovalRequestId.make("issue-write:operation"),
          decision: "accept",
          actorUserId: "spoofed-user",
          createdAt,
        },
      });
      const sync = makeThreadCommandSync(
        f.sql,
        f.engine,
        f.receipts,
        f.execution,
        f.transport,
        (command, authenticatedUserId) =>
          normalizeDispatchCommand(command, authenticatedUserId).pipe(
            Effect.provideContext(normalizerContext),
          ),
      );
      yield* sync.synchronize(threadId);
      assert.equal(f.acknowledged.get("approve-issue")?.status, "accepted");
      const [event] = yield* f.sql<{ actorUserId: string }>`SELECT
        json_extract(payload_json, '$.actorUserId') AS "actorUserId"
        FROM orchestration_events WHERE command_id = 'approve-issue'
          AND event_type = 'thread.approval-response-requested'`;
      assert.equal(event?.actorUserId, actor.userId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("uploads the complete persisted receipt unchanged after a lost acknowledgement", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.inbox.push(entry("archive-receipt"));
      const archived: OrchestrationCommandReceipt[] = [];
      let lose = true;
      const sync = f.make({
        acknowledge: (owner, id, receipt, commandReceipt) =>
          Effect.gen(function* () {
            if (!commandReceipt) return yield* Effect.die("Full receipt missing");
            archived.push(commandReceipt);
            if (lose) {
              lose = false;
              return yield* new ThreadCommandSyncError({ threadId, detail: "reply lost" });
            }
            yield* f.transport.acknowledge(owner, id, receipt);
          }),
      });
      yield* Effect.flip(sync.synchronize(threadId));
      yield* sync.synchronize(threadId);
      assert.equal(f.normalizations(), 1);
      assert.equal(archived.length, 2);
      assert.deepEqual(archived[0], archived[1]);
      assert.deepEqual(
        archived[0],
        Option.getOrThrow(
          yield* f.receipts.getByCommandId({ commandId: CommandId.make("archive-receipt") }),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("archives a pre-dispatch rejection with its immutable relay admission time", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("used-archive"),
        threadId,
        title: "Original",
      });
      const acceptedAt = createdAt;
      f.inbox.push({ ...entry("used-archive"), acceptedAt });
      let archived: OrchestrationCommandReceipt | undefined;
      yield* f
        .make({
          acknowledge: (owner, id, receipt, commandReceipt) =>
            Effect.gen(function* () {
              archived = commandReceipt;
              yield* f.transport.acknowledge(owner, id, receipt);
            }),
        })
        .synchronize(threadId);
      assert.equal(f.normalizations(), 0);
      assert.equal(archived?.status, "rejected");
      assert.equal(archived?.acceptedAt, acceptedAt);
      assert.equal(archived?.resultSequence, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an expired personal grant durably and continues the relay inbox", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const expired: RelayThreadInboxEntry = {
        ...entry("expired-grant"),
        acceptedAt: createdAt,
        command: {
          type: "thread.prompt.enqueue" as const,
          commandId: CommandId.make("expired-grant"),
          threadId,
          issueTrackerAuthorization: "expired-personal-grant",
          message: {
            messageId: MessageId.make("expired-message"),
            text: "Read my issue",
            attachments: [],
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt,
        },
      };
      f.inbox.push(expired, entry("after-expired", 2));
      const archived: OrchestrationCommandReceipt[] = [];
      let lose = true;
      const sync = makeThreadCommandSync(
        f.sql,
        f.engine,
        f.receipts,
        f.execution,
        {
          ...f.transport,
          acknowledge: (owner, id, receipt, commandReceipt) =>
            Effect.gen(function* () {
              if (id === expired.commandId) {
                assert(commandReceipt);
                archived.push(commandReceipt);
                if (lose) {
                  lose = false;
                  return yield* new ThreadCommandSyncError({ threadId, detail: "reply lost" });
                }
              }
              yield* f.transport.acknowledge(owner, id, receipt, commandReceipt);
            }),
        },
        (command) =>
          command.commandId === expired.commandId
            ? Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "Personal connection authorization is invalid or expired.",
                }),
              )
            : f.normalize(command),
      );
      yield* Effect.flip(sync.synchronize(threadId));
      assert.equal(f.acknowledged.size, 0);
      yield* sync.synchronize(threadId);
      assert.equal(f.acknowledged.get(expired.commandId)?.status, "rejected");
      assert.equal(f.acknowledged.get("after-expired")?.status, "accepted");
      assert.equal(
        Option.getOrThrow(yield* f.snapshot.getThreadDetailById(threadId)).title,
        "after-expired",
      );
      assert.equal(archived.length, 2);
      assert.deepEqual(archived[0], archived[1]);
      assert.equal(archived[0]?.acceptedAt, createdAt);
      assert.equal(archived[0]?.resultSequence, 0);
      assert.isTrue(
        Option.isNone(yield* f.receipts.getByCommandId({ commandId: expired.command.commandId })),
      );
      assert.isTrue([...f.work.values()].every(Boolean));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains an unexpected normalization failure for a later retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.inbox.push(entry("normalizer-defect"), entry("after-defect", 2));
      const broken = makeThreadCommandSync(
        f.sql,
        f.engine,
        f.receipts,
        f.execution,
        f.transport,
        () => Effect.die("Unexpected normalizer failure"),
      );
      const failed = yield* broken.synchronize(threadId).pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      assert.equal(f.acknowledged.size, 0);
      yield* f.make().synchronize(threadId);
      assert.equal(f.acknowledged.get("normalizer-defect")?.status, "accepted");
      assert.equal(f.acknowledged.get("after-defect")?.status, "accepted");
      assert.isTrue([...f.work.values()].every(Boolean));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "applies each ordered command once across concurrent drains and a lost relay acknowledgement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.inbox.push(entry("first"), entry("second", 2));
        let lose = true;
        const sync = f.make({
          acknowledge: (owner, id, receipt) =>
            Effect.gen(function* () {
              yield* f.transport.acknowledge(owner, id, receipt);
              if (lose) {
                lose = false;
                return yield* new ThreadCommandSyncError({ threadId, detail: "reply lost" });
              }
            }),
        });
        yield* Effect.flip(sync.synchronize(threadId));
        assert.equal(f.normalizations(), 1);
        const restarted = f.make();
        yield* Effect.all(
          Array.from({ length: 8 }, () => restarted.synchronize(threadId)),
          { concurrency: "unbounded" },
        );
        assert.equal(f.normalizations(), 2);
        assert.deepEqual([...f.acknowledged.keys()], ["first", "second"]);
        assert.equal(
          Option.getOrThrow(yield* f.snapshot.getThreadDetailById(threadId)).title,
          "second",
        );
        const rows = yield* f.sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id IN ('first', 'second')`;
        assert.equal(rows[0]?.n, 2);
        assert.isTrue([...f.work.values()].every(Boolean));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses the relay actor and rejects payload changes even when an accepted receipt already exists",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = {
          type: "thread.queue.pause" as const,
          threadId,
          commandId: CommandId.make("pause"),
          createdAt,
          author: { userId: "spoof", displayName: "Spoof", imageUrl: null },
        };
        f.inbox.push({ ...entry("pause"), command });
        yield* f.make().synchronize(threadId);
        const [row] = yield* f.sql<{
          command: string;
        }>`SELECT normalized_json AS command FROM thread_relay_command_deliveries WHERE command_id = 'pause'`;
        const saved = yield* decodeCommandJson(row!.command);
        assert.equal(saved.type, "thread.queue.pause");
        if (saved.type === "thread.queue.pause") assert.deepEqual(saved.author, actor);
        assert.equal(
          (yield* Effect.flip(f.engine.dispatch(command)))._tag,
          "ThreadExecutionFenceError",
        );
        assert.deepEqual(yield* f.engine.dispatch(saved), {
          sequence:
            f.acknowledged.get("pause")!.status === "accepted"
              ? (f.acknowledged.get("pause") as { sequence: number }).sequence
              : -1,
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "does not mistake an existing local command receipt for delivery of a new relay payload",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("used"),
          threadId,
          title: "Local",
        });
        f.inbox.push(entry("used"));
        yield* f.make().synchronize(threadId);
        assert.equal(f.acknowledged.get("used")?.status, "rejected");
        assert.equal(
          Option.getOrThrow(yield* f.snapshot.getThreadDetailById(threadId)).title,
          "Local",
        );
        assert.equal(f.normalizations(), 0);
        assert.equal(f.work.size, 0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "drains an admitted delivery before a move freezes the source even when the relay inbox is held",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.inbox.push(entry("held"));
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sync = makeThreadCommandSync(
          f.sql,
          f.engine,
          f.receipts,
          f.execution,
          f.transport,
          (command) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(f.normalize(command)),
            ),
        );
        const delivery = yield* Effect.forkChild(sync.synchronize(threadId));
        yield* Deferred.await(started);
        const move = { ...enrollment, operationId: "move", previousOperationId: "enroll" };
        yield* f.fence.beginDrain(move);
        assert.equal((yield* Effect.flip(f.fence.freeze(move)))._tag, "ThreadExecutionFenceError");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(delivery);
        assert.equal(f.acknowledged.get("held")?.status, "accepted");
        yield* f.fence.freeze(move);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains a locally accepted receipt while completion reporting is unavailable, without redispatching",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.inbox.push(entry("completion"));
        const execution = makeThreadExecutionRelay(f.sql, {
          ...f.authority,
          complete: () =>
            Effect.fail(
              new ThreadExecutionRelayError({ threadId, operation: "complete", detail: "offline" }),
            ),
        });
        const sync = makeThreadCommandSync(
          f.sql,
          f.engine,
          f.receipts,
          execution,
          f.transport,
          f.normalize,
        );
        yield* Effect.flip(sync.synchronize(threadId));
        assert.equal(f.acknowledged.get("completion")?.status, "accepted");
        yield* f.make().synchronize(threadId);
        assert.equal(f.normalizations(), 1);
        assert.isTrue([...f.work.values()].every(Boolean));
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "retries a transient dispatch failure with the saved normalized payload and acknowledges only persisted rejection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const invalid: RelayThreadInboxEntry = {
          ...entry("reject"),
          command: {
            type: "thread.queue.resume",
            threadId,
            commandId: CommandId.make("reject"),
            expectedRevision: 999,
            createdAt,
          },
        };
        f.inbox.push(invalid);
        const broken = makeThreadCommandSync(
          f.sql,
          {
            dispatch: () =>
              Effect.fail(new ThreadExecutionFenceError({ threadId, detail: "temporary hold" })),
          },
          f.receipts,
          f.execution,
          f.transport,
          f.normalize,
        );
        yield* Effect.flip(broken.synchronize(threadId));
        assert.equal(f.acknowledged.size, 0);
        assert.equal(f.normalizations(), 1);
        yield* f.make().synchronize(threadId);
        assert.equal(f.acknowledged.get("reject")?.status, "rejected");
        assert.equal(f.normalizations(), 1);
        assert.equal(
          Option.getOrThrow(
            yield* f.receipts.getByCommandId({ commandId: CommandId.make("reject") }),
          ).status,
          "rejected",
        );
      }).pipe(Effect.provide(testLayer)),
  );
});
