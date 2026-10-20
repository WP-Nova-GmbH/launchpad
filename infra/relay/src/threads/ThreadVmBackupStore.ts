import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { E2BBackupColdProof } from "../machines/E2BRestoreClient.ts";
const decodeColdProof = Schema.decodeUnknownEffect(E2BBackupColdProof);

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
  readonly threadId: string;
  readonly generation: number;
  readonly snapshotName: string;
  readonly snapshotId: string | null;
  readonly sourceTemplateId: string | null;
  readonly sourceBuildId: string | null;
  readonly phase: "pending" | "creating" | "captured" | "verifying" | "cleanup";
  readonly finalSaveOperationId?: string | null;
  readonly originalState?: "running" | "paused" | null;
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
        WHERE c.host_id = ${hostId} AND a.state = 'running' AND a.deleted_at IS NULL
          AND a.compute_ref IS NOT NULL AND p.phase = 'created' AND s.phase = 'ready'
          AND b.revoked_at IS NULL AND b.generation = p.generation
          AND t.environment_id = b.environment_id AND t.generation = p.generation
          AND t.operation_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
            WHERE x.allocation_id = a.allocation_id AND x.phase IN ('pending','sealed'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
            WHERE r.allocation_id = a.allocation_id AND r.phase IN ('waiting','resuming'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id
              AND x.phase IN ('pending','creating','captured','verifying','cleanup'))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id AND x.generation = t.generation
              AND (x.phase='failed' OR (x.phase='retiring' AND x.failed_probe_stopped_at IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_backups x
            WHERE x.allocation_id = a.allocation_id AND x.phase = 'verified'
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

  const claim = Effect.fn("relay.thread_vm.backup.claim")(function* (
    hostId: string,
    allowPausedFinalSave = false,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Omit<BackupClaim, "claimId">>`
        SELECT x.operation_id AS "operationId", x.allocation_id AS "allocationId",
          x.compute_ref AS "computeRef", p.operation_id AS "provisionOperationId",
          a.thread_id AS "threadId", x.generation, x.snapshot_name AS "snapshotName",
          x.snapshot_id AS "snapshotId", x.source_template_id AS "sourceTemplateId",
          x.source_build_id AS "sourceBuildId", x.phase, f.operation_id AS "finalSaveOperationId", f.original_state AS "originalState"
        FROM relay_thread_vm_backups x
        JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id = x.allocation_id
        LEFT JOIN relay_thread_vm_final_saves f ON f.backup_operation_id=x.operation_id AND f.phase='saving'
        JOIN LATERAL (SELECT * FROM relay_thread_vm_capacity WHERE allocation_id=x.allocation_id ORDER BY position DESC LIMIT 1) c ON (c.state='started' OR (f.original_state='paused' AND c.state='released'))
        JOIN relay_thread_vm_bindings b ON b.allocation_id = x.allocation_id
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        WHERE c.host_id = ${hostId} AND a.deleted_at IS NULL
          AND a.compute_ref = x.compute_ref AND p.phase = 'created'
          AND b.revoked_at IS NULL AND b.generation = x.generation
          AND t.environment_id = b.environment_id AND t.generation = x.generation
          AND ((t.operation_id IS NULL AND f.operation_id IS NULL AND a.state='running') OR
            (t.operation_id=f.operation_id AND f.environment_id=t.environment_id AND f.generation=t.generation AND a.state=f.original_state AND (a.state='running' OR ${allowPausedFinalSave})))
          AND x.phase IN ('pending','creating','captured','verifying','cleanup')
          AND x.retry_at <= clock_timestamp()
          AND (x.claim_until IS NULL OR x.claim_until <= clock_timestamp())
        ORDER BY x.retry_at,x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED`;
        if (!row) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_backups SET claim_id = ${claimId},
        claim_until = clock_timestamp() + interval '3 minutes',
        phase = CASE WHEN phase = 'captured' THEN 'verifying' ELSE phase END
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
          AND x.snapshot_id IS NULL AND x.source_template_id IS NULL AND x.source_build_id IS NULL AND x.probe_receipt IS NULL
          AND x.claim_id=${claim.claimId} AND x.claim_until>clock_timestamp()
          AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a
            JOIN relay_thread_placements t ON t.thread_id=a.thread_id
            JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
            JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
            WHERE a.allocation_id=x.allocation_id AND a.thread_id=${claim.threadId}
              AND a.deleted_at IS NULL AND a.compute_ref=x.compute_ref
              AND a.state=${claim.finalSaveOperationId ? claim.originalState : "running"}
              AND p.phase='created' AND p.operation_id=${claim.provisionOperationId} AND p.generation=x.generation
              AND b.revoked_at IS NULL AND b.environment_id=t.environment_id
              AND b.generation=x.generation AND t.generation=x.generation
              AND t.operation_id IS NOT DISTINCT FROM ${claim.finalSaveOperationId ?? null})
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
    if (!capture.snapshotId || !capture.sourceTemplateId || !capture.sourceBuildId)
      return yield* conflict("Snapshot identity is incomplete");
    const rows = yield* sql`UPDATE relay_thread_vm_backups
      SET phase = 'captured', snapshot_id = ${capture.snapshotId},
        source_template_id = ${capture.sourceTemplateId},
        source_build_id = ${capture.sourceBuildId},
        claim_id = NULL, claim_until = NULL, retry_at = clock_timestamp()
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase = 'creating' AND compute_ref = ${claim.computeRef}
      RETURNING operation_id`;
    return rows.length === 1;
  });

  const failCapture = Effect.fn("relay.thread_vm.backup.capture_failed")(function* (
    claim: BackupClaim,
    capture: {
      readonly snapshotId: string;
      readonly sourceTemplateId: string;
      readonly sourceBuildId: string;
    },
  ) {
    if (
      !capture.sourceTemplateId ||
      !capture.sourceBuildId ||
      capture.snapshotId !== capture.sourceTemplateId ||
      claim.snapshotName !==
        `launchpad-${claim.finalSaveOperationId ? "final" : "backup"}-${claim.operationId}`
    )
      return yield* conflict("Failed capture identity is incomplete");
    const rows = yield* sql`UPDATE relay_thread_vm_backups x
      SET phase='failed',snapshot_id=${capture.snapshotId},source_template_id=${capture.sourceTemplateId},
        source_build_id=${capture.sourceBuildId},claim_id=NULL,claim_until=NULL
      WHERE x.operation_id=${claim.operationId} AND x.allocation_id=${claim.allocationId}
        AND x.generation=${claim.generation} AND x.compute_ref=${claim.computeRef}
        AND x.snapshot_name=${claim.snapshotName} AND x.phase='creating' AND x.snapshot_id IS NULL
        AND x.claim_id=${claim.claimId} AND x.claim_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a
          JOIN relay_thread_placements t ON t.thread_id=a.thread_id
          JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
          WHERE a.allocation_id=x.allocation_id AND a.thread_id=${claim.threadId}
            AND a.deleted_at IS NULL AND a.compute_ref=x.compute_ref
            AND a.state=${claim.finalSaveOperationId ? claim.originalState : "running"}
            AND b.revoked_at IS NULL AND b.environment_id=t.environment_id
            AND b.generation=x.generation AND t.generation=x.generation
            AND t.operation_id IS NOT DISTINCT FROM ${claim.finalSaveOperationId ?? null})
      RETURNING operation_id`;
    return rows.length === 1;
  });

  const markProbeReady = Effect.fn("relay.thread_vm.backup.probe_ready")(function* (
    claim: BackupClaim,
    receipt: unknown,
  ) {
    const proof = yield* decodeColdProof(receipt).pipe(
      Effect.mapError(() => conflict("Cold recovery receipt is incomplete")),
    );
    if (
      proof.operationID !== claim.operationId ||
      proof.generation !== `backup-${claim.operationId}` ||
      proof.preparedBuildID !== proof.coldProbe.preparedBuildID
    )
      return yield* conflict("Cold recovery receipt belongs to a different preparation");
    const rows =
      yield* sql`UPDATE relay_thread_vm_backups SET phase = 'cleanup', probe_receipt = ${sql.json(proof)}
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase = 'verifying' AND snapshot_id IS NOT NULL
        AND source_template_id IS NOT NULL AND source_build_id IS NOT NULL
      RETURNING operation_id`;
    return rows.length === 1;
  });

  const complete = Effect.fn("relay.thread_vm.backup.complete")(function* (claim: BackupClaim) {
    const rows = yield* sql`UPDATE relay_thread_vm_backups
      SET phase = 'verified', verified_at = clock_timestamp(),
        claim_id = NULL, claim_until = NULL
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase = 'cleanup' AND probe_receipt IS NOT NULL AND snapshot_id IS NOT NULL
        AND source_template_id IS NOT NULL AND source_build_id IS NOT NULL
      RETURNING operation_id`;
    return rows.length === 1;
  });

  const defer = Effect.fn("relay.thread_vm.backup.defer")(function* (claim: BackupClaim) {
    yield* sql`UPDATE relay_thread_vm_backups SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId}
        AND phase IN ('pending','creating','captured','verifying','cleanup')`;
  });
  const fail = Effect.fn("relay.thread_vm.backup.fail")(function* (claim: BackupClaim) {
    const rows = yield* sql`UPDATE relay_thread_vm_backups SET phase = 'failed',
      claim_id = NULL, claim_until = NULL
      WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
        AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
        AND phase IN ('creating','verifying','cleanup') RETURNING operation_id`;
    return rows.length === 1;
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
      probeReceipt: E2BBackupColdProof | null;
    }>`SELECT operation_id AS "operationId",
      allocation_id AS "allocationId", phase, snapshot_name AS "snapshotName",
      snapshot_id AS "snapshotId", source_template_id AS "sourceTemplateId",
      source_build_id AS "sourceBuildId", probe_receipt AS "probeReceipt"
      FROM relay_thread_vm_backups WHERE operation_id = ${operationId}`;
    return row ?? null;
  });
  return {
    enqueueDue,
    claim,
    beginCapture,
    recordCapture,
    failCapture,
    markProbeReady,
    complete,
    defer,
    fail,
    get,
  };
}
