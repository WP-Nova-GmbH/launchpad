import { sha256 } from "@noble/hashes/sha2";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  normalizeThreadTransferManifest,
  THREAD_TRANSFER_MANIFEST_MAX_BYTES,
  type NormalizedThreadTransferManifest,
} from "@t3tools/shared/threadTransferManifest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadArtifactStore, type ThreadArtifact } from "./ThreadArtifactStore.ts";

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

type File = NormalizedThreadTransferManifest["files"][number];
type StorageObject = Pick<
  ThreadArtifact,
  "artifactId" | "storageKey" | "kind" | "sha256" | "sizeBytes"
>;
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
      artifact.sizeBytes > THREAD_TRANSFER_MANIFEST_MAX_BYTES
    )
      return yield* Effect.fail(conflict("Checkpoint chunk manifest is unavailable."));
    const readPinId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    yield* catalog.pin({
      artifactId: artifact.artifactId,
      threadId: input.threadId,
      operationId: readPinId,
      leaseMinutes: 60,
    });
    const streamObject = (object: StorageObject) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const digest = sha256.create();
          let length = 0;
          return (yield* objects.read(object.storageKey)).pipe(
            Stream.mapEffect((part) =>
              Effect.gen(function* () {
                length += part.length;
                if (length > object.sizeBytes)
                  return yield* Effect.fail(
                    conflict("Checkpoint object exceeded its declared size."),
                  );
                digest.update(part);
                return part;
              }),
            ),
            Stream.concat(
              Stream.fromEffect(
                Effect.suspend(() =>
                  length === object.sizeBytes && hex(digest.digest()) === object.sha256
                    ? Effect.void
                    : Effect.fail(conflict("Checkpoint object failed verification.")),
                ),
              ).pipe(Stream.drain),
            ),
          );
        }),
      );
    const readObject = Effect.fnUntraced(function* (object: StorageObject) {
      const bytes = new Uint8Array(object.sizeBytes);
      let offset = 0;
      yield* streamObject(object).pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            bytes.set(part, offset);
            offset += part.length;
          }),
        ),
      );
      return bytes;
    });
    return yield* Effect.gen(function* () {
      const encodedManifest = yield* text(yield* readObject(artifact));
      const manifest = yield* Effect.try({
        try: () => normalizeThreadTransferManifest(encodedManifest),
        catch: () => conflict("Checkpoint chunk manifest is invalid."),
      });
      if (
        manifest.threadId !== input.threadId ||
        manifest.operationId !== input.operationId ||
        manifest.files.length > (input.kind === "move" ? 100_000 : 1029) ||
        manifest.files.reduce((n, file) => n + file.sizeBytes, 0) > input.maxBytes
      )
        return yield* Effect.fail(
          conflict("Checkpoint manifest belongs to a different or unbounded point."),
        );
      if (manifest.objects.some((object) => object.artifactId === artifact.artifactId))
        return yield* Effect.fail(
          conflict("The checkpoint index cannot also be a payload object."),
        );
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
          file.path !== "manifest.json" &&
          !(input.kind === "move"
            ? /^(history|workspace|attachments|native)\//u.test(file.path)
            : file.path.startsWith(`${input.kind === "native" ? "native" : "attachments"}/`) ||
              (input.kind === "native" && file.path.startsWith("history/")))
        )
          return yield* Effect.fail(conflict("Checkpoint file set is invalid."));
      }
      entries.push(...manifest.objects);
      const encoded = encodeEntries(entries);
      // Pin every candidate together, before streaming any body. GC cannot race verification.
      const pinned = yield* sql.withTransaction(
        Effect.gen(function* () {
          const matched = yield* sql<StorageObject>`WITH expected AS (
          SELECT * FROM jsonb_to_recordset(${encoded}::jsonb)
            AS e("artifactId" text,sha256 text,"sizeBytes" bigint,kind text)
        ), locked AS MATERIALIZED (
          SELECT a.artifact_id AS "artifactId",a.storage_key AS "storageKey",a.kind,a.sha256,
            a.size_bytes::int AS "sizeBytes" FROM relay_thread_artifacts a JOIN expected e
            ON a.artifact_id=e."artifactId" AND a.sha256=e.sha256
              AND a.size_bytes=e."sizeBytes" AND a.kind=e.kind
          WHERE a.thread_id=${input.threadId} AND a.operation_id=${input.operationId} AND a.state='complete'
          ORDER BY a.artifact_id FOR UPDATE OF a
        ), pinned AS (
          INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id,expires_at)
          SELECT "artifactId",${readPinId},clock_timestamp()+interval '1 hour' FROM locked
          ON CONFLICT DO NOTHING
        ) SELECT * FROM locked`;
          if (matched.length !== entries.length)
            return yield* Effect.fail(
              conflict("Checkpoint has missing or mismatched completed objects."),
            );
          return matched;
        }),
      );
      const objectById = new Map(pinned.map((object) => [object.artifactId, object]));
      const byName = new Map(manifest.files.map((file) => [file.path, file]));
      const references = new Map<string, number>();
      for (const file of manifest.files)
        for (const slice of file.slices)
          references.set(slice.artifactId, (references.get(slice.artifactId) ?? 0) + 1);
      const streamFile = (file: File) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (byName.get(file.path) !== file)
              return yield* Effect.fail(conflict("File is not part of this checkpoint."));
            const privateObjects: StorageObject[] = [];
            for (const slice of file.slices) {
              const object = objectById.get(slice.artifactId);
              if (
                !object ||
                slice.offset !== 0 ||
                slice.length !== object.sizeBytes ||
                references.get(slice.artifactId) !== 1
              )
                return yield* Effect.fail(
                  conflict("Shared workspace packs require bulk verification."),
                );
              privateObjects.push(object);
            }
            const whole = sha256.create();
            const chunks = Stream.fromIterable(privateObjects).pipe(
              Stream.flatMap(streamObject),
              Stream.tap((part) =>
                Effect.sync(() => {
                  whole.update(part);
                }),
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
      const readFile = Effect.fnUntraced(function* (
        file: File,
        observe: (part: Uint8Array) => void,
      ) {
        yield* streamFile(file).pipe(Stream.runForEach((part) => Effect.sync(() => observe(part))));
      });
      const verifyFiles = Effect.fnUntraced(function* (files: ReadonlyArray<File>) {
        const seen = new Set<string>();
        const seenPacks = new Set<string>();
        let pack: { artifactId: string; bytes: Uint8Array } | undefined;
        for (const file of files) {
          if (byName.get(file.path) !== file || seen.has(file.path))
            return yield* Effect.fail(conflict("Bulk verification has unknown or repeated files."));
          seen.add(file.path);
          const slice = file.slices[0];
          if (slice && references.get(slice.artifactId)! > 1) {
            if (!pack || pack.artifactId !== slice.artifactId) {
              if (seenPacks.has(slice.artifactId))
                return yield* Effect.fail(
                  conflict("Bulk verification must follow canonical pack order."),
                );
              seenPacks.add(slice.artifactId);
              const object = objectById.get(slice.artifactId)!;
              pack = undefined;
              pack = { artifactId: object.artifactId, bytes: yield* readObject(object) };
            }
            const bytes = pack.bytes.subarray(slice.offset, slice.offset + slice.length);
            if (hex(sha256(bytes)) !== file.sha256)
              return yield* Effect.fail(conflict("Checkpoint file failed verification."));
          } else {
            if (file.sizeBytes > 0) pack = undefined;
            yield* readFile(file, () => {});
          }
        }
      });
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
      return {
        artifact,
        readPinId,
        manifest,
        entries,
        byName,
        readFile,
        streamFile,
        readMetadata,
        verifyFiles,
      };
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
