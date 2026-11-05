import { sha256 } from "@noble/hashes/sha2";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type { ThreadTransferPackedManifest } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeThreadCheckpointObjects } from "./ThreadCheckpointObjects.ts";
import { ThreadArtifactObjectError } from "./ThreadArtifactObjects.ts";
import type { ThreadArtifact } from "./ThreadArtifactStore.ts";

const hash = (bytes: Uint8Array) => Buffer.from(sha256(bytes)).toString("hex");
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const bytes = (value: string) => new TextEncoder().encode(value);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeExpected = Schema.decodeUnknownSync(
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
const scope = {
  threadId: "thread",
  operationId: "operation",
  sourceEnvironmentId: "source",
  generation: 1,
};

function fixture(count = 3) {
  const header = bytes("unchanged domain header");
  const payload = Uint8Array.from({ length: count * 4 }, (_, i) => i % 251);
  const data = new Map([
    [id(1), header],
    [id(2), payload],
  ]);
  const descriptor = (artifactId: string, kind: "manifest" | "workspace") => ({
    artifactId,
    kind,
    sizeBytes: data.get(artifactId)!.length,
    sha256: hash(data.get(artifactId)!),
  });
  const manifest: ThreadTransferPackedManifest = {
    format: "launchpad-thread-chunks-v2",
    ...scope,
    transferManifestSha256: hash(header),
    objects: [descriptor(id(1), "manifest"), descriptor(id(2), "workspace")],
    files: [
      {
        path: "manifest.json",
        sha256: hash(header),
        sizeBytes: header.length,
        slices: [{ artifactId: id(1), offset: 0, length: header.length }],
      },
      ...Array.from({ length: count }, (_, i) => ({
        path: `workspace/objects/${i.toString(16).padStart(64, "0")}`,
        sha256: hash(payload.subarray(i * 4, i * 4 + 4)),
        sizeBytes: 4,
        slices: [{ artifactId: id(2), offset: i * 4, length: 4 }],
      })),
    ],
  };
  const catalog = new Map<string, ThreadArtifact>();
  for (const object of manifest.objects)
    catalog.set(object.artifactId, {
      ...object,
      threadId: scope.threadId,
      operationId: scope.operationId,
      storageKey: object.artifactId,
      state: "complete",
    });
  const setIndex = (value: unknown) => {
    const content = bytes(encodeJson(value));
    data.set(id(0), content);
    catalog.set(id(0), {
      artifactId: id(0),
      kind: "manifest",
      sha256: hash(content),
      sizeBytes: content.length,
      storageKey: id(0),
      state: "complete",
      threadId: scope.threadId,
      operationId: scope.operationId,
    });
  };
  setIndex(manifest);
  const queries: string[] = [];
  const pins = new Set<string>();
  const reads = new Map<string, number>();
  const consumed = new Map<string, number>();
  let blocked: { artifactId: string; started: Deferred.Deferred<void> } | undefined;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        const query = strings.join("?").replace(/\s+/gu, " ").trim();
        queries.push(query);
        if (query.startsWith("WITH expected AS")) {
          const expected = decodeExpected(String(values[0]));
          const rows = expected.flatMap((e) => {
            const row = catalog.get(e.artifactId);
            return row &&
              row.sha256 === e.sha256 &&
              row.sizeBytes === e.sizeBytes &&
              row.kind === e.kind
              ? [row]
              : [];
          });
          for (const row of rows) pins.add(row.artifactId);
          return rows;
        }
        if (query.includes("FROM relay_thread_artifacts WHERE artifact_id")) {
          const row = catalog.get(String(values[0]));
          return row ? [row] : [];
        }
        if (query.startsWith("INSERT INTO relay_thread_artifact_pins")) {
          pins.add(String(values[0]));
          return [];
        }
        if (query.startsWith("DELETE FROM relay_thread_artifact_pins")) {
          pins.clear();
          return [];
        }
        throw new Error(`Unexpected checkpoint query: ${query}`);
      }),
    { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
  ) as unknown as PgClient;
  const objects = {
    put: () => Effect.die("unused put"),
    verify: () => Effect.die("unused verify"),
    remove: () => Effect.die("unused remove"),
    read: Effect.fnUntraced(function* (key: string) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (blocked?.artifactId === key)
        return Stream.fromEffect(
          Deferred.succeed(blocked.started, undefined).pipe(Effect.andThen(Effect.never)),
        );
      const content = data.get(key);
      if (!content) return yield* new ThreadArtifactObjectError({ operation: "missing" });
      return Stream.fromIterable(
        (function* () {
          const chunkSize = content.length > 1024 * 1024 ? 64 * 1024 : 7;
          for (let offset = 0; offset < content.length; offset += chunkSize)
            yield content.subarray(offset, offset + chunkSize);
        })(),
      ).pipe(
        Stream.tap((part) =>
          Effect.sync(() => {
            consumed.set(key, (consumed.get(key) ?? 0) + part.length);
          }),
        ),
      );
    }),
  };
  return {
    manifest,
    data,
    catalog,
    setIndex,
    queries,
    pins,
    reads,
    consumed,
    block: (artifactId: string, started: Deferred.Deferred<void>) => {
      blocked = { artifactId, started };
    },
    reader: makeThreadCheckpointObjects(sql, objects, (message) => new Error(message)),
    input: {
      threadId: scope.threadId,
      operationId: scope.operationId,
      manifestArtifactId: id(0),
      kind: "move" as const,
      maxBytes: 1024 * 1024,
    },
  };
}
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer));

