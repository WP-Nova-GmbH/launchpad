import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type ChatAttachment } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { attachmentRelativePath } from "../attachmentStore.ts";
import {
  exportThreadAttachments,
  importThreadAttachments,
  installThreadAttachments,
} from "./ThreadAttachmentTransfer.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-attachment-transfer-" });
  const attachmentsDir = path.join(root, "source");
  yield* fs.makeDirectory(attachmentsDir);
  const attachments: ReadonlyArray<ChatAttachment> = [
    {
      type: "image",
      id: "thread-1-00000000-0000-4000-8000-000000000001",
      name: "picture.png",
      mimeType: "image/png",
      sizeBytes: 6,
    },
    {
      type: "file",
      id: "thread-1-00000000-0000-4000-8000-000000000002-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    },
  ];
  const names = attachments.map((attachment) => attachmentRelativePath(attachment)!);
  yield* fs.writeFileString(path.join(attachmentsDir, names[0]!), "pixels");
  yield* fs.writeFileString(path.join(attachmentsDir, names[1]!), "notes");
  yield* fs.writeFileString(path.join(attachmentsDir, "unrelated.txt"), "other user's attachment");
  const input = {
    threadId: "thread-1",
    attachments,
    attachmentsDir,
    artifactRoot: path.join(root, "artifacts"),
  };
  const request = (exported: Effect.Success<ReturnType<typeof exportThreadAttachments>>) => ({
    threadId: input.threadId,
    attachments,
    manifest: exported.manifest,
    artifactDirectory: exported.directory,
    destinationRoot: path.join(root, "destination"),
  });
  return { fs, path, root, names, input, request };
});

