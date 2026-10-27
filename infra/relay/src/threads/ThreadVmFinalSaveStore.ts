import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { E2BBackupColdProof } from "../machines/E2BRestoreClient.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { idleDeadlines, makeThreadVmPolicyStore, lockThreadVmPolicy } from "./ThreadVmPolicy.ts";

export class ThreadVmFinalSaveConflict extends Schema.TaggedError<ThreadVmFinalSaveConflict>()(
  "ThreadVmFinalSaveConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmFinalSaveConflict({ message });
const decodeColdProof = Schema.decodeUnknownEffect(E2BBackupColdProof);
const decodeOperationId = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)),
);
export interface FinalSave {
  readonly operationId: string;
  readonly threadId: string;
  readonly allocationId: string;
  readonly actorUserId: string;
  readonly environmentId: string;
  readonly generation: number;
  readonly hostId: string;
  readonly computeRef: string;
  readonly originalState: "running" | "paused";
  readonly reason: "idle" | "replacement";
  readonly activityRevision: number;
  readonly idleSince: string;
  readonly sourceSequence: number | null;
  readonly nativeCheckpointOperationId: string | null;
  readonly backupOperationId: string | null;
  readonly errorCode: string | null;
  readonly physicalDeleteStartedAt: string | null;
  readonly abortProbeStoppedAt: string | null;
  readonly phase:
    | "draining"
    | "frozen"
    | "saving"
    | "deleting"
    | "completed"
    | "aborting"
    | "aborted";
}

