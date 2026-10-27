import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  RelayThreadVmResetRequest,
  RelayThreadVmRestoreRequest,
  RelayThreadVmCreateRequest,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { makeThreadMoveCheckpointStore } from "./ThreadMoveCheckpointStore.ts";
import { makeThreadVmMoveDestinationStore } from "./ThreadVmMoveDestinationStore.ts";
import { makeThreadVmResetStore } from "./ThreadVmResetStore.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { lockThreadVmPolicy } from "./ThreadVmPolicy.ts";
import { threadVmQuotaUsage } from "./ThreadVmQuota.ts";

export class ThreadVmReplacementConflict extends Schema.TaggedError<ThreadVmReplacementConflict>()(
  "ThreadVmReplacementConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmReplacementConflict({ message });
const savedIntent = {
  threadId: Schema.String,
  actorUserId: Schema.String,
  sourceEnvironmentId: Schema.String,
};
const Intent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reset"),
    ...savedIntent,
    request: RelayThreadVmResetRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("restore"),
    ...savedIntent,
    request: RelayThreadVmRestoreRequest,
  }),
  Schema.Struct({ kind: Schema.Literal("create"), request: RelayThreadVmCreateRequest }),
  Schema.Struct({
    kind: Schema.Literal("move"),
    threadId: Schema.String,
    operationId: Schema.String,
    actorUserId: Schema.String,
    sourceEnvironmentId: Schema.String,
    expectedGeneration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    sourceCredentialId: Schema.String,
    sourcePublicKey: Schema.String,
    sourceAllocationId: Schema.NullOr(Schema.String),
  }),
]);
export type ThreadVmReplacementIntent = typeof Intent.Type;
const encode = Schema.encodeEffect(Schema.fromJsonString(Intent));
const decode = Schema.decodeEffect(Schema.fromJsonString(Intent));
export interface ThreadVmReplacement {
  readonly requestId: string;
  readonly threadId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly repositoryId: string;
  readonly hostId: string;
  readonly templateId: string;
  readonly phase: "awaiting_choice" | "waiting" | "admitted" | "cancelled";
  readonly victimAllocationId: string | null;
  readonly finalSaveOperationId: string | null;
  readonly errorCode: string | null;
  readonly intent: ThreadVmReplacementIntent;
}

/** Database-only coordination. No compute is removed here: the existing certified
 * final-save protocol owns destruction, and the provision worker owns creation. */
