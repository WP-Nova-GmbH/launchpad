import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadId } from "@t3tools/contracts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import {
  makeThreadVmRestoreStore,
  ThreadVmRestoreConflict,
  type ThreadVmRestoreClaim,
} from "./ThreadVmRestoreStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "./ThreadAttachmentCheckpointStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";
const fail = () =>
  new ThreadVmRestoreConflict({
    message: "Restored conversation readiness or current ownership is unconfirmed.",
  });
const decodeReceipt = Schema.decodeUnknownEffect(RelayThreadVmRestoreImportReceipt);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmRestoreImportReceipt));

/** Imported bytes and a launch reply grant no execution. Only the enrolled guest's
 * later native/setup readiness handshake releases the placement and recovery pins. */
export function makeThreadVmRestoreImportStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const restores = makeThreadVmRestoreStore(sql, objects);
  const claim = Effect.fn("relay.thread_vm.restore.claim_import")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId" FROM relay_thread_vm_restores r
        JOIN relay_thread_placements t USING(thread_id) JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE r.host_id=${hostId} AND r.serving_requested AND r.phase IN ('importing','completed') AND a.state='running' AND a.deleted_at IS NULL
          AND t.generation=r.generation+1 AND (t.operation_id=r.operation_id OR (r.phase='completed' AND t.operation_id IS NULL))
          AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp())
        ORDER BY r.retry_at,r.created_at,r.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const row = yield* restores.lock(candidate.operationId),
          claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_restores SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${row.operationId}`;
        return { ...row, claimId };
      }),
    );
  });
  const current = Effect.fnUntraced(function* (operationId: string) {
    const row = yield* restores.lock(operationId);
    if (!row.servingRequested || !["importing", "completed"].includes(row.phase))
      return yield* fail();
    return yield* withPrivateThreadOwnerAccess(
      ThreadId.make(row.threadId),
      "write",
      row.actorUserId,
      () =>
        Effect.gen(function* () {
          const [binding] = yield* sql<{
            environmentId: string;
            repositoryId: string;
            canonicalKey: string;
            templateId: string;
          }>`SELECT b.environment_id AS "environmentId",b.repository_id AS "repositoryId",alias.canonical_key AS "canonicalKey",a.template_id AS "templateId"
        FROM relay_thread_placements t JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
        JOIN relay_thread_vm_enrollments e ON e.allocation_id=b.allocation_id JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
        JOIN relay_thread_vm_capacity c ON c.operation_id=p.operation_id
        JOIN LATERAL (SELECT canonical_key FROM relay_repository_aliases WHERE repository_id=t.repository_id AND organization_id=t.organization_id AND canonical_key LIKE 'github.com/%' ORDER BY canonical_key LIMIT 1) alias ON true
        WHERE t.thread_id=${row.threadId} AND t.generation=${row.generation + 1} AND t.owner_user_id=${row.actorUserId}
          AND (t.operation_id=${row.operationId} OR (${row.phase === "completed"} AND t.operation_id IS NULL))
          AND b.allocation_id=${row.allocationId} AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.repository_id=t.repository_id
          AND b.revoked_at IS NULL AND e.operation_id=${row.operationId} AND e.installed_at IS NOT NULL AND e.environment_id=b.environment_id
          AND e.credential_id=b.credential_id AND e.environment_public_key=b.environment_public_key AND k.revoked_at IS NULL
          AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref=${row.bootReceipt?.sandboxID ?? ""}
          AND p.operation_id=${row.operationId} AND p.phase='created' AND p.generation=t.generation
          AND c.state='started' AND c.compute_ref=a.compute_ref FOR SHARE OF b,e,a,p,k,c`;
          if (!binding) return yield* fail();
          if (row.phase !== "completed") yield* restores.requireRecovery(row);
          const [stored] = yield* sql<{
            receipt: unknown;
            identityCleaned: boolean;
          }>`SELECT import_receipt AS receipt, identity_cleaned_at IS NOT NULL AS "identityCleaned" FROM relay_thread_vm_restores WHERE operation_id=${row.operationId}`;
          return {
            ...row,
            ...binding,
            receipt: stored?.receipt ? yield* decodeReceipt(stored.receipt) : null,
            identityCleaned: stored?.identityCleaned ?? false,
            scope: {
              allocationId: row.allocationId,
              threadId: ThreadId.make(row.threadId),
              repositoryId: binding.repositoryId,
              generation: row.generation + 1,
            },
          };
        }),
    );
  });
  const authorize = Effect.fn("relay.thread_vm.restore.authorize_import")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* restores.requireClaim(claim);
        return yield* current(claim.operationId);
      }),
    );
  });
  const record = Effect.fn("relay.thread_vm.restore.import_receipt")(function* (
    claim: ThreadVmRestoreClaim,
    receipt: RelayThreadVmRestoreImportReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim),
          decoded = yield* decodeReceipt(receipt);
        const native = yield* makeThreadNativeCheckpointStore(sql, objects).getForOperation(row),
          chat = yield* makeThreadAttachmentCheckpointStore(sql, objects).getForOperation(row);
        if (
          row.phase !== "importing" ||
          !native ||
          !chat ||
          decoded.operationId !== row.operationId ||
          decoded.environmentId !== row.environmentId ||
          decoded.scope.allocationId !== row.allocationId ||
          decoded.scope.threadId !== row.threadId ||
          decoded.scope.repositoryId !== row.repositoryId ||
          decoded.scope.generation !== row.generation + 1 ||
          decoded.projectId !== `vm:${row.threadId}` ||
          decoded.workspaceRoot !== "/workspace/project" ||
          (decoded.checkoutPath !== decoded.workspaceRoot &&
            !decoded.checkoutPath.startsWith("/home/user/.launchpad/worktrees/")) ||
          decoded.sourceEnvironmentId !== native.sourceEnvironmentId ||
          decoded.sourceSequence !== native.sourceSequence ||
          decoded.nativeManifestArtifactId !== native.manifestArtifactId ||
          decoded.attachmentManifestArtifactId !== chat.manifestArtifactId
        )
          return yield* fail();
        const encoded = yield* encodeReceipt(decoded);
        if (row.receipt && (yield* encodeReceipt(row.receipt)) !== encoded) return yield* fail();
        yield* sql`UPDATE relay_thread_vm_restores SET import_receipt=${encoded}::jsonb WHERE operation_id=${row.operationId}`;
        return decoded;
      }),
    );
  });
  const finish = Effect.fn("relay.thread_vm.restore.confirm_activation")(function* (
    receipt: RelayThreadVmRestoreImportReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* current(receipt.operationId),
          decoded = yield* decodeReceipt(receipt);
        if (!row.receipt || (yield* encodeReceipt(row.receipt)) !== (yield* encodeReceipt(decoded)))
          return yield* fail();
        if (row.phase === "completed") return { ready: true };
        const digest = yield* (yield* Crypto.Crypto).digest(
          "SHA-256",
          new TextEncoder().encode(yield* encodeReceipt(decoded)),
        );
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
        VALUES(${row.allocationId},${row.canonicalKey},${decoded.branch ?? "detached"},${decoded.revision},'ready',${row.environmentId},${sha256})`;
        const changed =
          yield* sql`UPDATE relay_thread_placements SET operation_id=NULL,project_id=${decoded.projectId}
        WHERE thread_id=${row.threadId} AND generation=${row.generation + 1} AND environment_id=${row.environmentId} AND operation_id=${row.operationId} RETURNING thread_id`;
        if (!changed.length) return yield* fail();
        if (row.savedDiskOperationId)
          yield* makeThreadVmSavedDiskStore(sql).completeRestore({
            threadId: row.threadId,
            savedDiskOperationId: row.savedDiskOperationId,
            operationId: row.operationId,
          });
        else {
          const [recovery] = yield* sql<{
            backupOperationId: string;
          }>`UPDATE relay_thread_vm_backup_recoveries SET phase='completed',claim_id=NULL,claim_until=NULL,error_code=NULL WHERE operation_id=${row.backupRecoveryOperationId} AND phase='restoring' RETURNING backup_operation_id AS "backupOperationId"`;
          if (!recovery) return yield* fail();
          yield* makeThreadVmBackupRetentionStore(sql).releasePin({
            ...row,
            backupOperationId: recovery.backupOperationId,
          });
          yield* makeThreadVmRecoveryHistory(sql, objects).release(row);
        }
        yield* makeThreadNativeCheckpointStore(sql, objects).releaseOperation(row);
        yield* sql`UPDATE relay_thread_vm_restores SET phase='completed',claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${row.operationId}`;
        return { ready: true };
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.restore.defer_import")(function* (
    claim: ThreadVmRestoreClaim,
    errorCode: string | null,
  ) {
    yield* sql`UPDATE relay_thread_vm_restores SET claim_id=NULL,claim_until=NULL,error_code=${errorCode},retry_at=clock_timestamp()+interval '1 minute'
      WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()`;
  });
  const recordCleanup = Effect.fn("relay.thread_vm.restore.record_cleanup")(function* (
    claim: ThreadVmRestoreClaim,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim);
        if (row.phase !== "completed") return yield* fail();
        yield* sql`UPDATE relay_thread_vm_restores SET identity_cleaned_at=COALESCE(identity_cleaned_at,clock_timestamp()) WHERE operation_id=${row.operationId}`;
      }),
    );
  });
  return { claim, authorize, record, finish, defer, recordCleanup };
}
