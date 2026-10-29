import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { releaseThreadNativeCheckpointOperation } from "./ThreadNativeCheckpointStore.ts";
import type { ThreadVmCaptureSourceReceipt } from "../machines/E2BNativeSnapshotReceipt.ts";

export class ThreadVmResumeConflict extends Schema.TaggedError<ThreadVmResumeConflict>()(
  "ThreadVmResumeConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmResumeConflict({ message });
const operationId = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

interface ResumeRecord {
  readonly operationId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly phase: "waiting" | "resuming" | "completed";
}
export interface ResumeClaim extends ResumeRecord {
  readonly claimId: string;
  readonly threadId: string;
  readonly repositoryId: string;
  readonly computeRef: string;
  readonly templateId: string;
  readonly provisionOperationId: string;
  readonly pauseOperationId: string | null;
  readonly finalSaveOperationId: string | null;
  readonly capacityState: "reserved" | "started";
  readonly hostId: string;
}

/** Power may return under a cleaned-up final save's hold; execution still waits
 * for its guest activation acknowledgement. Queries use placement t/allocation a. */
export const threadVmResumePlacement = (sql: PgClient) => sql`(t.operation_id IS NULL OR EXISTS(
  SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.operation_id=t.operation_id
    AND f.thread_id=t.thread_id AND f.generation=t.generation AND f.environment_id=t.environment_id
    AND f.allocation_id=a.allocation_id AND f.compute_ref=a.compute_ref
    AND f.original_state='running' AND f.phase='aborted'))`;

/** Explicit wake reserves the same allocation and waits for physical host capacity. */
export function makeThreadVmResumeStore(sql: PgClient) {
  /** Only an exact, non-waking native inspection may call this. A timeout
   * releases power capacity without inventing a frozen conversation checkpoint. */
  const reconcileNativePause = Effect.fn("relay.thread_vm.resume.reconcile_native_pause")(
    function* (input: {
      readonly allocationId: string;
      readonly computeRef: string;
      readonly threadId: string;
      readonly generation: number;
      readonly operationId: string;
      readonly hostId: string;
      readonly capacityOperationId: string;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements
            WHERE thread_id=${input.threadId} FOR UPDATE`;
          const [current] = yield* sql<{
            environmentId: string;
          }>`SELECT t.environment_id AS "environmentId" FROM relay_thread_vm_allocations a
            JOIN relay_thread_vm_bindings b USING(allocation_id)
            JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
            JOIN relay_thread_vm_provisions p USING(allocation_id)
            JOIN relay_thread_placements t ON t.thread_id=a.thread_id
            JOIN relay_thread_vm_capacity c ON c.allocation_id=a.allocation_id
            WHERE a.runtime_protocol='native-v1' AND a.allocation_id=${input.allocationId} AND a.compute_ref=${input.computeRef}
              AND a.thread_id=${input.threadId} AND a.state='running' AND a.deleted_at IS NULL
              AND t.generation=${input.generation} AND ${threadVmResumePlacement(sql)}
              AND t.owner_user_id=a.owner_user_id AND t.environment_id=b.environment_id
              AND b.generation=t.generation AND b.revoked_at IS NULL AND k.revoked_at IS NULL
              AND p.operation_id=${input.operationId} AND p.generation=t.generation AND p.phase='created' AND p.ingress_recovery_claim_id IS NULL
              AND c.host_id=${input.hostId} AND c.operation_id=${input.capacityOperationId} AND c.compute_ref=a.compute_ref AND c.state='started'
              AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id
                AND (x.phase='sealed' OR (x.phase='pending' AND x.claim_id IS NOT NULL)))
              AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r WHERE r.allocation_id=a.allocation_id AND r.phase IN ('waiting','resuming'))
              AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id
                AND (x.pause_dispatch_claim_id IS NOT NULL OR (x.phase='pending' AND x.pause_dispatched_at IS NOT NULL)))
            FOR UPDATE OF a,c`;
          if (!current) return false;
          const [pause] = yield* sql<{
            operationId: string;
            phase: string;
            backupOperationId: string | null;
            sourceReceipt: ThreadVmCaptureSourceReceipt | null;
            checkpointOperationId: string | null;
            bootId: string | null;
            sourceFrozen: boolean;
          }>`SELECT operation_id AS "operationId",phase,backup_operation_id AS "backupOperationId",
            source_receipt AS "sourceReceipt",native_checkpoint_operation_id AS "checkpointOperationId",
            boot_id AS "bootId",source_frozen_at IS NOT NULL AS "sourceFrozen"
            FROM relay_thread_vm_pauses WHERE allocation_id=${input.allocationId}
              AND generation=${input.generation} FOR UPDATE`;
          const backups = yield* sql<{
            operationId: string;
            phase: string;
            sourceReceipt: ThreadVmCaptureSourceReceipt | null;
            unissued: boolean;
          }>`SELECT x.operation_id AS "operationId",x.phase,x.source_receipt AS "sourceReceipt",
            (x.capture_started_at IS NULL AND x.snapshot_id IS NULL AND x.source_template_id IS NULL
              AND x.source_build_id IS NULL AND x.probe_receipt IS NULL AND x.native_capture_receipt IS NULL) AS unissued
            FROM relay_thread_vm_backups x WHERE x.allocation_id=${input.allocationId}
              AND x.generation=${input.generation} AND x.compute_ref=${input.computeRef}
              AND (x.phase IN ('pending','creating','captured','verifying','cleanup')
                OR (x.source_reopened_at IS NULL AND (x.source_receipt IS NOT NULL OR (x.phase='failed' AND x.capture_started_at IS NULL))))
              AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=x.operation_id)
            FOR UPDATE`;
          for (const backup of backups) {
            if (["creating", "captured", "verifying", "cleanup"].includes(backup.phase))
              return false;
            const receipt = backup.sourceReceipt,
              captureOperationId =
                pause?.backupOperationId === backup.operationId
                  ? pause.operationId
                  : backup.operationId;
            if (
              receipt &&
              (receipt.allocationId !== input.allocationId ||
                receipt.computeRef !== input.computeRef ||
                receipt.threadId !== input.threadId ||
                receipt.generation !== input.generation ||
                receipt.environmentId !== current.environmentId ||
                receipt.provisionOperationId !== input.operationId ||
                receipt.captureOperationId !== captureOperationId)
            )
              return false;
            if (backup.phase === "pending" && !backup.unissued) return false;
          }
          if (pause?.phase === "pending" && pause.checkpointOperationId) {
            const backup = backups.find((row) => row.operationId === pause.backupOperationId);
            if (
              !backup ||
              backup.phase !== "pending" ||
              !backup.unissued ||
              !pause.sourceReceipt ||
              pause.sourceReceipt.nativeCheckpointOperationId !== pause.checkpointOperationId ||
              pause.sourceReceipt.bootId !== pause.bootId ||
              !pause.sourceFrozen
            )
              return false;
            const pins =
              yield* sql`SELECT operation_id FROM relay_thread_native_checkpoint_operations
              WHERE operation_id IN (${pause.operationId},${backup.operationId})
                AND checkpoint_operation_id=${pause.checkpointOperationId} AND phase='active'
                AND EXISTS(SELECT 1 FROM relay_thread_vm_backups x JOIN relay_thread_vm_pauses p ON p.backup_operation_id=x.operation_id
                  WHERE x.operation_id=${backup.operationId} AND p.operation_id=${pause.operationId}
                    AND p.source_receipt=x.source_receipt)`;
            if (pins.length !== 2) return false;
          } else if (
            pause?.phase === "pending" &&
            (pause.backupOperationId || pause.sourceReceipt || pause.bootId || pause.sourceFrozen)
          )
            return false;
          // A write-ahead candidate has no native side effect to reconcile.
          // Keep the generic source pin until its real activation acknowledgement.
          for (const backup of backups) {
            if (backup.phase !== "pending") continue;
            const pauseOwned = backup.operationId === pause?.backupOperationId;
            yield* sql`UPDATE relay_thread_vm_backups SET phase=${pauseOwned ? "retired" : "failed"},claim_id=NULL,claim_until=NULL
              WHERE operation_id=${backup.operationId} AND phase='pending' AND capture_started_at IS NULL`;
            if (pauseOwned)
              yield* releaseThreadNativeCheckpointOperation(sql, {
                threadId: input.threadId,
                operationId: backup.operationId,
              });
          }
          // The guest may already own this drain even before publishing its
          // checkpoint. Keep its identity and delivery hold until resumed ack.
          yield* sql`UPDATE relay_thread_vm_pauses SET phase='cancelled',claim_id=NULL,claim_until=NULL
            WHERE allocation_id=${input.allocationId} AND generation=${input.generation} AND phase='pending'
              AND claim_id IS NULL AND pause_dispatched_at IS NULL AND pause_dispatch_claim_id IS NULL`;
          yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',native_paused_generation=${input.generation}
            WHERE allocation_id=${input.allocationId}`;
          yield* sql`UPDATE relay_thread_vm_capacity SET state='released'
            WHERE operation_id=${input.capacityOperationId} AND allocation_id=${input.allocationId} AND compute_ref=${input.computeRef} AND state='started'`;
          yield* sql`UPDATE relay_thread_vm_activity SET revision=revision+1,activity='unknown',observed_at=NULL,
            idle_since=NULL,pause_due_at=NULL,delete_due_at=NULL WHERE allocation_id=${input.allocationId}`;
          return true;
        }),
      );
    },
  );
  const get = Effect.fn("relay.thread_vm.resume.get")(function* (allocationId: string) {
    const [row] = yield* sql<ResumeRecord>`SELECT operation_id AS "operationId",
      allocation_id AS "allocationId", generation, phase
      FROM relay_thread_vm_resumes WHERE allocation_id = ${allocationId}`;
    return row ?? null;
  });
  const request = Effect.fn("relay.thread_vm.resume.request")(function* (threadId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{ generation: number; operationId: string | null }>`
        SELECT generation, operation_id AS "operationId" FROM relay_thread_placements
        WHERE thread_id = ${threadId} FOR UPDATE`;
        if (!placement) return yield* conflict("Thread placement is unavailable for wake");
        const [allocation] = yield* sql<{
          allocationId: string;
          state: string;
          computeRef: string;
          nativePausedGeneration: number | null;
          runtimeProtocol: string;
        }>`
        SELECT allocation_id AS "allocationId", state, compute_ref AS "computeRef",
          native_paused_generation AS "nativePausedGeneration",runtime_protocol AS "runtimeProtocol"
        FROM relay_thread_vm_allocations WHERE thread_id = ${threadId}
          AND deleted_at IS NULL FOR UPDATE`;
        if (allocation && allocation.runtimeProtocol !== "native-v1")
          return yield* conflict(
            "This VM belongs to an earlier runtime and requires manual migration.",
          );
        if (!allocation || allocation.state !== "paused" || !allocation.computeRef)
          return yield* conflict("VM is not paused");
        const [placementReady] = yield* sql`SELECT 1 FROM relay_thread_placements t
          JOIN relay_thread_vm_allocations a ON a.allocation_id=${allocation.allocationId} AND a.thread_id=t.thread_id
          WHERE t.thread_id=${threadId} AND ${threadVmResumePlacement(sql)}`;
        if (!placementReady) return yield* conflict("Thread placement is unavailable for wake");
        const [binding] = yield* sql`SELECT 1 FROM relay_thread_vm_bindings b
        JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
        WHERE b.allocation_id = ${allocation.allocationId}
          AND b.generation = ${placement.generation} AND b.revoked_at IS NULL AND k.revoked_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=b.allocation_id AND x.pause_dispatch_claim_id IS NOT NULL)`;
        const [pause] = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
        WHERE allocation_id = ${allocation.allocationId} AND phase = 'completed' AND generation=${placement.generation}`;
        if (!binding || (!pause && allocation.nativePausedGeneration !== placement.generation))
          return yield* conflict("VM pause has not been confirmed");
        const prior = yield* get(allocation.allocationId);
        if (prior?.phase !== "completed" && prior) return prior;
        const [host] = yield* sql<{ hostId: string }>`SELECT host_id AS "hostId"
        FROM relay_thread_vm_capacity WHERE allocation_id = ${allocation.allocationId}
        ORDER BY position DESC LIMIT 1`;
        if (!host) return yield* conflict("VM host is unknown");
        const newOperationId = operationId();
        yield* sql`INSERT INTO relay_thread_vm_resumes (allocation_id, operation_id, generation, phase)
        VALUES (${allocation.allocationId}, ${newOperationId}, ${placement.generation}, 'waiting')
        ON CONFLICT (allocation_id) DO UPDATE SET operation_id = excluded.operation_id,
          generation = excluded.generation, phase = 'waiting', claim_id = NULL,
          claim_until = NULL, connect_claim_id = NULL, retry_at = clock_timestamp()
        WHERE relay_thread_vm_resumes.phase = 'completed'`;
        yield* makeThreadVmCapacityStore(sql).request({
          operationId: newOperationId,
          allocationId: allocation.allocationId,
          hostId: host.hostId,
          kind: "resume",
        });
        return (yield* get(allocation.allocationId))!;
      }),
    );
  });

  const claim = Effect.fn("relay.thread_vm.resume.claim")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<Omit<ResumeClaim, "claimId">>`
        SELECT r.operation_id AS "operationId", r.allocation_id AS "allocationId",
          r.generation, r.phase, a.thread_id AS "threadId",
          b.repository_id AS "repositoryId", a.compute_ref AS "computeRef", a.template_id AS "templateId",
          p.operation_id AS "provisionOperationId",final.operation_id AS "finalSaveOperationId",
          CASE WHEN x.phase IN ('cancelled','completed') AND x.source_reopened_at IS NULL THEN x.operation_id
            WHEN generic.operation_id IS NOT NULL THEN generic.operation_id
            WHEN a.native_paused_generation=r.generation THEN NULL ELSE x.operation_id END AS "pauseOperationId",
          c.state AS "capacityState",c.host_id AS "hostId"
        FROM relay_thread_vm_resumes r
        JOIN relay_thread_vm_allocations a ON a.allocation_id = r.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id = r.allocation_id
        LEFT JOIN relay_thread_vm_pauses x ON x.allocation_id = r.allocation_id AND x.generation=r.generation
        JOIN relay_thread_vm_capacity c ON c.operation_id = r.operation_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id = r.allocation_id
          AND b.generation = r.generation AND b.revoked_at IS NULL
        JOIN relay_environment_credentials k ON k.credential_id=b.credential_id AND k.revoked_at IS NULL
        JOIN relay_thread_placements t ON t.thread_id = a.thread_id
        LEFT JOIN LATERAL(SELECT z.operation_id FROM relay_thread_vm_backups z
          WHERE z.allocation_id=a.allocation_id AND z.generation=t.generation AND z.compute_ref=a.compute_ref
            AND z.source_reopened_at IS NULL AND z.phase IN ('verified','failed','retiring','retired')
            AND (z.source_receipt @> jsonb_build_object('allocationId',a.allocation_id,'computeRef',a.compute_ref,
                'threadId',t.thread_id,'generation',t.generation,'environmentId',t.environment_id,
                'provisionOperationId',p.operation_id,'captureOperationId',z.operation_id)
              OR (z.source_receipt IS NULL AND z.phase='failed' AND z.capture_started_at IS NULL
                AND z.snapshot_id IS NULL AND z.source_template_id IS NULL AND z.source_build_id IS NULL
                AND z.probe_receipt IS NULL AND z.native_capture_receipt IS NULL))
            AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f WHERE f.backup_operation_id=z.operation_id)
            AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses p WHERE p.backup_operation_id=z.operation_id)
          ORDER BY z.created_at DESC,z.operation_id DESC LIMIT 1) generic ON true
        LEFT JOIN LATERAL(SELECT f.operation_id FROM relay_thread_vm_final_saves f
          WHERE f.allocation_id=a.allocation_id AND f.compute_ref=a.compute_ref AND f.thread_id=t.thread_id
            AND f.generation=t.generation AND f.environment_id=t.environment_id
            AND f.original_state='running' AND f.phase='aborted'
            AND (t.operation_id=f.operation_id OR (t.operation_id IS NULL AND EXISTS(
              SELECT 1 FROM relay_thread_vm_backups z WHERE z.operation_id=f.backup_operation_id
                AND z.source_receipt IS NOT NULL AND z.source_reopened_at IS NULL)))
          ORDER BY f.completed_at DESC,f.operation_id LIMIT 1) final ON true
        WHERE a.runtime_protocol='native-v1' AND c.host_id = ${hostId} AND r.phase IN ('waiting','resuming')
          AND c.state IN ('reserved','started') AND a.state IN ('paused','running')
          AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
          AND (a.native_paused_generation=r.generation OR (x.phase='completed' AND x.generation=r.generation))
          AND t.generation = r.generation AND t.environment_id = b.environment_id
          AND t.owner_user_id=a.owner_user_id
          AND ${threadVmResumePlacement(sql)} AND r.retry_at <= clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id AND x.pause_dispatch_claim_id IS NOT NULL)
          AND r.connect_claim_id IS NULL AND p.ingress_recovery_claim_id IS NULL
          AND (r.claim_until IS NULL OR r.claim_until <= clock_timestamp())
        ORDER BY c.position LIMIT 1 FOR UPDATE OF r SKIP LOCKED`;
        if (!row) return null;
        const claimId = operationId();
        yield* sql`UPDATE relay_thread_vm_resumes SET claim_id = ${claimId},
        claim_until = clock_timestamp() + interval '2 minutes'
        WHERE allocation_id = ${row.allocationId}`;
        return { ...row, claimId } satisfies ResumeClaim;
      }),
    );
  });
  const requireCurrent = Effect.fnUntraced(function* (claim: ResumeClaim) {
    const [current] = yield* sql<{ role: string; userId: string; organizationId: string }>`
      SELECT m.role,m.user_id AS "userId",m.organization_id AS "organizationId" FROM relay_thread_placements t
      JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id
      JOIN relay_thread_vm_bindings b USING(allocation_id)
      JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
      JOIN relay_thread_vm_provisions p USING(allocation_id)
      JOIN relay_organization_members m ON m.organization_id=t.organization_id AND m.user_id=t.owner_user_id
      JOIN relay_repositories repo ON repo.repository_id=t.repository_id AND repo.organization_id=t.organization_id
      WHERE a.runtime_protocol='native-v1' AND t.thread_id=${claim.threadId} AND t.generation=${claim.generation}
        AND (t.operation_id IS NULL OR t.operation_id=${claim.finalSaveOperationId}) AND ${threadVmResumePlacement(sql)}
        AND a.allocation_id=${claim.allocationId} AND a.compute_ref=${claim.computeRef} AND a.deleted_at IS NULL
        AND a.state IN ('paused','running') AND a.template_id=${claim.templateId}
        AND t.owner_user_id=a.owner_user_id AND b.environment_id=t.environment_id AND b.generation=t.generation
        AND b.repository_id=t.repository_id
        AND b.revoked_at IS NULL AND k.revoked_at IS NULL
        AND p.operation_id=${claim.provisionOperationId} AND p.generation=t.generation AND p.phase='created'
        AND p.ingress_recovery_claim_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses x WHERE x.allocation_id=a.allocation_id AND x.pause_dispatch_claim_id IS NOT NULL)
        AND (m.role='admin' OR EXISTS(SELECT 1 FROM relay_repository_access grant_access
          WHERE grant_access.repository_id=t.repository_id AND grant_access.organization_id=t.organization_id
            AND grant_access.user_id=t.owner_user_id))
      FOR UPDATE OF t,a FOR SHARE OF m,repo`;
    if (!current) return yield* conflict("Resume ownership or credentials changed.");
    if (current.role !== "admin") {
      const [grant] = yield* sql`SELECT 1 FROM relay_repository_access
        WHERE repository_id=${claim.repositoryId} AND user_id=${current.userId}
          AND organization_id=${current.organizationId} FOR SHARE`;
      if (!grant) return yield* conflict("The resume owner no longer has repository access.");
    }
  });
  const requireActive = Effect.fnUntraced(function* (claim: ResumeClaim) {
    yield* requireCurrent(claim);
    const [row] = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
      WHERE allocation_id=${claim.allocationId} AND operation_id=${claim.operationId} AND generation=${claim.generation}
        AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()
        AND phase IN ('waiting','resuming') AND connect_claim_id IS NULL FOR UPDATE`;
    const [capacity] = yield* sql`SELECT 1 FROM relay_thread_vm_capacity
      WHERE operation_id=${claim.operationId} AND allocation_id=${claim.allocationId}
        AND host_id=${claim.hostId} AND state='started' AND compute_ref=${claim.computeRef} FOR UPDATE`;
    if (!row || !capacity) return yield* conflict("Resume claim or execution capacity changed.");
  });
  const begin = Effect.fn("relay.thread_vm.resume.begin")(function* (claim: ResumeClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireCurrent(claim);
        if (claim.capacityState === "reserved")
          yield* makeThreadVmCapacityStore(sql).beginExecution(claim.operationId);
        yield* requireActive(claim);
        yield* sql`UPDATE relay_thread_vm_resumes SET phase = 'resuming'
        WHERE allocation_id = ${claim.allocationId}`;
      }),
    );
  });
  const beginConnect = Effect.fn("relay.thread_vm.resume.begin_connect")(function* (
    claim: ResumeClaim,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireActive(claim);
        const rows = yield* sql`UPDATE relay_thread_vm_resumes SET connect_claim_id=${claim.claimId}
        WHERE allocation_id=${claim.allocationId} AND operation_id=${claim.operationId} AND phase='resuming'
        AND connect_claim_id IS NULL RETURNING allocation_id`;
        if (rows.length !== 1) return yield* conflict("Native resume was already dispatched.");
        // Connect may rotate the native routing token. A late acknowledgement
        // must not leave the next claim able to reuse the old execution's token.
        yield* sql`UPDATE relay_thread_vm_allocations SET sealed_traffic_access_token=NULL
          WHERE allocation_id=${claim.allocationId} AND compute_ref=${claim.computeRef}`;
      }),
    );
  });
  /** Settlement records an exact transport result, even after its admission claim expired. */
  const settleConnect = Effect.fn("relay.thread_vm.resume.settle_connect")(function* (
    claim: ResumeClaim,
  ) {
    const rows = yield* sql`UPDATE relay_thread_vm_resumes r SET connect_claim_id=NULL
      WHERE r.allocation_id=${claim.allocationId} AND r.operation_id=${claim.operationId}
        AND r.generation=${claim.generation} AND r.connect_claim_id=${claim.claimId}
        AND EXISTS(SELECT 1 FROM relay_thread_vm_allocations a
          WHERE a.runtime_protocol='native-v1' AND a.allocation_id=r.allocation_id AND a.thread_id=${claim.threadId} AND a.compute_ref=${claim.computeRef})
      RETURNING r.allocation_id`;
    return rows.length === 1;
  });
  const finishPower = Effect.fn("relay.thread_vm.resume.finish_power")(function* (
    claim: ResumeClaim,
    sealedTrafficAccessToken: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireActive(claim);
        if (!sealedTrafficAccessToken.trim())
          return yield* conflict("Private ingress is unavailable.");
        const [allocation] = yield* sql<{ state: string; computeRef: string }>`
        SELECT state, compute_ref AS "computeRef" FROM relay_thread_vm_allocations
        WHERE allocation_id = ${claim.allocationId} FOR UPDATE`;
        const [resume] = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
        WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
          AND claim_id = ${claim.claimId} AND claim_until > clock_timestamp()
          AND phase = 'resuming' AND connect_claim_id IS NULL FOR UPDATE`;
        const [capacity] = yield* sql`SELECT 1 FROM relay_thread_vm_capacity
        WHERE operation_id = ${claim.operationId} AND allocation_id = ${claim.allocationId}
          AND state = 'started' AND compute_ref = ${claim.computeRef} FOR UPDATE`;
        if (
          !resume ||
          !capacity ||
          allocation?.computeRef !== claim.computeRef ||
          !["paused", "running"].includes(allocation.state)
        )
          return false;
        yield* sql`UPDATE relay_thread_vm_allocations SET state = 'running',sealed_traffic_access_token=${sealedTrafficAccessToken}
        WHERE allocation_id = ${claim.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_activity SET revision = revision + 1,
        activity = 'unknown', observed_at = NULL, idle_since = NULL,
        last_work_at = clock_timestamp() WHERE allocation_id = ${claim.allocationId}`;
        return true;
      }),
    );
  });
  const complete = Effect.fn("relay.thread_vm.resume.complete")(function* (claim: ResumeClaim) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireActive(claim);
        const rows = yield* sql`UPDATE relay_thread_vm_resumes r SET phase = 'completed',
      claim_id = NULL, claim_until = NULL FROM relay_thread_vm_allocations a
      WHERE a.runtime_protocol='native-v1' AND r.allocation_id = ${claim.allocationId} AND r.operation_id = ${claim.operationId}
        AND r.claim_id = ${claim.claimId} AND r.claim_until > clock_timestamp()
        AND r.phase = 'resuming' AND r.connect_claim_id IS NULL AND a.allocation_id = r.allocation_id
        AND a.state = 'running' AND a.compute_ref = ${claim.computeRef}
      RETURNING r.allocation_id`;
        if (rows.length === 1)
          yield* sql`UPDATE relay_thread_vm_allocations SET native_paused_generation=NULL
        WHERE allocation_id=${claim.allocationId}`;
        return rows.length === 1;
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.resume.defer")(function* (claim: ResumeClaim) {
    yield* sql`UPDATE relay_thread_vm_resumes SET claim_id = NULL, claim_until = NULL,
      retry_at = clock_timestamp() + interval '1 minute'
      WHERE allocation_id = ${claim.allocationId} AND operation_id = ${claim.operationId}
        AND claim_id = ${claim.claimId} AND phase IN ('waiting','resuming')`;
  });
  return {
    get,
    request,
    claim,
    begin,
    beginConnect,
    settleConnect,
    finishPower,
    complete,
    defer,
    reconcileNativePause,
  };
}
