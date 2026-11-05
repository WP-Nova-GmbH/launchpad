import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initial } from "../jobs/WorkflowActions.test-fixture.ts";
import { WorkflowRun, make as makeStore } from "../jobs/WorkflowRunStore.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "./ThreadExecutionFence.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowRun));
const enrollment = {
  threadId: "thread",
  projectId: "project",
  relayUrl: "https://relay.example",
  environmentId: "environment",
  generation: 1,
  operationId: "enroll",
};
const move = {
  threadId: "thread",
  generation: 1,
  operationId: "move",
  previousOperationId: "enroll",
};
const released = (): WorkflowRun => {
  const run = initial();
  return { ...run, executionReserved: false, progress: { ...run.progress, status: "done" } };
};
const blocked: ReadonlyArray<readonly [string, (run: WorkflowRun) => WorkflowRun]> = [
  ["running", (run) => ({ ...run, progress: { ...run.progress, status: "running" } })],
  [
    "awaiting review",
    (run) => ({ ...run, progress: { ...run.progress, status: "awaiting_review" } }),
  ],
  [
    "waiting capacity",
    (run) => ({ ...run, progress: { ...run.progress, status: "waiting_capacity" } }),
  ],
  ["manual pause", (run) => ({ ...run, manualPause: { state: "paused", promptId: null } })],
  ["terminal reservation", (run) => ({ ...run, executionReserved: true })],
  [
    "approval cleanup",
    (run) => ({
      ...run,
      approvalAttempt: {
        approvedBy: null,
        checkpointId: "checkpoint",
        preparedHead: "head",
        acceptedRevision: 1,
        commandId: "approval",
        createdAt: "now",
        setupCleanup: { attemptId: "setup", state: "pending", detail: null },
      },
    }),
  ],
  [
    "cancellation cleanup",
    (run) => ({
      ...run,
      cancellationAttempt: {
        commandId: "cancel",
        createdAt: "now",
        setupCleanup: { attemptId: "setup", state: "failed", detail: "unconfirmed" },
      },
    }),
  ],
  [
    "queue intent",
    (run) => ({
      ...run,
      pendingQueueDismissal: { commandId: "dismiss", expectedRevision: 1, createdAt: "now" },
    }),
  ],
  [
    "preparation intent",
    (run) => ({
      ...run,
      pendingPreparationRetry: {
        commandId: "retry",
        expectedRevision: 1,
        expectedControlRevision: 1,
        createdAt: "now",
      },
    }),
  ],
  [
    "publishing command",
    (run) => ({
      ...run,
      actions: run.actions?.map((action) => ({
        ...action,
        commands: [
          { id: "command", pid: 42, identity: "owner", boot: null, stopped: false, code: null },
        ],
      })),
    }),
  ],
];
for (const [name, hold] of blocked)
  it.effect(`does not enroll, drain, activate or freeze ${name} workflow ownership`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = makeThreadExecutionFence(sql);
      const run = hold(released());
      const put = sql`INSERT INTO repository_workflow_jobs VALUES (${run.jobId},${run.progress.threadId},${run.progress.status},${run.executionReserved ? 1 : 0},${encode(run)})`;
      const clear = sql`DELETE FROM repository_workflow_jobs`;
      yield* put;
      assert.include((yield* Effect.flip(fence.prepare(enrollment))).message, "workflow");
      assert.isNull(yield* fence.get("thread"));
      yield* clear;
      yield* fence.prepare(enrollment);
      yield* put;
      assert.include((yield* Effect.flip(fence.activate(enrollment))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "frozen");
      yield* clear;
      yield* fence.activate(enrollment);
      yield* put;
      assert.include((yield* Effect.flip(fence.beginDrain(move))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "active");
      yield* clear;
      yield* fence.beginDrain(move);
      yield* put;
      assert.include((yield* Effect.flip(fence.freeze(move))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "draining");
      const store = yield* makeStore;
      assert.isNotNull(yield* store.getByThread("thread"));
      assert.lengthOf(yield* store.owners(), 1);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
  );
for (const status of ["done", "cancelled", "failed"] as const)
  it.effect(`permits VM placement after ${status} workflow fully releases ownership`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const run = released();
      const ended = { ...run, progress: { ...run.progress, status } };
      yield* sql`INSERT INTO repository_workflow_jobs VALUES (${run.jobId},${run.progress.threadId},${status},0,${encode(ended)})`;
      const fence = makeThreadExecutionFence(sql);
      yield* fence.prepare(enrollment);
      yield* fence.activate(enrollment);
      yield* fence.beginDrain(move);
      assert.equal(yield* fence.freeze(move), 0);
      const store = yield* makeStore;
      assert.isNull(yield* store.getByThread("thread"));
      assert.deepEqual(yield* store.owners(), []);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
  );
it.effect("fails closed for a malformed terminal workflow record", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repository_workflow_jobs VALUES ('bad','thread','done',0,'{}')`;
    assert.include(
      (yield* Effect.flip(makeThreadExecutionFence(sql).prepare(enrollment))).message,
      "workflow",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
