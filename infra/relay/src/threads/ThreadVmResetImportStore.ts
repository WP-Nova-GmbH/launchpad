import type { PgClient } from "@effect/sql-pg/PgClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadVmResetStore, ThreadVmResetConflict } from "./ThreadVmResetStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "./ThreadAttachmentCheckpointStore.ts";
const decodeReceipt = Schema.decodeUnknownEffect(RelayThreadVmRestoreImportReceipt);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmRestoreImportReceipt));
const fail = () =>
  new ThreadVmResetConflict({
    message: "Reset conversation, checkout, or current ownership is unconfirmed.",
  });

/** Fresh private guest only. Importing does not release ownership; its later
 * strict native/setup readiness acknowledgement does. Queue pause is part of the imported baseline. */
export function makeThreadVmResetImportStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const resets = makeThreadVmResetStore(sql, objects),
    natives = makeThreadNativeCheckpointStore(sql, objects);
  const current = Effect.fn("relay.thread_vm.reset.current_import")(function* (
    operationId: string,
  ) {
    const row = yield* resets.lock(operationId);
    if (!["importing", "completed"].includes(row.phase)) return yield* fail();
    return yield* withPrivateThreadOwnerAccess(
      ThreadId.make(row.threadId),
      "write",
      row.actorUserId,
      () =>
        Effect.gen(function* () {
          const [binding] = yield* sql<{
            environmentId: string;
            repositoryId: string;
            computeRef: string;
          }>`
        SELECT b.environment_id AS "environmentId",b.repository_id AS "repositoryId",a.compute_ref AS "computeRef"
        FROM relay_thread_placements t JOIN relay_thread_vm_bindings b ON b.thread_id=t.thread_id
        JOIN relay_thread_vm_enrollments e ON e.allocation_id=b.allocation_id
        JOIN relay_thread_vm_allocations a ON a.allocation_id=b.allocation_id
        JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
        JOIN relay_environment_credentials k ON k.credential_id=b.credential_id
        JOIN relay_thread_vm_capacity c ON c.operation_id=p.operation_id
        JOIN relay_repository_aliases alias ON alias.repository_id=t.repository_id AND alias.organization_id=t.organization_id
        WHERE t.thread_id=${row.threadId} AND t.generation=${row.expectedGeneration + 1} AND t.owner_user_id=${row.actorUserId}
          AND (t.operation_id=${row.operationId} OR (${row.phase === "completed"} AND t.operation_id IS NULL))
          AND b.allocation_id=${row.allocationId} AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.repository_id=t.repository_id
          AND b.revoked_at IS NULL AND e.operation_id=${row.operationId} AND e.installed_at IS NOT NULL AND e.environment_id=b.environment_id
          AND e.credential_id=b.credential_id AND e.environment_public_key=b.environment_public_key AND k.revoked_at IS NULL
          AND a.state='running' AND a.deleted_at IS NULL AND p.operation_id=${row.operationId} AND p.phase='created' AND p.generation=t.generation
          AND c.state='started' AND c.compute_ref=a.compute_ref AND alias.canonical_key=${row.canonicalKey} FOR SHARE OF b,e,a,p,k,c,alias`;
          if (!binding) return yield* fail();
          const native = row.phase === "importing" ? yield* natives.getForOperation(row) : null,
            attachments =
              row.phase === "importing"
                ? yield* makeThreadAttachmentCheckpointStore(sql, objects).getForOperation(row)
                : null;
          if (
            row.phase === "importing" &&
            (!native?.recoveryHistory ||
              !attachments ||
              native.operationId !== row.nativeCheckpointOperationId ||
              native.generation !== row.expectedGeneration ||
              native.sourceEnvironmentId !== row.sourceEnvironmentId ||
              native.sourceSequence !== row.sourceSequence ||
              attachments.nativeArchiveSha256 !== native.archiveSha256 ||
              attachments.sourceSequence !== native.sourceSequence)
          )
            return yield* fail();
          if (native)
            yield* natives.pinCompleteForOperation({
              ...row,
              checkpointOperationId: native.operationId,
              expected: native,
            });
          const [saved] = yield* sql<{
            receipt: unknown;
          }>`SELECT import_receipt AS receipt FROM relay_thread_vm_resets WHERE operation_id=${row.operationId}`;
          return {
            ...row,
            ...binding,
            native,
            attachments,
            receipt: saved?.receipt ? yield* decodeReceipt(saved.receipt) : null,
            scope: {
              allocationId: row.allocationId,
              threadId: ThreadId.make(row.threadId),
              repositoryId: binding.repositoryId,
              generation: row.expectedGeneration + 1,
            },
          };
        }),
    );
  });
  const claim = Effect.fn("relay.thread_vm.reset.claim_import")(function* (hostId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<{
          operationId: string;
        }>`SELECT r.operation_id AS "operationId" FROM relay_thread_vm_resets r
        JOIN relay_thread_placements t USING(thread_id) JOIN relay_thread_vm_allocations a ON a.allocation_id=r.allocation_id
        WHERE r.host_id=${hostId} AND r.phase IN ('importing','completed') AND a.state='running' AND a.deleted_at IS NULL
          AND t.generation=r.expected_generation+1 AND (t.operation_id=r.operation_id OR (r.phase='completed' AND t.operation_id IS NULL))
          AND r.retry_at<=clock_timestamp() AND (r.claim_until IS NULL OR r.claim_until<=clock_timestamp())
        ORDER BY r.retry_at,r.created_at,r.operation_id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
        if (!candidate) return null;
        const row = yield* resets.lock(candidate.operationId),
          claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_vm_resets SET claim_id=${claimId},claim_until=clock_timestamp()+interval '3 minutes' WHERE operation_id=${row.operationId}`;
        return { operationId: row.operationId, claimId };
      }),
    );
  });
  const authorize = Effect.fn("relay.thread_vm.reset.authorize_import")(function* (claim: {
    operationId: string;
    claimId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* resets.lock(claim.operationId);
        const held =
          yield* sql`SELECT 1 FROM relay_thread_vm_resets WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()`;
        if (!held.length) return yield* fail();
        return yield* current(claim.operationId);
      }),
    );
  });
  const record = Effect.fn("relay.thread_vm.reset.record_import")(function* (
    claim: { operationId: string; claimId: string },
    receipt: RelayThreadVmRestoreImportReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* authorize(claim),
          decoded = yield* decodeReceipt(receipt);
        if (
          row.phase !== "importing" ||
          !row.native ||
          !row.attachments ||
          decoded.operationId !== row.operationId ||
          decoded.environmentId !== row.environmentId ||
          decoded.scope.allocationId !== row.allocationId ||
          decoded.scope.threadId !== row.threadId ||
          decoded.scope.repositoryId !== row.repositoryId ||
          decoded.scope.generation !== row.expectedGeneration + 1 ||
          decoded.projectId !== `vm:${row.threadId}` ||
          decoded.workspaceRoot !== "/workspace/project" ||
          decoded.checkoutPath !== decoded.workspaceRoot ||
          decoded.branch !== row.branch ||
          decoded.revision !== row.revision ||
          !row.repositoryUpload ||
          decoded.repositoryBundleSha256 !== row.repositoryUpload.bundle.sha256 ||
          decoded.sourceEnvironmentId !== row.sourceEnvironmentId ||
          decoded.sourceSequence !== row.sourceSequence ||
          decoded.nativeManifestArtifactId !== row.native.manifestArtifactId ||
          decoded.attachmentManifestArtifactId !== row.attachments.manifestArtifactId
        )
          return yield* fail();
        const encoded = yield* encodeReceipt(decoded);
        if (row.receipt && (yield* encodeReceipt(row.receipt)) !== encoded) return yield* fail();
        yield* sql`UPDATE relay_thread_vm_resets SET import_receipt=${encoded}::jsonb WHERE operation_id=${row.operationId}`;
        return decoded;
      }),
    );
  });
  const finish = Effect.fn("relay.thread_vm.reset.activate_import")(function* (
    receipt: RelayThreadVmRestoreImportReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* current(receipt.operationId),
          decoded = yield* decodeReceipt(receipt);
        if (
          !row.repositoryUpload ||
          decoded.repositoryBundleSha256 !== row.repositoryUpload.bundle.sha256 ||
          !row.receipt ||
          (yield* encodeReceipt(row.receipt)) !== (yield* encodeReceipt(decoded))
        )
          return yield* fail();
        if (row.phase === "completed") return { ready: true };
        const hash = yield* (yield* Crypto.Crypto).digest(
            "SHA-256",
            new TextEncoder().encode(yield* encodeReceipt(decoded)),
          ),
          digest = Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
        VALUES(${row.allocationId},${row.canonicalKey},${row.branch},${row.revision},'ready',${row.environmentId},${digest})`;
        const changed =
          yield* sql`UPDATE relay_thread_placements SET operation_id=NULL,project_id=${decoded.projectId}
        WHERE thread_id=${row.threadId} AND generation=${row.expectedGeneration + 1} AND environment_id=${row.environmentId} AND operation_id=${row.operationId} RETURNING thread_id`;
        if (!changed.length) return yield* fail();
        yield* natives.releaseOperation(row);
        yield* sql`UPDATE relay_thread_vm_resets SET phase='completed',claim_id=NULL,claim_until=NULL,error_code=NULL,retry_at=clock_timestamp()+interval '1 minute' WHERE operation_id=${row.operationId}`;
        return { ready: true };
      }),
    );
  });
  const defer = Effect.fn("relay.thread_vm.reset.defer_import")(function* (
    claim: { operationId: string; claimId: string },
    errorCode: string | null,
  ) {
    yield* sql`UPDATE relay_thread_vm_resets SET claim_id=NULL,claim_until=NULL,error_code=${errorCode},retry_at=clock_timestamp()+interval '1 minute'
      WHERE operation_id=${claim.operationId} AND claim_id=${claim.claimId} AND claim_until>clock_timestamp()`;
  });
  const recovery = Effect.fn("relay.thread_vm.reset.recovery")(function* (operationId: string) {
    const row = yield* current(operationId);
    if (row.phase !== "importing" || !row.native || !row.attachments || !row.repositoryUpload)
      return yield* fail();
    return {
      operationId: row.operationId,
      savedDiskOperationId: row.savedDiskOperationId,
      environmentId: EnvironmentId.make(row.environmentId),
      scope: row.scope,
      native: row.native,
      attachments: row.attachments,
      reset: {
        canonicalKey: row.canonicalKey,
        branch: row.branch,
        revision: row.revision,
        repositoryUpload: row.repositoryUpload,
      },
    };
  });
  return { claim, authorize, record, finish, defer, recovery };
}
