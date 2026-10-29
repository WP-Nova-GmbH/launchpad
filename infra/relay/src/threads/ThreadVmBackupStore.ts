import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  E2BNativeSnapshotReceipt,
  ThreadVmCaptureSourceReceipt,
} from "../machines/E2BNativeSnapshotReceipt.ts";
const decodeCapture = Schema.decodeUnknownEffect(E2BNativeSnapshotReceipt);
const decodeSnapshotIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({
    snapshotId: E2BNativeSnapshotReceipt.fields.snapshotId,
    sourceTemplateId: E2BNativeSnapshotReceipt.fields.sourceTemplateId,
    sourceBuildId: E2BNativeSnapshotReceipt.fields.sourceBuildId,
  }),
);

export class ThreadVmBackupConflict extends Schema.TaggedError<ThreadVmBackupConflict>()(
  "ThreadVmBackupConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmBackupConflict({ message });

export interface BackupClaim {
  readonly operationId: string;
  readonly allocationId: string;
  readonly claimId: string;
  readonly computeRef: string;
  readonly provisionOperationId: string;
  readonly templateId: string;
  readonly capacityOperationId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly snapshotName: string;
  readonly snapshotId: string | null;
  readonly sourceTemplateId: string | null;
  readonly sourceBuildId: string | null;
  readonly sourceReceipt: ThreadVmCaptureSourceReceipt;
  readonly phase: "pending" | "creating";
  readonly finalSaveOperationId?: string | null;
}

/** Candidate and verified saves are separate so a failed capture cannot erase recovery. */
export function makeThreadVmBackupStore(sql: PgClient) {
  const enqueueDue = Effect.fn("relay.thread_vm.backup.enqueue_due")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          allocationId: string;
          computeRef: string;
          generation: number;
        }>`
        SELECT a.allocation_id AS "allocationId", a.compute_ref AS "computeRef", t.generation
        FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_provisions p ON p.allocation_id = a.allocation_id
        JOIN relay_thread_vm_capacity c ON c.allocation_id = a.allocation_id AND c.state = 'started'
        JOIN relay_thread_vm_ready s ON s.allocation_id = a.allocation_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id = a.allocation_id
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        JOIN relay_thread_vm_policies policy ON policy.organization_id = a.organization_id
        JOIN relay_thread_vm_activity v ON v.allocation_id=a.allocation_id
        WHERE a.runtime_protocol='native-v1' AND c.host_id = ${hostId} AND a.state = 'running' AND a.deleted_at IS NULL
          AND a.compute_ref IS NOT NULL AND p.phase = 'created' AND s.phase = 'ready'
          AND b.revoked_at IS NULL AND b.generation = p.generation
          AND t.environment_id = b.environment_id AND t.generation = p.generation
          AND t.operation_id IS NULL
          AND v.activity='idle' AND v.observed_at>=clock_timestamp()-interval '2 minutes'
          AND NOT EXISTS(SELECT 1 FROM relay_thread_commands q WHERE q.thread_id=a.thread_id AND q.receipt_json IS NULL)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_execution_admissions e WHERE e.thread_id=a.thread_id AND NOT e.completed
            AND NOT(e.environment_id=t.environment_id AND e.generation=t.generation AND jsonb_exists(v.inactive_work_ids,e.work_id)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
            WHERE x.allocation_id = a.allocation_id AND (x.phase IN ('pending','sealed')
              OR (x.phase IN ('cancelled','completed') AND x.source_reopened_at IS NULL)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
            WHERE r.allocation_id = a.allocation_id AND r.phase IN ('waiting','resuming'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id
              AND (x.phase IN ('pending','creating','captured','verifying','cleanup') OR (x.source_receipt IS NOT NULL AND x.source_reopened_at IS NULL AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses z WHERE z.backup_operation_id=x.operation_id))))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id AND x.generation = t.generation
              AND x.source_receipt IS NULL AND x.source_reopened_at IS NULL AND (x.phase='failed' OR (x.phase='retiring' AND x.failed_probe_stopped_at IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id AND x.phase = 'verified' AND x.native_capture_receipt IS NOT NULL
              AND x.verified_at > clock_timestamp() - make_interval(mins => policy.backup_interval_minutes))
        ORDER BY a.allocation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        // Deletion and manual power changes hold the allocation row. Recheck it
        // after acquiring that same lock so a candidate read cannot race them.
        const [current] = yield* sql<{ state: string; computeRef: string | null }>`
        SELECT state, compute_ref AS "computeRef" FROM relay_thread_vm_allocations
        WHERE allocation_id = ${candidate.allocationId} FOR UPDATE`;
        if (current?.state !== "running" || current.computeRef !== candidate.computeRef)
          return null;
        const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const snapshotName = `launchpad-backup-${operationId}`;
        yield* sql`INSERT INTO relay_thread_vm_backups
        (operation_id,allocation_id,generation,compute_ref,snapshot_name,phase)
        VALUES (${operationId},${candidate.allocationId},${candidate.generation},
          ${candidate.computeRef},${snapshotName},'pending')`;
        return operationId;
      }),
    );
  });

  const claim = Effect.fn("relay.thread_vm.backup.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Omit<BackupClaim, "claimId">>`
        SELECT x.operation_id AS "operationId", x.allocation_id AS "allocationId",
          x.compute_ref AS "computeRef", p.operation_id AS "provisionOperationId",a.template_id AS "templateId",c.operation_id AS "capacityOperationId",
          a.thread_id AS "threadId", x.generation, x.snapshot_name AS "snapshotName",
          x.snapshot_id AS "snapshotId", x.source_template_id AS "sourceTemplateId",
          x.source_build_id AS "sourceBuildId",x.source_receipt AS "sourceReceipt", x.phase, f.operation_id AS "finalSaveOperationId"
        FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id = x.allocation_id
        LEFT JOIN relay_thread_vm_final_saves f ON f.backup_operation_id=x.operation_id AND f.phase IN ('saving','aborting')
        JOIN LATERAL (SELECT * FROM relay_thread_vm_capacity WHERE a.runtime_protocol='native-v1' AND allocation_id=x.allocation_id ORDER BY position DESC LIMIT 1) c ON (c.state='started' OR (x.phase='creating' AND c.state='released'))
        JOIN relay_thread_vm_bindings b ON b.allocation_id = x.allocation_id
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE c.host_id = ${hostId} AND a.deleted_at IS NULL
          AND a.compute_ref = x.compute_ref AND p.phase = 'created'
          AND b.revoked_at IS NULL AND b.generation = x.generation
          AND t.environment_id = b.environment_id AND t.generation = x.generation
          AND ((t.operation_id IS NULL AND f.operation_id IS NULL) OR
            (t.operation_id=f.operation_id AND f.environment_id=t.environment_id AND f.generation=t.generation))
          AND (a.state='running' OR (x.phase='creating' AND a.state='paused'))
          AND (x.phase='creating' OR f.operation_id IS NULL OR f.phase='saving')
          AND x.phase IN ('pending','creating') AND x.source_receipt IS NOT NULL AND x.native_capture_receipt IS NULL
          AND x.retry_at <= clock_timestamp()
          AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
        ORDER BY x.retry_at,x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED`;
        if (!row) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_backups SET claim_id = ${claimId},
        claim_until = clock_timestamp() + interval '3 minutes'
        WHERE operation_id = ${row.operationId}`;
        return { ...row, claimId } satisfies BackupClaim;
      }),
    );
  });

  const beginCapture = Effect.fn("relay.thread_vm.backup.begin_capture")(function* (
    claim: BackupClaim,
  ) {
    if (claim.phase !== "pending") return false;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Permanent deletion takes the same lock before cancelling an unissued
        // capture. Exactly one of deletion or external dispatch can win.
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${claim.threadId} FOR UPDATE`;
        const rows =
          yield* sql`UPDATE relay_thread_vm_backups x SET phase='creating',capture_started_at=date_trunc('milliseconds',clock_timestamp())
        WHERE x.operation_id=${claim.operationId} AND x.allocation_id=${claim.allocationId}
          AND x.generation=${claim.generation} AND x.compute_ref=${claim.computeRef}
          AND x.snapshot_name=${claim.snapshotName} AND x.phase='pending'
          AND x.snapshot_id IS NULL AND x.source_template_id IS NULL AND x.source_build_id IS NULL AND x.native_capture_receipt IS NULL
          AND x.source_receipt=${sql.json(claim.sourceReceipt)}
          AND x.claim_id=${claim.claimId} AND x.claim_until>clock_timestamp()
          AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a
            JOIN relay_thread_placements t ON t.thread_id=a.thread_id
            JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
            JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
            WHERE a.runtime_protocol='native-v1' AND a.allocation_id=x.allocation_id AND a.thread_id=${claim.threadId}
              AND a.deleted_at IS NULL AND a.compute_ref=x.compute_ref
              AND a.state='running'
              AND p.phase='created' AND p.operation_id=${claim.provisionOperationId} AND p.generation=x.generation
              AND b.revoked_at IS NULL AND b.environment_id=t.environment_id
              AND b.generation=x.generation AND t.generation=x.generation
              AND t.operation_id IS NOT DISTINCT FROM ${claim.finalSaveOperationId ?? null}
              AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id AND f.phase!='saving'))
        RETURNING operation_id`;
        return rows.length === 1;
      }),
    );
  });

  const recordCapture = Effect.fn("relay.thread_vm.backup.record_capture")(function* (
    claim: BackupClaim,
    capture: {
      readonly snapshotId: string;
      readonly sourceTemplateId: string;
      readonly sourceBuildId: string;
    },
  ) {
    const { allocationId, computeRef, threadId, generation, ...source } = claim.sourceReceipt;
    const receipt = yield* decodeCapture({
      version: 1,
      kind: "native-full-snapshot-v1",
      operationId: claim.operationId,
      allocationId,
      computeRef,
      threadId,
      generation,
      ...capture,
      source,
    }).pipe(Effect.mapError(() => conflict("Native snapshot receipt is invalid")));
    if (
      allocationId !== claim.allocationId ||
      computeRef !== claim.computeRef ||
      threadId !== claim.threadId ||
      generation !== claim.generation
    )
      return yield* conflict("Native snapshot belongs to another source");
    const rows = yield* sql`UPDATE relay_thread_vm_backups
      SET phase = 'verified',verified_at=clock_timestamp(),native_capture_receipt=${sql.json(receipt)}, snapshot_id = ${capture.snapshotId},
        source_template_id = ${capture.sourceTemplateId},
        source_build_id = ${capture.sourceBuildId},
        claim_id = NULL, claim_until = NULL, retry_at = clock_timestamp()
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase = 'creating' AND compute_ref = ${claim.computeRef} AND source_receipt=${sql.json(claim.sourceReceipt)}
      RETURNING operation_id`;
    return rows.length === 1;
  });

  /** Native terminal-error alias evidence settles capture without claiming a usable backup. */
  const recordFailure = Effect.fn("relay.thread_vm.backup.record_failure")(function* (
    claim: BackupClaim,
    input: { snapshotId: string; sourceTemplateId: string; sourceBuildId: string },
  ) {
    const identity = yield* decodeSnapshotIdentity(input).pipe(
      Effect.mapError(() => conflict("Failed native snapshot identity is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${claim.threadId} FOR UPDATE`;
        const rows =
          yield* sql`UPDATE relay_thread_vm_backups SET phase='failed',snapshot_id=${identity.snapshotId},source_template_id=${identity.sourceTemplateId},source_build_id=${identity.sourceBuildId},claim_id=NULL,claim_until=NULL
        WHERE operation_id=${claim.operationId} AND allocation_id=${claim.allocationId} AND generation=${claim.generation}
          AND compute_ref=${claim.computeRef} AND source_receipt=${sql.json(claim.sourceReceipt)} AND phase='creating' AND native_capture_receipt IS NULL
          AND claim_id=${claim.claimId} AND claim_until>clock_timestamp() RETURNING operation_id`;
        if (!rows.length) return false;
        const cancelled =
          yield* sql`UPDATE relay_thread_vm_pauses SET phase='cancelled',claim_id=NULL,claim_until=NULL
        WHERE backup_operation_id=${claim.operationId} AND phase IN ('pending','sealed') AND source_receipt=${sql.json(claim.sourceReceipt)}
          AND pause_dispatched_at IS NULL AND pause_dispatch_claim_id IS NULL RETURNING allocation_id`;
        if (cancelled.length)
          yield* sql`UPDATE relay_thread_vm_activity SET revision=revision+1,activity='unknown',observed_at=NULL,idle_since=NULL WHERE allocation_id=${claim.allocationId}`;
        return true;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.backup.defer")(function* (claim: BackupClaim) {
    yield* sql`UPDATE relay_thread_vm_backups SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId}
        AND phase IN ('pending','creating')`;
  });
  const get = Effect.fn("relay.thread_vm.backup.get")(function* (operationId: string) {
    const [row] = yield* sql<{
      operationId: string;
      allocationId: string;
      phase: string;
      snapshotName: string;
      snapshotId: string | null;
      sourceTemplateId: string | null;
      sourceBuildId: string | null;
      sourceReceipt: ThreadVmCaptureSourceReceipt | null;
      nativeCaptureReceipt: E2BNativeSnapshotReceipt | null;
    }>`SELECT operation_id AS "operationId",
      allocation_id AS "allocationId", phase, snapshot_name AS "snapshotName",
      snapshot_id AS "snapshotId", source_template_id AS "sourceTemplateId",
      source_build_id AS "sourceBuildId", source_receipt AS "sourceReceipt",native_capture_receipt AS "nativeCaptureReceipt"
      FROM relay_thread_vm_backups WHERE operation_id = ${operationId}`;
    return row ?? null;
  });
  return {
    enqueueDue,
    claim,
    beginCapture,
    recordCapture,
    recordFailure,
    defer,
    get,
  };
}
