import { makeThreadMoveCheckpointStore } from "./ThreadMoveCheckpointStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactStore, type ThreadArtifactKind } from "./ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";

type Objects = ReturnType<typeof makeThreadArtifactObjects>;
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));
const ExpectedArtifact = Schema.Struct({
  artifactId: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  kind: Schema.String,
});
const encodeExpected = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ExpectedArtifact)));
export class ThreadMoveArtifactConflict extends Schema.TaggedError<ThreadMoveArtifactConflict>()(
  "ThreadMoveArtifactConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadMoveArtifactConflict({ message });

const kindFor = (file: string): ThreadArtifactKind | null => {
  if (file === "manifest.json") return "manifest";
  if (file.startsWith("history/")) return "history";
  if (file.startsWith("workspace/")) return "workspace";
  if (file.startsWith("attachments/")) return "attachment";
  if (file.startsWith("native/")) return "native";
  return null;
};
const expectedArtifacts = (manifest: ThreadTransferChunkManifest) => {
  const entries: Array<typeof ExpectedArtifact.Type> = [];
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  const filePaths = new Set<string>();
  let manifestFile = false;
  for (const file of manifest.files) {
    const kind = kindFor(file.path);
    const parts = file.path.split("/");
    if (
      !kind ||
      file.path.length > 4096 ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes("\\") ||
          part.includes(":") ||
          /[. ]$/u.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32),
      )
    )
      return null;
    if (filePaths.has(file.path)) return null;
    filePaths.add(file.path);
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const folded = prefix.normalize("NFD").toLowerCase();
      const prior = paths.get(folded);
      if (prior && prior !== prefix) return null;
      paths.set(folded, prefix);
    }
    if (file.path === "manifest.json") {
      if (file.sha256 !== manifest.transferManifestSha256) return null;
      manifestFile = true;
    }
    let size = 0;
    for (const chunk of file.chunks) {
      if (ids.has(chunk.artifactId) || chunk.sizeBytes > 64 * 1024 * 1024) return null;
      ids.add(chunk.artifactId);
      size += chunk.sizeBytes;
      entries.push({ ...chunk, kind });
    }
    if (size !== file.sizeBytes) return null;
  }
  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index++)
      if (filePaths.has(parts.slice(0, index).join("/"))) return null;
  }
  if (!manifestFile || filePaths.size > 100_000 || entries.length > 100_000) return null;
  return entries;
};

