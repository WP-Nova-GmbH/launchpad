import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import migration from "../persistence/Migrations/094_WorkflowResults.ts";
import { makeWorkflowResultOutbox, WORKFLOW_SAVE_CYCLE_MS } from "./WorkflowResultOutbox.ts";

const binding = {
  jobId: "job",
  threadId: ThreadId.make("workflow:job"),
  organizationId: "org",
  repositoryId: "repo",
  allocationId: "vm",
  environmentId: EnvironmentId.make("guest"),
  generation: 1,
  operationId: "operation",
  projectId: ProjectId.make("vm:workflow:job"),
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_events(sequence INTEGER,aggregate_kind TEXT,stream_id TEXT)`;
  yield* migration;
  const outbox = makeWorkflowResultOutbox(sql);
  return { sql, outbox };
});
const memory = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "rolls an export intent back with its job transaction and deduplicates unchanged state",
  () =>
    Effect.gen(function* () {
      const { sql, outbox } = yield* fixture;
      yield* sql.withTransaction(outbox.enqueue({ binding, recordJson: '{"cursor":0}' }));
      const original = yield* outbox.next(binding.threadId);
      yield* outbox.enqueue({ binding, recordJson: '{"cursor":0}' });
      expect(yield* sql`SELECT 1 FROM workflow_result_outbox`).toHaveLength(1);
      yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* outbox.enqueue({ binding, recordJson: '{"cursor":1}' });
            return yield* Effect.fail("rollback");
          }),
        ),
      );
      expect(yield* sql`SELECT 1 FROM workflow_result_outbox`).toHaveLength(1);
      yield* outbox.enqueue({ binding, recordJson: '{"cursor":1}' });
      expect(
        (yield* sql<{
          revision: number;
        }>`SELECT revision FROM workflow_result_outbox ORDER BY revision`).map((r) => r.revision),
      ).toEqual([1, 2]);
      expect(yield* outbox.next(binding.threadId)).toEqual(original);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "persists exhaustion across worker recreation and retries the same immutable intent",
  () =>
    Effect.gen(function* () {
      const { sql, outbox } = yield* fixture;
      yield* outbox.enqueue({ binding, recordJson: '{"cursor":0}' });
      const intent = (yield* outbox.next(binding.threadId))!;
      for (let n = 0; n < 3; n++) yield* outbox.fail(intent, "storage offline");
      const restarted = makeWorkflowResultOutbox(sql);
      expect(yield* restarted.saving(binding.jobId)).toMatchObject({
        state: "failed",
        retryable: true,
      });
      expect(yield* restarted.retry(binding.jobId, "not-this-publication")).toBe(false);
      expect(yield* restarted.retry(binding.jobId, intent.publicationId)).toBe(true);
      expect(yield* restarted.next(binding.threadId)).toMatchObject({
        publicationId: intent.publicationId,
        revision: intent.revision,
        recordJson: intent.recordJson,
        manifestArtifactId: intent.manifestArtifactId,
        failures: 0,
        status: "pending",
      });
      yield* restarted.fail(intent, "patch too large", true);
      expect(yield* restarted.retry(binding.jobId, intent.publicationId)).toBe(false);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "expires missing prerequisites without an upload attempt or a restart resetting the deadline",
  () =>
    Effect.gen(function* () {
      const { sql, outbox } = yield* fixture;
      yield* outbox.enqueue({ binding, recordJson: '{"cursor":0}' });
      const first = (yield* outbox.next(binding.threadId))!;
      yield* TestClock.adjust(WORKFLOW_SAVE_CYCLE_MS - 1);
      yield* makeWorkflowResultOutbox(sql).expire(binding.threadId);
      expect((yield* outbox.next(binding.threadId))?.status).toBe("pending");
      yield* TestClock.adjust(1);
      yield* makeWorkflowResultOutbox(sql).expire(binding.threadId);
      expect(yield* outbox.next(binding.threadId)).toMatchObject({
        deadline: first.deadline,
        status: "failed",
        failures: 0,
      });
      expect(yield* outbox.saving(binding.jobId)).toMatchObject({
        state: "failed",
        retryable: true,
      });
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "exports a new pause/control state without duplicating the Agent result already saving",
  () =>
    Effect.gen(function* () {
      const { sql, outbox } = yield* fixture;
      const captured = {
        resultId: "11111111-1111-4111-8111-111111111111",
        stepId: "agent",
        turnId: "turn",
        turnCount: 1,
        outcome: "completed" as const,
        createdAt: "now",
        checkpointRef: "ref",
        baselineCommitId: "base",
        commitId: "commit",
        treeId: "tree",
      };
      yield* outbox.enqueue({ binding, recordJson: '{"paused":false}', result: captured });
      yield* outbox.enqueue({
        binding,
        recordJson: '{"paused":true}',
        result: { ...captured, resultId: "22222222-2222-4222-8222-222222222222" },
      });
      const rows = yield* sql<{
        revision: number;
        result_json: string | null;
        record_json: string;
      }>`SELECT revision,result_json,record_json FROM workflow_result_outbox ORDER BY revision`;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.result_json).toContain(captured.resultId);
      expect(yield* outbox.saving(binding.jobId)).toMatchObject({
        resultId: captured.resultId,
        stepId: captured.stepId,
      });
      expect(rows[1]).toMatchObject({
        revision: 2,
        result_json: null,
        record_json: '{"paused":true}',
      });
      yield* outbox.enqueue({ binding, recordJson: '{"paused":true}', result: captured });
      expect(yield* sql`SELECT 1 FROM workflow_result_outbox`).toHaveLength(2);
      yield* sql`UPDATE workflow_result_outbox SET status='acknowledged' WHERE revision=1`;
      const stateOnly = yield* outbox.saving(binding.jobId);
      expect(stateOnly?.resultId).toBeNull();
      expect(stateOnly).not.toHaveProperty("stepId");
    }).pipe(Effect.provide(memory)),
);
