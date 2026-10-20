import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { RelayThreadVmRepositoryUpload } from "@t3tools/contracts/relay";
import { makeThreadMoveCheckpointStore } from "./ThreadMoveCheckpointStore.ts";
export class ThreadVmResetConflict extends Schema.TaggedError<ThreadVmResetConflict>()(
  "ThreadVmResetConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmResetConflict({ message });
const decodeId = Schema.decodeEffect(Schema.String.check(Schema.isUUID()));
const encodeRepository = Schema.encodeSync(Schema.fromJsonString(RelayThreadVmRepositoryUpload));
export interface ThreadVmReset {
  readonly operationId: string;
  readonly threadId: string;
  readonly allocationId: string;
  readonly actorUserId: string;
  readonly expectedGeneration: number;
  readonly savedDiskOperationId: string;
  readonly nativeCheckpointOperationId: string;
  readonly sourceEnvironmentId: string;
  readonly sourceSequence: number;
  readonly hostId: string;
  readonly templateId: string;
  readonly canonicalKey: string;
  readonly branch: string;
  readonly revision: string;
  readonly repositoryUpload: RelayThreadVmRepositoryUpload | null;
  readonly errorCode: string | null;
  readonly phase:
    | "pending"
    | "creating"
    | "committed"
    | "importing"
    | "completed"
    | "cancelling"
    | "cancelled";
}
type Intent = Pick<
  ThreadVmReset,
  | "operationId"
  | "threadId"
  | "allocationId"
  | "actorUserId"
  | "expectedGeneration"
  | "hostId"
  | "templateId"
  | "canonicalKey"
  | "branch"
  | "revision"
>;
/** Internal admission. The API must hold current private owner/repository access.
 * Reset is explicit after disk expiry: quota, placement hold, retained native/chat
 * pins and inert provisioning intent commit together. No command starts compute. */
export function makeThreadVmResetStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects);
  const get = Effect.fn("relay.thread_vm.reset.get")(function* (operationId: string) {
    const [row] =
      yield* sql<ThreadVmReset>`SELECT operation_id AS "operationId",thread_id AS "threadId",allocation_id AS "allocationId",actor_user_id AS "actorUserId",
      expected_generation AS "expectedGeneration",saved_disk_operation_id AS "savedDiskOperationId",native_checkpoint_operation_id AS "nativeCheckpointOperationId",
      source_environment_id AS "sourceEnvironmentId",source_sequence AS "sourceSequence",host_id AS "hostId",template_id AS "templateId",canonical_key AS "canonicalKey",branch,revision,repository_upload AS "repositoryUpload",phase,error_code AS "errorCode"
      FROM relay_thread_vm_resets WHERE operation_id=${operationId}`;
    return row ?? null;
  });
  const begin = Effect.fn("relay.thread_vm.reset.begin")(function* (
    input: Intent & { readonly replacementRequestId?: string },
  ) {
    yield* decodeId(input.operationId);
    yield* decodeId(input.allocationId);
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1 ||
      !input.branch.trim() ||
      !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(input.canonicalKey) ||
      !/^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.revision)
    )
      return yield* conflict("Reset requires an exact repository branch and revision");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
        const [placement] = yield* sql<{
          generation: number;
          environmentId: string;
          organizationId: string;
          repositoryId: string;
          ownerUserId: string;
          operationId: string | null;
        }>`
        SELECT generation,environment_id AS "environmentId",organization_id AS "organizationId",repository_id AS "repositoryId",owner_user_id AS "ownerUserId",operation_id AS "operationId"
        FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        if (!placement || placement.ownerUserId !== input.actorUserId)
          return yield* conflict("Only the private thread owner can reset its VM");
        const prior = yield* get(input.operationId);
        if (prior) {
          for (const key of [
            "threadId",
            "allocationId",
            "actorUserId",
            "expectedGeneration",
            "hostId",
            "templateId",
            "canonicalKey",
            "branch",
            "revision",
          ] as const)
            if (prior[key] !== input[key])
              return yield* conflict("Reset identity was reused with different intent");
          if (prior.phase === "completed" || prior.phase === "cancelled") return prior;
          const generation = ["committed", "importing"].includes(prior.phase)
            ? input.expectedGeneration + 1
            : input.expectedGeneration;
          if (placement.generation !== generation || placement.operationId !== input.operationId)
            return yield* conflict("Reset admission no longer owns this thread");
          yield* natives.pinCompleteForOperation({
            threadId: input.threadId,
            operationId: input.operationId,
            checkpointOperationId: prior.nativeCheckpointOperationId,
            expected: {
              sourceEnvironmentId: prior.sourceEnvironmentId,
              generation: prior.expectedGeneration,
              sourceSequence: prior.sourceSequence,
              nativeThreadId: (yield* natives.getForOperation(prior))?.nativeThreadId ?? "",
            },
          });
          return prior;
        }
        if (placement.generation !== input.expectedGeneration || placement.operationId !== null)
          return yield* conflict("Thread placement changed before reset");
        const repository = yield* makeThreadMoveCheckpointStore(sql, objects).repositoryUpload(
          input.threadId,
        );
        if (
          !repository ||
          repository.revision !== input.revision ||
          (repository.branch ?? "main") !== input.branch
        )
          return yield* conflict(
            "Reset requires the original Git commit uploaded by a local thread move",
          );
        const alias =
          yield* sql`SELECT 1 FROM relay_repository_aliases WHERE canonical_key=${input.canonicalKey} AND repository_id=${placement.repositoryId} AND organization_id=${placement.organizationId} FOR SHARE`;
        if (!alias.length) return yield* conflict("Reset cannot change the thread repository");
        // A paused final save reuses its certified pause checkpoint without waking the source.
        const [source] = yield* sql<{
          savedDiskOperationId: string;
          nativeCheckpointOperationId: string;
          sourceSequence: number;
          environmentId: string;
          captureOperationId: string | null;
        }>`
        SELECT s.operation_id AS "savedDiskOperationId",f.native_checkpoint_operation_id AS "nativeCheckpointOperationId",f.source_sequence AS "sourceSequence",f.environment_id AS "environmentId",
          CASE WHEN f.original_state='paused' THEN p.operation_id ELSE f.operation_id END AS "captureOperationId"
        FROM relay_thread_vm_saved_disks s JOIN relay_thread_vm_final_saves f ON f.operation_id=s.operation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=f.allocation_id
        LEFT JOIN relay_thread_vm_pauses p ON f.original_state='paused' AND p.allocation_id=f.allocation_id
          AND p.generation=f.generation AND p.phase='completed' AND p.boot_id IS NOT NULL
          AND p.native_checkpoint_operation_id=f.native_checkpoint_operation_id AND p.source_sequence=f.source_sequence
          AND p.source_frozen_at IS NOT NULL AND p.source_reopened_at IS NULL
        WHERE s.thread_id=${input.threadId} AND s.generation=${input.expectedGeneration} AND s.phase='expired' AND f.phase='completed'
          AND f.thread_id=s.thread_id AND f.generation=s.generation
          AND a.state='deleted' AND a.deleted_at IS NOT NULL AND f.environment_id=${placement.environmentId}
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations live WHERE live.thread_id=s.thread_id AND live.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_execution_admissions w WHERE w.thread_id=s.thread_id AND NOT w.completed)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
            WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR k.revoked_at IS NULL))
        FOR UPDATE OF s`;
        const point = source ? yield* natives.latestComplete(input.threadId) : null;
        if (
          !source ||
          !point ||
          !point.recoveryHistory ||
          point.operationId !== source.nativeCheckpointOperationId ||
          point.generation !== input.expectedGeneration ||
          point.sourceEnvironmentId !== source.environmentId ||
          point.sourceSequence !== source.sourceSequence ||
          !source.captureOperationId ||
          point.captureOperationId !== source.captureOperationId
        )
          return yield* conflict(
            "Reset requires an expired disk and complete independently retained conversation",
          );
        yield* natives.pinCompleteForOperation({
          threadId: input.threadId,
          operationId: input.operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        yield* sql`INSERT INTO relay_thread_vm_resets(operation_id,thread_id,allocation_id,actor_user_id,expected_generation,saved_disk_operation_id,native_checkpoint_operation_id,
        source_environment_id,source_sequence,host_id,template_id,canonical_key,branch,revision,repository_upload)
        VALUES(${input.operationId},${input.threadId},${input.allocationId},${input.actorUserId},${input.expectedGeneration},${source.savedDiskOperationId},${point.operationId},${point.sourceEnvironmentId},${point.sourceSequence},${input.hostId},${input.templateId},${input.canonicalKey},${input.branch},${input.revision},${encodeRepository(repository)}::jsonb)`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
        yield* makeThreadVmAllocationStore(sql).reserve({
          allocationId: input.allocationId,
          threadId: input.threadId,
          organizationId: placement.organizationId,
          ownerUserId: input.actorUserId,
          templateId: input.templateId,
          savedDiskResetOperationId: input.operationId,
          ...(input.replacementRequestId
            ? { replacementRequestId: input.replacementRequestId }
            : {}),
        });
        yield* makeThreadVmProvisionStore(sql).enqueue({
          allocationId: input.allocationId,
          operationId: input.operationId,
          generation: input.expectedGeneration + 1,
          hostId: input.hostId,
        });
        return (yield* get(input.operationId))!;
      }),
    );
  });
  const lock = Effect.fnUntraced(function* (operationId: string) {
    const candidate = yield* get(operationId);
    if (!candidate) return yield* conflict("Reset does not exist");
    yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${candidate.threadId} FOR UPDATE`;
    yield* sql`SELECT operation_id FROM relay_thread_vm_resets WHERE operation_id=${operationId} FOR UPDATE`;
    return (yield* get(operationId))!;
  });
  const requestCancellation = Effect.fn("relay.thread_vm.reset.cancel")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* lock(operationId);
        if (row.phase === "cancelled") return row;
        if (!["pending", "creating", "cancelling"].includes(row.phase))
          return yield* conflict("A reset that committed fresh ownership cannot be cancelled");
        const [owner] =
          yield* sql`SELECT 1 FROM relay_thread_placements WHERE thread_id=${row.threadId}
        AND generation=${row.expectedGeneration} AND environment_id=${row.sourceEnvironmentId} AND operation_id=${row.operationId}`;
        if (!owner) return yield* conflict("Reset no longer owns this expired workspace");
        // Revoke even a delivered-but-unconfirmed credential before cleanup. The
        // replacement remains inert; old expired credentials are never revived.
        yield* makeThreadVmAllocationStore(sql).requestDeletion(row.allocationId);
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=COALESCE(revoked_at,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        WHERE credential_id IN (SELECT credential_id FROM relay_thread_vm_bindings WHERE allocation_id=${row.allocationId})`;
        yield* sql`UPDATE relay_thread_vm_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE allocation_id=${row.allocationId}`;
        yield* sql`UPDATE relay_thread_vm_resets SET phase='cancelling',claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp(),error_code=NULL WHERE operation_id=${row.operationId}`;
        return (yield* get(operationId))!;
      }),
    );
  });
  const claimCancellation = Effect.fn("relay.thread_vm.reset.claim_cancel")(function* (
    hostId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId"
        FROM relay_thread_vm_resets r JOIN relay_thread_placements t USING(thread_id)
        WHERE r.host_id=${hostId} AND r.phase='cancelling' AND t.operation_id=r.operation_id
          AND t.generation=r.expected_generation AND t.environment_id=r.source_environment_id
          AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp())
        ORDER BY r.retry_at,r.created_at,r.operation_id FOR UPDATE OF t SKIP LOCKED LIMIT 1`;
        if (!candidate) return null;
        const row = yield* lock(candidate.operationId),
          claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_resets SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${row.operationId}`;
        return { ...row, claimId };
      }),
    );
  });
  const requireCancellationClaim = Effect.fnUntraced(function* (
    claim: ThreadVmReset & { claimId: string },
  ) {
    const row = yield* lock(claim.operationId);
    const [current] =
      yield* sql`SELECT 1 FROM relay_thread_vm_resets r JOIN relay_thread_placements t USING(thread_id)
      WHERE r.operation_id=${claim.operationId} AND r.claim_id=${claim.claimId} AND r.claim_until>clock_timestamp()
        AND r.phase='cancelling' AND t.operation_id=r.operation_id AND t.generation=r.expected_generation
        AND t.environment_id=r.source_environment_id`;
    if (!current) return yield* conflict("Reset cleanup claim expired or ownership changed");
    return row;
  });
  const finishCancellation = Effect.fn("relay.thread_vm.reset.cancelled")(function* (
    claim: ThreadVmReset & { claimId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* requireCancellationClaim(claim);
        const [absent] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
        WHERE a.allocation_id=${row.allocationId} AND a.state='deleted' AND a.deleted_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id AND c.state!='released')
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
            WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR k.revoked_at IS NULL)) FOR SHARE OF a`;
        if (!absent) return yield* conflict("Replacement VM absence is not confirmed");
        yield* natives.releaseOperation(row);
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${row.threadId} AND operation_id=${row.operationId}`;
        yield* sql`UPDATE relay_thread_vm_resets SET phase='cancelled',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${row.operationId}`;
        return (yield* get(row.operationId))!;
      }),
    );
  });
  const deferCancellation = Effect.fn("relay.thread_vm.reset.defer_cancel")(function* (
    claim: ThreadVmReset & { claimId: string },
    errorCode: string,
  ) {
    yield* sql`UPDATE relay_thread_vm_resets SET claim_id=NULL,claim_until=NULL,retry_at=clock_timestamp()+interval '30 seconds',error_code=${errorCode}
      WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp() AND phase='cancelling'`;
  });
  return {
    get,
    begin,
    lock,
    requestCancellation,
    claimCancellation,
    requireCancellationClaim,
    finishCancellation,
    deferCancellation,
  };
}
