import { sha256 } from "@noble/hashes/sha2";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import {
  makeLocalThreadArtifactObjects,
  verifyLocalThreadArtifactRoot,
} from "./ThreadArtifactLocalObjects.ts";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const body = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

it.effect("checks persistent storage before startup and reads it from a fresh adapter", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launchpad-persistent-" });
    const root = `${directory}/artifacts`;
    yield* verifyLocalThreadArtifactRoot(fs, root);
    expect(yield* fs.readDirectory(root)).toEqual([]);
    const key = "thread-artifacts/v1/33333333-3333-4333-8333-333333333333";
    const bytes = new TextEncoder().encode("saved result");
    yield* makeLocalThreadArtifactObjects(fs, root).put({
      key,
      body: body(bytes),
      sizeBytes: bytes.length,
    });
    yield* verifyLocalThreadArtifactRoot(fs, root);
    yield* makeLocalThreadArtifactObjects(fs, root).verify({
      key,
      sizeBytes: bytes.length,
      sha256: hex(sha256(bytes)),
    });
    expect(yield* Effect.flip(verifyLocalThreadArtifactRoot(fs, "relative"))).toMatchObject({
      _tag: "ThreadArtifactObjectError",
    });
    const blocked = `${directory}/file`;
    yield* fs.writeFileString(blocked, "not a directory");
    expect((yield* Effect.result(verifyLocalThreadArtifactRoot(fs, blocked)))._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("stores private development artifacts without overwriting an existing upload", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectory({ prefix: "launchpad-artifact-test-" });
    const objects = makeLocalThreadArtifactObjects(fs, root);
    const key = "thread-artifacts/v1/11111111-1111-4111-8111-111111111111";
    const original = new TextEncoder().encode("original bytes");
    const changed = new TextEncoder().encode("changed bytes!");
    yield* objects.put({ key, body: body(original), sizeBytes: original.length });
    yield* objects.put({ key, body: body(changed), sizeBytes: changed.length });
    for (const retry of [
      original.subarray(0, original.length - 1),
      Uint8Array.from([...original, 1]),
    ]) {
      expect(
        yield* Effect.flip(objects.put({ key, body: body(retry), sizeBytes: original.length })),
      ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "upload size" });
    }
    yield* objects.verify({ key, sha256: hex(sha256(original)), sizeBytes: original.length });
    expect(
      Array.from(yield* Stream.runCollect(yield* objects.read(key))).flatMap((chunk) =>
        Array.from(chunk),
      ),
    ).toEqual(Array.from(original));
    expect(
      yield* Effect.flip(
        objects.verify({
          key,
          sha256: hex(sha256(changed)),
          sizeBytes: changed.length,
        }),
      ),
    ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "checksum" });
    yield* objects.remove(key);
    expect(yield* Effect.flip(objects.read(key))).toMatchObject({
      _tag: "ThreadArtifactObjectError",
      operation: "missing",
    });
    yield* fs.remove(root, { recursive: true });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect("retries an interrupted upload without exposing partial bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectory({ prefix: "launchpad-artifact-retry-" });
    const objects = makeLocalThreadArtifactObjects(fs, root);
    const key = "thread-artifacts/v1/22222222-2222-4222-8222-222222222222";
    const bytes = new TextEncoder().encode("complete artifact");
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 3));
        else controller.error(new Error("interrupted upload"));
      },
    });
    expect(
      yield* Effect.flip(objects.put({ key, body: broken, sizeBytes: bytes.length })),
    ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "put" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
    expect(yield* Effect.flip(objects.put({ key, body: body(bytes), sizeBytes: 3 }))).toMatchObject(
      { _tag: "ThreadArtifactObjectError", operation: "put" },
    );
    expect(yield* fs.readDirectory(root)).toEqual([]);
    yield* objects.put({ key, body: body(bytes), sizeBytes: bytes.length });
    yield* objects.verify({ key, sha256: hex(sha256(bytes)), sizeBytes: bytes.length });
    expect(yield* fs.readDirectory(root)).toEqual([key.split("/").at(-1)]);
    yield* fs.remove(root, { recursive: true });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
