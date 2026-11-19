import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadVmCaptureSourceReceipt } from "../machines/E2BNativeSnapshotReceipt.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { ThreadVmBackupConflict } from "./ThreadVmBackupStore.ts";

type Owner = { threadId: string; environmentId: string; generation: number };
export interface ThreadVmBackupSource extends Owner {
  readonly allocationId: string;
  readonly operationId: string;
  readonly phase: "pending" | "creating" | "verified" | "failed" | "retiring" | "retired";
  readonly sourceReceipt: ThreadVmCaptureSourceReceipt | null;
  readonly snapshotId: string | null;
  readonly captureStarted: boolean;
  readonly canActivate: boolean;
  readonly sourceReopened: boolean;
}
const decode = Schema.decodeUnknownEffect(ThreadVmCaptureSourceReceipt);
const conflict = () =>
  new ThreadVmBackupConflict({ message: "Backup source ownership or frozen recovery changed." });

/** The environment owns its local drain; only native capture completion permits reopening. */
export function makeThreadVmBackupSourceStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects);
  const get = Effect.fn("relay.thread_vm.backup.source.get")(function* (owner: Owner) {
    const [row] =
      yield* sql<ThreadVmBackupSource>`SELECT x.allocation_id AS "allocationId",x.operation_id AS "operationId",a.thread_id AS "threadId",
      b.environment_id AS "environmentId",x.generation,x.phase,x.source_receipt AS "sourceReceipt",x.snapshot_id AS "snapshotId",x.capture_started_at IS NOT NULL AS "captureStarted",
      (a.state='running' AND x.phase IN ('verified','failed','retiring','retired')) AS "canActivate",x.source_reopened_at IS NOT NULL AS "sourceReopened"
      FROM relay_thread_vm_backups x JOIN relay_thread_vm_allocations a USING(allocation_id)
      JOIN relay_thread_vm_bindings b USING(allocation_id) JOIN relay_thread_placements t ON t.thread_id=a.thread_id
      WHERE a.runtime_protocol='native-v1' AND a.resource_kind='personal' AND a.thread_id=${owner.threadId} AND b.environment_id=${owner.environmentId} AND x.generation=${owner.generation}
        AND b.generation=x.generation AND b.revoked_at IS NULL AND t.environment_id=b.environment_id AND t.generation=x.generation
        AND t.operation_id IS NULL AND a.deleted_at IS NULL
        AND (x.phase='pending' OR x.source_receipt IS NOT NULL OR (x.phase='failed' AND x.capture_started_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses p WHERE p.backup_operation_id=x.operation_id)
      ORDER BY x.created_at DESC,x.operation_id DESC LIMIT 1`;
    return row ?? null;
  });
  const sourceFrozen = Effect.fn("relay.thread_vm.backup.source.frozen")(function* (
    input: Owner & {
      operationId: string;
      nativeCheckpointOperationId: string;
      bootId: string;
      sealEpoch: number;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const current = yield* get(input);
        if (!current || current.operationId !== input.operationId) return yield* conflict();
        if (current.sourceReceipt) {
          if (
            current.sourceReceipt.bootId !== input.bootId ||
            current.sourceReceipt.sealEpoch !== input.sealEpoch ||
            current.sourceReceipt.nativeCheckpointOperationId !== input.nativeCheckpointOperationId
          )
            return yield* conflict();
          return current;
        }
        if (current.phase !== "pending") return yield* conflict();
        const [allocation] = yield* sql<{
          allocationId: string;
          computeRef: string;
          provisionOperationId: string;
        }>`
        SELECT a.allocation_id AS "allocationId",a.compute_ref AS "computeRef",p.operation_id AS "provisionOperationId"
        FROM relay_thread_vm_allocations a JOIN relay_thread_vm_provisions p USING(allocation_id)
        WHERE a.runtime_protocol='native-v1' AND a.resource_kind='personal' AND a.thread_id=${input.threadId} AND a.state='running' AND a.deleted_at IS NULL
          AND a.compute_ref IS NOT NULL AND p.phase='created' AND p.generation=${input.generation} FOR UPDATE OF a`;
        const point = yield* natives.get(input.nativeCheckpointOperationId);
        if (
          !allocation ||
          !point ||
          !point.recoveryHistory ||
          point.threadId !== input.threadId ||
          point.sourceEnvironmentId !== input.environmentId ||
          point.generation !== input.generation ||
          point.captureOperationId !== input.operationId
        )
          return yield* conflict();
        const [mirrored] =
          yield* sql`SELECT 1 FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId}
        AND environment_id=${input.environmentId} AND generation=${input.generation} AND source_sequence>=${point.sourceSequence}`;
        const unsettled =
          yield* sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${input.threadId}
        AND environment_id=${input.environmentId} AND source_sequence>${point.sourceSequence}
        UNION ALL SELECT 1 FROM relay_thread_execution_admissions WHERE thread_id=${input.threadId} AND NOT completed
        UNION ALL SELECT 1 FROM relay_thread_commands WHERE thread_id=${input.threadId} AND receipt_json IS NULL LIMIT 1`;
        if (!mirrored || unsettled.length) return yield* conflict();
        const source = yield* decode({
          ...allocation,
          ...input,
          captureOperationId: input.operationId,
          sourceSequence: point.sourceSequence,
        });
        yield* natives.pinCompleteForOperation({
          threadId: input.threadId,
          operationId: input.operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        const rows =
          yield* sql`UPDATE relay_thread_vm_backups SET source_receipt=${sql.json(source)}
        WHERE operation_id=${input.operationId} AND phase='pending' AND source_receipt IS NULL RETURNING operation_id`;
        if (!rows.length) return yield* conflict();
        return (yield* get(input))!;
      }),
    );
  });
  const cancelPending = Effect.fn("relay.thread_vm.backup.source.cancel_pending")(function* (
    input: Owner & { operationId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const current = yield* get(input);
        if (!current || current.operationId !== input.operationId) return yield* conflict();
        if (current.phase === "failed") return current;
        const rows =
          yield* sql`UPDATE relay_thread_vm_backups SET phase='failed',claim_id=NULL,claim_until=NULL
        WHERE operation_id=${input.operationId} AND phase='pending' AND capture_started_at IS NULL RETURNING operation_id`;
        if (!rows.length) return yield* conflict();
        return (yield* get(input))!;
      }),
    );
  });
  const confirmActivation = Effect.fn("relay.thread_vm.backup.source.activate")(function* (
    input: Owner & { operationId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const current = yield* get(input);
        if (!current || current.operationId !== input.operationId || !current.canActivate)
          return yield* conflict();
        yield* sql`UPDATE relay_thread_vm_backups SET source_reopened_at=COALESCE(source_reopened_at,clock_timestamp())
        WHERE operation_id=${input.operationId}`;
        if (
          current.phase === "failed" &&
          current.sourceReceipt &&
          !current.captureStarted &&
          current.snapshotId === null
        ) {
          // A cancelled write-ahead candidate never dispatched a snapshot.
          yield* sql`UPDATE relay_thread_vm_backups SET phase='retired' WHERE operation_id=${input.operationId} AND capture_started_at IS NULL AND snapshot_id IS NULL`;
          if (current.sourceReceipt)
            yield* natives.releaseOperation({
              threadId: input.threadId,
              operationId: input.operationId,
            });
        }
        // Completed snapshots keep this independent checkpoint until retirement.
        return (yield* get(input))!;
      }),
    );
  });
  return { get, sourceFrozen, cancelPending, confirmActivation };
}