it.effect(
  "bulk-verifies thousands of packed members with one object read and fixed catalog work",
  () =>
    run(
      Effect.gen(function* () {
        const f = fixture(2_000);
        yield* f.reader.withPinned(f.input, (view) => view.verifyFiles(view.manifest.files));
        expect(f.reads.get(id(2))).toBe(1);
        expect(f.consumed.get(id(2))).toBe(8_000);
        expect(
          f.queries.filter((query) =>
            query.includes("FROM relay_thread_artifacts WHERE artifact_id"),
          ),
        ).toHaveLength(2);
        expect(f.queries.filter((query) => query.startsWith("WITH expected AS"))).toHaveLength(1);
        expect(f.pins.size).toBe(0);
      }),
    ),
);

for (const corruption of ["object checksum", "file checksum", "truncated", "oversized"] as const)
  it.effect(`rejects ${corruption} and releases every read pin`, () =>
    run(
      Effect.gen(function* () {
        const f = fixture();
        if (corruption === "file checksum")
          f.setIndex({
            ...f.manifest,
            files: f.manifest.files.map((file, i) =>
              i === 1 ? { ...file, sha256: "0".repeat(64) } : file,
            ),
          });
        else {
          const content = f.data.get(id(2))!;
          f.data.set(
            id(2),
            corruption === "truncated"
              ? content.subarray(1)
              : corruption === "oversized"
                ? Uint8Array.from([...content, 0])
                : Uint8Array.from(content, (value, i) => (i === 0 ? value ^ 1 : value)),
          );
        }
        expect(
          yield* Effect.flip(
            f.reader.withPinned(f.input, (view) => view.verifyFiles(view.manifest.files)),
          ),
        ).toBeInstanceOf(Error);
        expect(f.pins.size).toBe(0);
      }),
    ),
  );

it.effect("rejects invalid metadata and an index reused as a payload before bulk pinning", () =>
  run(
    Effect.gen(function* () {
      for (const collision of [false, true]) {
        const f = fixture();
        f.setIndex(
          collision
            ? {
                ...f.manifest,
                objects: f.manifest.objects.map((object) =>
                  object.artifactId === id(2) ? { ...object, artifactId: id(0) } : object,
                ),
                files: f.manifest.files.map((file) => ({
                  ...file,
                  slices: file.slices.map((slice) =>
                    slice.artifactId === id(2) ? { ...slice, artifactId: id(0) } : slice,
                  ),
                })),
              }
            : {
                ...f.manifest,
                files: f.manifest.files.map((file, i) =>
                  i === 1 ? { ...file, path: "workspace/../escape" } : file,
                ),
              },
        );
        yield* Effect.flip(
          f.reader.withPinned(f.input, () => Effect.die("invalid index reached consumer")),
        );
        expect(f.queries.some((query) => query.startsWith("WITH expected AS"))).toBe(false);
        expect([...f.reads.keys()]).toEqual([id(0)]);
        expect(f.pins.size).toBe(0);
      }
    }),
  ),
);

