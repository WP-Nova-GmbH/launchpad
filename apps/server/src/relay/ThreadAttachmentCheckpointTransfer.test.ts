import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { installThreadAttachments } from "./ThreadAttachmentTransfer.ts";
import {
  makeThreadAttachmentCheckpointTransfer,
  materializeAttachmentCheckpoint,
} from "./ThreadAttachmentCheckpointTransfer.ts";
import {
  attachmentCheckpointFixture,
  makeAttachmentCheckpointFixture,
  runAttachmentCheckpointTest as run,
} from "./testUtils/threadAttachmentCheckpoint.ts";

const fixture = Effect.gen(function* () {
  const f = yield* attachmentCheckpointFixture;
  const saved = yield* f.store.capture(f.input);
  const transfer = makeThreadAttachmentCheckpointTransfer(f.sql);
  const input = {
    threadId: f.input.threadId,
    generation: f.input.generation,
    turnId: f.input.turnId,
    sourceEnvironmentId: f.point.environmentId,
    scratchRoot: f.path.join(f.root, "packing"),
    chunkSizeBytes: 3,
  };
  const recover = (packed: Effect.Success<ReturnType<typeof transfer.pack>>) =>
    materializeAttachmentCheckpoint({
      manifest: packed.manifest,
      expected: packed.header,
      chunkDirectory: packed.directory,
      destinationRoot: f.path.join(f.root, "restoring"),
      threadId: input.threadId,
      operationId: packed.header.operationId,
      transferManifestSha256: packed.manifest.transferManifestSha256,
    });
  return { ...f, saved, transfer, input, recover };
});

it.effect(
  "restores all retained chat files from chunks after the original files and local outbox are removed",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture,
          packed = yield* f.transfer.pack(f.input);
        const repeated = yield* f.transfer.pack(f.input);
        expect(repeated.header.operationId).toBe(packed.header.operationId);
        expect(repeated.manifest).toEqual(packed.manifest);
        expect(repeated.sha256).toBe(packed.sha256);
        expect(packed.uploads.some((part) => part.kind === "attachment")).toBe(true);
        expect(packed.manifest.files).toHaveLength(4);
        expect(packed.manifest.files.some((file) => file.path.includes("unrelated-auth"))).toBe(
          false,
        );
        yield* f.fs.remove(f.attachmentsDir, { recursive: true });
        yield* f.fs.remove(f.saved.directory, { recursive: true });
        const restored = yield* f.recover(packed);
        yield* installThreadAttachments({
          threadId: f.input.threadId,
          attachments: f.attachments.slice(0, 2),
          manifest: restored.header.attachments,
          artifactDirectory: restored.attachmentsDirectory,
          attachmentsDir: f.path.join(f.root, "installed"),
        });
        for (const [index, attachment] of f.attachments.slice(0, 2).entries())
          expect(
            yield* f.fs.readFileString(
              f.path.join(f.root, "installed", attachmentRelativePath(attachment)!),
            ),
          ).toBe(`data${index}`);
        expect(restored.header.sourceSequence).toBe(f.point.sourceSequence);
        expect(restored.header.nativeArchiveSha256).toBe(f.point.archiveSha256);
      }),
    ),
);
it.effect(
  "a trusted attachment publication receipt must match the exact local and native point",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture,
          packed = yield* f.transfer.pack(f.input);
        const receipt = {
          ...packed.header,
          manifestArtifactId: packed.artifactId,
          manifestSha256: packed.sha256,
        };
        yield* Effect.flip(
          f.store.markPublished({ ...receipt, nativeArchiveSha256: "0".repeat(64) }),
        );
        expect(
          (yield* f.store.get(f.input.threadId, 1, f.input.turnId))?.publishedArtifactId,
        ).toBeNull();
        const published = yield* f.store.markPublished(receipt);
        expect(published.publishedArtifactId).toBe(packed.artifactId);
        expect(yield* f.store.markPublished(receipt)).toEqual(published);
        yield* Effect.flip(
          f.store.markPublished({ ...receipt, manifestArtifactId: NodeCrypto.randomUUID() }),
        );
        expect(yield* f.store.get(f.input.threadId, 1, f.input.turnId)).toEqual(published);
      }),
    ),
);
for (const changed of [
  "generation",
  "sourceSequence",
  "nativeArchiveSha256",
  "attachmentManifestSha256",
] as const)
  it.effect(`recovery refuses an unrelated ${changed} and removes its quarantine candidate`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture,
          packed = yield* f.transfer.pack(f.input);
        const expected = {
          ...packed.header,
          [changed]:
            typeof packed.header[changed] === "number"
              ? Number(packed.header[changed]) + 1
              : "0".repeat(64),
        };
        yield* Effect.flip(
          materializeAttachmentCheckpoint({
            manifest: packed.manifest,
            expected,
            chunkDirectory: packed.directory,
            destinationRoot: f.path.join(f.root, "restoring"),
            threadId: f.input.threadId,
            operationId: packed.header.operationId,
            transferManifestSha256: packed.manifest.transferManifestSha256,
          }),
        );
        if (yield* f.fs.exists(f.path.join(f.root, "restoring")))
          expect(yield* f.fs.readDirectory(f.path.join(f.root, "restoring"))).toEqual([]);
        expect(yield* f.fs.exists(f.saved.directory)).toBe(true);
      }),
    ),
  );
