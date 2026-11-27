import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import { importCodexConversation } from "../../../../apps/server/src/provider/Drivers/CodexConversationTransfer.ts";
import { materializeNativeCheckpoint } from "../../../../apps/server/src/relay/ThreadNativeCheckpointTransfer.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import {
  nativeCheckpointCatalogTestLayer as migrated,
  nativeCheckpointCatalogFixture as fixture,
  nativeId,
  decodeChunkManifest,
} from "./testUtils/nativeCheckpointCatalog.ts";
const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("independently retained native checkpoints (Postgres)", () => {
  layer(migrated)((it) => {
    it.effect(
      "publishes only verified independent bytes and returns the same receipt after a lost reply",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture,
              packed = yield* f.pack("turn-1", 31);
            yield* f.upload(packed);
            yield* f.mirror(31);
            const receipt = yield* f.publish(packed);
            expect(receipt.nativeThreadId).toBe(nativeId);
            expect(receipt.archiveSha256).toBe(packed.header.archiveSha256);
            expect(receipt.manifestSha256).toBe(packed.sha256);
            expect(yield* f.publish(packed)).toEqual(receipt);
            expect(yield* f.store.latest(f.threadId)).toEqual(receipt);
            const [pins] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins
          WHERE operation_id=${`native-checkpoint:${packed.header.operationId}`} AND expires_at IS NULL`;
            expect(pins?.count).toBe(packed.uploads.length);
            yield* f.sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days'
          WHERE thread_id=${f.threadId}`;
            expect(yield* f.transfer.collectOne()).toBe(false);
          }),
        ),
    );
    it.effect("an upload without every native chunk cannot publish or leave permanent pins", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            packed = yield* f.pack("turn-1", 31);
          const missing = packed.uploads.find((entry) => entry.kind === "native")!;
          yield* f.upload(packed, missing.artifactId);
          yield* f.mirror(31);
          expect(yield* Effect.flip(f.publish(packed))).toMatchObject({
            _tag: "ThreadNativeCheckpointConflict",
          });
          expect(yield* f.store.latest(f.threadId)).toBeNull();
          const pins =
            yield* f.sql`SELECT 1 FROM relay_thread_artifact_pins p JOIN relay_thread_artifacts a
          ON a.artifact_id=p.artifact_id WHERE a.thread_id=${f.threadId}`;
          expect(pins).toHaveLength(0);
        }),
      ),
    );
    it.effect("corrupt retained bytes preserve the preceding checkpoint", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            first = yield* f.pack("turn-1", 31);
          yield* f.upload(first);
          yield* f.mirror(32);
          const previous = yield* f.publish(first),
            candidate = yield* f.pack("turn-2", 32);
          yield* f.upload(candidate);
          const broken = candidate.uploads.find((entry) => entry.kind === "native")!;
          yield* f.fs.writeFileString(`${f.root}/objects/${broken.artifactId}`, "corrupt");
          yield* Effect.flip(f.publish(candidate));
          expect(yield* f.store.latest(f.threadId)).toEqual(previous);
          expect(yield* f.store.get(candidate.header.operationId)).toBeNull();
        }),
      ),
    );
    it.effect("incomplete mirrored history blocks a native publication", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            packed = yield* f.pack("turn-1", 31);
          yield* f.upload(packed);
          yield* f.mirror(30);
          expect(yield* Effect.flip(f.publish(packed))).toMatchObject({
            _tag: "ThreadNativeCheckpointConflict",
          });
          expect(yield* f.store.latest(f.threadId)).toBeNull();
        }),
      ),
    );
    it.effect("ownership changed during object verification cannot publish", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            packed = yield* f.pack("turn-1", 31);
          yield* f.upload(packed);
          yield* f.mirror(31);
          let changed = false;
          const racing = makeThreadNativeCheckpointStore(f.sql, {
            ...f.objects,
            read: (key) =>
              f.objects.read(key).pipe(
                Effect.tap(() => {
                  if (changed) return Effect.void;
                  changed = true;
                  return f.sql`UPDATE relay_thread_placements SET environment_id='destination',generation=2
              WHERE thread_id=${f.threadId}`.pipe(Effect.asVoid, Effect.orDie);
                }),
              ),
          });
          yield* Effect.flip(
            racing.publish({
              threadId: f.threadId,
              operationId: packed.header.operationId,
              manifestArtifactId: packed.artifactId,
            }),
          );
          expect(yield* f.store.latest(f.threadId)).toBeNull();
        }),
      ),
    );
    it.effect(
      "keeps current and previous conversations while independent operation pins protect older bytes",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const first = yield* f.pack("turn-1", 31),
              second = yield* f.pack("turn-2", 32),
              third = yield* f.pack("turn-3", 33);
            yield* f.mirror(33);
            for (const point of [first, second]) {
              yield* f.upload(point);
              yield* f.publish(point);
            }
            const ownRestore = NodeCrypto.randomUUID();
            yield* f.sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
          SELECT artifact_id,${ownRestore} FROM relay_thread_artifacts WHERE operation_id=${first.header.operationId}`;
            yield* f.upload(third);
            yield* f.publish(third);
            expect(yield* f.store.get(first.header.operationId)).toBeNull();
            expect(yield* f.store.get(second.header.operationId)).not.toBeNull();
            expect((yield* f.store.latest(f.threadId))?.turnId).toBe("turn-3");
            const retained =
              yield* f.sql`SELECT 1 FROM relay_thread_native_checkpoints WHERE thread_id=${f.threadId} AND retained`;
            expect(retained).toHaveLength(2);
            const otherPins =
              yield* f.sql`SELECT 1 FROM relay_thread_artifact_pins WHERE operation_id=${ownRestore}`;
            expect(otherPins.length).toBe(first.uploads.length);
            yield* Effect.flip(f.publish(first));
            expect((yield* f.store.latest(f.threadId))?.turnId).toBe("turn-3");
          }),
        ),
    );
    it.effect("an older candidate cannot replace a newer retained conversation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            newer = yield* f.pack("turn-2", 32),
            older = yield* f.pack("turn-1", 31);
          yield* f.mirror(32);
          yield* f.upload(newer);
          yield* f.publish(newer);
          yield* f.upload(older);
          yield* Effect.flip(f.publish(older));
          expect((yield* f.store.latest(f.threadId))?.turnId).toBe("turn-2");
        }),
      ),
    );
    it.effect("concurrent verified candidates cannot regress the retained history cursor", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            older = yield* f.pack("turn-1", 31),
            newer = yield* f.pack("turn-2", 32);
          yield* f.mirror(32);
          yield* f.upload(older);
          yield* f.upload(newer);
          yield* Effect.forEach(
            [older, newer],
            (point) =>
              f
                .publish(point)
                .pipe(
                  Effect.catchTag("ThreadNativeCheckpointConflict", () => Effect.succeed(null)),
                ),
            { concurrency: "unbounded" },
          );
          expect((yield* f.store.latest(f.threadId))?.sourceSequence).toBe(32);
        }),
      ),
    );
    it.effect("a fresh conversation cannot replace the retained native conversation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            first = yield* f.pack("turn-1", 31);
          yield* f.mirror(32);
          yield* f.upload(first);
          const receipt = yield* f.publish(first);
          const replacement = yield* f.pack("turn-2", 32, "01900000-0000-7000-8000-000000000002");
          yield* f.upload(replacement);
          yield* Effect.flip(f.publish(replacement));
          expect(yield* f.store.latest(f.threadId)).toEqual(receipt);
        }),
      ),
    );
    it.effect(
      "durable recovery pins preserve a superseded point until explicit operation release",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const first = yield* f.pack("turn-1", 31),
              second = yield* f.pack("turn-2", 32),
              third = yield* f.pack("turn-3", 33);
            yield* f.mirror(33);
            yield* f.upload(first);
            const receipt = yield* f.publish(first);
            const operationId = NodeCrypto.randomUUID();
            const pin = {
              threadId: f.threadId,
              operationId,
              checkpointOperationId: first.header.operationId,
              expected: {
                sourceEnvironmentId: "local",
                generation: 1,
                sourceSequence: 31,
                nativeThreadId: nativeId,
              },
            };
            expect(yield* f.store.pinForOperation(pin)).toEqual(receipt);
            for (const point of [second, third]) {
              yield* f.upload(point);
              yield* f.publish(point);
            }
            expect(yield* f.store.get(first.header.operationId)).toBeNull();
            expect(yield* f.store.pinForOperation(pin)).toEqual(receipt);
            expect(yield* f.store.getForOperation({ threadId: f.threadId, operationId })).toEqual(
              receipt,
            );
            const parts = yield* Stream.runCollect(
              f.store.readForOperation({
                threadId: f.threadId,
                operationId,
                artifactId: first.artifactId,
              }),
            );
            expect(parts.length).toBeGreaterThan(0);
            expect(yield* f.transfer.collectOne()).toBe(false);
            yield* f.store.releaseOperation({ threadId: f.threadId, operationId });
            yield* f.store.releaseOperation({ threadId: f.threadId, operationId });
            expect(
              yield* f.store.getForOperation({ threadId: f.threadId, operationId }),
            ).toBeNull();
            yield* Effect.flip(f.store.pinForOperation(pin));
            yield* Effect.flip(
              Stream.runCollect(
                f.store.readForOperation({
                  threadId: f.threadId,
                  operationId,
                  artifactId: first.artifactId,
                }),
              ),
            );
            for (let index = 0; index < first.uploads.length; index++)
              expect(yield* f.transfer.collectOne()).toBe(true);
            expect(yield* f.transfer.collectOne()).toBe(false);
            expect((yield* f.store.latest(f.threadId))?.turnId).toBe("turn-3");
          }),
        ),
    );
    it.effect(
      "recovery operation identity cannot be redirected to a different point or thread",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture,
              first = yield* f.pack("turn-1", 31),
              second = yield* f.pack("turn-2", 32);
            yield* f.mirror(32);
            for (const point of [first, second]) {
              yield* f.upload(point);
              yield* f.publish(point);
            }
            const pin = {
              threadId: f.threadId,
              operationId: NodeCrypto.randomUUID(),
              checkpointOperationId: first.header.operationId,
              expected: {
                sourceEnvironmentId: "local",
                generation: 1,
                sourceSequence: 31,
                nativeThreadId: nativeId,
              },
            };
            const receipt = yield* f.store.pinForOperation(pin);
            yield* Effect.flip(
              f.store.pinForOperation({
                ...pin,
                checkpointOperationId: second.header.operationId,
                expected: { ...pin.expected, sourceSequence: 32 },
              }),
            );
            yield* Effect.flip(
              f.store.pinForOperation({
                ...pin,
                expected: { ...pin.expected, sourceSequence: 32 },
              }),
            );
            yield* Effect.flip(f.store.releaseOperation({ ...pin, threadId: "other" }));
            yield* Effect.flip(
              Stream.runCollect(
                f.store.readForOperation({ ...pin, artifactId: second.artifactId }),
              ),
            );
            expect(yield* f.store.getForOperation(pin)).toEqual(receipt);
          }),
        ),
    );
    it.effect("a new recovery operation cannot adopt an already retired point", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture,
            first = yield* f.pack("turn-1", 31);
          yield* f.mirror(33);
          yield* f.upload(first);
          yield* f.publish(first);
          for (const [turn, sequence] of [
            ["turn-2", 32],
            ["turn-3", 33],
          ] as const) {
            const point = yield* f.pack(turn, sequence);
            yield* f.upload(point);
            yield* f.publish(point);
          }
          const operationId = NodeCrypto.randomUUID();
          yield* Effect.flip(
            f.store.pinForOperation({
              threadId: f.threadId,
              operationId,
              checkpointOperationId: first.header.operationId,
              expected: {
                sourceEnvironmentId: "local",
                generation: 1,
                sourceSequence: 31,
                nativeThreadId: nativeId,
              },
            }),
          );
          expect(yield* f.store.getForOperation({ threadId: f.threadId, operationId })).toBeNull();
        }),
      ),
    );
    it.effect(
      "recovers the same native conversation using only independently retained objects after source removal",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture,
              packed = yield* f.pack("turn-1", 31);
            yield* f.upload(packed);
            yield* f.mirror(31);
            const receipt = yield* f.publish(packed);
            const operationId = NodeCrypto.randomUUID();
            yield* f.store.pinForOperation({
              threadId: f.threadId,
              operationId,
              checkpointOperationId: receipt.operationId,
              expected: {
                sourceEnvironmentId: receipt.sourceEnvironmentId,
                generation: receipt.generation,
                sourceSequence: receipt.sourceSequence,
                nativeThreadId: receipt.nativeThreadId,
              },
            });
            for (const relative of ["source-turn-1", "outbox-turn-1", "packing"])
              yield* f.fs.remove(`${f.root}/${relative}`, { recursive: true });
            const chunks = `${f.root}/independent-recovery-chunks`;
            yield* f.fs.makeDirectory(chunks, { mode: 0o700 });
            const download = Effect.fnUntraced(function* (artifactId: string) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const output = yield* f.fs.open(`${chunks}/${artifactId}`, {
                    flag: "wx",
                    mode: 0o600,
                  });
                  yield* f.store
                    .readForOperation({ threadId: f.threadId, operationId, artifactId })
                    .pipe(Stream.runForEach((part) => output.writeAll(part)));
                  yield* output.sync;
                }),
              );
            });
            yield* download(receipt.manifestArtifactId);
            const bytes = yield* f.fs.readFile(`${chunks}/${receipt.manifestArtifactId}`);
            expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
              receipt.manifestSha256,
            );
            const manifest = yield* decodeChunkManifest(new TextDecoder().decode(bytes));
            for (const file of manifest.files)
              for (const chunk of file.chunks) yield* download(chunk.artifactId);
            const restored = yield* materializeNativeCheckpoint({
              manifest,
              chunkDirectory: chunks,
              destinationRoot: `${f.root}/recovered`,
              threadId: receipt.threadId,
              operationId: receipt.operationId,
              transferManifestSha256: manifest.transferManifestSha256,
              expected: {
                threadId: receipt.threadId,
                operationId: receipt.operationId,
                turnId: receipt.turnId,
                sourceEnvironmentId: receipt.sourceEnvironmentId,
                generation: receipt.generation,
                sourceSequence: receipt.sourceSequence,
              },
            });
            const imported = yield* importCodexConversation({
              manifest: restored.header.native,
              rolloutPath: `${restored.nativeDirectory}/rollout.jsonl`,
              destinationRoot: `${f.root}/destination-provider`,
              codexVersion: "0.159.3",
            });
            expect(imported.resumeCursor).toEqual({
              threadId: nativeId,
              resumePolicy: "require-existing",
            });
            expect(yield* f.fs.readFileString(imported.rolloutPath)).toContain("remember turn-1");
            expect(yield* f.fs.exists(`${imported.homePath}/auth.json`)).toBe(false);
            expect(yield* f.fs.exists(`${f.root}/source-turn-1`)).toBe(false);
          }),
        ),
    );
  });
});
