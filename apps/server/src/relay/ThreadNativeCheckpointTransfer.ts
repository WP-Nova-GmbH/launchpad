import { ThreadHistoryArchiveManifest } from "@t3tools/contracts/threadTransfer";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadHistoryArchive, inspectThreadHistoryArchive } from "./ThreadHistoryArchive.ts";
import { checkpointPublicationOperationId } from "./ThreadCheckpointIntent.ts";
import { importCodexConversation } from "../provider/Drivers/CodexConversationTransfer.ts";
import { nativeCheckpointFiles } from "@t3tools/shared/nativeCheckpointFiles";
import * as NodeCrypto from "node:crypto";
import {
  CodexConversationManifest,
  ThreadNativeCheckpointArchiveManifest,
  ThreadTransferChunkManifest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { flushThreadArtifactTree } from "./ThreadArtifactDurability.ts";
import {
  digestNativeCheckpointArchive,
  makeThreadNativeCheckpoint,
  threadCheckpointId,
  ThreadNativeCheckpointError,
} from "./ThreadNativeCheckpoint.ts";
import {
  materializeThreadTransferChunks,
  packThreadTransferArchive,
} from "./ThreadTransferChunks.ts";

const historyCodec = Schema.fromJsonString(ThreadHistoryArchiveManifest);
const decodeHistory = Schema.decodeEffect(historyCodec);
const encodeHistory = Schema.encodeEffect(historyCodec);
const decodeNative = Schema.decodeEffect(Schema.fromJsonString(CodexConversationManifest));
const decodeHeaderValue = Schema.decodeEffect(ThreadNativeCheckpointArchiveManifest);
const decodeChunks = Schema.decodeEffect(ThreadTransferChunkManifest);
const decodeHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadNativeCheckpointArchiveManifest),
);
const encodeHeader = Schema.encodeEffect(
  Schema.fromJsonString(ThreadNativeCheckpointArchiveManifest),
);
const encodeNative = Schema.encodeSync(Schema.fromJsonString(CodexConversationManifest));
const fail = (message: string) => new ThreadNativeCheckpointError({ message });
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
type Header = ThreadNativeCheckpointArchiveManifest;
type Identity = Pick<
  Header,
  | "threadId"
  | "operationId"
  | "turnId"
  | "sourceEnvironmentId"
  | "generation"
  | "sourceSequence"
  | "captureOperationId"
>;

const readManifest = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(file);
  if (stat.type !== "File" || stat.size > 2n * 1024n * 1024n || (yield* fs.realPath(file)) !== file)
    return yield* fail("Native checkpoint manifest is not a bounded regular file.");
  return yield* fs.readFile(file);
});

/** Verify the exact native file set, including empty directories in the whole-tree digest. */
export const verifyNativeCheckpointArchive = Effect.fn("ThreadNativeCheckpointTransfer.verify")(
  function* (directory: string, header: Header) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    if ((yield* digestNativeCheckpointArchive(directory)) !== header.archiveSha256)
      return yield* fail("The complete native checkpoint failed verification.");
    const bytes = yield* readManifest(path.join(directory, "manifest.json"));
    if (hash(bytes) !== header.nativeManifestSha256)
      return yield* fail("The native checkpoint manifest changed.");
    const native = yield* decodeNative(new TextDecoder().decode(bytes));
    if (encodeNative(native) !== encodeNative(header.native))
      return yield* fail("Native checkpoint header and conversation do not match.");
    const specification = nativeCheckpointFiles(header);
    if (!specification) return yield* fail("The native checkpoint file set is invalid.");
    const { files: expected, directories: declared } = specification;
    const found = new Set<string>();
    for (const name of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, name),
        stat = yield* fs.stat(absolute);
      if (stat.type === "Directory") {
        if (!declared.has(name)) return yield* fail("Unexpected native checkpoint directory.");
        for (const child of yield* fs.readDirectory(absolute)) found.add(`${name}/${child}`);
      } else found.add(name);
    }
    for (const name of declared)
      if (
        !(yield* fs.exists(path.join(directory, name))) ||
        (yield* fs.stat(path.join(directory, name))).type !== "Directory"
      )
        return yield* fail("A declared native checkpoint directory is missing.");
    if (found.size !== expected.size || [...found].some((name) => !expected.has(name)))
      return yield* fail("Unexpected or missing files in the native checkpoint.");
    for (const [name, descriptor] of expected) {
      const file = path.join(directory, name),
        stat = yield* fs.stat(file);
      if (
        stat.type !== "File" ||
        (descriptor.sizeBytes !== undefined && stat.size !== BigInt(descriptor.sizeBytes))
      )
        return yield* fail("Native checkpoint file size does not match its manifest.");
      const digest = NodeCrypto.createHash("sha256");
      yield* fs
        .stream(file)
        .pipe(Stream.runForEach((part) => Effect.sync(() => digest.update(part))));
      if (digest.digest("hex") !== descriptor.sha256)
        return yield* fail("Native checkpoint file failed verification.");
    }
    return { native, files: [...expected.keys()] };
  },
);