it.effect("corrupt chunk bytes cannot install attachments or replace the source checkpoint", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        packed = yield* f.transfer.pack(f.input);
      const body = packed.uploads.find((upload) => upload.kind === "attachment")!;
      yield* f.fs.writeFileString(body.path, "bad");
      yield* Effect.flip(f.recover(packed));
      expect(yield* f.fs.readDirectory(f.path.join(f.root, "restoring"))).toEqual([]);
      expect(yield* f.store.get(f.input.threadId, 1, f.input.turnId)).toEqual(f.saved);
    }),
  ),
);
it.effect("extra credential files and symbolic links are rejected before attachment packing", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.saved.directory, "auth.json");
      yield* f.fs.writeFileString(file, "do-not-transfer");
      yield* Effect.flip(f.transfer.pack(f.input));
      yield* f.fs.remove(file);
      const target = f.path.join(f.saved.directory, attachmentRelativePath(f.attachments[0]!)!);
      yield* f.fs.remove(target);
      yield* f.fs.symlink(
        f.path.join(f.attachmentsDir, attachmentRelativePath(f.attachments[0]!)!),
        target,
      );
      yield* Effect.flip(f.transfer.pack(f.input));
      expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual([]);
      expect(yield* f.store.get(f.input.threadId, 1, f.input.turnId)).toEqual(f.saved);
    }),
  ),
);
it.effect("staging cannot mutate an immutable outbox even through a redirected parent", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.flip(
        f.transfer.pack({ ...f.input, scratchRoot: f.path.join(f.saved.directory, "packing") }),
      );
      const link = f.path.join(f.root, "redirected");
      yield* f.fs.symlink(f.saved.directory, link);
      yield* Effect.flip(
        f.transfer.pack({ ...f.input, scratchRoot: f.path.join(link, "packing") }),
      );
      expect((yield* f.fs.readDirectory(f.saved.directory)).length).toBe(3);
    }),
  ),
);
it.effect("lost ownership during packing preserves the source and clears partial chunks", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        copy = f.fs.copy;
      const fs = {
        ...f.fs,
        copy: (...args: Parameters<typeof copy>) =>
          copy(...args).pipe(
            Effect.tap(
              () =>
                f.sql`UPDATE thread_execution_fences SET phase='retired' WHERE thread_id=${f.input.threadId}`,
            ),
          ),
      };
      yield* Effect.flip(
        f.transfer.pack(f.input).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
      expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.saved.directory)).toBe(true);
    }),
  ),
);
it.effect(
  "same-size file mutation during chunking cannot publish a matching checkpoint header",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture,
          makeTemp = f.fs.makeTempDirectory,
          stream = f.fs.stream;
        let packing = false,
          changed = false;
        const fs = {
          ...f.fs,
          makeTempDirectory: (...args: Parameters<typeof makeTemp>) =>
            makeTemp(...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (args[0]?.prefix === "chunks-") packing = true;
                }),
              ),
            ),
          stream: (...args: Parameters<typeof stream>) =>
            Stream.unwrap(
              Effect.gen(function* () {
                if (
                  packing &&
                  !changed &&
                  args[0].includes("/archive/attachments/") &&
                  !args[0].endsWith("manifest.json")
                ) {
                  changed = true;
                  yield* f.fs.writeFileString(args[0], "wrong");
                }
                return stream(...args);
              }),
            ),
        };
        yield* Effect.flip(
          f.transfer.pack(f.input).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        );
        expect(changed).toBe(true);
        expect(yield* f.fs.readDirectory(f.input.scratchRoot)).toEqual([]);
        expect(yield* f.fs.exists(f.saved.directory)).toBe(true);
      }),
    ),
);
it.effect("unrelated file trees are refused before reading recovery chunk storage", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        packed = yield* f.transfer.pack(f.input);
      yield* Effect.flip(
        materializeAttachmentCheckpoint({
          manifest: {
            ...packed.manifest,
            files: [
              ...packed.manifest.files,
              { path: "native/auth.json", sha256: "0".repeat(64), sizeBytes: 0, chunks: [] },
            ],
          },
          expected: packed.header,
          chunkDirectory: f.path.join(f.root, "does-not-exist"),
          destinationRoot: f.path.join(f.root, "restoring"),
          threadId: f.input.threadId,
          operationId: packed.header.operationId,
          transferManifestSha256: packed.manifest.transferManifestSha256,
        }),
      );
      expect(yield* f.fs.exists(f.path.join(f.root, "restoring"))).toBe(false);
    }),
  ),
);

it.effect("a checkpoint with no chat attachments restores its verified empty set", () =>
  run(
    Effect.gen(function* () {
      const f = yield* makeAttachmentCheckpointFixture(false);
      const saved = yield* f.store.capture(f.input);
      const packed = yield* makeThreadAttachmentCheckpointTransfer(f.sql).pack({
        threadId: f.input.threadId,
        generation: 1,
        turnId: f.input.turnId,
        sourceEnvironmentId: f.point.environmentId,
        scratchRoot: f.path.join(f.root, "packing"),
        chunkSizeBytes: 128,
      });
      expect(packed.manifest.files).toHaveLength(2);
      yield* f.fs.remove(saved.directory, { recursive: true });
      const restored = yield* materializeAttachmentCheckpoint({
        manifest: packed.manifest,
        expected: packed.header,
        chunkDirectory: packed.directory,
        destinationRoot: f.path.join(f.root, "restoring"),
        threadId: f.input.threadId,
        operationId: packed.header.operationId,
        transferManifestSha256: packed.manifest.transferManifestSha256,
      });
      expect(restored.header.attachments.files).toEqual([]);
      expect(yield* f.fs.readDirectory(restored.attachmentsDirectory)).toEqual(["manifest.json"]);
    }),
  ),
);
