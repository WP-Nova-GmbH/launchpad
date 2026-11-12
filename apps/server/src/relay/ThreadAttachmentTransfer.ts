import { ThreadAttachmentManifest } from "@t3tools/contracts/relay";
import * as NodeCrypto from "node:crypto";
import { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const AttachmentList = Schema.Array(ChatAttachment);
export { ThreadAttachmentManifest } from "@t3tools/contracts/relay";
export class ThreadAttachmentTransferError extends Schema.TaggedError<ThreadAttachmentTransferError>()(
  "ThreadAttachmentTransferError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadAttachmentTransferError({ message });
const decodeAttachments = Schema.decodeEffect(AttachmentList);
const decodeManifest = Schema.decodeUnknownEffect(ThreadAttachmentManifest);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadAttachmentManifest));
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));

// The caller supplies references from the complete, frozen thread baseline (including
// queued prompts and historical question answers), never a directory listing or UI page.
export const threadAttachmentFiles = Effect.fnUntraced(function* (
  threadId: string,
  input: ReadonlyArray<ChatAttachment>,
) {
  const attachments = yield* decodeAttachments(input);
  const files = new Map<string, { attachment: ChatAttachment; filename: string }>();
  const names = new Map<string, string>();
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) return yield* fail("The thread has no valid attachment identity.");
  for (const attachment of attachments) {
    const filename = attachmentRelativePath(attachment);
    if (!filename || parseThreadSegmentFromAttachmentId(attachment.id) !== threadSegment)
      return yield* fail("An attachment is unsupported or does not belong to this thread.");
    const nameOwner = names.get(filename.toLowerCase());
    if (nameOwner !== undefined && nameOwner !== attachment.id)
      return yield* fail("Attachment names collide on the destination filesystem.");
    names.set(filename.toLowerCase(), attachment.id);
    const existing = files.get(attachment.id);
    if (existing && encodeAttachment(existing.attachment) !== encodeAttachment(attachment))
      return yield* fail("The thread contains conflicting references to the same attachment.");
    files.set(attachment.id, { attachment, filename });
  }
  return [...files.values()].sort((a, b) => a.filename.localeCompare(b.filename));
});

export const inspectThreadAttachmentFile = Effect.fnUntraced(function* (
  root: string,
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, filename);
  if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== "File")
    return yield* fail("Attachment transfer requires a regular file inside its storage directory.");
  const hash = NodeCrypto.createHash("sha256");
  let sizeBytes = 0;
  yield* fs.stream(file).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        sizeBytes += chunk.length;
        hash.update(chunk);
      }),
    ),
  );
  return { sha256: hash.digest("hex"), sizeBytes };
});

