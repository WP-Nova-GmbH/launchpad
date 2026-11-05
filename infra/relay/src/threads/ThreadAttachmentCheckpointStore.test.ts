import {
  attachmentCheckpointCatalogFixture as fixture,
  laterAttachmentCheckpoint as laterCheckpoint,
} from "./testUtils/attachmentCheckpointCatalog.ts";
import {
  prepareMoveCheckpointArchive,
  readPackedMoveFiles,
} from "./testUtils/moveCheckpointCatalog.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { attachmentRelativePath } from "../../../../apps/server/src/attachmentStore.ts";
import { materializeAttachmentCheckpoint } from "../../../../apps/server/src/relay/ThreadAttachmentCheckpointTransfer.ts";
import { materializeNativeCheckpoint } from "../../../../apps/server/src/relay/ThreadNativeCheckpointTransfer.ts";
import { importCodexConversation } from "../../../../apps/server/src/provider/Drivers/CodexConversationTransfer.ts";
import { installThreadAttachments } from "../../../../apps/server/src/relay/ThreadAttachmentTransfer.ts";
import { makeThreadAttachmentCheckpointStore } from "./ThreadAttachmentCheckpointStore.ts";
import {
  nativeCheckpointCatalogTestLayer,
  decodeChunkManifest,
  nativeId,
} from "./testUtils/nativeCheckpointCatalog.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const completeLaterCheckpoint = Effect.fnUntraced(function* (
  f: Effect.Success<typeof fixture>,
  offset: number,
) {
  const candidate = yield* laterCheckpoint(f, offset);
  yield* f.upload(candidate.attachments);
  yield* f.attachmentStore.publish({
    threadId: f.threadId,
    operationId: candidate.attachments.header.operationId,
    manifestArtifactId: candidate.attachments.artifactId,
    nativeCheckpointOperationId: candidate.native.header.operationId,
  });
  return candidate;
});

const download = Effect.fnUntraced(function* (
  f: Effect.Success<typeof fixture>,
  manifestArtifactId: string,
  manifestSha256: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = Effect.fnUntraced(function* (artifactId: string) {
    const parts: Uint8Array[] = [];
    yield* f.storeNative
      .readForOperation({ threadId: f.threadId, operationId: f.recovery.operationId, artifactId })
      .pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            parts.push(part);
          }),
        ),
      );
    return Buffer.concat(parts);
  });
  const metadata = yield* bytes(manifestArtifactId);
  expect(NodeCrypto.createHash("sha256").update(metadata).digest("hex")).toBe(manifestSha256);
  const manifest = yield* decodeChunkManifest(metadata.toString("utf8"));
  const directory = `${f.root}/${name}`;
  yield* fs.makeDirectory(directory);
  for (const file of manifest.files)
    for (const chunk of file.chunks)
      yield* fs.writeFile(`${directory}/${chunk.artifactId}`, yield* bytes(chunk.artifactId));
  return { manifest, chunkDirectory: directory };
});