/** Publishing is an atomic pointer and pin set, never evidence that an upload merely started. */
export function makeThreadMoveArtifactStore(sql: PgClient, objects: Objects) {
  const catalog = makeThreadArtifactStore(sql);
  const transfer = makeThreadArtifactTransfer(sql, objects);
  const get = Effect.fn("relay.thread_move_artifacts.get")(function* (operationId: string) {
    const [row] = yield* sql<{
      manifestArtifactId: string;
    }>`SELECT manifest_artifact_id AS "manifestArtifactId"
      FROM relay_thread_move_artifacts WHERE operation_id = ${operationId}`;
    return row ?? null;
  });
  const publish = Effect.fn("relay.thread_move_artifacts.publish")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly manifestArtifactId: string;
  }) {
    const artifact = yield* catalog.get(input.manifestArtifactId);
    if (
      !artifact ||
      artifact.threadId !== input.threadId ||
      artifact.operationId !== input.operationId ||
      artifact.kind !== "manifest" ||
      artifact.sizeBytes > 32 * 1024 * 1024
    )
      return yield* conflict("Move artifact manifest is unavailable.");
    const [current] = yield* sql`SELECT 1 FROM relay_thread_moves m
      JOIN relay_thread_placements t ON t.thread_id = m.thread_id
      WHERE m.operation_id = ${input.operationId} AND m.thread_id = ${input.threadId}
        AND m.phase IN ('frozen','ready') AND t.operation_id = m.operation_id`;
    if (!current) return yield* conflict("Move is not awaiting transfer artifacts.");
    const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const stream = yield* transfer.readPinned({
      threadId: input.threadId,
      artifactId: input.manifestArtifactId,
      operationId: readPinId,
    });
    const publishVerified = Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      let length = 0;
      yield* stream.pipe(
        Stream.runForEach((part) =>
          Effect.gen(function* () {
            length += part.length;
            if (length > 32 * 1024 * 1024)
              return yield* conflict("Move artifact manifest is too large.");
            chunks.push(part);
          }),
        ),
      );
      if (length !== artifact.sizeBytes || length > 32 * 1024 * 1024)
        return yield* conflict("Move artifact manifest size changed.");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const encoded = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => conflict("Move artifact manifest is not UTF-8."),
      });
      const manifest = yield* decodeManifest(encoded).pipe(
        Effect.mapError(() => conflict("Move artifact manifest is invalid.")),
      );
      if (manifest.threadId !== input.threadId || manifest.operationId !== input.operationId)
        return yield* conflict("Move artifact manifest belongs to another operation.");
      const entries = expectedArtifacts(manifest);
      if (!entries) return yield* conflict("Move artifact file set is invalid.");
      entries.push({
        artifactId: input.manifestArtifactId,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        kind: "manifest",
      });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [placement] = yield* sql<{ operationId: string | null }>`SELECT
          operation_id AS "operationId" FROM relay_thread_placements
          WHERE thread_id = ${input.threadId} FOR UPDATE`;
          const [move] = yield* sql<{
            phase: string;
            sourceEnvironmentId: string;
            expectedGeneration: number;
            manifestSha256: string | null;
          }>`SELECT phase,
          source_environment_id AS "sourceEnvironmentId",
          expected_generation AS "expectedGeneration",
          manifest_sha256 AS "manifestSha256"
          FROM relay_thread_moves WHERE operation_id = ${input.operationId}
            AND thread_id = ${input.threadId} FOR UPDATE`;
          if (
            placement?.operationId !== input.operationId ||
            !move ||
            !["frozen", "ready"].includes(move.phase) ||
            move.sourceEnvironmentId !== manifest.sourceEnvironmentId ||
            move.expectedGeneration !== manifest.generation ||
            move.manifestSha256 !== manifest.transferManifestSha256
          )
            return yield* conflict("Move no longer owns this frozen source.");
          const prior = yield* get(input.operationId);
          if (prior && prior.manifestArtifactId !== input.manifestArtifactId)
            return yield* conflict("Move already published a different artifact manifest.");
          const expected = encodeExpected(entries);
          const [matched] = yield* sql<{ count: number }>`WITH expected AS (
          SELECT * FROM jsonb_to_recordset(${expected}::jsonb)
            AS e("artifactId" text, sha256 text, "sizeBytes" bigint, kind text)
        ), locked AS MATERIALIZED (
          SELECT a.artifact_id FROM relay_thread_artifacts a
          JOIN expected e ON e."artifactId" = a.artifact_id
            AND e.sha256 = a.sha256 AND e."sizeBytes" = a.size_bytes AND e.kind = a.kind
          WHERE a.thread_id = ${input.threadId} AND a.operation_id = ${input.operationId}
            AND a.state = 'complete'
          ORDER BY a.artifact_id FOR UPDATE OF a
        ), pinned AS (
          INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
          SELECT artifact_id, ${input.operationId} FROM locked ON CONFLICT DO NOTHING
        ) SELECT count(*)::int AS count FROM locked`;
          if (matched?.count !== entries.length)
            return yield* conflict("Move has missing or mismatched completed artifacts.");
          yield* sql`INSERT INTO relay_thread_move_artifacts (operation_id,manifest_artifact_id)
          VALUES (${input.operationId},${input.manifestArtifactId}) ON CONFLICT DO NOTHING`;
          return { manifestArtifactId: input.manifestArtifactId, artifactCount: entries.length };
        }),
      );
    });
    const published = yield* publishVerified.pipe(
      Effect.timeout("55 minutes"),
      Effect.ensuring(
        transfer
          .releasePin({
            artifactId: input.manifestArtifactId,
            operationId: readPinId,
          })
          .pipe(Effect.ignore),
      ),
    );
    yield* makeThreadMoveCheckpointStore(sql, objects).publish(input);
    return published;
  });
  const releasePins = Effect.fn("relay.thread_move_artifacts.release_pins")(function* (
    operationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [identity] = yield* sql<{
          threadId: string;
        }>`SELECT thread_id AS "threadId" FROM relay_thread_moves WHERE operation_id=${operationId}`;
        if (identity)
          yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${identity.threadId} FOR UPDATE`;
        const [move] = yield* sql<{ phase: string }>`SELECT phase FROM relay_thread_moves
          WHERE operation_id = ${operationId} FOR UPDATE`;
        if (!move || !["completed", "aborted"].includes(move.phase))
          return yield* conflict("Move artifacts are still needed by the handoff.");
        const native = makeThreadNativeCheckpointStore(sql, objects);
        if (
          identity &&
          (yield* native.getForOperation({ threadId: identity.threadId, operationId }))
        )
          yield* native.releaseOperation({ threadId: identity.threadId, operationId });
        yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id = ${operationId}`;
        if (identity) yield* makeThreadMoveCheckpointStore(sql, objects).retire(identity.threadId);
      }),
    );
  });
  const openPublished = (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly artifactId: string;
  }) =>
    Effect.gen(function* () {
      const [available] = yield* sql`SELECT 1 FROM relay_thread_move_artifacts ma
      JOIN relay_thread_moves m ON m.operation_id = ma.operation_id
      JOIN relay_thread_artifact_pins p ON p.operation_id = ma.operation_id
      JOIN relay_thread_artifacts a ON a.artifact_id = p.artifact_id
      WHERE ma.operation_id = ${input.operationId} AND m.thread_id = ${input.threadId}
        AND a.artifact_id = ${input.artifactId} AND a.thread_id = ${input.threadId}
        AND a.operation_id = ${input.operationId} AND a.state = 'complete'`;
      if (!available) return yield* conflict("Artifact is not part of this published move.");
      const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const stream = yield* transfer.readPinned({
        threadId: input.threadId,
        artifactId: input.artifactId,
        operationId: readPinId,
      });
      // The temporary read pin expires after an hour if a worker dies. Stop a
      // surviving slow reader before it could outlive that lease.
      return stream.pipe(
        Stream.interruptWhen(Effect.sleep("55 minutes")),
        Stream.ensuring(
          transfer
            .releasePin({ artifactId: input.artifactId, operationId: readPinId })
            .pipe(Effect.ignore),
        ),
      );
    });
  const readPublished = (input: Parameters<typeof openPublished>[0]) =>
    Stream.unwrap(openPublished(input));
  return { get, publish, readPublished, openPublished, releasePins };
}