it.layer(NodeServices.layer)("thread attachment transfer", (it) => {
  it.effect(
    "preserves referenced bytes and IDs after source deletion, without unrelated files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportThreadAttachments({
          ...f.input,
          attachments: [...f.input.attachments, f.input.attachments[0]!],
        });
        expect(exported.manifest.files).toHaveLength(2);
        yield* f.fs.remove(f.input.attachmentsDir, { recursive: true });
        const imported = yield* importThreadAttachments(f.request(exported));
        expect((yield* f.fs.readDirectory(imported.attachmentsDir)).sort()).toEqual(
          [...f.names].sort(),
        );
        expect(yield* f.fs.readFileString(f.path.join(imported.attachmentsDir, f.names[0]!))).toBe(
          "pixels",
        );
        expect(yield* f.fs.readFileString(f.path.join(imported.attachmentsDir, f.names[1]!))).toBe(
          "notes",
        );
        expect(imported.manifest).toEqual(exported.manifest);
      }),
  );
  for (const mode of ["missing", "corrupt", "size"] as const) {
    it.effect(`rejects ${mode} attachment bytes and removes incomplete import`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportThreadAttachments(f.input);
        const file = f.path.join(exported.directory, f.names[1]!);
        if (mode === "missing") yield* f.fs.remove(file);
        else yield* f.fs.writeFileString(file, mode === "corrupt" ? "other" : "too-long");
        const request = f.request(exported);
        yield* Effect.flip(importThreadAttachments(request));
        expect(yield* f.fs.readDirectory(request.destinationRoot)).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.input.attachmentsDir, f.names[1]!))).toBe(
          "notes",
        );
      }),
    );
  }
  for (const mode of ["omitted", "duplicate", "extra", "wrong-thread"] as const) {
    it.effect(`rejects a ${mode} manifest before creating a destination`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportThreadAttachments(f.input);
        const files = exported.manifest.files;
        const manifest = {
          ...exported.manifest,
          threadId: mode === "wrong-thread" ? "different" : f.input.threadId,
          files:
            mode === "omitted"
              ? files.slice(1)
              : mode === "duplicate"
                ? [...files, files[0]!]
                : files,
        };
        const request = {
          ...f.request(exported),
          manifest,
          attachments: mode === "extra" ? f.input.attachments.slice(0, 1) : f.input.attachments,
        };
        const error = yield* Effect.flip(importThreadAttachments(request));
        expect(error._tag).toBe("ThreadAttachmentTransferError");
        expect(yield* f.fs.exists(request.destinationRoot)).toBe(false);
      }),
    );
  }
  it.effect("blocks unsupported and cross-thread references", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const attachment of [
        { ...f.input.attachments[0]!, type: "future-format" },
        { ...f.input.attachments[0]!, id: "another-00000000-0000-4000-8000-000000000001" },
      ]) {
        const error = yield* Effect.flip(
          exportThreadAttachments({ ...f.input, attachments: [attachment] }),
        );
        expect(error._tag).toBe("ThreadAttachmentTransferError");
        expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
      }
    }),
  );
  it.effect("rejects names which collide on a case-insensitive destination", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = f.input.attachments[0]!;
      const error = yield* Effect.flip(
        exportThreadAttachments({
          ...f.input,
          attachments: [first, { ...first, id: first.id.toUpperCase() }],
        }),
      );
      expect(error.message).toContain("collide");
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  );

  it.effect("transfers an empty attachment set without requiring source storage", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.input.attachmentsDir, { recursive: true });
      const exported = yield* exportThreadAttachments({ ...f.input, attachments: [] });
      const imported = yield* importThreadAttachments({ ...f.request(exported), attachments: [] });
      expect(yield* f.fs.readDirectory(imported.attachmentsDir)).toEqual([]);
    }),
  );

  it.effect("rejects inconsistent metadata for repeated references", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* Effect.flip(
        exportThreadAttachments({
          ...f.input,
          attachments: [
            ...f.input.attachments,
            { ...f.input.attachments[0]!, name: "renamed.png" },
          ],
        }),
      );
      expect(error.message).toContain("conflicting");
    }),
  );
  it.effect.skipIf(!symlinksSupported)("does not follow an attachment symlink", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.input.attachmentsDir, f.names[0]!);
      const outside = f.path.join(f.root, "outside");
      yield* f.fs.rename(file, outside);
      yield* f.fs.symlink(outside, file);
      const error = yield* Effect.flip(exportThreadAttachments(f.input));
      expect(error.message).toContain("regular file");
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.readFileString(outside)).toBe("pixels");
    }),
  );
  it.effect("detects an earlier attachment changing while a later file is copied", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const changedFs = {
        ...f.fs,
        copyFile: (source: string, destination: string) =>
          f.fs
            .copyFile(source, destination)
            .pipe(
              Effect.andThen(
                source.endsWith(f.names[1]!)
                  ? f.fs.writeFileString(f.path.join(f.input.attachmentsDir, f.names[0]!), "edited")
                  : Effect.void,
              ),
            ),
      };
      const error = yield* exportThreadAttachments(f.input).pipe(
        Effect.provideService(FileSystem.FileSystem, changedFs),
        Effect.flip,
      );
      expect(error.message).toContain("changed");
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
    }),
  );
  for (const phase of ["export", "import"] as const) {
    it.effect(`cleans up interrupted ${phase} without deleting the completed artifact`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const previous = yield* exportThreadAttachments(f.input);
        const copied = yield* Deferred.make<void>();
        const interruptedFs = {
          ...f.fs,
          copyFile: (source: string, destination: string) =>
            f.fs
              .copyFile(source, destination)
              .pipe(
                Effect.andThen(Deferred.succeed(copied, undefined)),
                Effect.andThen(Effect.never),
              ),
        };
        const operation =
          phase === "export"
            ? exportThreadAttachments(f.input).pipe(Effect.asVoid)
            : importThreadAttachments(f.request(previous)).pipe(Effect.asVoid);
        const fiber = yield* operation.pipe(
          Effect.provideService(FileSystem.FileSystem, interruptedFs),
          Effect.forkChild,
        );
        yield* Deferred.await(copied);
        yield* Fiber.interrupt(fiber);
        expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([
          f.path.basename(previous.directory),
        ]);
        if (phase === "import")
          expect(yield* f.fs.readDirectory(f.request(previous).destinationRoot)).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(f.input.attachmentsDir, f.names[0]!))).toBe(
          "pixels",
        );
      }),
    );
  }
  it.effect(
    "publishes atomically, survives retries, and preserves conflicting destination data",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const exported = yield* exportThreadAttachments(f.input);
        const attachmentsDir = f.path.join(f.root, "installed");
        const input = { ...f.request(exported), attachmentsDir };
        yield* installThreadAttachments(input);
        yield* installThreadAttachments(input);
        expect((yield* f.fs.readDirectory(attachmentsDir)).sort()).toEqual([...f.names].sort());
        const target = f.path.join(attachmentsDir, f.names[0]!);
        yield* f.fs.writeFileString(target, "other data");
        expect((yield* Effect.flip(installThreadAttachments(input))).message).toContain(
          "different bytes",
        );
        expect(yield* f.fs.readFileString(target)).toBe("other data");
        expect((yield* f.fs.readDirectory(attachmentsDir)).sort()).toEqual([...f.names].sort());
      }),
  );
  it.effect("does not install through an existing attachment symlink", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const exported = yield* exportThreadAttachments(f.input);
      const attachmentsDir = f.path.join(f.root, "installed");
      yield* f.fs.makeDirectory(attachmentsDir);
      const original = f.path.join(f.input.attachmentsDir, f.names[0]!);
      yield* f.fs.symlink(original, f.path.join(attachmentsDir, f.names[0]!));
      yield* Effect.flip(installThreadAttachments({ ...f.request(exported), attachmentsDir }));
      expect(yield* f.fs.readFileString(original)).toBe("pixels");
    }),
  );
});
