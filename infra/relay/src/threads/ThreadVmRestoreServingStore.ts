import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadVmWarmRestoreBootstrapReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  authorizeWorkflowVmCheckpoint,
  lockWorkflowVmCheckpoint,
} from "../jobs/WorkflowVmCheckpoint.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import {
  type NativeThreadVmRestoreBootReceipt,
  NativeThreadVmRestoreDeletedBootReceipt,
} from "./NativeThreadVmRestoreReceipt.ts";
import {
  makeThreadVmRestoreStore,
  ThreadVmRestoreConflict,
  type ThreadVmRestore,
  type ThreadVmRestoreClaim,
} from "./ThreadVmRestoreStore.ts";
import { readCurrentWorkflowCheckpoint } from "./WorkflowVmWorkspace.ts";

const conflict = (message: string) => new ThreadVmRestoreConflict({ message });

const decodeBootstrap = Schema.decodeUnknownEffect(ThreadVmWarmRestoreBootstrapReceipt);
const decodeDeleted = Schema.decodeUnknownEffect(NativeThreadVmRestoreDeletedBootReceipt);

/** Ownership commits before native create. Unknown create/connect keeps its slot and fence. */
export function makeThreadVmRestoreServingStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const restores = makeThreadVmRestoreStore(sql, objects),
    capacity = makeThreadVmCapacityStore(sql),
    allocations = makeThreadVmAllocationStore(sql);
  const requireOwner = Effect.fnUntraced(function* (row: ThreadVmRestore) {
    const [owner] = yield* sql<{ repositoryId: string; organizationId: string; role: string }>`
      SELECT t.repository_id AS "repositoryId",t.organization_id AS "organizationId",m.role
      FROM relay_thread_placements t JOIN relay_organization_members m ON m.organization_id=t.organization_id AND m.user_id=t.owner_user_id
      JOIN relay_repositories repo ON repo.repository_id=t.repository_id AND repo.organization_id=t.organization_id
      WHERE t.thread_id=${row.threadId} AND t.owner_user_id=${row.actorUserId}
        AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id) FOR SHARE OF m,repo`;
    if (!owner) return yield* conflict("The restore owner no longer has repository access.");
    if (owner.role !== "admin") {
      const [grant] =
        yield* sql`SELECT user_id FROM relay_repository_access WHERE repository_id=${owner.repositoryId} AND organization_id=${owner.organizationId} AND user_id=${row.actorUserId} FOR SHARE`;
      if (!grant) return yield* conflict("The restore owner no longer has repository access.");
    }
    return owner;
  });
  const claim = Effect.fn("relay.thread_vm.restore.claim_serving")(function* (
    hostId: string,
    allowStart = true,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
          workflowJobId: string | null;
          phase: ThreadVmRestore["phase"];
        }>`SELECT r.operation_id AS "operationId",t.workflow_job_id AS "workflowJobId",r.phase
        FROM relay_thread_vm_restores r JOIN relay_thread_placements t USING(thread_id)
        JOIN relay_thread_vm_capacity c ON c.operation_id=r.operation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE r.host_id=${hostId} AND r.serving_requested AND r.prepared_receipt->>'kind'='native-restore-catalog-v1'
          AND a.runtime_protocol='native-v1' AND (a.resource_kind='personal' OR
            (a.resource_kind='organization_workflow' AND t.audience='repository' AND t.workflow_job_id IS NOT NULL))
          AND (r.phase IN ('prepared','committed','creating','bootstrapping') OR
            (r.phase='aborting' AND r.committed_at IS NOT NULL) OR
            (r.phase='booted' AND (r.boot_recovery_started_at IS NOT NULL OR r.error_code IS NOT NULL OR
              NOT EXISTS(SELECT 1 FROM relay_thread_vm_enrollments e WHERE e.allocation_id=r.allocation_id AND e.environment_id IS NOT NULL) OR
              EXISTS(SELECT 1 FROM relay_thread_vm_provisions p WHERE p.allocation_id=r.allocation_id AND p.error_code='enrollment_unconfirmed'))) OR
            (r.phase='importing' AND (r.error_code IS NOT NULL OR r.boot_recovery_started_at IS NOT NULL)))
          AND (${allowStart} OR r.phase='aborting')
          AND r.boot_ingress_recovery_claim_id IS NULL AND r.retry_at<=clock_timestamp()
          AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp()) AND c.state IN ('reserved','started')
        ORDER BY r.retry_at,r.created_at,r.operation_id LIMIT 1`;
        if (!candidate) return null;
        if (
          candidate.workflowJobId &&
          !(yield* lockWorkflowVmCheckpoint(sql, candidate.workflowJobId))
        )
          return null;
        const row = yield* restores
          .lock(candidate.operationId)
          .pipe(Effect.catchTag("ThreadVmRestoreConflict", () => Effect.succeed(null)));
        if (
          !row ||
          row.phase !== candidate.phase ||
          (row.workflowCheckpoint?.jobId ?? null) !== candidate.workflowJobId
        )
          return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const [claimed] =
          yield* sql`UPDATE relay_thread_vm_restores SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes'
          WHERE operation_id=${row.operationId} AND retry_at<=clock_timestamp()
            AND (claim_until IS NULL OR claim_until<=clock_timestamp())
            AND boot_ingress_recovery_claim_id IS NULL
            AND EXISTS(SELECT 1 FROM relay_thread_vm_capacity c WHERE c.operation_id=${row.operationId}
              AND c.allocation_id=${row.allocationId} AND c.state IN ('reserved','started'))
          RETURNING operation_id`;
        if (!claimed) return null;
        return { ...row, claimId };
      }),
    );
  });
  const authorize = Effect.fn("relay.thread_vm.restore.authorize_serving")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* restores.get(claim.operationId);
        const workflowJob = prior?.workflowCheckpoint
          ? yield* lockWorkflowVmCheckpoint(sql, prior.workflowCheckpoint.jobId)
          : null;
        const row = yield* restores.requireClaim(claim);
        const owner = row.workflowCheckpoint ? workflowJob : yield* requireOwner(row);
        if (
          !owner ||
          (row.workflowCheckpoint &&
            (workflowJob?.record.runtime?.kind !== "vm" ||
              workflowJob.record.runtime.threadId !== row.threadId)) ||
          !row.servingRequested ||
          !["prepared", "committed", "creating", "bootstrapping", "booted", "importing"].includes(
            row.phase,
          ) ||
          row.bootIngressRecoveryClaimId
        )
          return yield* conflict("Restore does not admit this serving step.");
        yield* restores.requireRecovery(row);
        return { ...row, repositoryId: owner.repositoryId, workflowJob };
      }),
    );
  });
  const startAuthorized = Effect.fnUntraced(function* (
    row: Effect.Success<ReturnType<typeof authorize>>,
  ) {
    if (!row.workflowCheckpoint) return true;
    const response = row.workflowJob
      ? yield* authorizeWorkflowVmCheckpoint(sql, row.workflowJob)
      : null;
    if (
      response?.responseId === row.operationId &&
      response.userId === row.actorUserId &&
      response.checkpoint.checkpointId === row.workflowCheckpoint.checkpointId &&
      (response.checkpoint.generation ?? 0) === row.workflowCheckpoint.checkpointGeneration &&
      (yield* readCurrentWorkflowCheckpoint(sql, row.workflowCheckpoint))
    )
      return true;
    yield* restores.requestAbort(row.operationId);
    return false;
  });
  const commit = Effect.fn("relay.thread_vm.restore.commit_boot")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (row.servingCommitted) return row;
        if (row.phase !== "prepared" || row.preparedReceipt?.kind !== "native-restore-catalog-v1")
          return yield* conflict("Only a validated native snapshot can commit.");
        if (!(yield* startAuthorized(row))) return null;
        yield* restores.requireSourceAbsent(row);
        yield* capacity.beginExecution(row.operationId);
        const [changed] = yield* sql<{
          generation: number;
        }>`UPDATE relay_thread_placements SET generation=generation+1,
        environment_id=${`pending-restore:${row.allocationId}`},project_id=${`vm:${row.threadId}`}
        WHERE thread_id=${row.threadId} AND generation=${row.generation} AND operation_id=${row.operationId}
          AND ${
            row.workflowCheckpoint
              ? sql`audience='repository' AND owner_user_id IS NULL AND workflow_job_id=${row.workflowCheckpoint.jobId}`
              : sql`owner_user_id=${row.actorUserId}`
          }
        RETURNING generation`;
        if (!changed) return yield* conflict("Restore ownership changed before commit.");
        yield* sql`UPDATE relay_thread_vm_allocations SET template_id=${row.sourceTemplateId} WHERE allocation_id=${row.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_restores SET phase='committed',target_generation=${changed.generation},committed_at=clock_timestamp(),claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const beginCreate = Effect.fn("relay.thread_vm.restore.begin_create")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (
          row.phase !== "committed" ||
          !row.servingCommitted ||
          !row.targetGeneration ||
          row.bootCreateStarted ||
          row.bootReceipt
        )
          return yield* conflict(
            "This native boot attempt was already dispatched or is not committed.",
          );
        const reservation = yield* capacity.get(row.operationId);
        if (
          reservation?.state !== "started" ||
          reservation.hostId !== row.hostId ||
          reservation.computeRef !== null
        )
          return yield* conflict("Restore execution capacity changed.");
        if (!(yield* startAuthorized(row))) return null;
        yield* sql`UPDATE relay_thread_vm_restores SET phase='creating',boot_create_started_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const recordObserved = Effect.fn("relay.thread_vm.restore.record_observed")(function* (
    claim: ThreadVmRestoreClaim,
    sandboxId: string,
    sealedTrafficAccessToken?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        if (
          !row.servingCommitted ||
          !row.targetGeneration ||
          !row.bootCreateStarted ||
          !["creating", "bootstrapping", "booted", "importing", "aborting"].includes(row.phase) ||
          row.bootIngressRecoveryClaimId ||
          (row.bootReceipt && row.bootReceipt.sandboxId !== sandboxId)
        )
          return yield* conflict("Native boot identity changed.");
        const receipt: NativeThreadVmRestoreBootReceipt = {
          version: 1,
          kind: "native-restore-boot-v1",
          operationId: row.operationId,
          allocationId: row.allocationId,
          threadId: row.threadId,
          generation: row.targetGeneration,
          bootAttempt: row.bootAttempt,
          sandboxId,
          sourceTemplateId: row.sourceTemplateId,
          sourceBuildId: row.sourceBuildId,
        };
        yield* capacity.recordCreated(row.operationId, sandboxId);
        yield* allocations.recordCreated({
          allocationId: row.allocationId,
          computeRef: sandboxId,
          resourceKind: row.workflowCheckpoint ? "organization_workflow" : "personal",
          ...(sealedTrafficAccessToken ? { sealedTrafficAccessToken } : {}),
        });
        yield* sql`UPDATE relay_thread_vm_restores SET boot_receipt=${sql.json(receipt)},phase=${row.phase === "aborting" ? "aborting" : ["booted", "importing"].includes(row.phase) ? row.phase : "bootstrapping"} WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const admitIngressRecovery = Effect.fn("relay.thread_vm.restore.admit_ingress")(function* (
    claim: ThreadVmRestoreClaim,
    sandboxId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim),
          reservation = yield* capacity.get(row.operationId);
        if (
          !["bootstrapping", "booted", "importing"].includes(row.phase) ||
          row.bootReceipt?.sandboxId !== sandboxId ||
          reservation?.state !== "started" ||
          reservation.computeRef !== sandboxId ||
          reservation.hostId !== row.hostId
        )
          return yield* conflict(
            "Native ingress recovery no longer owns this exact boot and capacity.",
          );
        return row;
      }),
    );
  });
  const beginIngressRecovery = Effect.fn("relay.thread_vm.restore.begin_ingress")(function* (
    claim: ThreadVmRestoreClaim,
    sandboxId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* admitIngressRecovery(claim, sandboxId);
        yield* sql`UPDATE relay_thread_vm_restores SET boot_ingress_recovery_claim_id=${claim.claimId} WHERE operation_id=${row.operationId}`;
        yield* sql`UPDATE relay_thread_vm_allocations SET sealed_traffic_access_token=NULL WHERE allocation_id=${row.allocationId} AND compute_ref=${sandboxId}`;
        return row;
      }),
    );
  });
  // An acknowledged old call may settle after its worker lease expires; it may not publish ownership.
  const settleIngressRecovery = Effect.fn("relay.thread_vm.restore.settle_ingress")(function* (
    claim: ThreadVmRestoreClaim,
    sandboxId: string,
  ) {
    const [settled] =
      yield* sql`UPDATE relay_thread_vm_restores SET boot_ingress_recovery_claim_id=NULL
      WHERE operation_id=${claim.operationId} AND boot_ingress_recovery_claim_id=${claim.claimId}
        AND boot_receipt->>'sandboxId'=${sandboxId} RETURNING operation_id`;
    if (!settled) return yield* conflict("The native ingress attempt identity changed.");
  });
  const recordBootstrap = Effect.fn("relay.thread_vm.restore.bootstrap")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: ThreadVmWarmRestoreBootstrapReceipt,
  ) {
    receipt = yield* decodeBootstrap(receipt).pipe(
      Effect.mapError(() => conflict("Trusted bootstrap receipt is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim),
          source = yield* restores.requireRecovery(row);
        if (
          row.phase !== "bootstrapping" ||
          !row.bootReceipt ||
          !row.targetGeneration ||
          receipt.kind !== "native-warm-restore-bootstrap-v1" ||
          receipt.boot.operationId !== row.operationId ||
          receipt.boot.allocationId !== row.allocationId ||
          receipt.boot.threadId !== row.threadId ||
          receipt.boot.generation !== row.targetGeneration ||
          receipt.source.allocationId !== source.allocationId ||
          receipt.source.operationId !== source.source.provisionOperationId ||
          receipt.source.threadId !== source.threadId ||
          receipt.source.generation !== source.generation ||
          receipt.source.bootId !== source.source.bootId ||
          receipt.source.captureOperationId !== source.source.captureOperationId ||
          receipt.source.sealEpoch !== source.source.sealEpoch ||
          receipt.targetSealEpoch !== source.source.sealEpoch + 1 ||
          !receipt.coordinatorStopped ||
          !receipt.sealRebound
        )
          return yield* conflict(
            "Trusted bootstrap does not bind this source and committed destination.",
          );
        const [token] =
          yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} AND compute_ref=${row.bootReceipt.sandboxId} AND state='running' AND deleted_at IS NULL AND sealed_traffic_access_token IS NOT NULL FOR UPDATE`;
        if (!token) return yield* conflict("Native boot has no private ingress credential.");
        if (row.workflowCheckpoint) {
          const [provision] =
            yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase,workflow_snapshot)
            SELECT ${row.allocationId},${row.operationId},${row.targetGeneration},'created',p.workflow_snapshot
            FROM relay_thread_vm_provisions p JOIN relay_thread_vm_allocations a USING(allocation_id)
            WHERE p.allocation_id=${source.allocationId} AND p.operation_id=${source.source.provisionOperationId}
              AND p.generation=${source.generation} AND p.workflow_snapshot IS NOT NULL
              AND a.thread_id=${row.threadId} AND a.resource_kind='organization_workflow'
            RETURNING allocation_id`;
          if (!provision)
            return yield* conflict("The frozen workflow provision snapshot is missing.");
        } else {
          yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES(${row.allocationId},${row.operationId},${row.targetGeneration},'created')`;
        }
        yield* sql`UPDATE relay_thread_vm_restores SET phase='booted',bootstrap_receipt=${sql.json(receipt)},claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const beginBootRecovery = Effect.fn("relay.thread_vm.restore.begin_boot_recovery")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        if (
          !row.servingCommitted ||
          !row.bootReceipt ||
          row.bootIngressRecoveryClaimId ||
          !["bootstrapping", "booted", "importing", "aborting"].includes(row.phase)
        )
          return yield* conflict("The boot is unknown or has an unsettled ingress attempt.");
        yield* sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE allocation_id=${row.allocationId} FOR UPDATE`;
        // Activation takes the same placement lock. Its completed phase wins;
        // every still-held destination is unactivated and may retire only its own identity.
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          WHERE credential_id IN(SELECT credential_id FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId}
            UNION SELECT credential_id FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId} AND credential_id IS NOT NULL)`;
        yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE allocation_id=${row.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_restores SET boot_recovery_started_at=COALESCE(boot_recovery_started_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const retryStoppedBoot = Effect.fn("relay.thread_vm.restore.retry_deleted_boot")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: NativeThreadVmRestoreDeletedBootReceipt,
  ) {
    const decoded = yield* decodeDeleted(receipt).pipe(
      Effect.mapError(() => conflict("Native deletion acknowledgement is invalid.")),
    );
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim),
          boot = row.bootReceipt;
        if (
          !row.bootRecoveryStarted ||
          row.bootIngressRecoveryClaimId ||
          !boot ||
          decoded.operationId !== row.operationId ||
          decoded.allocationId !== row.allocationId ||
          decoded.threadId !== row.threadId ||
          decoded.generation !== row.targetGeneration ||
          decoded.bootAttempt !== row.bootAttempt ||
          decoded.sandboxId !== boot.sandboxId ||
          decoded.sourceTemplateId !== row.sourceTemplateId ||
          decoded.sourceBuildId !== row.sourceBuildId
        )
          return yield* conflict("Native deletion acknowledgement belongs to another boot.");
        const [liveIdentity] =
          yield* sql`SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials k USING(credential_id)
          WHERE b.allocation_id=${row.allocationId} AND (b.revoked_at IS NULL OR k.revoked_at IS NULL)`;
        if (liveIdentity)
          return yield* conflict("The failed destination identity has not been revoked.");
        yield* sql`DELETE FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId}`;
        yield* sql`DELETE FROM relay_thread_vm_setups WHERE allocation_id=${row.allocationId}`;
        yield* sql`DELETE FROM relay_thread_vm_leases WHERE allocation_id=${row.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_activity SET revision=revision+1,activity='unknown',observed_at=NULL,idle_since=NULL,
          inactive_work_ids='[]'::jsonb,pause_due_at=NULL,delete_due_at=NULL,deadline_idle_since=NULL,deadline_policy_revision=NULL,
          deadline_time_zone=NULL,lifecycle_checked_at=NULL,last_work_at=clock_timestamp() WHERE allocation_id=${row.allocationId}`;
        yield* sql`DELETE FROM relay_thread_vm_enrollments WHERE allocation_id=${row.allocationId}`;
        yield* sql`DELETE FROM relay_thread_vm_provisions WHERE allocation_id=${row.allocationId}`;
        const allocation =
          yield* sql`UPDATE relay_thread_vm_allocations SET state='creating',compute_ref=NULL,sealed_traffic_access_token=NULL,native_paused_generation=NULL
          WHERE allocation_id=${row.allocationId} AND compute_ref=${decoded.sandboxId} AND state='running' AND deleted_at IS NULL RETURNING allocation_id`;
        const reservation =
          yield* sql`UPDATE relay_thread_vm_capacity SET compute_ref=NULL WHERE operation_id=${row.operationId} AND state='started' AND compute_ref=${decoded.sandboxId} RETURNING operation_id`;
        if (!allocation.length || !reservation.length)
          return yield* conflict("The failed target allocation or capacity changed before retry.");
        yield* sql`UPDATE relay_thread_vm_restores SET phase=${row.phase === "aborting" ? "aborting" : "committed"},boot_attempt=boot_attempt+1,
        boot_create_started_at=NULL,boot_receipt=NULL,bootstrap_receipt=NULL,boot_recovery_started_at=NULL,import_receipt=NULL,identity_cleaned_at=NULL,
        retired_boot_receipts=retired_boot_receipts || ${sql.json([decoded])},claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET environment_id=${`pending-restore:${row.allocationId}`},project_id=${`vm:${row.threadId}`}
          WHERE thread_id=${row.threadId} AND operation_id=${row.operationId} AND generation=${row.targetGeneration}`;
        return (yield* restores.get(row.operationId))!;
      }),
    );
  });
  const completeCommittedAbort = Effect.fn("relay.thread_vm.restore.complete_committed_abort")(
    function* (claim: ThreadVmRestoreClaim) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* restores.requireClaim(claim);
          if (
            row.phase !== "aborting" ||
            !row.servingCommitted ||
            !row.targetGeneration ||
            row.bootReceipt ||
            row.bootCreateStarted ||
            row.bootIngressRecoveryClaimId ||
            !row.savedDiskOperationId
          )
            return yield* conflict("The committed cancellation still has an unsettled target.");
          const resourceKind = row.workflowCheckpoint ? "organization_workflow" : "personal";
          yield* allocations.requestDeletion(row.allocationId, resourceKind);
          yield* sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE operation_id=${row.operationId} AND state='started' AND compute_ref IS NULL`;
          yield* allocations.confirmDeleted({
            allocationId: row.allocationId,
            computeRef: null,
            resourceKind,
          });
          yield* makeThreadVmSavedDiskStore(sql).cancelCommittedRestore({
            threadId: row.threadId,
            savedDiskOperationId: row.savedDiskOperationId,
            operationId: row.operationId,
            targetGeneration: row.targetGeneration,
          });
          if (row.nativeCheckpointOperationId)
            yield* makeThreadNativeCheckpointStore(sql, objects).releaseOperation(row);
          yield* sql`UPDATE relay_thread_vm_restores SET phase='aborted',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${row.operationId}`;
        }),
      );
    },
  );
  const confirmStillActive = Effect.fn("relay.thread_vm.restore.confirm_still_active")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* restores.requireClaim(claim);
        yield* sql`UPDATE relay_thread_vm_restores SET claim_id=NULL,claim_until=NULL,error_code=NULL,
          retry_at=clock_timestamp()+CASE WHEN ${row.enrollmentIssued || row.phase === "importing"} THEN interval '0 seconds' ELSE interval '1 minute' END
          WHERE operation_id=${claim.operationId}`;
      }),
    );
  });
  return {
    claim,
    authorize,
    commit,
    beginCreate,
    recordObserved,
    admitIngressRecovery,
    beginIngressRecovery,
    settleIngressRecovery,
    recordBootstrap,
    beginBootRecovery,
    retryStoppedBoot,
    completeCommittedAbort,
    confirmStillActive,
  };
}