/** Package the local outbox only; publication still requires an independently pinned receipt. */
export function makeThreadNativeCheckpointTransfer(
  sql: SqlClient.SqlClient,
  events?: Pick<OrchestrationEventStoreShape, "readAggregateRange">,
) {
  const points = makeThreadNativeCheckpoint(sql),
    fences = makeThreadExecutionFence(sql);
  const pack = Effect.fn("ThreadNativeCheckpointTransfer.pack")(function* (input: {
    readonly threadId: string;
    readonly generation: number;
    readonly turnId: string;
    readonly captureOperationId?: string;
    readonly sourceEnvironmentId: string;
    readonly scratchRoot: string;
    readonly chunkSizeBytes?: number;
  }) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const point = yield* points.get(
      input.threadId,
      input.generation,
      threadCheckpointId(input.turnId, input.captureOperationId),
    );
    const fence = yield* fences.get(input.threadId);
    if (
      !point ||
      !fence ||
      fence.generation !== input.generation ||
      fence.environmentId !== input.sourceEnvironmentId ||
      point.environmentId !== input.sourceEnvironmentId ||
      point.turnId !== input.turnId ||
      point.captureOperationId !== (input.captureOperationId ?? null) ||
      (input.captureOperationId !== undefined &&
        (fence.phase !== "frozen" ||
          fence.operationId !== input.captureOperationId ||
          fence.frozenSequence !== point.sourceSequence)) ||
      fence.phase === "retired"
    )
      return yield* fail("This environment does not own the requested native checkpoint.");
    const source = yield* fs.realPath(point.directory);
    if ((yield* digestNativeCheckpointArchive(source)) !== point.archiveSha256)
      return yield* fail("The retained native checkpoint is damaged.");
    const bytes = yield* readManifest(path.join(source, "manifest.json"));
    if (hash(bytes) !== point.manifestSha256)
      return yield* fail("Native checkpoint manifest changed.");
    const native = yield* decodeNative(new TextDecoder().decode(bytes));
    if (native.threadId !== point.nativeThreadId)
      return yield* fail("Native checkpoint identity changed.");
    const directories: Header["directories"][number][] = [];
    for (const name of ["files", "native-rollouts"] as const)
      if (yield* fs.exists(path.join(source, name))) directories.push(name);
    let header = yield* decodeHeaderValue({
      format: "launchpad-native-checkpoint-v1",
      threadId: input.threadId,
      operationId: checkpointPublicationOperationId(
        "launchpad-native-checkpoint-v1",
        input.threadId,
        input.generation,
        input.turnId,
        point,
      ),
      turnId: input.turnId,
      ...(input.captureOperationId === undefined
        ? {}
        : { captureOperationId: input.captureOperationId }),
      sourceEnvironmentId: input.sourceEnvironmentId,
      generation: input.generation,
      sourceSequence: point.sourceSequence,
      nativeManifestSha256: point.manifestSha256,
      archiveSha256: point.archiveSha256,
      native,
      directories,
    });
    yield* verifyNativeCheckpointArchive(source, header);
    // Do not add staging files inside the immutable outbox or follow a redirected scratch root.
    const scratch = path.resolve(input.scratchRoot);
    let ancestor = scratch;
    while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
    const canonical = path.resolve(yield* fs.realPath(ancestor), path.relative(ancestor, scratch));
    if (canonical === source || canonical.startsWith(`${source}${path.sep}`))
      return yield* fail("Checkpoint packing must use separate staging storage.");
    yield* fs.makeDirectory(scratch, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({
      directory: scratch,
      prefix: "native-transfer-",
    });
    return yield* Effect.gen(function* () {
      const copy = path.join(directory, "native");
      yield* fs.copy(source, copy);
      yield* verifyNativeCheckpointArchive(copy, header);
      // A correct digest can preserve malformed native history. Exercise the strict
      // installer in disposable storage before publishing the immutable candidate.
      const validationRoot = path.join(directory, "validate-native");
      yield* importCodexConversation({
        manifest: header.native,
        rolloutPath: path.join(copy, "rollout.jsonl"),
        destinationRoot: validationRoot,
        codexVersion: header.native.codexVersion,
      }).pipe(
        Effect.ensuring(
          fs.remove(validationRoot, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
      if ((yield* digestNativeCheckpointArchive(source)) !== point.archiveSha256)
        return yield* fail("Native checkpoint changed while packing.");
      const historyArchive =
        input.captureOperationId && events ? makeThreadHistoryArchive(sql, events) : null;
      if (historyArchive) {
        const saved = yield* historyArchive.exportFrozen({
          threadId: input.threadId,
          environmentId: input.sourceEnvironmentId,
          generation: input.generation,
          operationId: input.captureOperationId!,
          artifactRoot: directory,
        });
        if (
          saved.manifest.sourceSequence !== header.sourceSequence ||
          saved.manifest.eventCount > 100_000 ||
          saved.manifest.receiptCount > 100_000 ||
          saved.manifest.events.size + saved.manifest.receipts.size > 256 * 1024 * 1024
        )
          return yield* fail("Frozen history and native checkpoint watermarks disagree.");
        yield* fs.rename(saved.directory, path.join(directory, "history"));
        header = { ...header, recoveryHistory: saved.manifest };
      }
      const encoded = yield* encodeHeader(header);
      yield* fs.writeFileString(path.join(directory, "manifest.json"), encoded, {
        flag: "wx",
        mode: 0o600,
      });
      yield* flushThreadArtifactTree(directory);
      const packed = yield* packThreadTransferArchive({
        archiveDirectory: directory,
        scratchRoot: scratch,
        expectedManifestSha256: hash(new TextEncoder().encode(encoded)),
        ...(input.chunkSizeBytes === undefined ? {} : { chunkSizeBytes: input.chunkSizeBytes }),
      });
      return yield* Effect.gen(function* () {
        if (header.recoveryHistory && historyArchive)
          yield* historyArchive.verifyFrozen(header.recoveryHistory);
        const currentFence = yield* fences.get(input.threadId);
        const currentPoint = yield* points.get(
          input.threadId,
          input.generation,
          threadCheckpointId(input.turnId, input.captureOperationId),
        );
        if (
          !currentFence ||
          currentFence.phase === "retired" ||
          currentFence.generation !== input.generation ||
          currentFence.environmentId !== input.sourceEnvironmentId ||
          !currentPoint ||
          currentPoint.archiveSha256 !== point.archiveSha256 ||
          currentPoint.sourceSequence !== point.sourceSequence ||
          (input.captureOperationId !== undefined &&
            (currentFence.phase !== "frozen" ||
              currentFence.operationId !== input.captureOperationId ||
              currentFence.frozenSequence !== point.sourceSequence))
        )
          return yield* fail("Native checkpoint ownership changed while packing.");
        return { ...packed, header };
      }).pipe(
        Effect.onError(() => fs.remove(packed.directory, { recursive: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.ensuring(fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  });
  return { pack };
}

/** Reconstruct verified bytes in quarantine; callers must still use strict native import/resume. */
export const materializeNativeCheckpoint = Effect.fn("ThreadNativeCheckpointTransfer.materialize")(
  function* (
    input: Parameters<typeof materializeThreadTransferChunks>[0] & { readonly expected: Identity },
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const manifest = yield* decodeChunks(input.manifest);
    if (
      manifest.threadId !== input.expected.threadId ||
      manifest.operationId !== input.expected.operationId ||
      manifest.sourceEnvironmentId !== input.expected.sourceEnvironmentId ||
      manifest.generation !== input.expected.generation ||
      manifest.files.length > 1029 ||
      manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) > 770 * 1024 * 1024 ||
      manifest.files.some(
        (file) =>
          file.path !== "manifest.json" &&
          !file.path.startsWith("native/") &&
          !file.path.startsWith("history/"),
      ) ||
      (manifest.files.find((file) => file.path === "manifest.json")?.sizeBytes ?? Infinity) >
        2 * 1024 * 1024
    )
      return yield* fail("Native recovery chunks exceed or do not match the requested checkpoint.");
    const directory = yield* materializeThreadTransferChunks({ ...input, manifest });
    return yield* Effect.gen(function* () {
      const header = yield* decodeHeader(
        new TextDecoder().decode(yield* readManifest(path.join(directory, "manifest.json"))),
      );
      const expected = input.expected;
      if (
        header.threadId !== expected.threadId ||
        header.operationId !== expected.operationId ||
        header.turnId !== expected.turnId ||
        (header.captureOperationId ?? null) !== (expected.captureOperationId ?? null) ||
        header.sourceEnvironmentId !== expected.sourceEnvironmentId ||
        header.generation !== expected.generation ||
        header.sourceSequence !== expected.sourceSequence ||
        input.manifest.sourceEnvironmentId !== header.sourceEnvironmentId ||
        input.manifest.generation !== header.generation
      )
        return yield* fail("Native checkpoint does not match the requested recovery point.");
      const nativeDirectory = path.join(directory, "native");
      for (const name of header.directories)
        yield* fs.makeDirectory(path.join(nativeDirectory, name), { recursive: true, mode: 0o700 });
      const verified = yield* verifyNativeCheckpointArchive(nativeDirectory, header);
      const allowed = new Set(["manifest.json", ...verified.files.map((file) => `native/${file}`)]);
      let recoveryHistory:
        | Effect.Success<ReturnType<typeof inspectThreadHistoryArchive>>
        | undefined;
      if (header.recoveryHistory) {
        const h = header.recoveryHistory;
        if (
          h.eventCount > 100_000 ||
          h.receiptCount > 100_000 ||
          h.events.size + h.receipts.size > 256 * 1024 * 1024 ||
          !header.captureOperationId ||
          h.operationId !== header.captureOperationId ||
          h.threadId !== header.threadId ||
          h.environmentId !== header.sourceEnvironmentId ||
          h.generation !== header.generation ||
          h.sourceSequence !== header.sourceSequence
        )
          return yield* fail("Retained history belongs to a different frozen checkpoint.");
        for (const name of ["manifest.json", "events.jsonl", "receipts.jsonl"])
          allowed.add(`history/${name}`);
        const historyDirectory = path.join(directory, "history");
        const metadata = new TextDecoder().decode(
          yield* readManifest(path.join(historyDirectory, "manifest.json")),
        );
        const decoded = yield* Schema.decodeEffect(
          Schema.fromJsonString(ThreadHistoryArchiveManifest),
        )(metadata);
        if (
          (yield* Schema.encodeEffect(Schema.fromJsonString(ThreadHistoryArchiveManifest))(
            decoded,
          )) !== (yield* encodeHistory(h))
        )
          return yield* fail("Retained history metadata disagrees with its checkpoint.");
        recoveryHistory = yield* inspectThreadHistoryArchive({
          owner: h,
          manifest: h,
          directory: historyDirectory,
        });
      }
      if (
        input.manifest.files.length !== allowed.size ||
        input.manifest.files.some((file) => !allowed.has(file.path))
      )
        return yield* fail("Unexpected files in the native recovery archive.");
      return { directory, nativeDirectory, header, recoveryHistory };
    }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
  },
);