it.effect("retains private v1 streaming, observers and pre-response attachment integrity", () =>
  run(
    Effect.gen(function* () {
      const f = fixture();
      const content = f.data.get(id(2))!;
      const legacy = {
        format: "launchpad-thread-chunks-v1",
        ...scope,
        transferManifestSha256: hash(content),
        files: [
          {
            path: "attachments/proof.bin",
            sha256: hash(content),
            sizeBytes: content.length,
            chunks: [{ artifactId: id(2), sha256: hash(content), sizeBytes: content.length }],
          },
        ],
      };
      f.catalog.set(id(2), { ...f.catalog.get(id(2))!, kind: "attachment" });
      f.setIndex(legacy);
      const input = { ...f.input, kind: "attachment" as const };
      const observed: number[] = [];
      yield* f.reader.withPinned(input, (view) =>
        view.readFile(view.byName.get("attachments/proof.bin")!, (part) => observed.push(...part)),
      );
      expect(observed).toEqual(Array.from(content));
      const stream = yield* f.reader.openFile(input, (view) =>
        Effect.succeed(view.byName.get("attachments/proof.bin")!),
      );
      expect(f.pins.size).toBeGreaterThan(0);
      expect(Array.from(yield* Stream.runCollect(stream)).flatMap((part) => [...part])).toEqual([
        ...content,
      ]);
      expect(f.pins.size).toBe(0);
      f.data.set(id(2), content.subarray(1));
      yield* Effect.flip(
        f.reader.openFile(input, (view) =>
          Effect.succeed(view.byName.get("attachments/proof.bin")!),
        ),
      );
      expect(f.pins.size).toBe(0);
    }),
  ),
);

it.effect("releases bulk read pins when a packed stream is interrupted", () =>
  run(
    Effect.gen(function* () {
      const f = fixture();
      const started = yield* Deferred.make<void>();
      f.block(id(2), started);
      const fiber = yield* f.reader
        .withPinned(f.input, (view) => view.verifyFiles(view.manifest.files))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(f.pins.size).toBeGreaterThan(0);
      yield* Fiber.interrupt(fiber);
      expect(f.pins.size).toBe(0);
    }),
  ),
);

it.effect("streams private legacy objects above the new pack limit without truncating them", () =>
  run(
    Effect.gen(function* () {
      const f = fixture();
      const content = new Uint8Array(9 * 1024 * 1024).fill(13);
      f.data.set(id(2), content);
      f.catalog.set(id(2), {
        ...f.catalog.get(id(2))!,
        kind: "attachment",
        sizeBytes: content.length,
        sha256: hash(content),
      });
      f.setIndex({
        format: "launchpad-thread-chunks-v1",
        ...scope,
        transferManifestSha256: hash(content),
        files: [
          {
            path: "attachments/large.bin",
            sizeBytes: content.length,
            sha256: hash(content),
            chunks: [{ artifactId: id(2), sizeBytes: content.length, sha256: hash(content) }],
          },
        ],
      });
      let observed = 0;
      let largestPart = 0;
      yield* f.reader.withPinned(
        { ...f.input, kind: "attachment", maxBytes: content.length },
        (view) =>
          view.readFile(view.byName.get("attachments/large.bin")!, (part) => {
            observed += part.length;
            largestPart = Math.max(largestPart, part.length);
          }),
      );
      expect(observed).toBe(content.length);
      expect(largestPart).toBeLessThanOrEqual(64 * 1024);
      expect(f.reads.get(id(2))).toBe(1);
      expect(f.pins.size).toBe(0);
    }),
  ),
);