/** Returns an unpublished artifact; publish its manifest only after the frozen baseline is durable. */
export const exportThreadAttachments = Effect.fn("exportThreadAttachments")(function* (input: {
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir: string;
  readonly artifactRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* threadAttachmentFiles(input.threadId, input.attachments);
  const root = files.length ? yield* fs.realPath(input.attachmentsDir) : input.attachmentsDir;
  yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({
    directory: input.artifactRoot,
    prefix: "attachments-",
  });
  return yield* Effect.gen(function* () {
    const stored: Array<ThreadAttachmentManifest["files"][number]> = [];
    for (const { attachment, filename } of files) {
      const before = yield* inspectThreadAttachmentFile(root, filename);
      if (before.sizeBytes !== attachment.sizeBytes)
        return yield* fail("An attachment's size no longer matches the thread history.");
      yield* fs.copyFile(path.join(root, filename), path.join(directory, filename));
      yield* fs.chmod(path.join(directory, filename), 0o600);
      const copied = yield* inspectThreadAttachmentFile(yield* fs.realPath(directory), filename);
      if (copied.sha256 !== before.sha256 || copied.sizeBytes !== before.sizeBytes)
        return yield* fail("An attachment changed during transfer.");
      stored.push({ attachment, sha256: copied.sha256 });
    }
    // Recheck the whole set, not just the most recently copied file.
    for (let index = 0; index < files.length; index++) {
      const current = yield* inspectThreadAttachmentFile(root, files[index]!.filename);
      if (current.sha256 !== stored[index]!.sha256)
        return yield* fail("An attachment changed during transfer.");
    }
    const manifest: ThreadAttachmentManifest = {
      format: "launchpad-attachments-v1",
      threadId: input.threadId,
      files: stored,
    };
    yield* fs.writeFileString(
      path.join(directory, "manifest.json"),
      yield* encodeManifest(manifest),
      { mode: 0o600, flag: "wx" },
    );
    return { directory, manifest };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

/** Stage in a fresh directory. The handoff owns installation; existing attachments are never overwritten. */
export const importThreadAttachments = Effect.fn("importThreadAttachments")(function* (input: {
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly manifest: unknown;
  readonly artifactDirectory: string;
  readonly destinationRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* decodeManifest(input.manifest);
  const expected = yield* threadAttachmentFiles(input.threadId, input.attachments);
  const supplied = yield* threadAttachmentFiles(
    manifest.threadId,
    manifest.files.map((file) => file.attachment),
  );
  if (
    manifest.threadId !== input.threadId ||
    supplied.length !== manifest.files.length ||
    supplied.length !== expected.length ||
    supplied.some(
      (file, index) =>
        encodeAttachment(file.attachment) !== encodeAttachment(expected[index]!.attachment),
    )
  )
    return yield* fail("The attachment manifest does not match this thread's complete references.");
  const hashes = new Map(manifest.files.map((file) => [file.attachment.id, file.sha256]));
  const root = expected.length
    ? yield* fs.realPath(input.artifactDirectory)
    : input.artifactDirectory;
  yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({
    directory: input.destinationRoot,
    prefix: "attachments-",
  });
  return yield* Effect.gen(function* () {
    const destination = yield* fs.realPath(directory);
    for (const { attachment, filename } of expected) {
      yield* inspectThreadAttachmentFile(root, filename);
      yield* fs.copyFile(path.join(root, filename), path.join(destination, filename));
      yield* fs.chmod(path.join(destination, filename), 0o600);
      const copied = yield* inspectThreadAttachmentFile(destination, filename);
      if (copied.sha256 !== hashes.get(attachment.id) || copied.sizeBytes !== attachment.sizeBytes)
        return yield* fail("An attachment failed its integrity check.");
    }
    return { attachmentsDir: destination, manifest };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

/** Publish verified attachments into the environment store without replacing an
 * existing ID. A retry accepts identical bytes; partial files are never visible.
 */
export const installThreadAttachments = Effect.fn("installThreadAttachments")(function* (input: {
  readonly threadId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly manifest: unknown;
  readonly artifactDirectory: string;
  readonly attachmentsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.attachmentsDir, { recursive: true, mode: 0o700 });
  const targetRoot = yield* fs.realPath(input.attachmentsDir);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scratch = yield* fs.makeTempDirectoryScoped({
        directory: targetRoot,
        prefix: ".transfer-",
      });
      const verified = yield* importThreadAttachments({ ...input, destinationRoot: scratch });
      for (const file of verified.manifest.files) {
        const filename = attachmentRelativePath(file.attachment)!;
        const target = path.join(targetRoot, filename);
        const source = path.join(verified.attachmentsDir, filename);
        yield* Effect.scoped(
          fs.open(source, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
        );
        // Hard-link publication is atomic and exclusive on the same filesystem.
        yield* fs
          .link(source, target)
          .pipe(
            Effect.catch((error) =>
              fs
                .exists(target)
                .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
            ),
          );
        const stored = yield* inspectThreadAttachmentFile(targetRoot, filename);
        if (stored.sha256 !== file.sha256 || stored.sizeBytes !== file.attachment.sizeBytes)
          return yield* fail("A destination attachment ID already contains different bytes.");
      }
      yield* Effect.scoped(
        fs.open(targetRoot, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
      );
      return verified.manifest;
    }),
  );
});