/** Internal protocol: a source acknowledgement and independent checkpoints must precede a new final disk capture. */
export function makeThreadVmFinalSaveStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects);
  const backups = makeThreadVmBackupRetentionStore(sql);
  const get = Effect.fn("relay.thread_vm.final_save.get")(function* (operationId: string) {
    const [row] =
      yield* sql<FinalSave>`SELECT operation_id AS "operationId", thread_id AS "threadId",
      allocation_id AS "allocationId", actor_user_id AS "actorUserId",environment_id AS "environmentId",
      generation, host_id AS "hostId",compute_ref AS "computeRef",original_state AS "originalState", reason,
      activity_revision AS "activityRevision",to_char(idle_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "idleSince",
      source_sequence AS "sourceSequence",native_checkpoint_operation_id AS "nativeCheckpointOperationId",
      backup_operation_id AS "backupOperationId",error_code AS "errorCode",
      to_char(physical_delete_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "physicalDeleteStartedAt",
      to_char(abort_probe_stopped_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "abortProbeStoppedAt",phase FROM relay_thread_vm_final_saves WHERE operation_id=${operationId}`;
    return row ?? null;
  });
  const lock = Effect.fnUntraced(function* (operationId: string) {
    const operation = yield* get(operationId);
    if (!operation) return yield* conflict("Final save does not exist.");
    // Admission, moves and disk expiry share this lock order.
    yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${operation.threadId} FOR UPDATE`;
    yield* sql`SELECT operation_id FROM relay_thread_vm_final_saves WHERE operation_id=${operationId} FOR UPDATE`;
    const current = (yield* get(operationId))!;
    if (current.phase !== "completed" && current.phase !== "aborted") {
      const [owned] = yield* sql`SELECT 1 FROM relay_thread_placements t
        JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id
        JOIN relay_thread_vm_bindings b ON b.allocation_id=a.allocation_id
        WHERE t.thread_id=${current.threadId} AND t.operation_id=${operationId}
          AND t.environment_id=${current.environmentId} AND t.generation=${current.generation}
          AND a.allocation_id=${current.allocationId} AND a.compute_ref=${current.computeRef}
          AND a.deleted_at IS NULL AND b.environment_id=t.environment_id AND b.generation=t.generation
          AND b.revoked_at IS NULL FOR UPDATE OF a`;
      if (!owned) return yield* conflict("Final save no longer owns its source allocation.");
    }
    return current;
  });
  const checkDeadline = Effect.fnUntraced(function* (
    operation: Pick<FinalSave, "threadId" | "reason" | "idleSince">,
  ) {
    if (operation.reason !== "idle") return;
    const [placement] = yield* sql<{
      organizationId: string;
    }>`SELECT organization_id AS "organizationId" FROM relay_thread_placements WHERE thread_id=${operation.threadId}`;
    if (!placement) return yield* conflict("Thread policy is unavailable.");
    yield* sql`SELECT organization_id FROM relay_thread_vm_policies WHERE organization_id=${placement.organizationId} FOR SHARE`;
    const { policy } = yield* makeThreadVmPolicyStore(sql).get(placement.organizationId);
    const deadlines = idleDeadlines({
      activity: "idle",
      idleSince: DateTime.makeUnsafe(operation.idleSince),
      policy,
    })!;
    const [now] = yield* sql<{
      at: string;
    }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
    if (
      DateTime.makeUnsafe(now!.at).epochMilliseconds <
      DateTime.makeUnsafe(deadlines.deleteAt).epochMilliseconds
    )
      return yield* conflict("The current inactivity policy does not yet allow deletion.");
  });
  const requireStillIdle = Effect.fnUntraced(function* (operation: FinalSave) {
    const [idle] =
      yield* sql`SELECT 1 FROM relay_thread_vm_allocations a JOIN relay_thread_vm_activity v USING(allocation_id)
      WHERE a.allocation_id=${operation.allocationId} AND a.state=${operation.originalState}
        AND date_trunc('milliseconds',v.idle_since)=${operation.idleSince}::timestamptz
        AND (a.state='paused' OR v.activity='idle')`;
    if (!idle) return yield* conflict("New source activity changed the final-save idle boundary.");
  });
  const begin = Effect.fn("relay.thread_vm.final_save.begin")(function* (input: {
    readonly operationId: string;
    readonly threadId: string;
    readonly allocationId: string;
    readonly actorUserId: string;
    readonly expectedGeneration: number;
    readonly reason: "idle" | "replacement";
  }) {
    yield* decodeOperationId(input.operationId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [placement] = yield* sql<{
          operationId: string | null;
          generation: number;
          ownerUserId: string;
          environmentId: string;
          organizationId: string;
        }>`SELECT
        organization_id AS "organizationId",operation_id AS "operationId",generation,owner_user_id AS "ownerUserId",environment_id AS "environmentId"
        FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const prior = yield* get(input.operationId);
        if (prior) {
          if (
            prior.threadId !== input.threadId ||
            prior.allocationId !== input.allocationId ||
            prior.actorUserId !== input.actorUserId ||
            prior.generation !== input.expectedGeneration ||
            prior.reason !== input.reason
          )
            return yield* conflict("Final save operation identity changed.");
          return prior;
        }
        if (
          !placement ||
          placement.ownerUserId !== input.actorUserId ||
          placement.generation !== input.expectedGeneration ||
          placement.operationId !== null
        )
          return yield* conflict(
            "Only the current private owner can reserve an idle VM for final saving.",
          );
        yield* lockThreadVmPolicy(sql, placement.organizationId);
        const [candidate] = yield* sql<{
          computeRef: string;
          hostId: string;
          state: "running" | "paused";
          revision: number;
          idleSince: string;
        }>`SELECT
        a.compute_ref AS "computeRef", c.host_id AS "hostId",a.state,v.revision,
        to_char(v.idle_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "idleSince"
        FROM relay_thread_vm_allocations a JOIN relay_thread_vm_bindings b USING(allocation_id)
        JOIN relay_thread_vm_provisions p USING(allocation_id) JOIN relay_thread_vm_ready s USING(allocation_id)
        JOIN relay_thread_vm_activity v USING(allocation_id)
        JOIN LATERAL (SELECT host_id,state FROM relay_thread_vm_capacity WHERE allocation_id=a.allocation_id ORDER BY position DESC LIMIT 1) c ON true
        WHERE a.allocation_id=${input.allocationId} AND a.thread_id=${input.threadId}
          AND a.owner_user_id=${input.actorUserId} AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL
          AND b.environment_id=${placement.environmentId} AND b.generation=${placement.generation} AND b.revoked_at IS NULL
          AND p.phase='created' AND s.phase='ready' AND v.idle_since IS NOT NULL
          AND ((a.state='running' AND v.activity='idle' AND v.observed_at>=clock_timestamp()-interval '2 minutes' AND c.state='started')
            OR (a.state='paused' AND c.state='released' AND EXISTS(SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=a.allocation_id AND phase='completed' AND generation=${input.expectedGeneration} AND native_checkpoint_operation_id IS NOT NULL AND source_frozen_at IS NOT NULL AND source_reopened_at IS NULL)))
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=a.allocation_id AND (phase IN ('pending','sealed') OR (phase='cancelled' AND source_reopened_at IS NULL)))
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=a.allocation_id AND phase IN ('waiting','resuming'))
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_backups WHERE allocation_id=a.allocation_id AND phase IN ('pending','creating','captured','verifying','cleanup'))
          AND NOT EXISTS(SELECT 1 FROM relay_thread_commands WHERE thread_id=a.thread_id AND receipt_json IS NULL)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_execution_admissions e WHERE e.thread_id=a.thread_id AND NOT e.completed
            AND NOT (a.state='running' AND e.environment_id=${placement.environmentId} AND e.generation=${placement.generation}
              AND jsonb_exists(v.inactive_work_ids,e.work_id)))
        FOR UPDATE OF a,v`;
        if (!candidate)
          return yield* conflict(
            "The selected VM is busy, uncertain, or changing lifecycle state.",
          );
        yield* checkDeadline({ ...input, idleSince: candidate.idleSince });
        yield* sql`INSERT INTO relay_thread_vm_final_saves(operation_id,thread_id,allocation_id,actor_user_id,environment_id,generation,host_id,compute_ref,original_state,reason,activity_revision,idle_since,phase)
        VALUES(${input.operationId},${input.threadId},${input.allocationId},${input.actorUserId},${placement.environmentId},${placement.generation},${candidate.hostId},${candidate.computeRef},${candidate.state},${input.reason},${candidate.revision},${candidate.idleSince}::timestamptz,'draining')`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
        if (candidate.state === "paused") {
          const [pause] = yield* sql<{
            nativeCheckpointOperationId: string;
          }>`SELECT native_checkpoint_operation_id AS "nativeCheckpointOperationId"
            FROM relay_thread_vm_pauses WHERE allocation_id=${input.allocationId} AND generation=${input.expectedGeneration}
              AND phase='completed' AND native_checkpoint_operation_id IS NOT NULL`;
          if (!pause) return yield* conflict("Paused source has no certified recovery point.");
          yield* sourceFrozen({
            operationId: input.operationId,
            environmentId: placement.environmentId,
            generation: placement.generation,
            nativeCheckpointOperationId: pause.nativeCheckpointOperationId,
          });
        }
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const sourceFrozen = Effect.fn("relay.thread_vm.final_save.source_frozen")(function* (input: {
    readonly operationId: string;
    readonly environmentId: string;
    readonly generation: number;
    readonly nativeCheckpointOperationId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(input.operationId);
        if (
          operation.environmentId !== input.environmentId ||
          operation.generation !== input.generation
        )
          return yield* conflict("Freeze acknowledgement belongs to a different source.");
        if (operation.phase !== "draining") {
          if (
            ["frozen", "saving", "deleting", "completed"].includes(operation.phase) &&
            operation.nativeCheckpointOperationId === input.nativeCheckpointOperationId
          )
            return operation;
          return yield* conflict("Final save no longer accepts a source acknowledgement.");
        }
        yield* requireStillIdle(operation);
        const [pause] =
          operation.originalState === "paused"
            ? yield* sql<{ operationId: string; sourceSequence: number }>`
          SELECT x.operation_id AS "operationId",x.source_sequence AS "sourceSequence" FROM relay_thread_vm_pauses x
          JOIN relay_thread_native_checkpoint_operations n ON n.operation_id=x.operation_id
          WHERE x.allocation_id=${operation.allocationId} AND x.generation=${operation.generation} AND x.phase='completed'
            AND x.native_checkpoint_operation_id=${input.nativeCheckpointOperationId} AND x.source_frozen_at IS NOT NULL AND x.source_reopened_at IS NULL
            AND n.phase='active' AND n.checkpoint_operation_id=x.native_checkpoint_operation_id FOR UPDATE OF x`
            : [];
        if (operation.originalState === "paused" && !pause)
          return yield* conflict("Paused source recovery is not certified.");
        const point = yield* natives.get(input.nativeCheckpointOperationId);
        if (
          !point ||
          !point.recoveryHistory ||
          point.threadId !== operation.threadId ||
          point.sourceEnvironmentId !== operation.environmentId ||
          point.generation !== operation.generation ||
          point.captureOperationId !== (pause?.operationId ?? operation.operationId) ||
          (pause && point.sourceSequence !== pause.sourceSequence)
        )
          return yield* conflict(
            "Final saving requires the exact independently retained frozen conversation and chat checkpoint.",
          );
        const [mirrored] =
          yield* sql`SELECT 1 FROM relay_thread_history_watermarks WHERE thread_id=${operation.threadId} AND environment_id=${operation.environmentId} AND generation=${operation.generation} AND source_sequence>=${point.sourceSequence}`;
        const later =
          yield* sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${operation.threadId} AND environment_id=${operation.environmentId} AND source_sequence>${point.sourceSequence}`;
        const unfinished =
          yield* sql`SELECT 1 FROM relay_thread_execution_admissions WHERE thread_id=${operation.threadId} AND NOT completed`;
        if (!mirrored || later.length || unfinished.length)
          return yield* conflict("Final source history or execution has not settled.");
        yield* natives.pinCompleteForOperation({
          threadId: operation.threadId,
          operationId: operation.operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='frozen' ,source_sequence=${point.sourceSequence},native_checkpoint_operation_id=${point.operationId},frozen_at=clock_timestamp() WHERE operation_id=${operation.operationId}`;
        return (yield* get(operation.operationId))!;
      }),
    );
  });
  const reserveBackup = Effect.fn("relay.thread_vm.final_save.reserve_backup")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(operationId);
        if (
          ["saving", "deleting", "completed"].includes(operation.phase) &&
          operation.backupOperationId
        )
          return operation;
        if (operation.phase !== "frozen")
          return yield* conflict("A final disk capture requires its frozen recovery certificate.");
        const backupOperationId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase)
        VALUES(${backupOperationId},${operation.allocationId},${operation.generation},${operation.computeRef},${`launchpad-final-${backupOperationId}`},'pending')`;
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='saving',backup_operation_id=${backupOperationId} WHERE operation_id=${operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const recordSaved = Effect.fn("relay.thread_vm.final_save.record_saved")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(operationId);
        if (operation.phase === "deleting" || operation.phase === "completed") return operation;
        if (
          operation.phase !== "saving" ||
          !operation.backupOperationId ||
          !operation.nativeCheckpointOperationId
        )
          return yield* conflict("The final disk capture is incomplete.");
        yield* checkDeadline(operation);
        yield* requireStillIdle(operation);
        const point = yield* natives.get(operation.nativeCheckpointOperationId);
        if (!point?.recoveryHistory)
          return yield* conflict(
            "The independent conversation and history checkpoint is unavailable.",
          );
        yield* natives.pinCompleteForOperation({
          threadId: operation.threadId,
          operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        const [verified] = yield* sql<{
          proof: unknown;
        }>`SELECT x.probe_receipt AS proof FROM relay_thread_vm_backups x JOIN relay_thread_vm_final_saves f ON f.backup_operation_id=x.operation_id
        WHERE f.operation_id=${operationId} AND x.phase='verified' AND x.probe_receipt IS NOT NULL
          AND x.allocation_id=f.allocation_id AND x.generation=f.generation AND x.compute_ref=f.compute_ref
          AND x.created_at>=f.frozen_at AND x.verified_at>=f.frozen_at FOR UPDATE OF x`;
        if (!verified)
          return yield* conflict(
            "A fresh final disk save and successful cold recovery probe are required before deletion.",
          );
        const proof = yield* decodeColdProof(verified.proof).pipe(
          Effect.mapError(() => conflict("Final cold recovery proof is invalid.")),
        );
        if (
          proof.operationID !== operation.backupOperationId ||
          proof.generation !== `backup-${operation.backupOperationId}` ||
          proof.preparedBuildID !== proof.coldProbe.preparedBuildID
        )
          return yield* conflict("Final cold recovery proof belongs to another disk save.");
        yield* backups.pin({
          threadId: operation.threadId,
          backupOperationId: operation.backupOperationId,
          operationId: `saved-${operationId}`,
        });
        yield* sql`INSERT INTO relay_thread_vm_saved_disks(operation_id,thread_id,backup_operation_id,generation,host_id,phase)
        VALUES(${operationId},${operation.threadId},${operation.backupOperationId},${operation.generation},${operation.hostId},'available')`;
        yield* makeThreadVmAllocationStore(sql).requestDeletion(operation.allocationId);
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='deleting' WHERE operation_id=${operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const claimPhase = Effect.fn("relay.thread_vm.final_save.claim")(function* (
    hostId: string,
    step: "save" | "delete" | "abort",
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT f.operation_id AS "operationId" FROM relay_thread_vm_final_saves f
        JOIN relay_thread_placements t USING(thread_id) WHERE f.host_id=${hostId} AND (( ${step}='delete' AND f.phase='deleting') OR (${step}='save' AND f.phase IN ('frozen','saving')) OR (${step}='abort' AND f.phase='aborting'))
          AND t.operation_id=f.operation_id AND f.retry_at<=clock_timestamp()
          AND (${step}!='abort' OR NOT EXISTS(SELECT 1 FROM relay_thread_vm_backups x WHERE x.operation_id=f.backup_operation_id AND x.claim_until>clock_timestamp()))
          AND (f.claim_until IS NULL OR f.claim_until<=clock_timestamp())
        ORDER BY f.retry_at,f.created_at,f.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const operation = yield* lock(candidate.operationId),
          claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        if (step === "abort" && operation.backupOperationId) {
          const [backup] =
            yield* sql`SELECT 1 FROM relay_thread_vm_backups WHERE operation_id=${operation.backupOperationId} AND (claim_until IS NULL OR claim_until<=clock_timestamp()) FOR UPDATE`;
          if (!backup) return null;
          yield* sql`UPDATE relay_thread_vm_backups SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${operation.backupOperationId}`;
        }
        const rows =
          yield* sql`UPDATE relay_thread_vm_final_saves SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes'
        WHERE operation_id=${operation.operationId} AND phase=${operation.phase} AND retry_at<=clock_timestamp()
          AND (claim_until IS NULL OR claim_until<=clock_timestamp()) RETURNING operation_id`;
        return rows.length ? { ...operation, claimId } : null;
      }),
    );
  });
  const claimDeletion = (hostId: string) => claimPhase(hostId, "delete");
  const claimSave = (hostId: string) => claimPhase(hostId, "save");
  const claimAbort = (hostId: string) => claimPhase(hostId, "abort");
  const deferSave = Effect.fn("relay.thread_vm.final_save.defer_save")(function* (
    input: { operationId: string; claimId: string },
    errorCode: string | null,
  ) {
    yield* sql`UPDATE relay_thread_vm_final_saves SET claim_id=NULL,claim_until=NULL,
      retry_at=CASE WHEN phase='deleting' THEN clock_timestamp() ELSE clock_timestamp()+interval '1 minute' END,error_code=${errorCode}
      WHERE operation_id=${input.operationId} AND claim_id=${input.claimId} AND phase IN ('frozen','saving','deleting')`;
  });
  const requireClaim = Effect.fnUntraced(function* (input: {
    operationId: string;
    claimId: string;
  }) {
    const [claimed] =
      yield* sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE operation_id=${input.operationId}
      AND claim_id=${input.claimId} AND claim_until>clock_timestamp() AND phase='deleting'`;
    if (!claimed)
      return yield* conflict("The final deletion worker claim expired or was replaced.");
  });
  const deferDeletion = Effect.fn("relay.thread_vm.final_save.defer_deletion")(function* (
    input: { operationId: string; claimId: string },
    errorCode: string,
  ) {
    yield* sql`UPDATE relay_thread_vm_final_saves SET claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp()+interval '1 minute',error_code=${errorCode}
      WHERE operation_id=${input.operationId} AND claim_id=${input.claimId} AND phase='deleting'`;
  });
  const authorizeDeletion = Effect.fn("relay.thread_vm.final_save.authorize_deletion")(
    function* (input: { operationId: string; claimId: string }) {
      const operationId = input.operationId;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const operation = yield* lock(operationId);
          yield* requireClaim(input);
          if (!operation.physicalDeleteStartedAt) yield* checkDeadline(operation);
          if (
            operation.phase !== "deleting" ||
            !operation.nativeCheckpointOperationId ||
            !operation.backupOperationId
          )
            return yield* conflict("Final save has not authorized physical deletion.");
          const point = yield* natives.get(operation.nativeCheckpointOperationId);
          if (!point)
            return yield* conflict("The independent conversation checkpoint is unavailable.");
          yield* natives.pinCompleteForOperation({
            threadId: operation.threadId,
            operationId,
            checkpointOperationId: point.operationId,
            expected: point,
          });
          const [saved] = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s
        JOIN relay_thread_vm_backups b ON b.operation_id=s.backup_operation_id
        JOIN relay_thread_vm_backup_pins p ON p.backup_operation_id=b.operation_id
        WHERE s.operation_id=${operationId} AND s.thread_id=${operation.threadId} AND s.generation=${operation.generation}
          AND s.host_id=${operation.hostId} AND s.phase='available' AND b.operation_id=${operation.backupOperationId}
          AND b.phase='verified' AND b.probe_receipt IS NOT NULL AND p.operation_id=${`saved-${operationId}`}`;
          if (!saved) return yield* conflict("The final disk recovery pin is missing.");
          return operation;
        }),
      );
    },
  );
  // Policy can still win up to this durable boundary. After an uncertain stop
  // request, reconcile it even if the threshold changes; quota must not leak.
  const beginDeletion = Effect.fn("relay.thread_vm.final_save.begin_deletion")(function* (input: {
    operationId: string;
    claimId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* authorizeDeletion(input);
        yield* sql`UPDATE relay_thread_vm_final_saves SET physical_delete_started_at=COALESCE(physical_delete_started_at,clock_timestamp()) WHERE operation_id=${operation.operationId}`;
        return (yield* get(operation.operationId))!;
      }),
    );
  });
  /** Invoke only after the patched host's positive physical-stop receipt AND non-waking absence inspection. */
  const confirmDeleted = Effect.fn("relay.thread_vm.final_save.confirm_deleted")(function* (input: {
    operationId: string;
    claimId: string;
  }) {
    const operationId = input.operationId;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(operationId);
        if (operation.phase === "completed") return operation;
        yield* authorizeDeletion(input);
        if (!operation.physicalDeleteStartedAt)
          return yield* conflict("Physical deletion has not begun.");
        const [saved] =
          yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks s JOIN relay_thread_vm_backup_pins p ON p.backup_operation_id=s.backup_operation_id
        WHERE s.operation_id=${operationId} AND s.phase='available' AND p.operation_id=${`saved-${operationId}`}`;
        if (!saved) return yield* conflict("The final disk recovery pin is missing.");
        yield* makeThreadVmAllocationStore(sql).confirmDeleted({
          allocationId: operation.allocationId,
          computeRef: operation.computeRef,
        });
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE credential_id IN(SELECT credential_id FROM relay_thread_vm_bindings WHERE allocation_id=${operation.allocationId})`;
        yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE allocation_id=${operation.allocationId}`;
        // Start retention once, at confirmed compute absence, never on a read or retry.
        yield* sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp() WHERE operation_id=${operationId}`;
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='completed',completed_at=clock_timestamp(),claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${operationId}`;
        yield* sql`UPDATE relay_thread_vm_replacements SET checked_at=NULL WHERE final_save_operation_id=${operationId} AND phase='waiting'`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${operation.threadId}`;
        yield* natives.releaseOperation({ threadId: operation.threadId, operationId });
        if (operation.originalState === "paused") {
          const [pause] = yield* sql<{ operationId: string }>`SELECT operation_id AS "operationId"
            FROM relay_thread_vm_pauses WHERE allocation_id=${operation.allocationId} AND generation=${operation.generation}
              AND native_checkpoint_operation_id=${operation.nativeCheckpointOperationId} AND phase='completed'`;
          if (!pause)
            return yield* conflict("The deleted paused source lost its recovery identity.");
          yield* natives.releaseOperation({
            threadId: operation.threadId,
            operationId: pause.operationId,
          });
        }
        return (yield* get(operationId))!;
      }),
    );
  });
  const requestAbort = Effect.fn("relay.thread_vm.final_save.request_abort")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(operationId);
        if (operation.phase === "aborted" || operation.phase === "aborting") return operation;
        if (operation.phase === "deleting" || operation.phase === "completed")
          return yield* conflict("The saved-only transition already won; deletion must reconcile.");
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='aborting',claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const cancelBeforeFreeze = Effect.fn("relay.thread_vm.final_save.cancel_before_freeze")(
    function* (input: {
      readonly threadId: string;
      readonly environmentId: string;
      readonly generation: number;
      readonly operationId: string;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const operation = yield* lock(input.operationId);
          if (
            operation.threadId !== input.threadId ||
            operation.environmentId !== input.environmentId ||
            operation.generation !== input.generation ||
            operation.nativeCheckpointOperationId !== null ||
            !["draining", "aborting", "aborted"].includes(operation.phase)
          )
            return yield* conflict("Certified final saving cannot be cancelled by its source.");
          if (operation.phase !== "aborted")
            yield* sql`UPDATE relay_thread_vm_activity
        SET revision=revision+1,activity='unknown',observed_at=NULL,idle_since=NULL
        WHERE allocation_id=${operation.allocationId}`;
          return yield* requestAbort(input.operationId);
        }),
      );
    },
  );
  const abortCandidate = Effect.fn("relay.thread_vm.final_save.abort_candidate")(function* (input: {
    operationId: string;
    claimId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(input.operationId);
        const [claim] =
          yield* sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE operation_id=${input.operationId} AND phase='aborting' AND claim_id=${input.claimId} AND claim_until>clock_timestamp()`;
        if (!claim) return yield* conflict("Final save cancellation claim expired or changed.");
        if (!operation.backupOperationId) return { operation, backup: null };
        const [backup] = yield* sql<{
          operationId: string;
          phase: string;
          snapshotId: string | null;
          snapshotName: string;
          sourceBuildId: string | null;
        }>`SELECT operation_id AS "operationId",phase,snapshot_id AS "snapshotId",snapshot_name AS "snapshotName",source_build_id AS "sourceBuildId" FROM relay_thread_vm_backups WHERE operation_id=${operation.backupOperationId} AND allocation_id=${operation.allocationId} AND generation=${operation.generation} AND compute_ref=${operation.computeRef} AND claim_id=${input.claimId} AND claim_until>clock_timestamp() FOR UPDATE`;
        if (!backup)
          return yield* conflict("Final capture identity or cancellation claim changed.");
        const pins =
          yield* sql`SELECT 1 FROM relay_thread_vm_backup_pins WHERE backup_operation_id=${backup.operationId}`;
        if (pins.length)
          return yield* conflict("The final capture is still pinned by a recovery operation.");
        return { operation, backup };
      }),
    );
  });
  const adoptAbortCapture = Effect.fn("relay.thread_vm.final_save.adopt_abort_capture")(function* (
    input: { operationId: string; claimId: string },
    snapshotId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { backup } = yield* abortCandidate(input);
        if (!backup || backup.phase !== "creating" || backup.snapshotId || !snapshotId)
          return yield* conflict("Cancellation cannot adopt a different capture.");
        // Creating cannot have started a probe: captured -> verifying is persisted
        // before prepare. This reconciles the single uncertain snapshot by name.
        yield* sql`UPDATE relay_thread_vm_backups SET snapshot_id=${snapshotId},phase='captured' WHERE operation_id=${backup.operationId}`;
        return yield* abortCandidate(input);
      }),
    );
  });
  /** confirmed-stop requires a positive cancellation receipt for this backup operation. */
  const recordAbortProbeStopped = Effect.fn("relay.thread_vm.final_save.abort_probe_stopped")(
    function* (
      input: { operationId: string; claimId: string },
      evidence: "not-required" | "confirmed-stop",
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* abortCandidate(input);
          if (current.operation.abortProbeStoppedAt) return current;
          if (
            evidence === "not-required" &&
            current.backup &&
            !(
              current.backup.phase === "failed" &&
              current.backup.snapshotId === null &&
              current.backup.sourceBuildId === null
            ) &&
            !["pending", "creating", "captured", "verified", "retired"].includes(
              current.backup.phase,
            )
          )
            return yield* conflict("The recovery probe needs a positive physical-stop receipt.");
          yield* sql`UPDATE relay_thread_vm_final_saves SET abort_probe_stopped_at=clock_timestamp() WHERE operation_id=${input.operationId}`;
          return yield* abortCandidate(input);
        }),
      );
    },
  );
  const retireAbortCapture = Effect.fn("relay.thread_vm.final_save.retire_abort_capture")(
    function* (input: { operationId: string; claimId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* abortCandidate(input),
            backup = current.backup;
          if (!backup) return current;
          if (!current.operation.abortProbeStoppedAt)
            return yield* conflict("Recovery probe stop has not been recorded.");
          if (
            backup.phase === "pending" ||
            (backup.phase === "failed" &&
              backup.snapshotId === null &&
              backup.sourceBuildId === null)
          ) {
            // Pending has no external capture; an explicitly rejected paused
            // capture has no snapshot or prepared source from which to boot a probe.
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retired' WHERE operation_id=${backup.operationId}`;
          } else if (backup.phase !== "retired") {
            if (!backup.snapshotId || backup.phase === "creating")
              return yield* conflict("An uncertain snapshot capture has not been reconciled.");
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retiring' WHERE operation_id=${backup.operationId}`;
          }
          return yield* abortCandidate(input);
        }),
      );
    },
  );
  const completeAbortCapture = Effect.fn("relay.thread_vm.final_save.complete_abort_capture")(
    function* (input: { operationId: string; claimId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const { backup } = yield* abortCandidate(input);
          if (backup && backup.phase !== "retired") {
            if (backup.phase !== "retiring" || !backup.snapshotId)
              return yield* conflict("Final capture retirement is incomplete.");
          }
          if (backup)
            yield* sql`UPDATE relay_thread_vm_backups SET phase='retired',claim_id=NULL,claim_until=NULL WHERE operation_id=${backup.operationId}`;
          return yield* confirmAborted(input.operationId);
        }),
      );
    },
  );
  const deferAbort = Effect.fn("relay.thread_vm.final_save.defer_abort")(function* (
    input: { operationId: string; claimId: string },
    errorCode: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          backupOperationId: string | null;
        }>`UPDATE relay_thread_vm_final_saves SET claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp()+interval '1 minute',error_code=${errorCode} WHERE operation_id=${input.operationId} AND phase='aborting' AND claim_id=${input.claimId} RETURNING backup_operation_id AS "backupOperationId"`;
        if (row?.backupOperationId)
          yield* sql`UPDATE relay_thread_vm_backups SET claim_id=NULL,claim_until=NULL WHERE operation_id=${row.backupOperationId} AND claim_id=${input.claimId}`;
      }),
    );
  });
  /** Release the relay hold only after cancelling any in-progress capture/probe; local execution remains fenced until its owner reconciles this result. */
  const confirmAborted = Effect.fn("relay.thread_vm.final_save.confirm_aborted")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const operation = yield* lock(operationId);
        if (operation.phase === "aborted") return operation;
        if (operation.phase !== "aborting") return yield* conflict("Final save is not aborting.");
        if (operation.backupOperationId) {
          const [backup] = yield* sql<{
            phase: string;
            snapshotId: string | null;
          }>`SELECT phase,snapshot_id AS "snapshotId" FROM relay_thread_vm_backups WHERE operation_id=${operation.backupOperationId} FOR UPDATE`;
          if (!backup || (backup.phase !== "verified" && backup.phase !== "retired"))
            return yield* conflict(
              "The final capture or cold probe still needs cleanup before releasing the source.",
            );
        }
        if (operation.nativeCheckpointOperationId)
          yield* natives.releaseOperation({ threadId: operation.threadId, operationId });
        yield* sql`UPDATE relay_thread_vm_final_saves SET phase='aborted',completed_at=clock_timestamp(),claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${operation.threadId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  return {
    get,
    begin,
    sourceFrozen,
    reserveBackup,
    recordSaved,
    claimDeletion,
    claimSave,
    claimAbort,
    abortCandidate,
    adoptAbortCapture,
    recordAbortProbeStopped,
    retireAbortCapture,
    completeAbortCapture,
    deferAbort,
    deferSave,
    deferDeletion,
    authorizeDeletion,
    beginDeletion,
    confirmDeleted,
    requestAbort,
    cancelBeforeFreeze,
    confirmAborted,
  };
}