export function makeThreadVmReplacementCoordinator(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const saves = makeThreadVmFinalSaveStore(sql, objects);
  const get = Effect.fn("relay.thread_vm.replacement.get")(function* (requestId: string) {
    const [row] = yield* sql<Omit<ThreadVmReplacement, "intent"> & { intentJson: string }>`
      SELECT request_id AS "requestId",thread_id AS "threadId",organization_id AS "organizationId",
        owner_user_id AS "ownerUserId",repository_id AS "repositoryId",host_id AS "hostId",template_id AS "templateId",
        phase,victim_allocation_id AS "victimAllocationId",final_save_operation_id AS "finalSaveOperationId",
        error_code AS "errorCode",intent_json AS "intentJson" FROM relay_thread_vm_replacements WHERE request_id=${requestId}`;
    if (!row) return null;
    const { intentJson, ...request } = row;
    return {
      ...request,
      intent: yield* decode(intentJson).pipe(
        Effect.mapError(() => conflict("The retained VM request is invalid")),
      ),
    };
  });
  const lockOwner = (ownerUserId: string) =>
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerUserId},721864))`;
  const lockThreads = Effect.fnUntraced(function* (
    request: ThreadVmReplacement,
    victimThreadId?: string,
  ) {
    yield* sql`SELECT thread_id FROM relay_thread_placements
      WHERE thread_id IN (${request.threadId},${victimThreadId ?? request.threadId}) ORDER BY thread_id FOR UPDATE`;
  });
  const repositoryAccess = Effect.fnUntraced(function* (
    organizationId: string,
    repositoryId: string,
    ownerUserId: string,
  ) {
    const [membership] = yield* sql<{ role: string }>`SELECT role FROM relay_organization_members
      WHERE organization_id=${organizationId} AND user_id=${ownerUserId} FOR SHARE`;
    if (!membership) return false;
    const repositories = yield* sql`SELECT repository_id FROM relay_repositories
      WHERE repository_id=${repositoryId} AND organization_id=${organizationId} FOR SHARE`;
    if (!repositories.length) return false;
    if (membership.role === "admin") return true;
    const grants = yield* sql`SELECT user_id FROM relay_repository_access
      WHERE repository_id=${repositoryId} AND organization_id=${organizationId} AND user_id=${ownerUserId} FOR SHARE`;
    return grants.length === 1;
  });
  const currentAccess = Effect.fnUntraced(function* (request: ThreadVmReplacement) {
    if (request.intent.kind === "create") return false;
    if (
      !(yield* repositoryAccess(request.organizationId, request.repositoryId, request.ownerUserId))
    )
      return false;
    const intent = request.intent;
    if (intent.kind === "reset" || intent.kind === "restore") {
      const [saved] = yield* sql`SELECT 1 FROM relay_thread_placements t
        JOIN relay_thread_vm_saved_disks s ON s.thread_id=t.thread_id AND s.generation=t.generation
        JOIN relay_thread_vm_final_saves f ON f.operation_id=s.operation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=f.allocation_id
        JOIN relay_thread_native_checkpoints n ON n.operation_id=f.native_checkpoint_operation_id
        JOIN relay_thread_attachment_checkpoints chat ON chat.native_checkpoint_operation_id=n.operation_id
        JOIN relay_thread_vm_policies p ON p.organization_id=t.organization_id
        LEFT JOIN relay_thread_vm_pauses pause ON f.original_state='paused' AND pause.allocation_id=f.allocation_id
          AND pause.generation=f.generation AND pause.phase='completed' AND pause.boot_id IS NOT NULL
          AND pause.native_checkpoint_operation_id=f.native_checkpoint_operation_id AND pause.source_sequence=f.source_sequence
          AND pause.source_frozen_at IS NOT NULL AND pause.source_reopened_at IS NULL
        WHERE t.thread_id=${request.threadId} AND t.owner_user_id=${request.ownerUserId}
          AND t.organization_id=${request.organizationId} AND t.repository_id=${request.repositoryId}
          AND t.environment_id=${intent.sourceEnvironmentId} AND t.generation=${intent.request.expectedGeneration}
          AND t.operation_id IS NULL AND (${intent.kind !== "restore"} OR s.host_id=${request.hostId}) AND f.phase='completed'
          AND a.deleted_at IS NOT NULL AND a.state='deleted' AND n.retained AND n.recovery_history_json IS NOT NULL
          AND n.generation=t.generation AND n.source_environment_id=t.environment_id
          AND n.source_sequence=f.source_sequence
          AND n.capture_operation_id=CASE WHEN f.original_state='paused' THEN pause.operation_id ELSE f.operation_id END
          AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations live WHERE live.thread_id=t.thread_id AND live.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b JOIN relay_environment_credentials k USING(credential_id)
            WHERE b.allocation_id=a.allocation_id AND (b.revoked_at IS NULL OR k.revoked_at IS NULL))
          AND (${intent.kind === "reset"} AND s.phase='expired' OR
            ${intent.kind === "restore"} AND s.phase='available' AND s.operation_id=${intent.kind === "restore" ? intent.request.savedDiskOperationId : null}
            AND a.template_id=${request.templateId}
            AND ((s.saved_at AT TIME ZONE p.calendar_time_zone + make_interval(days => p.saved_disk_retention_days)) AT TIME ZONE p.calendar_time_zone)>clock_timestamp())
          AND (${intent.kind !== "reset"} OR EXISTS(SELECT 1 FROM relay_repository_aliases alias
            WHERE alias.organization_id=t.organization_id AND alias.repository_id=t.repository_id AND alias.canonical_key=${intent.kind === "reset" ? intent.request.canonicalKey : null}))
        FOR SHARE OF s,f,a,n,chat,p`;
      if (!saved) return false;
      if (intent.kind === "reset") {
        const repository = yield* makeThreadMoveCheckpointStore(sql, objects)
          .repositoryUpload(request.threadId)
          .pipe(Effect.catchTag("ThreadMoveCheckpointConflict", () => Effect.succeed(null)));
        return (
          !!repository &&
          repository.revision === intent.request.revision &&
          (repository.branch ?? "main") === intent.request.branch
        );
      }
      return true;
    }
    const [placement] = yield* sql`SELECT 1 FROM relay_thread_placements
      WHERE thread_id=${request.threadId} AND owner_user_id=${request.ownerUserId}
        AND organization_id=${request.organizationId} AND repository_id=${request.repositoryId}
        AND environment_id=${intent.sourceEnvironmentId} AND generation=${intent.expectedGeneration}
        AND operation_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM relay_thread_local_enrollments WHERE thread_id=${request.threadId} AND phase='aborted')`;
    if (!placement) return false;
    const [credential] = yield* sql`SELECT 1 FROM relay_environment_credentials
      WHERE credential_id=${intent.sourceCredentialId} AND environment_id=${intent.sourceEnvironmentId}
        AND environment_public_key=${intent.sourcePublicKey} AND revoked_at IS NULL FOR SHARE`;
    if (!credential) return false;
    if (intent.sourceAllocationId) {
      const [allocation] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations
        WHERE allocation_id=${intent.sourceAllocationId} AND thread_id=${request.threadId}
          AND deleted_at IS NULL AND state!='deleting' FOR SHARE`;
      if (!allocation) return false;
      const bindings = yield* sql`SELECT 1 FROM relay_thread_vm_bindings
        WHERE allocation_id=${intent.sourceAllocationId} AND thread_id=${request.threadId}
          AND repository_id=${request.repositoryId} AND environment_id=${intent.sourceEnvironmentId}
          AND credential_id=${intent.sourceCredentialId} AND environment_public_key=${intent.sourcePublicKey}
          AND generation=${intent.expectedGeneration} AND revoked_at IS NULL FOR SHARE`;
      return bindings.length === 1;
    }
    const links = yield* sql`SELECT 1 FROM relay_environment_links
      WHERE environment_id=${intent.sourceEnvironmentId} AND environment_public_key=${intent.sourcePublicKey}
        AND user_id=${request.ownerUserId} AND revoked_at IS NULL FOR SHARE`;
    if (links.length) return true;
    const machines =
      yield* sql`SELECT 1 FROM relay_machines WHERE environment_id=${intent.sourceEnvironmentId}
      AND environment_public_key=${intent.sourcePublicKey} AND organization_id=${request.organizationId}
      AND deprovisioned_at IS NULL FOR SHARE`;
    return machines.length > 0;
  });
  const record = Effect.fn("relay.thread_vm.replacement.record")(function* (
    input: Pick<
      ThreadVmReplacement,
      | "requestId"
      | "threadId"
      | "organizationId"
      | "repositoryId"
      | "ownerUserId"
      | "hostId"
      | "templateId"
      | "intent"
    >,
  ) {
    if (input.intent.kind === "create") return yield* conflict("thread_vm_move_required");
    const encoded = yield* encode(input.intent).pipe(
      Effect.mapError(() => conflict("Invalid VM request")),
    );
    if (
      input.requestId !==
        (input.intent.kind === "move"
          ? input.intent.operationId
          : input.intent.request.operationId) ||
      input.threadId !== input.intent.threadId ||
      input.ownerUserId !== input.intent.actorUserId
    )
      return yield* conflict("VM request identity changed");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockOwner(input.ownerUserId);
        const prior = yield* get(input.requestId);
        if (prior) {
          if (
            prior.ownerUserId !== input.ownerUserId ||
            prior.threadId !== input.threadId ||
            prior.organizationId !== input.organizationId ||
            prior.repositoryId !== input.repositoryId ||
            prior.hostId !== input.hostId ||
            prior.templateId !== input.templateId ||
            (yield* encode(prior.intent)) !== encoded
          )
            return yield* conflict("VM request ID reused with different intent");
          return prior;
        }
        const request = {
          ...input,
          phase: "awaiting_choice" as const,
          victimAllocationId: null,
          finalSaveOperationId: null,
          errorCode: null,
        };
        yield* lockThreads(request);
        if (!(yield* currentAccess(request)))
          return yield* conflict("VM request no longer has current owner access");
        const pending = yield* sql`SELECT 1 FROM relay_thread_vm_replacements
        WHERE thread_id=${input.threadId} AND phase IN ('awaiting_choice','waiting')`;
        if (pending.length) return yield* conflict("Thread already has a waiting VM request");
        yield* sql`INSERT INTO relay_thread_vm_replacements(request_id,thread_id,organization_id,repository_id,owner_user_id,host_id,template_id,intent_json,phase)
        VALUES(${input.requestId},${input.threadId},${input.organizationId},${input.repositoryId},${input.ownerUserId},${input.hostId},${input.templateId},${encoded},'awaiting_choice')`;
        return (yield* get(input.requestId))!;
      }),
    );
  });
  const admit = Effect.fnUntraced(function* (request: ThreadVmReplacement) {
    const replacementRequestId = request.phase === "waiting" ? request.requestId : undefined;
    if (request.intent.kind === "create") return yield* conflict("thread_vm_move_required");
    else if (request.intent.kind === "reset")
      yield* makeThreadVmResetStore(sql, objects).begin({
        ...request.intent.request,
        threadId: request.threadId,
        actorUserId: request.ownerUserId,
        hostId: request.hostId,
        templateId: request.templateId,
        ...(replacementRequestId ? { replacementRequestId } : {}),
      });
    else if (request.intent.kind === "restore")
      yield* makeThreadVmRestoreStore(sql, objects).begin({
        ...request.intent.request,
        threadId: request.threadId,
        actorUserId: request.ownerUserId,
        serving: true,
        ...(replacementRequestId ? { replacementRequestId } : {}),
      });
    else
      yield* makeThreadVmMoveDestinationStore(sql).enqueue({
        ...request.intent,
        hostId: request.hostId,
        templateId: request.templateId,
        cancelBeforeStart: false,
        ...(replacementRequestId ? { replacementRequestId } : {}),
      });
    yield* sql`UPDATE relay_thread_vm_replacements SET phase='admitted',error_code=NULL WHERE request_id=${request.requestId}`;
    return (yield* get(request.requestId))!;
  });
  const cancelLocked = Effect.fnUntraced(function* (
    request: ThreadVmReplacement,
    errorCode: string | null,
  ) {
    if (request.phase === "admitted")
      return yield* conflict(
        "Cancel the admitted VM setup or move through its normal cancellation path",
      );
    if (request.phase === "cancelled") return request;
    yield* sql`UPDATE relay_thread_vm_replacements SET phase='cancelled',error_code=${errorCode} WHERE request_id=${request.requestId}`;
    if (request.finalSaveOperationId) {
      const save = yield* saves.get(request.finalSaveOperationId);
      // After saved-only wins, destruction must reconcile, but incoming admission stays cancelled.
      if (save && !["deleting", "completed", "aborted", "aborting"].includes(save.phase))
        yield* saves.requestAbort(save.operationId);
    }
    return (yield* get(request.requestId))!;
  });
  const owned = Effect.fnUntraced(function* (requestId: string, ownerUserId: string) {
    const request = yield* get(requestId);
    if (!request || request.ownerUserId !== ownerUserId)
      return yield* conflict("VM request does not belong to this user");
    return request;
  });
  const select = Effect.fn("relay.thread_vm.replacement.select")(function* (input: {
    requestId: string;
    ownerUserId: string;
    victimAllocationId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockOwner(input.ownerUserId);
        const request = yield* owned(input.requestId, input.ownerUserId);
        if (request.intent.kind === "create") return yield* conflict("thread_vm_move_required");
        if (request.phase === "waiting" || request.phase === "admitted") {
          if (request.victimAllocationId && request.victimAllocationId !== input.victimAllocationId)
            return yield* conflict("The replacement choice has already been committed");
          return request;
        }
        if (request.phase === "cancelled") return yield* conflict("The VM request was cancelled");
        const [victim] = yield* sql<{
          threadId: string;
          organizationId: string;
          repositoryId: string;
          generation: number;
        }>`
        SELECT t.thread_id AS "threadId",t.organization_id AS "organizationId",t.repository_id AS "repositoryId",t.generation
        FROM relay_thread_vm_allocations a JOIN relay_thread_placements t USING(thread_id)
        WHERE a.allocation_id=${input.victimAllocationId} AND a.owner_user_id=${input.ownerUserId}
          AND t.owner_user_id=${input.ownerUserId} AND a.deleted_at IS NULL`;
        yield* lockThreads(request, victim?.threadId);
        if (!(yield* currentAccess(request)))
          return yield* conflict("VM request no longer has current owner access");
        const policy = yield* lockThreadVmPolicy(sql, request.organizationId);
        if ((yield* threadVmQuotaUsage(sql, request.ownerUserId)) < policy.policy.maxVmsPerUser)
          return yield* admit(request); // A naturally freed slot needs no victim.
        if (
          !victim ||
          victim.threadId === request.threadId ||
          !(yield* repositoryAccess(
            victim.organizationId,
            victim.repositoryId,
            request.ownerUserId,
          ))
        )
          return yield* conflict("The replacement VM is not an accessible private allocation");
        const selected = yield* sql`SELECT 1 FROM relay_thread_vm_replacements
        WHERE victim_allocation_id=${input.victimAllocationId} AND phase='waiting'`;
        if (selected.length) return yield* conflict("Another request already selected this VM");
        const crypto = yield* Crypto.Crypto;
        const save = yield* saves.begin({
          operationId: yield* crypto.randomUUIDv4,
          threadId: victim.threadId,
          allocationId: input.victimAllocationId,
          actorUserId: request.ownerUserId,
          expectedGeneration: victim.generation,
          reason: "replacement",
        });
        yield* sql`UPDATE relay_thread_vm_replacements SET phase='waiting',victim_allocation_id=${input.victimAllocationId},
        final_save_operation_id=${save.operationId},checked_at=NULL,error_code=NULL WHERE request_id=${request.requestId}`;
        return (yield* get(request.requestId))!;
      }),
    );
  });
  const cancel = Effect.fn("relay.thread_vm.replacement.cancel")(function* (input: {
    requestId: string;
    ownerUserId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockOwner(input.ownerUserId);
        const request = yield* owned(input.requestId, input.ownerUserId);
        const save = request.finalSaveOperationId
          ? yield* saves.get(request.finalSaveOperationId)
          : null;
        yield* lockThreads(request, save?.threadId);
        return yield* cancelLocked(request, null);
      }),
    );
  });
  const runOne = Effect.fn("relay.thread_vm.replacement.advance_one")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const candidates = yield* sql<{
          requestId: string;
          ownerUserId: string;
        }>`SELECT r.request_id AS "requestId",r.owner_user_id AS "ownerUserId"
        FROM relay_thread_vm_replacements r
        WHERE r.host_id=${hostId} AND r.phase IN ('awaiting_choice','waiting')
          AND (r.checked_at IS NULL OR r.checked_at<clock_timestamp()-interval '1 minute')
        ORDER BY r.checked_at ASC NULLS FIRST,r.position LIMIT 32`;
        let candidate: (typeof candidates)[number] | undefined;
        for (const pending of candidates) {
          const [ownerLock] = yield* sql<{
            held: boolean;
          }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${pending.ownerUserId},721864)) AS held`;
          if (ownerLock?.held) {
            candidate = pending;
            break;
          }
        }
        if (!candidate) return false;
        const request = yield* get(candidate.requestId);
        if (!request || !["awaiting_choice", "waiting"].includes(request.phase)) return true;
        let save = request.finalSaveOperationId
          ? yield* saves.get(request.finalSaveOperationId)
          : null;
        yield* lockThreads(request, save?.threadId);
        if (save) save = yield* saves.get(save.operationId);
        yield* sql`UPDATE relay_thread_vm_replacements SET checked_at=clock_timestamp() WHERE request_id=${request.requestId}`;
        if (request.intent.kind === "create") {
          yield* cancelLocked(request, "thread_vm_move_required");
          return true;
        }
        if (!(yield* currentAccess(request))) {
          yield* cancelLocked(request, "access_or_placement_changed");
          return true;
        }
        if (save && ["aborting", "aborted"].includes(save.phase)) {
          yield* cancelLocked(request, "replacement_aborted");
          return true;
        }
        if (request.phase === "waiting") {
          const absent = yield* sql`SELECT 1 FROM relay_thread_vm_allocations
          WHERE allocation_id=${request.victimAllocationId} AND state='deleted' AND deleted_at IS NOT NULL`;
          if (!save || save.phase !== "completed" || !absent.length) return true;
        }
        const hold = (errorCode: string) =>
          sql`UPDATE relay_thread_vm_replacements SET error_code=${errorCode} WHERE request_id=${request.requestId}`;
        yield* admit(request).pipe(
          Effect.catchTags({
            ThreadVmQuotaExceeded: () =>
              hold(request.phase === "awaiting_choice" ? "quota_reached" : "quota_policy"),
            ThreadPlacementConflict: () => hold("source_busy"),
            ThreadVmAllocationConflict: () => hold("destination_conflict"),
            ThreadVmProvisionConflict: () => hold("destination_conflict"),
            ThreadVmCapacityConflict: () => hold("destination_conflict"),
            ThreadVmResetConflict: () => hold("recovery_changed"),
            ThreadVmRestoreConflict: () => hold("recovery_changed"),
            ThreadVmSavedDiskConflict: () => hold("recovery_changed"),
            ThreadNativeCheckpointConflict: () => hold("recovery_changed"),
            ThreadVmBackupConflict: () => hold("recovery_changed"),
            ThreadMoveCheckpointConflict: () => hold("recovery_changed"),
          }),
        );
        return true;
      }),
    );
  });
  return { get, record, select, cancel, runOne, currentAccess };
}
