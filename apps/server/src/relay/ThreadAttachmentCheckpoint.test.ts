import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { makeThreadAttachmentCheckpoint } from "./ThreadAttachmentCheckpoint.ts";
import { ThreadAttachmentManifest } from "./ThreadAttachmentTransfer.ts";
import {
  attachmentCheckpointFixture as fixture,
  runAttachmentCheckpointTest as run,
} from "./testUtils/threadAttachmentCheckpoint.ts";
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ThreadAttachmentManifest));

it.effect(
  "retains historical and removed queued attachments at the native point's exact cursor",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.message(f.attachments[2]!);
        const saved = yield* f.store.capture(f.input);
        expect(saved.sourceSequence).toBe(f.point.sourceSequence);
        const manifest = yield* decodeManifest(
          yield* f.fs.readFileString(f.path.join(saved.directory, "manifest.json")),
        );
        expect(manifest.files.map((file) => file.attachment.id)).toEqual(
          f.attachments.slice(0, 2).map((file) => file.id),
        );
        expect(
          yield* f.fs.exists(
            f.path.join(saved.directory, attachmentRelativePath(f.attachments[2]!)!),
          ),
        ).toBe(false);
        expect(yield* f.fs.exists(f.path.join(saved.directory, "unrelated-auth.json"))).toBe(false);
        expect(saved.publishedArtifactId).toBeNull();
        expect(yield* f.store.capture(f.input)).toEqual(saved);
        expect((yield* f.fs.readDirectory(f.input.artifactRoot)).length).toBe(1);
      }),
    ),
);
it.effect(
  "damaged retained attachment bytes block retry without replacing the recovery point",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture,
          saved = yield* f.store.capture(f.input);
        yield* f.fs.writeFileString(
          f.path.join(saved.directory, attachmentRelativePath(f.attachments[0]!)!),
          "wrong",
        );
        yield* Effect.flip(f.store.capture(f.input));
        expect(yield* f.store.get(f.input.threadId, 1, "turn-1")).toEqual(saved);
        expect(
          yield* f.fs.readFileString(
            f.path.join(f.attachmentsDir, attachmentRelativePath(f.attachments[0]!)!),
          ),
        ).toBe("data0");
      }),
    ),
);
it.effect("extra files in a retained checkpoint are rejected before publication", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        saved = yield* f.store.capture(f.input);
      yield* f.fs.writeFileString(f.path.join(saved.directory, "auth.json"), "do-not-publish");
      const error = yield* Effect.flip(f.store.capture(f.input));
      expect(error.message).toContain("unexpected");
      expect(yield* f.store.get(f.input.threadId, 1, "turn-1")).toEqual(saved);
    }),
  ),
);
it.effect("incomplete historical reads cannot silently omit attachment references", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const incomplete = makeThreadAttachmentCheckpoint(f.sql, {
        readAggregateRange: (input) => f.events.readAggregateRange(input).pipe(Stream.take(2)),
      });
      yield* Effect.flip(incomplete.capture(f.input));
      expect(yield* f.store.get(f.input.threadId, 1, "turn-1")).toBeNull();
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
    }),
  ),
);
it.effect("ownership changes during history export cannot publish attachment checkpoints", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      let changed = false;
      const racing = makeThreadAttachmentCheckpoint(f.sql, {
        readAggregateRange: (input) =>
          f.events.readAggregateRange(input).pipe(
            Stream.tap(() => {
              if (changed) return Effect.void;
              changed = true;
              return f.sql`UPDATE thread_execution_fences SET phase='retired'
        WHERE thread_id=${f.input.threadId}`.pipe(Effect.asVoid, Effect.orDie);
            }),
          ),
      });
      yield* Effect.flip(racing.capture(f.input));
      expect(yield* f.store.get(f.input.threadId, 1, "turn-1")).toBeNull();
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.point.directory)).toBe(true);
    }),
  ),
);
it.effect("a missing source attachment cannot publish a partial checkpoint", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.path.join(f.attachmentsDir, attachmentRelativePath(f.attachments[1]!)!));
      yield* Effect.flip(f.store.capture(f.input));
      expect(yield* f.store.get(f.input.threadId, 1, "turn-1")).toBeNull();
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.point.directory)).toBe(true);
    }),
  ),
);

it.effect("disk flush failure cannot publish an attachment point or discard its native point", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        open = f.fs.open;
      const fs = {
        ...f.fs,
        open: (...args: Parameters<typeof open>) =>
          open(...args).pipe(
            Effect.map((file) => ({
              ...file,
              sync: Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "sync",
                  description: "injected disk flush failure",
                }),
              ),
            })),
          ),
      };
      yield* Effect.flip(
        f.store.capture(f.input).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
      expect(yield* f.store.get(f.input.threadId, 1, f.input.turnId)).toBeNull();
      expect(yield* f.fs.readDirectory(f.input.artifactRoot)).toEqual([]);
      expect(yield* f.fs.exists(f.point.directory)).toBe(true);
    }),
  ),
);
