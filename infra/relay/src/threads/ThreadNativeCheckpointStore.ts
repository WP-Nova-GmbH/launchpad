import { verifyRetainedCheckpointHistory } from "./ThreadCheckpointHistory.ts";
import { retireThreadCheckpoints } from "./ThreadCheckpointRetention.ts";
import { makeThreadCheckpointObjects } from "./ThreadCheckpointObjects.ts";
import { sha256 } from "@noble/hashes/sha2";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  CodexConversationManifest,
  ThreadNativeCheckpointArchiveManifest,
  ThreadNativeCheckpointPublicationReceipt,
} from "@t3tools/contracts/relay";
import { nativeCheckpointFiles } from "@t3tools/shared/nativeCheckpointFiles";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";

const decodeHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadNativeCheckpointArchiveManifest),
);
const decodeNative = Schema.decodeEffect(Schema.fromJsonString(CodexConversationManifest));
const encodeNative = Schema.encodeSync(Schema.fromJsonString(CodexConversationManifest));
const encodeDigestEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeOperationId = Schema.decodeEffect(
  ThreadNativeCheckpointPublicationReceipt.fields.operationId,
);
const decodeReceipt = Schema.decodeEffect(ThreadNativeCheckpointPublicationReceipt);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export class ThreadNativeCheckpointConflict extends Schema.TaggedError<ThreadNativeCheckpointConflict>()(
  "ThreadNativeCheckpointConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadNativeCheckpointConflict({ message });
type Receipt = ThreadNativeCheckpointPublicationReceipt;

/** Internal object-store publication. It does not send credentials or thread data over HTTP. */
export function makeThreadNativeCheckpointStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const catalog = makeThreadArtifactStore(sql);
  const transfer = makeThreadArtifactTransfer(sql, objects);
  const checkpointObjects = makeThreadCheckpointObjects(sql, objects, conflict);
  const getStored = Effect.fnUntraced(function* (operationId: string) {
    const [row] = yield* sql<Receipt & { retained: boolean; artifactCount: number }>`SELECT
      operation_id AS "operationId", thread_id AS "threadId", turn_id AS "turnId",capture_operation_id AS "captureOperationId",
      source_environment_id AS "sourceEnvironmentId", generation, source_sequence AS "sourceSequence",
      native_thread_id AS "nativeThreadId", native_manifest_sha256 AS "nativeManifestSha256",
      recovery_history_json AS "recoveryHistory", archive_sha256 AS "archiveSha256", manifest_artifact_id AS "manifestArtifactId",
      manifest_sha256 AS "manifestSha256", artifact_count AS "artifactCount", retained
      FROM relay_thread_native_checkpoints WHERE operation_id = ${operationId}`;
    return row ?? null;
  });
  const get = Effect.fn("relay.native_checkpoint.get")(function* (operationId: string) {
    const row = yield* getStored(operationId);
    return row?.retained ? yield* decodeReceipt(row) : null;
  });
  const latest = Effect.fn("relay.native_checkpoint.latest")(function* (threadId: string) {
    const [row] = yield* sql<{ operationId: string }>`SELECT operation_id AS "operationId"
      FROM relay_thread_native_checkpoints WHERE thread_id = ${threadId} AND retained
      ORDER BY generation DESC,source_sequence DESC,published_at DESC,operation_id DESC LIMIT 1`;
    return row ? yield* get(row.operationId) : null;
  });
  const latestComplete = Effect.fn("relay.native_checkpoint.latest_complete")(function* (
    threadId: string,
  ) {
    const [row] = yield* sql<{ operationId: string }>`SELECT n.operation_id AS "operationId"
      FROM relay_thread_native_checkpoints n
      JOIN relay_thread_attachment_checkpoints a ON a.native_checkpoint_operation_id=n.operation_id
      WHERE n.thread_id=${threadId} AND n.retained
      ORDER BY n.generation DESC,n.source_sequence DESC,n.published_at DESC,n.operation_id DESC LIMIT 1`;
    return row ? yield* get(row.operationId) : null;
  });
  const publish = Effect.fn("relay.native_checkpoint.publish")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly manifestArtifactId: string;
  }) {
    return yield* checkpointObjects.withPinned(
      { ...input, kind: "native", maxBytes: 770 * 1024 * 1024 },
      ({ artifact, readPinId, manifest, entries, byName, readFile, streamFile, readMetadata }) =>
        Effect.gen(function* () {
          const header = yield* decodeHeader(yield* readMetadata("manifest.json"));
          if (
            header.threadId !== input.threadId ||
            header.operationId !== input.operationId ||
            header.sourceEnvironmentId !== manifest.sourceEnvironmentId ||
            header.generation !== manifest.generation ||
            byName.get("manifest.json")?.sha256 !== manifest.transferManifestSha256
          )
            return yield* conflict("Native checkpoint owner or manifest changed.");
          const native = yield* decodeNative(yield* readMetadata("native/manifest.json"));
          if (encodeNative(native) !== encodeNative(header.native))
            return yield* conflict("Native conversation and checkpoint header disagree.");
          const specification = nativeCheckpointFiles(header);
          if (
            !specification ||
            byName.size !== specification.files.size + 1 + (header.recoveryHistory ? 3 : 0)
          )
            return yield* conflict("Native checkpoint contains an invalid file set.");
          for (const [name, expected] of specification.files) {
            const file = byName.get(`native/${name}`);
            if (
              !file ||
              file.sha256 !== expected.sha256 ||
              (expected.sizeBytes !== undefined && file.sizeBytes !== expected.sizeBytes)
            )
              return yield* conflict("Native checkpoint file descriptors disagree.");
          }
          if (header.recoveryHistory) {
            const h = header.recoveryHistory;
            if (
              !header.captureOperationId ||
              h.operationId !== header.captureOperationId ||
              h.threadId !== header.threadId ||
              h.environmentId !== header.sourceEnvironmentId ||
              h.generation !== header.generation ||
              h.sourceSequence !== header.sourceSequence
            )
              return yield* conflict("Frozen history belongs to a different native checkpoint.");
            yield* verifyRetainedCheckpointHistory({
              sql,
              history: h,
              byName,
              readMetadata,
              streamFile,
              conflict,
            });
          }
          const archive = sha256.create(),
            encoder = new TextEncoder();
          const updateEntry = (entry: string[]) =>
            archive.update(encoder.encode(encodeDigestEntry(entry) + "\n"));
          updateEntry(["", "directory"]);
          const roots = new Set<string>([
            ...specification.directories,
            ...[...specification.files.keys()].filter((name) => !name.includes("/")),
          ]);
          for (const name of [...roots].sort()) {
            if (specification.directories.has(name)) {
              updateEntry([name, "directory"]);
              for (const child of [...specification.files.keys()]
                .filter((file) => file.startsWith(`${name}/`))
                .sort()) {
                const file = byName.get(`native/${child}`)!;
                updateEntry([child, "file", String(file.sizeBytes)]);
                yield* readFile(file, (part) => {
                  archive.update(part);
                });
              }
            } else {
              const file = byName.get(`native/${name}`)!;
              updateEntry([name, "file", String(file.sizeBytes)]);
              yield* readFile(file, (part) => {
                archive.update(part);
              });
            }
          }
          if (hex(archive.digest()) !== header.archiveSha256)
            return yield* conflict("The complete retained native archive digest does not match.");
          const receipt = yield* decodeReceipt({
            ...header,
            recoveryHistory: header.recoveryHistory ?? null,
            nativeThreadId: native.threadId,
            captureOperationId: header.captureOperationId ?? null,
            manifestArtifactId: artifact.artifactId,
            manifestSha256: artifact.sha256,
          });
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [placement] = yield* sql<{
                environmentId: string;
                generation: number;
                operationId: string | null;
              }>`SELECT
          environment_id AS "environmentId",generation,operation_id AS "operationId" FROM relay_thread_placements
          WHERE thread_id=${input.threadId} FOR UPDATE`;
              const prior = yield* getStored(input.operationId);
              if (prior) {
                if (
                  !prior.retained ||
                  prior.threadId !== input.threadId ||
                  prior.manifestArtifactId !== input.manifestArtifactId
                )
                  return yield* conflict(
                    "Native checkpoint publication intent changed or was retired.",
                  );
                return yield* decodeReceipt(prior);
              }
              const [watermark] = yield* sql<{
                sourceSequence: number;
              }>`SELECT source_sequence AS "sourceSequence"
          FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId}
            AND environment_id=${header.sourceEnvironmentId} AND generation=${header.generation}`;
              const previous = yield* latest(input.threadId);
              const pauseCapture =
                header.recoveryHistory && placement?.operationId !== header.captureOperationId
                  ? yield* sql`SELECT 1 FROM relay_thread_vm_pauses pause
                  JOIN relay_thread_vm_bindings binding USING(allocation_id)
                  JOIN relay_environment_credentials credential USING(credential_id)
                  JOIN relay_thread_vm_allocations allocation USING(allocation_id)
                  WHERE pause.operation_id=${header.captureOperationId ?? null} AND pause.phase IN('pending','sealed')
                    AND binding.thread_id=${input.threadId} AND binding.environment_id=${header.sourceEnvironmentId}
                    AND binding.generation=${header.generation} AND binding.revoked_at IS NULL AND credential.revoked_at IS NULL
                    AND allocation.thread_id=${input.threadId} AND allocation.state='running' AND allocation.deleted_at IS NULL
                  FOR SHARE OF pause,binding,credential,allocation`
                  : [];
              if (
                !placement ||
                placement.environmentId !== header.sourceEnvironmentId ||
                placement.generation !== header.generation ||
                (header.recoveryHistory &&
                  placement.operationId !== header.captureOperationId &&
                  !pauseCapture.length) ||
                (watermark?.sourceSequence ?? -1) < header.sourceSequence ||
                (previous &&
                  (previous.nativeThreadId !== native.threadId ||
                    previous.generation > header.generation ||
                    (previous.generation === header.generation &&
                      (previous.sourceSequence > header.sourceSequence ||
                        (previous.sourceSequence === header.sourceSequence &&
                          !header.captureOperationId)))))
              )
                return yield* conflict(
                  "Native checkpoint is stale or its mirrored history is incomplete.",
                );
              yield* sql`INSERT INTO relay_thread_native_checkpoints
          (operation_id,thread_id,turn_id,capture_operation_id,source_environment_id,generation,source_sequence,native_thread_id,
            native_manifest_sha256,archive_sha256,manifest_artifact_id,manifest_sha256,artifact_count,recovery_history_json)
          VALUES (${receipt.operationId},${receipt.threadId},${receipt.turnId},${receipt.captureOperationId ?? null},${receipt.sourceEnvironmentId},
            ${receipt.generation},${receipt.sourceSequence},${receipt.nativeThreadId},${receipt.nativeManifestSha256},
            ${receipt.archiveSha256},${receipt.manifestArtifactId},${receipt.manifestSha256},${entries.length},${receipt.recoveryHistory ? sql.json(receipt.recoveryHistory) : null})`;
              yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
          SELECT artifact_id,${`native-checkpoint:${input.operationId}`} FROM relay_thread_artifact_pins
          WHERE operation_id=${readPinId} ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
              yield* retireThreadCheckpoints(sql, input.threadId);
              return receipt;
            }),
          );
        }),
    );
  });
  const operationPin = (operationId: string) => `native-recovery:${operationId}`;
  const getOperation = Effect.fnUntraced(function* (operationId: string) {
    const [row] = yield* sql<{ checkpointOperationId: string; phase: "active" | "released" }>`SELECT
      checkpoint_operation_id AS "checkpointOperationId",phase FROM relay_thread_native_checkpoint_operations
      WHERE operation_id=${operationId}`;
    return row ?? null;
  });
  const getForOperation = Effect.fn("relay.native_checkpoint.operation.get")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
  }) {
    const operation = yield* getOperation(input.operationId);
    const point =
      operation?.phase === "active" ? yield* getStored(operation.checkpointOperationId) : null;
    return point?.threadId === input.threadId ? yield* decodeReceipt(point) : null;
  });
  const pinForOperation = Effect.fn("relay.native_checkpoint.operation.pin")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly checkpointOperationId: string;
    readonly expected: Pick<
      Receipt,
      "sourceEnvironmentId" | "generation" | "sourceSequence" | "nativeThreadId"
    >;
  }) {
    yield* decodeOperationId(input.operationId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* sql`SELECT thread_id FROM relay_thread_placements
        WHERE thread_id=${input.threadId} FOR UPDATE`;
        if (!placement.length) return yield* conflict("Recovery thread is unavailable.");
        const point = yield* getStored(input.checkpointOperationId);
        const prior = yield* getOperation(input.operationId);
        if (
          !point ||
          point.threadId !== input.threadId ||
          point.sourceEnvironmentId !== input.expected.sourceEnvironmentId ||
          point.generation !== input.expected.generation ||
          point.sourceSequence !== input.expected.sourceSequence ||
          point.nativeThreadId !== input.expected.nativeThreadId ||
          (prior &&
            (prior.phase !== "active" ||
              prior.checkpointOperationId !== input.checkpointOperationId)) ||
          (!prior && !point.retained)
        )
          return yield* conflict("Recovery operation does not own that retained native point.");
        if (prior) {
          const [pins] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
          FROM relay_thread_artifact_pins p JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id
          WHERE p.operation_id=${operationPin(input.operationId)} AND p.expires_at IS NULL
            AND a.thread_id=${input.threadId} AND (a.operation_id=${point.operationId} OR a.operation_id IN
              (SELECT operation_id FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${point.operationId})) AND a.state='complete' `;
          if (pins?.count !== point.artifactCount)
            return yield* conflict("Recovery pin set is incomplete.");
          return yield* decodeReceipt(point);
        }
        const [pinned] = yield* sql<{ count: number }>`WITH locked AS MATERIALIZED (
        SELECT a.artifact_id FROM relay_thread_artifacts a JOIN relay_thread_artifact_pins p
          ON p.artifact_id=a.artifact_id
        WHERE p.operation_id=${`native-checkpoint:${point.operationId}`} AND p.expires_at IS NULL
          AND a.thread_id=${input.threadId} AND (a.operation_id=${point.operationId} OR a.operation_id IN
              (SELECT operation_id FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${point.operationId})) AND a.state='complete'
        ORDER BY a.artifact_id FOR UPDATE OF a
      ), inserted AS (
        INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
        SELECT artifact_id,${operationPin(input.operationId)} FROM locked
        ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at=NULL
      ) SELECT count(*)::int AS count FROM locked`;
        if (pinned?.count !== point.artifactCount)
          return yield* conflict("Native checkpoint retention pins are incomplete.");
        yield* sql`INSERT INTO relay_thread_native_checkpoint_operations
        (operation_id,checkpoint_operation_id,phase) VALUES (${input.operationId},${point.operationId},'active')`;
        return yield* decodeReceipt(point);
      }),
    );
  });
  /** Whole-thread recovery requires independently retained chat files even when their set is empty. */
  const pinCompleteForOperation = Effect.fn("relay.native_checkpoint.operation.pin_complete")(
    function* (input: Parameters<typeof pinForOperation>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
          const [attachments] = yield* sql`SELECT 1 FROM relay_thread_attachment_checkpoints a
        JOIN relay_thread_native_checkpoints n ON n.operation_id=a.native_checkpoint_operation_id
        WHERE n.operation_id=${input.checkpointOperationId} AND n.thread_id=${input.threadId}`;
          if (!attachments)
            return yield* conflict("Whole-thread recovery requires its retained chat attachments.");
          return yield* pinForOperation(input);
        }),
      );
    },
  );
  /** The lifecycle caller releases this only after its operation has durably ended. */
  const releaseOperation = Effect.fn("relay.native_checkpoint.operation.release")(
    function* (input: { readonly threadId: string; readonly operationId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
          const operation = yield* getOperation(input.operationId);
          const point = operation ? yield* getStored(operation.checkpointOperationId) : null;
          if (!operation || point?.threadId !== input.threadId)
            return yield* conflict("Recovery operation belongs to a different thread.");
          if (operation.phase === "released") return;
          yield* sql`UPDATE relay_thread_native_checkpoint_operations SET phase='released',released_at=clock_timestamp()
        WHERE operation_id=${input.operationId} AND phase='active'`;
          yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${operationPin(input.operationId)}`;
        }),
      );
    },
  );
  const openForOperation = Effect.fn("relay.native_checkpoint.operation.open")(function* (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly artifactId: string;
  }) {
    const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const artifact = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const point = yield* getForOperation(input);
        const [available] = yield* sql`SELECT 1 FROM relay_thread_native_checkpoint_operations o
            JOIN relay_thread_artifact_pins p ON p.operation_id=${operationPin(input.operationId)}
            JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id
            WHERE o.operation_id=${input.operationId} AND o.phase='active'
              AND a.artifact_id=${input.artifactId} AND a.thread_id=${input.threadId}
              AND (a.operation_id=${point?.operationId ?? ""} OR a.operation_id IN
              (SELECT operation_id FROM relay_thread_attachment_checkpoints WHERE native_checkpoint_operation_id=${point?.operationId ?? ""})) AND a.state='complete' AND p.expires_at IS NULL`;
        if (!point || !available)
          return yield* conflict("Artifact is not retained by this recovery operation.");
        return yield* catalog.pin({ ...input, operationId: readPinId, leaseMinutes: 60 });
      }),
    );
    const stream = yield* Effect.gen(function* () {
      yield* objects.verify({
        key: artifact.storageKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
      return yield* objects.read(artifact.storageKey);
    }).pipe(
      Effect.onError(() =>
        transfer
          .releasePin({ artifactId: input.artifactId, operationId: readPinId })
          .pipe(Effect.ignore),
      ),
    );
    return stream.pipe(
      Stream.interruptWhen(Effect.sleep("55 minutes")),
      Stream.ensuring(
        transfer
          .releasePin({ artifactId: input.artifactId, operationId: readPinId })
          .pipe(Effect.ignore),
      ),
    );
  });
  const readForOperation = (input: Parameters<typeof openForOperation>[0]) =>
    Stream.unwrap(openForOperation(input));
  return {
    openForOperation,
    get,
    latest,
    latestComplete,
    publish,
    pinForOperation,
    pinCompleteForOperation,
    getForOperation,
    releaseOperation,
    readForOperation,
  };
}
