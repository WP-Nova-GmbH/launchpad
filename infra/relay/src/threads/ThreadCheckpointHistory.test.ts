import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { downloadThreadArtifactChunks } from "../../../../apps/server/src/relay/ThreadArtifactDownload.ts";
import { materializeNativeCheckpoint } from "../../../../apps/server/src/relay/ThreadNativeCheckpointTransfer.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("independently retained frozen history (Postgres)", () => {
  layer(nativeCheckpointCatalogTestLayer)((it) => {
    it.effect(
      "preserves full history under native recovery pins after source loss and disk expiry",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture();
            yield* f.store.begin(f.input);
            const packed = yield* f.freeze;
            yield* f.verifyBackup;
            yield* f.store.recordSaved(f.input.operationId);
            const deletion = (yield* f.store.claimDeletion(f.hostId))!;
            yield* f.store.beginDeletion(deletion);
            yield* f.store.confirmDeleted(deletion);
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.operationId}`;
            const saved = makeThreadVmSavedDiskStore(f.sql),
              expiry = (yield* saved.claimExpired(f.hostId))!;
            expect(yield* saved.completeExpiry(expiry)).toBe(true);
            expect((yield* saved.get(f.input.operationId))?.phase).toBe("expired");
            const native = makeThreadNativeCheckpointStore(f.sql, f.objects);
            const point = (yield* native.get(packed.native.header.operationId))!;
            expect(point.recoveryHistory?.eventCount).toBe(packed.history.length);
            expect(point.recoveryHistory?.operationId).toBe(f.input.operationId);
            const operationId = NodeCrypto.randomUUID();
            yield* native.pinCompleteForOperation({
              threadId: f.threadId,
              operationId,
              checkpointOperationId: point.operationId,
              expected: point,
            });
            // Removing the source checkout/outboxes cannot remove independently stored recovery objects.
            for (const name of [
              "source-turn-1",
              "outbox-turn-1",
              "source-chat-files",
              "chat-outbox",
              "packing",
            ])
              if (yield* f.fs.exists(`${f.root}/${name}`))
                yield* f.fs.remove(`${f.root}/${name}`, { recursive: true });
            yield* f.sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '40 days' WHERE thread_id=${f.threadId}`;
            expect(yield* f.transfer.collectOne()).toBe(false);
            const chunks = yield* downloadThreadArtifactChunks({
              threadId: f.threadId,
              operationId: point.operationId,
              sourceEnvironmentId: point.sourceEnvironmentId,
              generation: point.generation,
              indexArtifactId: point.manifestArtifactId,
              indexSha256: point.manifestSha256,
              scratchRoot: `${f.root}/downloads`,
              maxFiles: 1029,
              maxBytes: 770 * 1024 * 1024,
              readArtifact: (id) =>
                Effect.succeed(
                  native.readForOperation({ threadId: f.threadId, operationId, artifactId: id }),
                ),
            });
            const recovered = yield* materializeNativeCheckpoint({
              ...chunks,
              destinationRoot: `${f.root}/recovered`,
              threadId: f.threadId,
              operationId: point.operationId,
              expected: point,
              transferManifestSha256: chunks.manifest.transferManifestSha256,
            });
            expect(yield* Stream.runCollect(recovered.recoveryHistory!.events)).toEqual(
              packed.history,
            );
            expect(recovered.recoveryHistory?.receipts).toEqual([]);
            expect(yield* native.get(point.operationId)).toEqual(point);
          }),
        ),
    );
    it.effect(
      "requires full history before deleting a VM even when native/chat and disk witnesses exist",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture();
            yield* f.store.begin(f.input);
            const packed = yield* f.freeze;
            // Model a legacy checkpoint created before history became part of recovery.
            yield* f.sql`UPDATE relay_thread_native_checkpoints SET recovery_history_json=NULL WHERE operation_id=${packed.native.header.operationId}`;
            // Final-save commit rechecks recovery before allowing source deletion.
            yield* f.verifyBackup;
            yield* Effect.flip(f.store.recordSaved(f.input.operationId));
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("saving");
          }),
        ),
    );
  });
});
