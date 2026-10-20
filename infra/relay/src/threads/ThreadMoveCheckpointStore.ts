import * as Crypto from "effect/Crypto";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
import { nativeCheckpointFiles } from "@t3tools/shared/nativeCheckpointFiles";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { sha256 } from "@noble/hashes/sha2";
import { OrchestrationEvent, ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ThreadTransferArchiveManifest,
  OrchestrationCommandReceipt,
} from "@t3tools/contracts/threadTransfer";
import {
  ThreadAttachmentManifest,
  CodexConversationManifest,
  RelayThreadVmRepositoryUpload,
} from "@t3tools/contracts/relay";
import { collectThreadAttachmentReferences } from "@t3tools/shared/threadAttachmentReferences";
import {
  attachmentRelativePath,
  toSafeThreadAttachmentSegment,
  parseThreadSegmentFromAttachmentId,
} from "@t3tools/shared/attachmentLayout";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadCheckpointObjects } from "./ThreadCheckpointObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";

export class ThreadMoveCheckpointConflict extends Schema.TaggedError<ThreadMoveCheckpointConflict>()(
  "ThreadMoveCheckpointConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadMoveCheckpointConflict({ message });
const decodeArchive = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferArchiveManifest));
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(OrchestrationEvent));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(OrchestrationCommandReceipt));
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(ThreadAttachmentManifest));
const encodeHistory = Schema.encodeSync(
  Schema.fromJsonString(ThreadTransferArchiveManifest.fields.history),
);
const encodeWorkspace = Schema.encodeSync(
  Schema.fromJsonString(ThreadTransferArchiveManifest.fields.workspace),
);
const encodeNative = Schema.encodeSync(Schema.fromJsonString(CodexConversationManifest));
const hash = (text: string) =>
  Array.from(sha256(new TextEncoder().encode(text)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
const pinId = (operationId: string) => `move-recovery:${operationId}`;
const repositoryPinId = (operationId: string) => `move-repository:${operationId}`;
const encodeRepository = Schema.encodeSync(Schema.fromJsonString(RelayThreadVmRepositoryUpload));
const decodeRepository = Schema.decodeUnknownEffect(RelayThreadVmRepositoryUpload);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A transfer pointer alone cannot authorize cutover. Verify its complete frozen recovery data first. */
export function makeThreadMoveCheckpointStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const catalog = makeThreadArtifactStore(sql),
    transfer = makeThreadArtifactTransfer(sql, objects);
  const verifier = makeThreadCheckpointObjects(sql, objects, conflict);
  const nativeStore = makeThreadNativeCheckpointStore(sql, objects);
  const publish = Effect.fn("relay.move_checkpoint.publish")(function* (input: {
    threadId: string;
    operationId: string;
    manifestArtifactId: string;
  }) {
    return yield* verifier.withPinned(
      { ...input, kind: "move", maxBytes: 64 * 1024 ** 3 },
      (view) =>
        Effect.gen(function* () {
          const header = yield* decodeArchive(
            yield* view.readMetadata("manifest.json", 32 * 1024 * 1024),
          );
          const h = header.history;
          if (
            h.threadId !== input.threadId ||
            h.operationId !== input.operationId ||
            h.environmentId !== view.manifest.sourceEnvironmentId ||
            h.generation !== view.manifest.generation ||
            header.workspace.threadId !== input.threadId ||
            header.attachments.threadId !== input.threadId ||
            view.byName.get("manifest.json")?.sha256 !== view.manifest.transferManifestSha256
          )
            return yield* conflict("Move recovery data belongs to a different frozen source.");
          const files = new Map<string, { sha256: string; size?: number }>([
            ["manifest.json", { sha256: view.manifest.transferManifestSha256 }],
            ["history/manifest.json", { sha256: hash(encodeHistory(h)) }],
            ["history/events.jsonl", h.events],
            ["history/receipts.jsonl", h.receipts],
            ["attachments/manifest.json", { sha256: hash(encodeAttachments(header.attachments)) }],
            ["workspace/manifest.json", { sha256: hash(encodeWorkspace(header.workspace)) }],
            ["workspace/repository.bundle", header.workspace.bundle],
            ["workspace/index", header.workspace.index],
          ]);
          const attachmentIds = new Set<string>(),
            attachmentNames = new Set<string>();
          const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
          for (const file of header.attachments.files) {
            const name = attachmentRelativePath(file.attachment);
            if (
              !threadSegment ||
              !name ||
              parseThreadSegmentFromAttachmentId(file.attachment.id) !== threadSegment ||
              attachmentIds.has(file.attachment.id) ||
              attachmentNames.has(name.toLowerCase())
            )
              return yield* conflict("Move attachments have invalid identities.");
            attachmentIds.add(file.attachment.id);
            attachmentNames.add(name.toLowerCase());
            files.set(`attachments/${name}`, {
              sha256: file.sha256,
              size: file.attachment.sizeBytes,
            });
          }
          if (header.native) {
            const native = nativeCheckpointFiles({
              native: header.native,
              nativeManifestSha256: hash(encodeNative(header.native)),
              directories: [
                ...(header.native.files?.length ? ["files" as const] : []),
                ...(header.native.format === "codex-rollout-v3"
                  ? ["native-rollouts" as const]
                  : []),
              ],
            });
            if (!native) return yield* conflict("Move native dependency set is invalid.");
            for (const [name, descriptor] of native.files)
              files.set(`native/${name}`, {
                sha256: descriptor.sha256,
                ...(descriptor.sizeBytes === undefined ? {} : { size: descriptor.sizeBytes }),
              });
          }
          // The destination importer validates Git semantics and checkout installation.
          for (const file of view.manifest.files) {
            if (file.path.startsWith("workspace/") && !files.has(file.path)) continue;
            const expected = files.get(file.path);
            if (
              !expected ||
              expected.sha256 !== file.sha256 ||
              (expected.size !== undefined && expected.size !== file.sizeBytes)
            )
              return yield* conflict("Move recovery files disagree with their domain manifests.");
          }
          for (const [name, expected] of files) {
            const file = view.byName.get(name);
            if (
              !file ||
              file.sha256 !== expected.sha256 ||
              (expected.size !== undefined && file.sizeBytes !== expected.size)
            )
              return yield* conflict("Move recovery data omitted a required file.");
          }
          if (
            header.native &&
            view.byName.get("native/manifest.json")?.sha256 !== hash(encodeNative(header.native))
          )
            return yield* conflict("Move native manifest is incomplete.");
          for (const file of view.manifest.files)
            if (!["history/events.jsonl", "history/receipts.jsonl"].includes(file.path))
              yield* view.readFile(file, () => {});
          const eventFile = view.byName.get("history/events.jsonl")!;
          const lines = (file: typeof eventFile) =>
            Stream.unwrap(
              Effect.sync(() => {
                const decoder = new TextDecoder("utf-8", { fatal: true });
                let last: number | undefined;
                let lineLength = 0;
                const decode = (bytes?: Uint8Array) =>
                  Effect.try({
                    try: () => {
                      if (bytes?.length) last = bytes.at(-1);
                      const text = decoder.decode(bytes, { stream: bytes !== undefined });
                      const pieces = text.split("\n");
                      for (let index = 0; index < pieces.length; index++) {
                        lineLength += pieces[index]!.length;
                        if (lineLength > 32 * 1024 * 1024)
                          throw conflict("Move history record is too large.");
                        if (index < pieces.length - 1) lineLength = 0;
                      }
                      return text;
                    },
                    catch: () => conflict("Move history is not UTF-8."),
                  });
                return view.streamFile(file).pipe(
                  Stream.mapEffect(decode),
                  Stream.concat(Stream.fromEffect(decode())),
                  Stream.splitLines,
                  Stream.filter((line) => line.length > 0),
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() =>
                        last !== undefined && last !== 10
                          ? Effect.fail(conflict("Move history ends with an incomplete record."))
                          : Effect.void,
                      ),
                    ).pipe(Stream.drain),
                  ),
                );
              }),
            );
          const archived: Array<{ eventId: string; type: string }> = [];
          let previous = 0,
            batchBytes = 0;
          const batch: string[] = [];
          const verifyBatch = Effect.fnUntraced(function* () {
            if (!batch.length) return;
            const [matched] = yield* sql<{
              count: number;
            }>`WITH expected AS (SELECT value AS event,ordinality+${archived.length - batch.length} AS cursor FROM jsonb_array_elements(${`[${batch.join(",")}]`}::jsonb) WITH ORDINALITY) SELECT count(*)::int AS count FROM expected e JOIN relay_thread_history h ON h.thread_id=${input.threadId} AND h.cursor=e.cursor AND (h.event_json-'sequence')=(e.event-'sequence')`;
            if (matched?.count !== batch.length)
              return yield* conflict("Move history content does not match its independent mirror.");
            batch.length = 0;
            batchBytes = 0;
          });
          const references = yield* collectThreadAttachmentReferences(
            input.threadId,
            lines(eventFile).pipe(
              Stream.mapEffect((line) => decodeEvent(line)),
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  if (
                    event.sequence <= previous ||
                    event.sequence > h.sourceSequence ||
                    (archived.length === 0 && event.type !== "thread.created")
                  )
                    return yield* conflict("Move history has an invalid source order.");
                  if (archived.length >= 100_000)
                    return yield* conflict("Move history exceeds its bounded manifest.");
                  previous = event.sequence;
                  archived.push({ eventId: event.eventId, type: event.type });
                  const encoded = encodeEvent(event);
                  batch.push(encoded);
                  batchBytes += encoded.length;
                  if (batch.length >= 32 || batchBytes >= 8 * 1024 * 1024) yield* verifyBatch();
                  return event;
                }),
              ),
            ),
          );
          yield* verifyBatch();
          if (
            archived.length !== h.eventCount ||
            archived.length === 0 ||
            previous !== h.sourceSequence ||
            new Set(archived.map((e) => e.eventId)).size !== archived.length
          )
            return yield* conflict("Move history is incomplete.");
          const referenceIds = new Map<string, string>();
          for (const attachment of references) {
            const encoded = encodeAttachment(attachment),
              prior = referenceIds.get(attachment.id);
            if (prior !== undefined && prior !== encoded)
              return yield* conflict(
                "History contains conflicting references to the same attachment.",
              );
            referenceIds.set(attachment.id, encoded);
          }
          if (
            referenceIds.size !== header.attachments.files.length ||
            header.attachments.files.some(
              (f) => referenceIds.get(f.attachment.id) !== encodeAttachment(f.attachment),
            )
          )
            return yield* conflict("Move omitted or changed a historical attachment.");
          const receiptIds = new Set<string>();
          yield* lines(view.byName.get("history/receipts.jsonl")!).pipe(
            Stream.mapEffect((line) => decodeReceipt(line)),
            Stream.runForEach((receipt) =>
              Effect.gen(function* () {
                if (
                  receipt.aggregateKind !== "thread" ||
                  receipt.aggregateId !== input.threadId ||
                  receiptIds.has(receipt.commandId)
                )
                  return yield* conflict("Move command receipts belong to another thread.");
                receiptIds.add(receipt.commandId);
              }),
            ),
          );
          if (receiptIds.size !== h.receiptCount)
            return yield* conflict("Move command receipts are incomplete.");
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const [placement] = yield* sql<{
                operationId: string | null;
                environmentId: string;
                generation: number;
              }>`SELECT operation_id AS "operationId",environment_id AS "environmentId",generation FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
              const [move] = yield* sql<{
                phase: string;
                sourceCursor: number;
                manifestSha256: string;
              }>`SELECT phase,source_cursor AS "sourceCursor",manifest_sha256 AS "manifestSha256" FROM relay_thread_moves WHERE operation_id=${input.operationId} AND thread_id=${input.threadId}`;
              if (
                !placement ||
                placement.operationId !== input.operationId ||
                placement.environmentId !== h.environmentId ||
                placement.generation !== h.generation ||
                !move ||
                !["frozen", "ready"].includes(move.phase) ||
                move.sourceCursor !== h.sourceSequence ||
                move.manifestSha256 !== view.manifest.transferManifestSha256
              )
                return yield* conflict("Move no longer owns this exact frozen source.");
              const mirrored = yield* sql<{
                eventId: string;
                type: string;
              }>`SELECT event_json->>'eventId' AS "eventId",event_json->>'type' AS type FROM relay_thread_history WHERE thread_id=${input.threadId} ORDER BY cursor`;
              if (
                mirrored.length !== archived.length ||
                mirrored.some(
                  (e, i) => e.eventId !== archived[i]?.eventId || e.type !== archived[i]?.type,
                )
              )
                return yield* conflict(
                  "Move history does not match the independently mirrored thread.",
                );
              const [unfinished] =
                yield* sql`SELECT 1 FROM relay_thread_execution_admissions WHERE thread_id=${input.threadId} AND NOT completed LIMIT 1`;
              if (unfinished) return yield* conflict("Source work is not fully reconciled.");
              let nativeCheckpointOperationId: string | null = null;
              if (header.native) {
                const [point] = yield* sql<{
                  operationId: string;
                  nativeManifestSha256: string;
                  attachmentManifestSha256: string;
                }>`SELECT n.operation_id AS "operationId",n.native_manifest_sha256 AS "nativeManifestSha256",a.attachment_manifest_sha256 AS "attachmentManifestSha256" FROM relay_thread_native_checkpoints n JOIN relay_thread_attachment_checkpoints a ON a.native_checkpoint_operation_id=n.operation_id WHERE n.thread_id=${input.threadId} AND n.capture_operation_id=${input.operationId} AND n.source_environment_id=${h.environmentId} AND n.generation=${h.generation} AND n.source_sequence=${h.sourceSequence} AND n.retained`;
                if (
                  !point ||
                  point.nativeManifestSha256 !== hash(encodeNative(header.native)) ||
                  point.attachmentManifestSha256 !== hash(encodeAttachments(header.attachments))
                )
                  return yield* conflict(
                    "Move needs its exact independent frozen native and attachment checkpoint.",
                  );
                yield* nativeStore.pinCompleteForOperation({
                  threadId: input.threadId,
                  operationId: input.operationId,
                  checkpointOperationId: point.operationId,
                  expected: {
                    sourceEnvironmentId: h.environmentId,
                    generation: h.generation,
                    sourceSequence: h.sourceSequence,
                    nativeThreadId: header.native.threadId,
                  },
                });
                nativeCheckpointOperationId = point.operationId;
              } else {
                const [priorNative] =
                  yield* sql`SELECT 1 FROM relay_thread_native_checkpoints WHERE thread_id=${input.threadId} LIMIT 1`;
                if (
                  priorNative ||
                  mirrored.some((e) =>
                    ["thread.turn-start-requested", "thread.session-set"].includes(e.type),
                  )
                )
                  return yield* conflict(
                    "An existing native conversation cannot be replaced with an empty one.",
                  );
                const [assistant] =
                  yield* sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${input.threadId} AND event_json->>'type'='thread.message-sent' AND event_json->'payload'->>'role'='assistant' LIMIT 1`;
                if (assistant)
                  return yield* conflict("Prior provider work has no native recovery point.");
              }
              const recoveryEntries = view.entries.filter((e) => e.kind !== "workspace");
              const [prior] = yield* sql<{
                manifestArtifactId: string;
              }>`SELECT manifest_artifact_id AS "manifestArtifactId" FROM relay_thread_move_checkpoints WHERE operation_id=${input.operationId}`;
              if (prior && prior.manifestArtifactId !== input.manifestArtifactId)
                return yield* conflict("Move recovery intent cannot change.");
              yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id) SELECT p.artifact_id,${pinId(input.operationId)} FROM relay_thread_artifact_pins p JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id WHERE p.operation_id=${view.readPinId} AND a.kind!='workspace' ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
              // Retain reset defaults from the verified archive, even after its
              // disposable workspace payload and whole-disk backup expire.
              yield* sql`INSERT INTO relay_thread_move_checkpoints (operation_id,thread_id,manifest_artifact_id,native_checkpoint_operation_id,artifact_count,workspace_branch,workspace_revision) VALUES (${input.operationId},${input.threadId},${input.manifestArtifactId},${nativeCheckpointOperationId},${recoveryEntries.length},${header.workspace.branch},${header.workspace.head}) ON CONFLICT DO NOTHING`;
              const [localUpload] = yield* sql`SELECT 1 FROM relay_thread_vm_move_destinations d
                JOIN relay_thread_moves m USING(operation_id)
                WHERE d.operation_id=${input.operationId}
                  AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b
                    WHERE b.environment_id=m.source_environment_id AND b.thread_id=m.thread_id)`;
              if (localUpload) {
                const bundle = view.byName.get("workspace/repository.bundle")!;
                const repository: RelayThreadVmRepositoryUpload = {
                  operationId: input.operationId,
                  threadId: ThreadId.make(input.threadId),
                  sourceEnvironmentId: EnvironmentId.make(h.environmentId),
                  generation: h.generation,
                  branch: header.workspace.branch,
                  revision: header.workspace.head,
                  objectFormat: header.workspace.objectFormat,
                  bundle: {
                    sha256: bundle.sha256,
                    sizeBytes: bundle.sizeBytes,
                    chunks: bundle.chunks,
                  },
                };
                const ids = encodeIds(bundle.chunks.map((chunk) => chunk.artifactId));
                yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id)
                  SELECT p.artifact_id,${repositoryPinId(input.operationId)} FROM relay_thread_artifact_pins p
                  WHERE p.operation_id=${view.readPinId} AND p.artifact_id IN
                    (SELECT value #>> '{}' FROM jsonb_array_elements(${ids}::jsonb))
                  ON CONFLICT(artifact_id,operation_id) DO UPDATE SET expires_at=NULL`;
                yield* sql`UPDATE relay_thread_move_checkpoints SET repository_upload=${encodeRepository(repository)}::jsonb,
                  repository_retained=true WHERE operation_id=${input.operationId}`;
              }
              return { nativeCheckpointOperationId, artifactCount: recoveryEntries.length };
            }),
          );
        }),
    );
  });
  const retire = Effect.fn("relay.move_checkpoint.retire")(function* (threadId: string) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${threadId} FOR UPDATE`;
        const retired = yield* sql<{
          operationId: string;
        }>`WITH newest AS (SELECT c.operation_id FROM relay_thread_move_checkpoints c JOIN relay_thread_moves m ON m.operation_id=c.operation_id WHERE c.thread_id=${threadId} AND c.retained ORDER BY m.expected_generation DESC,m.source_cursor DESC,c.verified_at DESC,c.operation_id DESC LIMIT 2) UPDATE relay_thread_move_checkpoints c SET retained=false FROM relay_thread_moves m WHERE c.operation_id=m.operation_id AND c.thread_id=${threadId} AND c.retained AND m.phase IN ('completed','aborted') AND c.operation_id NOT IN (SELECT operation_id FROM newest) RETURNING c.operation_id AS "operationId"`;
        for (const row of retired)
          yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${pinId(row.operationId)}`;
        // Keep the last successful local upload even if later VM moves retire
        // its conversation checkpoint. A new upload replaces it only after cutover.
        const repositories = yield* sql<{ operationId: string }>`WITH newest AS (
          SELECT c.operation_id FROM relay_thread_move_checkpoints c JOIN relay_thread_moves m USING(operation_id)
          WHERE c.thread_id=${threadId} AND c.repository_retained AND m.phase='completed'
          ORDER BY m.expected_generation DESC,c.verified_at DESC,c.operation_id DESC LIMIT 1
        ) UPDATE relay_thread_move_checkpoints c SET repository_retained=false FROM relay_thread_moves m
          WHERE c.operation_id=m.operation_id AND c.thread_id=${threadId} AND c.repository_retained
            AND m.phase IN('completed','aborted') AND c.operation_id NOT IN(SELECT operation_id FROM newest)
          RETURNING c.operation_id AS "operationId"`;
        for (const row of repositories)
          yield* sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${repositoryPinId(row.operationId)}`;
      }),
    );
  });
  const latest = Effect.fn("relay.move_checkpoint.latest")(function* (threadId: string) {
    const [row] = yield* sql<{
      operationId: string;
      manifestArtifactId: string;
      nativeCheckpointOperationId: string | null;
      sourceEnvironmentId: string;
      generation: number;
      sourceSequence: number;
    }>`SELECT c.operation_id AS "operationId",c.manifest_artifact_id AS "manifestArtifactId",c.native_checkpoint_operation_id AS "nativeCheckpointOperationId",m.source_environment_id AS "sourceEnvironmentId",m.expected_generation AS generation,m.source_cursor AS "sourceSequence" FROM relay_thread_move_checkpoints c JOIN relay_thread_moves m ON m.operation_id=c.operation_id WHERE c.thread_id=${threadId} AND c.retained ORDER BY m.expected_generation DESC,m.source_cursor DESC,c.verified_at DESC,c.operation_id DESC LIMIT 1`;
    return row ?? null;
  });
  const repositoryUpload = Effect.fn("relay.move_checkpoint.repository_upload")(function* (
    threadId: string,
    operationId?: string,
  ) {
    const [row] = yield* sql<{ repository: unknown }>`SELECT c.repository_upload AS repository
      FROM relay_thread_move_checkpoints c JOIN relay_thread_moves m USING(operation_id)
      WHERE c.thread_id=${threadId} AND c.repository_retained AND m.phase='completed'
        AND (${operationId === undefined} OR c.operation_id=${operationId ?? ""})
      ORDER BY m.expected_generation DESC,c.verified_at DESC,c.operation_id DESC LIMIT 1`;
    if (!row) return null;
    const repository = yield* decodeRepository(row.repository).pipe(
      Effect.mapError(() => conflict("The uploaded repository is invalid.")),
    );
    const available = yield* sql<{ artifactId: string; sha256: string; sizeBytes: number }>`
      SELECT a.artifact_id AS "artifactId",a.sha256,a.size_bytes::int AS "sizeBytes"
      FROM relay_thread_artifact_pins p JOIN relay_thread_artifacts a USING(artifact_id)
      WHERE p.operation_id=${repositoryPinId(repository.operationId)} AND p.expires_at IS NULL
        AND a.thread_id=${threadId} AND a.operation_id=${repository.operationId} AND a.state='complete'`;
    const chunks = new Map(available.map((chunk) => [chunk.artifactId, chunk]));
    if (
      !repository.bundle.chunks.length ||
      repository.bundle.chunks.some((chunk) => {
        const retained = chunks.get(chunk.artifactId);
        return (
          !retained || retained.sha256 !== chunk.sha256 || retained.sizeBytes !== chunk.sizeBytes
        );
      })
    )
      return null;
    return repository;
  });
  const openRetained = (
    input: { threadId: string; operationId: string; artifactId: string },
    repository = false,
  ) =>
    Effect.gen(function* () {
      const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const artifact = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
          const [available] =
            yield* sql`SELECT 1 FROM relay_thread_move_checkpoints c JOIN relay_thread_artifact_pins p
                ON p.operation_id=${repository ? repositoryPinId(input.operationId) : pinId(input.operationId)} AND p.expires_at IS NULL
                JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id
                WHERE c.thread_id=${input.threadId} AND c.operation_id=${input.operationId}
                  AND (${repository} AND c.repository_retained OR ${!repository} AND c.retained)
                  AND a.artifact_id=${input.artifactId} AND a.thread_id=c.thread_id AND a.operation_id=c.operation_id AND a.state='complete'`;
          if (!available)
            return yield* conflict("Artifact is not part of this retained thread save.");
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
  const readRetained = (input: { threadId: string; operationId: string; artifactId: string }) =>
    Stream.unwrap(openRetained(input));
  const isRetainedComplete = Effect.fn("relay.move_checkpoint.is_retained_complete")(
    function* (input: { threadId: string; operationId: string; manifestArtifactId: string }) {
      const [row] = yield* sql<{ expected: number; actual: number }>`
        SELECT c.artifact_count AS expected, count(a.artifact_id)::int AS actual
        FROM relay_thread_move_checkpoints c
        JOIN relay_thread_move_artifacts ma ON ma.operation_id=c.operation_id
          AND ma.manifest_artifact_id=c.manifest_artifact_id
        LEFT JOIN relay_thread_artifact_pins p
          ON p.operation_id='move-recovery:' || c.operation_id AND p.expires_at IS NULL
        LEFT JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id
          AND a.thread_id=c.thread_id AND a.operation_id=c.operation_id AND a.state='complete'
        WHERE c.thread_id=${input.threadId} AND c.operation_id=${input.operationId}
          AND c.manifest_artifact_id=${input.manifestArtifactId} AND c.retained
        GROUP BY c.artifact_count`;
      return !!row && row.expected > 0 && row.expected === row.actual;
    },
  );
  return {
    publish,
    retire,
    latest,
    readRetained,
    isRetainedComplete,
    repositoryUpload,
    readRepositoryUpload: (input: { threadId: string; operationId: string; artifactId: string }) =>
      Stream.unwrap(openRetained(input, true)),
    openRepositoryUpload: (input: { threadId: string; operationId: string; artifactId: string }) =>
      openRetained(input, true),
  };
}
