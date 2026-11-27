import * as NodeCrypto from "node:crypto";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayThreadVmRepositoryUpload } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "../ThreadArtifactObjects.ts";
import { makeThreadArtifactTransfer } from "../ThreadArtifactTransfer.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(RelayThreadVmRepositoryUpload));

/** Admission fixture for a previously verified local move. Real Git bundle
 * semantics are exercised by the server's uploaded workspace tests. */
export const repositoryUploadCatalogFixture = Effect.fnUntraced(function* (
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  threadId: string,
  revision = "b".repeat(40),
  generation = 1,
) {
  const operationId = NodeCrypto.randomUUID(),
    artifactId = NodeCrypto.randomUUID();
  const bytes = new TextEncoder().encode("retained Git bundle fixture");
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const upload: RelayThreadVmRepositoryUpload = {
    operationId,
    threadId: ThreadId.make(threadId),
    sourceEnvironmentId: EnvironmentId.make("local-upload"),
    generation,
    branch: "main",
    revision,
    objectFormat: "sha1",
    bundle: {
      sha256,
      sizeBytes: bytes.length,
      chunks: [{ artifactId, sha256, sizeBytes: bytes.length }],
    },
  };
  const transfer = makeThreadArtifactTransfer(sql, objects);
  const intent = {
    artifactId,
    threadId,
    operationId,
    kind: "workspace" as const,
    sha256,
    sizeBytes: bytes.length,
  };
  yield* transfer.upload({
    ...intent,
    retentionDays: null,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
  yield* sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256)
    VALUES(${operationId},${threadId},'user','local-upload',${generation},'vm-upload','project','completed',0,${sha256})`;
  yield* sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,artifact_count,workspace_branch,workspace_revision,repository_upload,repository_retained)
    VALUES(${operationId},${threadId},${artifactId},1,'main',${revision},${encode(upload)}::jsonb,true)`;
  yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id) VALUES(${artifactId},${`move-repository:${operationId}`})`;
  return upload;
});
