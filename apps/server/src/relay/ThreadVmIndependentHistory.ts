import * as NodeCrypto from "node:crypto";
import { RelayThreadVmIndependentHistory } from "@t3tools/contracts/relay";
import { ThreadHistoryArchiveManifest } from "@t3tools/contracts/threadTransfer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { downloadThreadArtifactChunks } from "./ThreadArtifactDownload.ts";
import { inspectThreadHistoryArchive } from "./ThreadHistoryArchive.ts";
import { ThreadVmRestoreHistoryError } from "./ThreadVmRestoreHistory.ts";

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(ThreadHistoryArchiveManifest));
const fail = () =>
  new ThreadVmRestoreHistoryError({
    stage: "independent-history",
    message:
      "The independent conversation archive is incomplete or changed. Execution remains blocked.",
  });

/** Unlike saved-disk history, these events are authenticated by the relay's
 * immutable mirror. The old disk contributes workspace bytes only. */
export const materializeThreadVmIndependentHistory = Effect.fn(
  "ThreadVmIndependentHistory.materialize",
)(function* <E, R>(input: {
  threadId: string;
  operationId: string;
  history: RelayThreadVmIndependentHistory;
  scratchRoot: string;
  readArtifact: (id: string) => Effect.Effect<Stream.Stream<Uint8Array, E, R>, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    h = input.history;
  const packed = yield* downloadThreadArtifactChunks({
    indexArtifactId: h.manifestArtifactId,
    indexSha256: h.manifestSha256,
    threadId: input.threadId,
    operationId: input.operationId,
    sourceEnvironmentId: h.nativeBoundary.sourceEnvironmentId,
    generation: h.nativeBoundary.generation,
    scratchRoot: input.scratchRoot,
    maxFiles: 3,
    maxBytes: 320 * 1024 * 1024,
    readArtifact: input.readArtifact,
  });
  const expected = new Set([
    "history/manifest.json",
    "history/events.jsonl",
    "history/receipts.jsonl",
  ]);
  if (packed.manifest.files.length !== 3) return yield* fail();
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: input.scratchRoot,
    prefix: "independent-history-",
  });
  for (const file of packed.manifest.files) {
    if (!expected.delete(file.path)) return yield* fail();
    const destination = path.join(directory, file.path.slice("history/".length)),
      hash = NodeCrypto.createHash("sha256");
    let count = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(destination, { flag: "wx", mode: 0o600 });
        for (const chunk of file.chunks)
          yield* fs.stream(path.join(packed.chunkDirectory, chunk.artifactId)).pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                count += part.length;
                hash.update(part);
                yield* output.writeAll(part);
              }),
            ),
          );
        yield* output.sync;
      }),
    );
    if (count !== file.sizeBytes || hash.digest("hex") !== file.sha256) return yield* fail();
  }
  const raw = yield* fs.readFileString(path.join(directory, "manifest.json"));
  if (
    NodeCrypto.createHash("sha256").update(raw).digest("hex") !==
    packed.manifest.transferManifestSha256
  )
    return yield* fail();
  const manifest = yield* decodeManifest(raw);
  if (
    manifest.threadId !== input.threadId ||
    manifest.operationId !== input.operationId ||
    manifest.environmentId !== h.nativeBoundary.sourceEnvironmentId ||
    manifest.generation !== h.nativeBoundary.generation ||
    manifest.sourceSequence !== h.throughRelayCursor ||
    h.nativeBoundary.relayCursor > h.throughRelayCursor
  )
    return yield* fail();
  const history = yield* inspectThreadHistoryArchive({ owner: manifest, manifest, directory });
  const events = yield* Stream.runCollect(history.events);
  if (
    events.some((event, index) => event.sequence !== index + 1) ||
    events.at(-1)?.sequence !== h.throughRelayCursor
  )
    return yield* fail();
  return { ...history, events: Stream.fromIterable(events) };
});