describe.skipIf(!databaseUrl)("native and chat attachment recovery points (Postgres)", () => {
  layer(nativeCheckpointCatalogTestLayer)((it) => {
    it.effect(
      "keeps independently verified chat files with the native point and recovers after loss of every source copy",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* Effect.flip(f.storeNative.pinCompleteForOperation(f.recovery));
            yield* f.upload(f.attachments);
            const receipt = yield* f.publishAttachments;
            expect(yield* f.publishAttachments).toEqual(receipt);
            expect(yield* f.attachmentStore.get(f.native.header.operationId)).toEqual(receipt);
            yield* f.storeNative.pinCompleteForOperation(f.recovery);
            expect(yield* f.attachmentStore.getForOperation(f.recovery)).toEqual(receipt);
            const [pins] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins
        WHERE operation_id=${`native-recovery:${f.recovery.operationId}`} AND expires_at IS NULL`;
            expect(pins?.count).toBe(f.native.uploads.length + f.attachments.uploads.length);
            yield* f.sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days' WHERE thread_id=${f.threadId}`;
            expect(yield* f.transfer.collectOne()).toBe(false);
            // Remove only this fixture's producer homes, chat files, local outboxes and both packages.
            for (const name of [
              "source-turn-1",
              "source-chat-files",
              "outbox-turn-1",
              "chat-outbox",
              "packing",
            ])
              yield* f.fs.remove(`${f.root}/${name}`, { recursive: true });
            const nativeChunks = yield* download(
              f,
              f.native.artifactId,
              f.native.sha256,
              "native-download",
            );
            const native = yield* materializeNativeCheckpoint({
              ...nativeChunks,
              expected: f.native.header,
              destinationRoot: `${f.root}/native-restore`,
              threadId: f.threadId,
              operationId: f.native.header.operationId,
              transferManifestSha256: nativeChunks.manifest.transferManifestSha256,
            });
            const imported = yield* importCodexConversation({
              manifest: native.header.native,
              rolloutPath: `${native.nativeDirectory}/rollout.jsonl`,
              destinationRoot: `${f.root}/fresh-provider`,
              codexVersion: "0.159.3",
            });
            expect(imported.resumeCursor).toEqual({
              threadId: nativeId,
              resumePolicy: "require-existing",
            });
            expect(yield* f.fs.exists(`${imported.homePath}/auth.json`)).toBe(false);
            const attachmentChunks = yield* download(
              f,
              receipt.manifestArtifactId,
              receipt.manifestSha256,
              "chat-download",
            );
            const chat = yield* materializeAttachmentCheckpoint({
              ...attachmentChunks,
              expected: f.attachments.header,
              destinationRoot: `${f.root}/chat-restore`,
              threadId: f.threadId,
              operationId: receipt.operationId,
              transferManifestSha256: attachmentChunks.manifest.transferManifestSha256,
            });
            yield* installThreadAttachments({
              threadId: f.threadId,
              attachments: [f.attachment],
              manifest: chat.header.attachments,
              artifactDirectory: chat.attachmentsDirectory,
              attachmentsDir: `${f.root}/installed-files`,
            });
            expect(
              yield* f.fs.readFileString(
                `${f.root}/installed-files/${attachmentRelativePath(f.attachment)}`,
              ),
            ).toBe("notes");
            const history = yield* f.journal.history({
              threadId: f.threadId,
              after: 0,
              limit: 100,
            });
            expect(history.map((entry) => entry.event.eventId)).toEqual(
              f.history.map((event) => event.eventId),
            );
          }),
        ),
    );
    it.effect(
      "missing attachment chunks cannot certify recovery or change permanent native pins",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture,
              missing = f.attachments.uploads.find((entry) => entry.kind === "attachment")!;
            yield* f.upload(f.attachments, missing.artifactId);
            yield* Effect.flip(f.publishAttachments);
            expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
            yield* Effect.flip(f.storeNative.pinCompleteForOperation(f.recovery));
            const [pins] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins p
        JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id WHERE a.thread_id=${f.threadId}`;
            expect(pins?.count).toBe(f.native.uploads.length);
          }),
        ),
    );
    it.effect(
      "corrupted stored chat bytes preserve the native point and cannot publish attachment pins",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            const broken = f.attachments.uploads.find((entry) => entry.kind === "attachment")!;
            yield* f.fs.writeFileString(`${f.root}/objects/${broken.artifactId}`, "corrupt");
            yield* Effect.flip(f.publishAttachments);
            expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
            expect((yield* f.storeNative.latest(f.threadId))?.operationId).toBe(
              f.native.header.operationId,
            );
          }),
        ),
    );
    it.effect("concurrent retry publishes the attachment set exactly once", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.upload(f.attachments);
          const receipts = yield* Effect.forEach([1, 2], () => f.publishAttachments, {
            concurrency: "unbounded",
          });
          expect(receipts[0]).toEqual(receipts[1]);
          const [point] = yield* f.sql<{
            count: number;
          }>`SELECT artifact_count AS count FROM relay_thread_native_checkpoints WHERE operation_id=${f.native.header.operationId}`;
          expect(point?.count).toBe(f.native.uploads.length + f.attachments.uploads.length);
          yield* f.storeNative.pinCompleteForOperation(f.recovery);
          expect(yield* f.storeNative.pinCompleteForOperation(f.recovery)).toEqual(
            yield* f.storeNative.get(f.native.header.operationId),
          );
        }),
      ),
    );
    it.effect(
      "an existing recovery operation receives attachment pins atomically and loses access when released",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.storeNative.pinForOperation(f.recovery);
            yield* f.upload(f.attachments);
            const receipt = yield* f.publishAttachments;
            yield* f.storeNative.pinCompleteForOperation(f.recovery);
            expect(yield* f.attachmentStore.getForOperation(f.recovery)).toEqual(receipt);
            yield* f.storeNative
              .readForOperation({
                threadId: f.threadId,
                operationId: f.recovery.operationId,
                artifactId: receipt.manifestArtifactId,
              })
              .pipe(Stream.runDrain);
            yield* f.storeNative.releaseOperation(f.recovery);
            expect(yield* f.attachmentStore.getForOperation(f.recovery)).toBeNull();
            yield* Effect.flip(
              f.storeNative
                .readForOperation({
                  threadId: f.threadId,
                  operationId: f.recovery.operationId,
                  artifactId: receipt.manifestArtifactId,
                })
                .pipe(Stream.runDrain),
            );
          }),
        ),
    );
    it.effect(
      "superseded chat files remain readable only while a durable recovery operation pins them",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            const receipt = yield* f.publishAttachments;
            yield* f.storeNative.pinCompleteForOperation(f.recovery);
            for (const offset of [1, 2]) yield* completeLaterCheckpoint(f, offset);
            expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
            expect(yield* f.attachmentStore.getForOperation(f.recovery)).toEqual(receipt);
            yield* f.storeNative.pinCompleteForOperation(f.recovery);
            expect(yield* f.transfer.collectOne()).toBe(false);
            yield* f.storeNative
              .readForOperation({
                threadId: f.threadId,
                operationId: f.recovery.operationId,
                artifactId: receipt.manifestArtifactId,
              })
              .pipe(Stream.runDrain);
            yield* f.storeNative.releaseOperation(f.recovery);
            for (let i = 0; i < f.native.uploads.length + f.attachments.uploads.length; i++)
              expect(yield* f.transfer.collectOne()).toBe(true);
            const [deleted] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_artifacts
        WHERE operation_id IN (${f.native.header.operationId},${f.attachments.header.operationId}) AND state='deleted'`;
            expect(deleted?.count).toBe(f.native.uploads.length + f.attachments.uploads.length);
            expect(yield* f.attachmentStore.getForOperation(f.recovery)).toBeNull();
          }),
        ),
    );
    it.effect(
      "failed newer attachment publications preserve the last complete point while candidates remain bounded",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            const receipt = yield* f.publishAttachments;
            expect((yield* f.storeNative.latestComplete(f.threadId))?.operationId).toBe(
              f.native.header.operationId,
            );
            for (const offset of [1, 2, 3]) {
              const candidate = yield* laterCheckpoint(f, offset);
              yield* f.upload(
                candidate.attachments,
                candidate.attachments.uploads.find((x) => x.kind === "attachment")!.artifactId,
              );
              yield* Effect.flip(
                f.attachmentStore.publish({
                  threadId: f.threadId,
                  operationId: candidate.attachments.header.operationId,
                  manifestArtifactId: candidate.attachments.artifactId,
                  nativeCheckpointOperationId: candidate.native.header.operationId,
                }),
              );
              expect(yield* f.attachmentStore.get(f.native.header.operationId)).toEqual(receipt);
              expect((yield* f.storeNative.latestComplete(f.threadId))?.operationId).toBe(
                f.native.header.operationId,
              );
            }
            const [retained] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_native_checkpoints
          WHERE thread_id=${f.threadId} AND retained`;
            expect(retained?.count).toBe(3);
            yield* f.sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days' WHERE thread_id=${f.threadId}`;
            // Collect failed candidates, then prove the complete point still supports a new recovery operation.
            while (yield* f.transfer.collectOne()) {}
            yield* f.storeNative.pinCompleteForOperation(f.recovery);
            yield* f.storeNative
              .readForOperation({
                threadId: f.threadId,
                operationId: f.recovery.operationId,
                artifactId: receipt.manifestArtifactId,
              })
              .pipe(Stream.runDrain);
          }),
        ),
    );
    it.effect(
      "a newer complete point releases old fallback retention, even after multiple incomplete candidates",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            yield* f.publishAttachments;
            for (const offset of [1, 2, 3]) yield* laterCheckpoint(f, offset);
            const complete = yield* completeLaterCheckpoint(f, 4);
            expect((yield* f.storeNative.latestComplete(f.threadId))?.operationId).toBe(
              complete.native.header.operationId,
            );
            expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
            yield* Effect.flip(f.storeNative.pinCompleteForOperation(f.recovery));
            const [retained] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_native_checkpoints
          WHERE thread_id=${f.threadId} AND retained`;
            expect(retained?.count).toBe(2);
          }),
        ),
    );
    it.effect(
      "a complete frozen point can retain the same real turn with a newer exact history watermark",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            yield* f.publishAttachments;
            const captureOperationId = NodeCrypto.randomUUID();
            const point = yield* laterCheckpoint(f, 1, captureOperationId);
            expect(point.native.header.turnId).toBe(f.native.header.turnId);
            expect(point.native.header.captureOperationId).toBe(captureOperationId);
            yield* f.upload(point.attachments);
            const receipt = yield* f.attachmentStore.publish({
              threadId: f.threadId,
              operationId: point.attachments.header.operationId,
              manifestArtifactId: point.attachments.artifactId,
              nativeCheckpointOperationId: point.native.header.operationId,
            });
            expect(receipt.captureOperationId).toBe(captureOperationId);
            expect(receipt.sourceSequence).toBe(point.sourceSequence);
            expect((yield* f.storeNative.latestComplete(f.threadId))?.operationId).toBe(
              point.native.header.operationId,
            );
            yield* f.storeNative.pinCompleteForOperation({
              ...f.recovery,
              operationId: NodeCrypto.randomUUID(),
              checkpointOperationId: point.native.header.operationId,
              expected: { ...f.recovery.expected, sourceSequence: point.sourceSequence },
            });
            expect(yield* f.storeNative.get(f.native.header.operationId)).not.toBeNull();
          }),
        ),
    );
    it.effect(
      "a move cannot commit before its exact fresh frozen native and chat save is complete",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.upload(f.attachments);
            yield* f.publishAttachments;
            const operationId = NodeCrypto.randomUUID();
            const point = yield* laterCheckpoint(f, 1, operationId);
            const nativeFiles = yield* readPackedMoveFiles(f.fs, point.native),
              chatFiles = yield* readPackedMoveFiles(f.fs, point.attachments);
            const move = yield* prepareMoveCheckpointArchive({
              sql: f.sql,
              fs: f.fs,
              root: f.root,
              threadId: f.threadId,
              sourceEnvironmentId: f.sourceEnvironmentId,
              operationId,
              history: point.history,
              native: point.native.header.native,
              attachments: point.attachments.header.attachments,
              extraFiles: new Map([...nativeFiles, ...chatFiles]),
            });
            yield* move.ready;
            expect(yield* Effect.flip(move.publish)).toMatchObject({
              _tag: "ThreadMoveCheckpointConflict",
            });
            yield* Effect.flip(move.placements.commitMove(move.move));
            expect((yield* move.placements.get(f.threadId))?.environmentId).toBe(
              f.sourceEnvironmentId,
            );
            yield* f.upload(point.attachments);
            yield* f.attachmentStore.publish({
              threadId: f.threadId,
              operationId: point.attachments.header.operationId,
              manifestArtifactId: point.attachments.artifactId,
              nativeCheckpointOperationId: point.native.header.operationId,
            });
            yield* move.publish;
            yield* move.publish;
            expect(
              (yield* f.storeNative.getForOperation({ threadId: f.threadId, operationId }))
                ?.captureOperationId,
            ).toBe(operationId);
            yield* move.placements.commitMove(move.move);
            yield* move.placements.activated({
              ...move.move,
              environmentId: move.move.destinationEnvironmentId,
              generation: 2,
            });
            yield* move.store.releasePins(operationId);
            expect(
              yield* f.storeNative.getForOperation({ threadId: f.threadId, operationId }),
            ).toBeNull();
            const [saved] = yield* f.sql<{
              retained: boolean;
            }>`SELECT retained FROM relay_thread_move_checkpoints WHERE operation_id=${operationId}`;
            expect(saved?.retained).toBe(true);
          }),
        ),
    );
    it.effect("an older settled save cannot satisfy a new move's freeze identity", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.upload(f.attachments);
          yield* f.publishAttachments;
          const nativeFiles = yield* readPackedMoveFiles(f.fs, f.native),
            chatFiles = yield* readPackedMoveFiles(f.fs, f.attachments);
          const move = yield* prepareMoveCheckpointArchive({
            sql: f.sql,
            fs: f.fs,
            root: f.root,
            threadId: f.threadId,
            sourceEnvironmentId: f.sourceEnvironmentId,
            history: f.history,
            native: f.native.header.native,
            attachments: f.attachments.header.attachments,
            extraFiles: new Map([...nativeFiles, ...chatFiles]),
          });
          expect(yield* Effect.flip(move.publish)).toMatchObject({
            _tag: "ThreadMoveCheckpointConflict",
          });
          yield* move.ready;
          yield* Effect.flip(move.placements.commitMove(move.move));
        }),
      ),
    );
    it.effect("the attachment package cannot attach to a missing native point", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.upload(f.attachments);
          yield* Effect.flip(
            f.attachmentStore.publish({
              threadId: f.threadId,
              operationId: f.attachments.header.operationId,
              manifestArtifactId: f.attachments.artifactId,
              nativeCheckpointOperationId: NodeCrypto.randomUUID(),
            }),
          );
          expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
        }),
      ),
    );
    it.effect("a placement change during object verification rejects attachment publication", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.upload(f.attachments);
          let changed = false;
          const objects = {
            ...f.objects,
            read: (key: string) =>
              f.objects.read(key).pipe(
                Effect.tap(() => {
                  if (changed) return Effect.void;
                  changed = true;
                  return f.sql`UPDATE relay_thread_placements SET environment_id='new-owner',generation=2 WHERE thread_id=${f.threadId}`.pipe(
                    Effect.asVoid,
                    Effect.orDie,
                  );
                }),
              ),
          };
          const racing = makeThreadAttachmentCheckpointStore(f.sql, objects);
          yield* Effect.flip(
            racing.publish({
              threadId: f.threadId,
              operationId: f.attachments.header.operationId,
              manifestArtifactId: f.attachments.artifactId,
              nativeCheckpointOperationId: f.native.header.operationId,
            }),
          );
          expect(yield* f.attachmentStore.get(f.native.header.operationId)).toBeNull();
        }),
      ),
    );
  });
});
