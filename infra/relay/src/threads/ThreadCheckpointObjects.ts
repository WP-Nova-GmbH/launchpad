import { sha256 } from "@noble/hashes/sha2";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";

const decodeChunks = Schema.decodeEffect(Schema.fromJsonString(ThreadTransferChunkManifest));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const encodeEntries = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        artifactId: Schema.String,
        sha256: Schema.String,
        sizeBytes: Schema.Number,
        kind: Schema.String,
      }),
    ),
  ),
);

type File = ThreadTransferChunkManifest["files"][number];
type Input = {
  readonly threadId: string;
  readonly operationId: string;
  readonly manifestArtifactId: string;
  readonly kind: "native" | "attachment" | "move";
  readonly maxBytes: number;
};
/** Callers verify every file and its domain manifest before publishing a durable pin set. */
export function makeThreadCheckpointObjects<E extends Error>(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
  conflict: (message: string) => E,
) {
  const catalog = makeThreadArtifactStore(sql);
  const text = (bytes: Uint8Array) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => conflict("Checkpoint metadata is not UTF-8."),
    });
  const prepare = Effect.fnUntraced(function* (input: Input) {
    const artifact = yield* catalog.get(input.manifestArtifactId);
    if (
      !artifact ||
      artifact.threadId !== input.threadId ||
      artifact.operationId !== input.operationId ||
      artifact.kind !== "manifest" ||
      artifact.state !== "complete" ||
      artifact.sizeBytes > 32 * 1024 * 1024
    )
      return yield* Effect.fail(conflict("Checkpoint chunk manifest is unavailable."));
    const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    yield* catalog.pin({
      artifactId: artifact.artifactId,
      threadId: input.threadId,
      operationId: readPinId,
      leaseMinutes: 60,
    });
    const readObject = Effect.fnUntraced(function* (artifactId: string, maxBytes: number) {
      const object = yield* catalog.get(artifactId);
      if (
        !object ||
        object.threadId !== input.threadId ||
        object.operationId !== input.operationId ||
        object.state !== "complete" ||
        object.sizeBytes > maxBytes
      )
        return yield* Effect.fail(conflict("Checkpoint object is unavailable."));
      const chunks: Uint8Array[] = [],
        digest = sha256.create();
      let length = 0;
      const stream = yield* objects.read(object.storageKey);
      yield* stream.pipe(
        Stream.runForEach((part) =>
          Effect.gen(function* () {
            length += part.length;
            if (length > maxBytes || length > object.sizeBytes)
              return yield* Effect.fail(conflict("Checkpoint object exceeded its declared size."));
            chunks.push(part);
            digest.update(part);
          }),
        ),
      );
      if (length !== object.sizeBytes || hex(digest.digest()) !== object.sha256)
        return yield* Effect.fail(conflict("Checkpoint object failed verification."));
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    });
    return yield* Effect.gen(function* () {
      const manifest = yield* decodeChunks(
        yield* text(yield* readObject(artifact.artifactId, 32 * 1024 * 1024)),
      );
      if (
        manifest.threadId !== input.threadId ||
        manifest.operationId !== input.operationId ||
        manifest.files.length > (input.kind === "move" ? 100_000 : 1029) ||
        manifest.files.reduce((n, file) => n + file.sizeBytes, 0) > input.maxBytes
      )
        return yield* Effect.fail(
          conflict("Checkpoint manifest belongs to a different or unbounded point."),
        );
      const names = new Set<string>(),
        ids = new Set<string>([artifact.artifactId]);
      const entries = [
        {
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          kind: "manifest",
        },
      ];
      for (const file of manifest.files) {
        if (
          names.has(file.path) ||
          (file.path !== "manifest.json" &&
            !(input.kind === "move"
              ? /^(history|workspace|attachments|native)\//u.test(file.path)
              : file.path.startsWith(`${input.kind === "native" ? "native" : "attachments"}/`) ||
                (input.kind === "native" && file.path.startsWith("history/")))) ||
          file.chunks.reduce((n, chunk) => n + chunk.sizeBytes, 0) !== file.sizeBytes
        )
          return yield* Effect.fail(conflict("Checkpoint file set is invalid."));
        names.add(file.path);
        for (const chunk of file.chunks) {
          if (
            ids.has(chunk.artifactId) ||
            chunk.sizeBytes > 64 * 1024 * 1024 ||
            entries.length >= 100_000
          )
            return yield* Effect.fail(conflict("Checkpoint chunks are duplicated or unbounded."));
          ids.add(chunk.artifactId);
          entries.push({
            ...chunk,
            kind:
              file.path === "manifest.json"
                ? "manifest"
                : input.kind === "move"
                  ? file.path.startsWith("attachments/")
                    ? "attachment"
                    : file.path.split("/")[0]!
                  : file.path.startsWith("history/")
                    ? "history"
                    : input.kind,
          });
        }
      }
      const encoded = encodeEntries(entries);
      // Pin every candidate together, before streaming any body. GC cannot race verification.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [matched] = yield* sql<{ count: number }>`WITH expected AS (
          SELECT * FROM jsonb_to_recordset(${encoded}::jsonb)
            AS e("artifactId" text,sha256 text,"sizeBytes" bigint,kind text)
        ), locked AS MATERIALIZED (
          SELECT a.artifact_id FROM relay_thread_artifacts a JOIN expected e
            ON a.artifact_id=e."artifactId" AND a.sha256=e.sha256
              AND a.size_bytes=e."sizeBytes" AND a.kind=e.kind
          WHERE a.thread_id=${input.threadId} AND a.operation_id=${input.operationId} AND a.state='complete'
          ORDER BY a.artifact_id FOR UPDATE OF a
        ), pinned AS (
          INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id,expires_at)
          SELECT artifact_id,${readPinId},clock_timestamp()+interval '1 hour' FROM locked
          ON CONFLICT DO NOTHING
        ) SELECT count(*)::int AS count FROM locked`;
          if (matched?.count !== entries.length)
            return yield* Effect.fail(
              conflict("Checkpoint has missing or mismatched completed objects."),
            );
        }),
      );
      const byName = new Map(manifest.files.map((file) => [file.path, file]));
      const readFile = Effect.fnUntraced(function* (
        file: File,
        observe: (part: Uint8Array) => void,
      ) {
        const whole = sha256.create();
        for (const chunk of file.chunks) {
          const object = yield* catalog.get(chunk.artifactId);
          if (!object || object.state !== "complete")
            return yield* Effect.fail(conflict("Pinned checkpoint chunk disappeared."));
          const digest = sha256.create();
          let length = 0;
          yield* (yield* objects.read(object.storageKey)).pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                length += part.length;
                if (length > chunk.sizeBytes)
                  return yield* Effect.fail(
                    conflict("Checkpoint chunk changed during verification."),
                  );
                digest.update(part);
                whole.update(part);
                observe(part);
              }),
            ),
          );
          if (length !== chunk.sizeBytes || hex(digest.digest()) !== chunk.sha256)
            return yield* Effect.fail(conflict("Checkpoint chunk failed its integrity check."));
        }
        if (hex(whole.digest()) !== file.sha256)
          return yield* Effect.fail(conflict("Checkpoint file failed verification."));
      });
      const streamFile = (file: File) =>
        Stream.unwrap(
          Effect.sync(() => {
            const whole = sha256.create();
            const chunks = Stream.fromIterable(file.chunks).pipe(
              Stream.flatMap((chunk) =>
                Stream.unwrap(
                  Effect.gen(function* () {
                    const object = yield* catalog.get(chunk.artifactId);
                    if (!object || object.state !== "complete")
                      return yield* Effect.fail(conflict("Pinned checkpoint chunk disappeared."));
                    const digest = sha256.create();
                    let length = 0;
                    return (yield* objects.read(object.storageKey)).pipe(
                      Stream.mapEffect((part) =>
                        Effect.gen(function* () {
                          length += part.length;
                          if (length > chunk.sizeBytes)
                            return yield* Effect.fail(
                              conflict("Checkpoint chunk exceeded its declared size."),
                            );
                          digest.update(part);
                          whole.update(part);
                          return part;
                        }),
                      ),
                      Stream.concat(
                        Stream.fromEffect(
                          Effect.suspend(() =>
                            length === chunk.sizeBytes && hex(digest.digest()) === chunk.sha256
                              ? Effect.void
                              : Effect.fail(conflict("Checkpoint chunk failed verification.")),
                          ),
                        ).pipe(Stream.drain),
                      ),
                    );
                  }),
                ),
              ),
            );
            return chunks.pipe(
              Stream.concat(
                Stream.fromEffect(
                  Effect.suspend(() =>
                    hex(whole.digest()) === file.sha256
                      ? Effect.void
                      : Effect.fail(conflict("Checkpoint file failed verification.")),
                  ),
                ).pipe(Stream.drain),
              ),
            );
          }),
        );
      const readMetadata = Effect.fnUntraced(function* (name: string, maxBytes = 2 * 1024 * 1024) {
        const file = byName.get(name);
        if (!file || file.sizeBytes > maxBytes || maxBytes > 32 * 1024 * 1024)
          return yield* Effect.fail(conflict("Checkpoint metadata is missing or unbounded."));
        const bytes = new Uint8Array(file.sizeBytes);
        let offset = 0;
        yield* readFile(file, (part) => {
          bytes.set(part, offset);
          offset += part.length;
        });
        return yield* text(bytes);
      });
      return { artifact, readPinId, manifest, entries, byName, readFile, streamFile, readMetadata };
    }).pipe(
      Effect.onError(() =>
        sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${readPinId}`.pipe(
          Effect.ignore,
        ),
      ),
    );
  });
  type View = Effect.Success<ReturnType<typeof prepare>>;
  const withPinned = Effect.fn("relay.checkpoint_objects.with_pinned")(function* <A, E2, R>(
    input: Input,
    consume: (view: View) => Effect.Effect<A, E2, R>,
  ) {
    const view = yield* prepare(input);
    return yield* consume(view).pipe(
      Effect.ensuring(
        sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${view.readPinId}`.pipe(
          Effect.ignore,
        ),
      ),
    );
  }, Effect.timeout("55 minutes"));
  /** The read lease outlives eager authorization and is released when the body ends. */
  const openFile = Effect.fn("relay.checkpoint_objects.open_file")(function* <E2, R>(
    input: Input,
    select: (view: View) => Effect.Effect<File, E2, R>,
  ) {
    const view = yield* prepare(input);
    const release =
      sql`DELETE FROM relay_thread_artifact_pins WHERE operation_id=${view.readPinId}`.pipe(
        Effect.ignore,
      );
    const file = yield* select(view).pipe(Effect.onError(() => release));
    if (!view.manifest.files.includes(file)) {
      yield* release;
      return yield* Effect.fail(conflict("File is not part of this checkpoint."));
    }
    // Reject corruption before sending HTTP headers. Published objects are immutable.
    yield* view.readFile(file, () => {}).pipe(Effect.onError(() => release));
    return view
      .streamFile(file)
      .pipe(Stream.interruptWhen(Effect.sleep("55 minutes")), Stream.ensuring(release));
  }, Effect.timeout("55 minutes"));
  return { withPinned, openFile };
}
