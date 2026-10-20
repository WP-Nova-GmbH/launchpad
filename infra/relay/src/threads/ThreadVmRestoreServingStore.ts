import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { E2BRestoreStatus, E2BStoppedRestoreBoot } from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import {
  makeThreadVmRestoreStore,
  restoreBootGeneration,
  restoreComputeGeneration,
  restoreProbeOperationId,
  ThreadVmRestoreConflict,
  type ThreadVmRestore,
  type ThreadVmRestoreClaim,
} from "./ThreadVmRestoreStore.ts";

const conflict = (message: string) => new ThreadVmRestoreConflict({ message });
const decodeStatus = Schema.decodeUnknownEffect(E2BRestoreStatus);
const decodeStoppedBoot = Schema.decodeUnknownEffect(E2BStoppedRestoreBoot);
const encodeStoppedBoot = Schema.encodeSync(Schema.fromJsonString(E2BStoppedRestoreBoot));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(E2BRestoreStatus));
const sameIdentity = (a: E2BRestoreStatus, b: E2BRestoreStatus) =>
  a.operationID === b.operationID &&
  a.generation === b.generation &&
  a.sandboxID === b.sandboxID &&
  a.executionID === b.executionID &&
  a.preparedBuildID === b.preparedBuildID &&
  a.manifestSHA256 === b.manifestSHA256;

/** The old source is already positively absent. Commit the new generation before
 * boot, retain the operation fence through import, and never roll a committed
 * destination back into the old source. Worker leases grant no execution. */
export function makeThreadVmRestoreServingStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const restores = makeThreadVmRestoreStore(sql, objects),
    capacity = makeThreadVmCapacityStore(sql),
    allocations = makeThreadVmAllocationStore(sql);
  const requireOwner = Effect.fnUntraced(function* (row: ThreadVmRestore) {
    const [owner] = yield* sql<{ repositoryId: string; organizationId: string; role: string }>`
      SELECT t.repository_id AS "repositoryId", t.organization_id AS "organizationId",m.role
      FROM relay_thread_placements t JOIN relay_organization_members m
        ON m.organization_id=t.organization_id AND m.user_id=t.owner_user_id
      JOIN relay_repositories repo ON repo.repository_id=t.repository_id AND repo.organization_id=t.organization_id
      WHERE t.thread_id=${row.threadId} AND t.owner_user_id=${row.actorUserId}
      FOR SHARE OF m,repo`;
    if (!owner) return yield* conflict("The restore owner no longer has repository access.");
    if (owner.role !== "admin") {
      const grants = yield* sql`SELECT user_id FROM relay_repository_access
        WHERE repository_id=${owner.repositoryId} AND organization_id=${owner.organizationId}
          AND user_id=${row.actorUserId} FOR SHARE`;
      if (!grants.length)
        return yield* conflict("The restore owner no longer has repository access.");
    }
    return owner;
  });
  const claim = Effect.fn("relay.thread_vm.restore.claim_serving")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId"
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id=r.operation_id
        WHERE r.host_id=${hostId} AND r.serving_requested
          AND (r.phase IN ('prepared','boot_preparing','boot_prepared','committed') OR
            (r.phase='booted' AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_enrollments e
              WHERE e.allocation_id=r.allocation_id AND e.environment_id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_bindings b WHERE b.allocation_id=r.allocation_id)))
          AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp())
          AND c.state IN ('reserved','started')
        ORDER BY r.retry_at,r.created_at,r.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const row = yield* restores.lock(candidate.operationId);
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_restores SET claim_id=${claimId},
        claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${row.operationId}`;
        return { ...row, claimId };
      }),
    );
  });
  const authorize = Effect.fn("relay.thread_vm.restore.authorize_serving")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        const owner = yield* requireOwner(row);
        if (
          !row.servingRequested ||
          !["prepared", "boot_preparing", "boot_prepared", "committed", "booted"].includes(
            row.phase,
          )
        )
          return yield* conflict("Restore does not accept this serving step.");
        yield* restores.requireRecovery(row);
        return { ...row, repositoryId: owner.repositoryId };
      }),
    );
  });
  const recordProbeRemoved = Effect.fn("relay.thread_vm.restore.probe_removed")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: E2BRestoreStatus,
  ) {
    const decoded = yield* decodeStatus(receipt).pipe(
      Effect.mapError(() => conflict("Invalid probe cleanup receipt.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        if (
          !row.servingRequested ||
          row.phase !== "prepared" ||
          !row.preparedReceipt ||
          decoded.operationID !== restoreProbeOperationId(row.operationId, row.probeAttempt) ||
          decoded.generation !== restoreComputeGeneration(row.operationId) ||
          decoded.state !== "cancelled" ||
          !sameIdentity(decoded, row.preparedReceipt)
        )
          return yield* conflict("The exact verification preparation has not been removed.");
        yield* sql`UPDATE relay_thread_vm_restores SET probe_removed_at=COALESCE(probe_removed_at,clock_timestamp())
        WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const beginPrepare = Effect.fn("relay.thread_vm.restore.begin_boot_prepare")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* requireOwner(row);
        yield* restores.requireRecovery(row);
        if (
          !row.servingRequested ||
          !row.probeRemoved ||
          !(
            row.phase === "prepared" ||
            row.phase === "boot_preparing" ||
            (row.phase === "committed" && row.bootReceipt === null)
          ) ||
          (yield* capacity.get(row.operationId))?.state !==
            (row.servingCommitted ? "started" : "reserved")
        )
          return yield* conflict(
            "Boot preparation requires verified cleanup and reserved capacity.",
          );
        yield* sql`UPDATE relay_thread_vm_restores SET phase=${row.servingCommitted ? "committed" : "boot_preparing"},
        boot_prepare_started_at=COALESCE(boot_prepare_started_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const recordPrepared = Effect.fn("relay.thread_vm.restore.boot_prepared")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: E2BRestoreStatus,
  ) {
    const decoded = yield* decodeStatus(receipt).pipe(
      Effect.mapError(() => conflict("Invalid boot preparation receipt.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* restores.requireRecovery(row);
        if (
          !row.servingRequested ||
          !row.bootPrepareStarted ||
          !(
            row.phase === "boot_preparing" ||
            row.phase === "boot_prepared" ||
            (row.phase === "committed" && row.bootReceipt === null)
          ) ||
          decoded.operationID !== restoreBootOperationId(row.operationId, row.bootAttempt) ||
          decoded.generation !== restoreBootGeneration(row.generation) ||
          decoded.state !== "prepared" ||
          !decoded.coldProbe ||
          !decoded.manifestSHA256 ||
          decoded.coldProbe.preparedBuildID !== decoded.preparedBuildID ||
          decoded.coldProbe.initSHA256 !== row.preparedReceipt?.coldProbe?.initSHA256 ||
          decoded.preparedBuildID === row.preparedReceipt?.preparedBuildID ||
          decoded.sandboxID === row.preparedReceipt?.sandboxID ||
          (row.bootReceipt && !sameIdentity(decoded, row.bootReceipt))
        )
          return yield* conflict(
            "Boot preparation does not prove the stopped, distinct destination.",
          );
        // Installing bootstrap changes the disk hash. Its immutable prepare request
        // binds the original saved source pair; the prior probe proved that source.
        yield* sql`UPDATE relay_thread_vm_restores SET phase=${row.servingCommitted ? "committed" : "boot_prepared"},boot_receipt=${encodeStatus(decoded)}::jsonb,
        claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const recordFailedPreparation = Effect.fn("relay.thread_vm.restore.failed_boot_prepare")(
    function* (claim: ThreadVmRestoreClaim, receipt: E2BRestoreStatus) {
      const decoded = yield* decodeStatus(receipt).pipe(
        Effect.mapError(() => conflict("Invalid failed boot preparation receipt.")),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* restores.requireClaim(claim);
          yield* requireOwner(row);
          yield* restores.requireRecovery(row);
          if (
            row.phase !== "committed" ||
            !row.servingCommitted ||
            !row.bootPrepareStarted ||
            row.bootAttempt === 0 ||
            row.bootReceipt !== null ||
            decoded.operationID !== restoreBootOperationId(row.operationId, row.bootAttempt) ||
            decoded.generation !== restoreBootGeneration(row.generation) ||
            (decoded.state !== "failed" && decoded.state !== "cancelled") ||
            decoded.preparedBuildID === row.preparedReceipt?.preparedBuildID ||
            decoded.sandboxID === row.preparedReceipt?.sandboxID
          )
            return yield* conflict("Failed preparation does not identify the committed retry.");
          // A failed preparation is only a cleanup target, never permission to boot.
          yield* sql`UPDATE relay_thread_vm_restores SET boot_receipt=${encodeStatus(decoded)}::jsonb
        WHERE operation_id=${row.operationId}`;
          return (yield* restores.get(row.operationId))!;
        }),
      );
    },
  );
  const commit = Effect.fn("relay.thread_vm.restore.commit_boot")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: E2BRestoreStatus,
  ) {
    const decoded = yield* decodeStatus(receipt).pipe(
      Effect.mapError(() => conflict("Invalid pre-commit boot inspection.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* requireOwner(row);
        yield* restores.requireRecovery(row);
        if (
          decoded.state !== "prepared" ||
          !row.bootReceipt ||
          !sameIdentity(decoded, row.bootReceipt)
        )
          return yield* conflict("Pre-commit inspection differs from the prepared destination.");
        if (row.phase === "committed") return row;
        if (row.phase !== "boot_prepared" || !row.bootReceipt || !row.probeRemoved)
          return yield* conflict("Only a verified boot preparation can commit.");
        yield* restores.requireSourceAbsent(row);
        yield* capacity.beginExecution(row.operationId);
        const changed = yield* sql`UPDATE relay_thread_placements SET generation=generation+1,
        environment_id=${`pending-restore:${row.allocationId}`},project_id=${`vm:${row.threadId}`}
        WHERE thread_id=${row.threadId} AND generation=${row.generation} AND operation_id=${row.operationId}
          AND owner_user_id=${row.actorUserId} RETURNING thread_id`;
        if (!changed.length) return yield* conflict("Restore ownership changed before commit.");
        yield* sql`UPDATE relay_thread_vm_restores SET phase='committed',committed_at=clock_timestamp(),
        claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const recordActive = Effect.fn("relay.thread_vm.restore.record_boot")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: E2BRestoreStatus,
  ) {
    const decoded = yield* decodeStatus(receipt).pipe(
      Effect.mapError(() => conflict("Invalid restore boot receipt.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        if (
          row.phase !== "committed" ||
          !row.bootReceipt ||
          row.bootReceipt.state !== "prepared" ||
          decoded.state !== "active" ||
          !sameIdentity(decoded, row.bootReceipt)
        )
          return yield* conflict("Restore boot does not match committed destination ownership.");
        yield* capacity.recordCreated(row.operationId, decoded.sandboxID);
        yield* allocations.recordCreated({
          allocationId: row.allocationId,
          computeRef: decoded.sandboxID,
        });
        // The verified snapshot is a different image from the original base.
        // Pin it before enrollment opens so every adapter validates the restored image.
        yield* sql`UPDATE relay_thread_vm_allocations SET template_id=${row.sourceTemplateId}
        WHERE allocation_id=${row.allocationId}`;
        // Ordinary create reconciliation never sees a pending restore provision.
        // This created record only opens narrow enrollment after the exact boot receipt.
        yield* sql`INSERT INTO relay_thread_vm_provisions (allocation_id,operation_id,generation,phase)
        VALUES (${row.allocationId},${row.operationId},${row.generation + 1},'created')`;
        yield* sql`UPDATE relay_thread_vm_restores SET phase='booted',claim_id=NULL,claim_until=NULL,
        retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  /** A stopped unenrolled attempt has never acquired a serving identity. Retain
   * ownership and quota, archive its exact stop receipt, then prepare a new cold
   * attempt from the same pinned recovery point. An HTTP absence is not proof. */

  const beginBootRecovery = Effect.fn("relay.thread_vm.restore.fence_boot_recovery")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* requireOwner(row);
        if (
          (row.phase !== "booted" && row.phase !== "committed") ||
          !row.servingCommitted ||
          !row.bootReceipt
        )
          return yield* conflict("Only an unenrolled restore boot can enter recovery.");
        // The same allocation lock serializes enrollment exchanges. Once fenced,
        // no in-flight seed can issue an identity while the external stop runs.
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
        const issued =
          yield* sql`SELECT 1 FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId} AND environment_id IS NOT NULL
        UNION ALL SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId}`;
        if (issued.length)
          return yield* conflict("An issued VM identity cannot enter boot recovery.");
        if (row.phase === "committed") {
          const unexpected = yield* sql`SELECT 1 FROM relay_thread_vm_provisions
          WHERE allocation_id=${row.allocationId} FOR UPDATE`;
          if (unexpected.length) return yield* conflict("Boot enrollment ownership changed.");
        }
        yield* sql`UPDATE relay_thread_vm_restores SET boot_recovery_started_at=COALESCE(boot_recovery_started_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const retryStoppedBoot = Effect.fn("relay.thread_vm.restore.retry_stopped_boot")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: E2BStoppedRestoreBoot,
  ) {
    const decoded = yield* decodeStoppedBoot(receipt).pipe(
      Effect.mapError(() => conflict("Invalid stopped boot receipt.")),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* requireOwner(row);
        yield* restores.requireRecovery(row);
        if (
          (row.phase !== "booted" && row.phase !== "committed") ||
          !row.servingCommitted ||
          !row.bootRecoveryStarted ||
          !row.bootReceipt ||
          !sameIdentity(decoded, row.bootReceipt)
        )
          return yield* conflict("The exact unenrolled boot has not been positively stopped.");
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
        const issued =
          yield* sql`SELECT 1 FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId} AND environment_id IS NOT NULL
        UNION ALL SELECT 1 FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId}`;
        if (issued.length)
          return yield* conflict("An issued VM identity cannot be replaced by boot recovery.");
        if (row.phase === "booted") {
          const created =
            yield* sql`SELECT 1 FROM relay_thread_vm_provisions WHERE allocation_id=${row.allocationId}
          AND operation_id=${row.operationId} AND generation=${row.generation + 1} AND phase='created' FOR UPDATE`;
          if (!created.length) return yield* conflict("Boot enrollment ownership changed.");
          const allocation =
            yield* sql`UPDATE relay_thread_vm_allocations SET state='creating',compute_ref=NULL
        WHERE allocation_id=${row.allocationId} AND compute_ref=${decoded.sandboxID} AND state='running' AND deleted_at IS NULL RETURNING allocation_id`;
          const reservation =
            yield* sql`UPDATE relay_thread_vm_capacity SET compute_ref=NULL WHERE operation_id=${row.operationId}
        AND allocation_id=${row.allocationId} AND state='started' AND compute_ref=${decoded.sandboxID} RETURNING operation_id`;
          if (!allocation.length || !reservation.length)
            return yield* conflict("The stopped allocation or its reservation changed.");
        } else {
          const unexpected =
            yield* sql`SELECT 1 FROM relay_thread_vm_provisions WHERE allocation_id=${row.allocationId} FOR UPDATE`;
          const reservation = yield* sql`SELECT 1 FROM relay_thread_vm_capacity
          WHERE operation_id=${row.operationId} AND allocation_id=${row.allocationId}
            AND state='started' AND compute_ref IS NULL FOR UPDATE`;
          if (unexpected.length || !reservation.length)
            return yield* conflict("The unstarted boot or its reservation changed.");
        }
        yield* sql`DELETE FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId}`;
        yield* sql`DELETE FROM relay_thread_vm_provisions WHERE allocation_id=${row.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_restores SET boot_attempt=boot_attempt+1,phase='committed',
        boot_recovery_started_at=NULL,boot_prepare_started_at=NULL,boot_receipt=NULL,retired_boot_receipts=retired_boot_receipts || ${encodeStoppedBoot(decoded)}::jsonb,
        claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
      }),
    );
  });
  const confirmStillActive = Effect.fn("relay.thread_vm.restore.confirm_still_active")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* restores.requireClaim(claim);
        yield* sql`UPDATE relay_thread_vm_restores SET claim_id=NULL,claim_until=NULL,error_code=NULL,
        retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId}`;
      }),
    );
  });
  const verifyReceipt = (row: ThreadVmRestore, receipt: E2BRestoreStatus) =>
    decodeStatus(receipt).pipe(
      Effect.flatMap((decoded) =>
        row.bootReceipt && sameIdentity(decoded, row.bootReceipt)
          ? Effect.succeed(decoded)
          : conflict("Host inspection differs from the committed restore."),
      ),
    );
  return {
    claim,
    authorize,
    beginBootRecovery,
    retryStoppedBoot,
    confirmStillActive,
    verifyReceipt,
    recordProbeRemoved,
    beginPrepare,
    recordPrepared,
    recordFailedPreparation,
    commit,
    recordActive,
  };
}
