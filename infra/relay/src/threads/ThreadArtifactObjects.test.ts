import { sha256 } from "@noble/hashes/sha2";
import * as Alchemy from "alchemy";
import type { R2 } from "alchemy/Cloudflare";
import { it, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";

const runtimeContext = {} as Alchemy.BaseRuntimeContext;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

it.effect("verifies an R2 object across chunks before it may enter the catalog", () =>
  Effect.gen(function* () {
    const chunks = [new TextEncoder().encode("portable "), new TextEncoder().encode("thread")];
    const bytes = new TextEncoder().encode("portable thread");
    const put = vi.fn(() => Effect.succeed(null));
    const get = vi.fn(() =>
      Effect.succeed({
        size: bytes.length,
        body: Stream.fromIterable(chunks),
      }),
    );
    const remove = vi.fn(() => Effect.void);
    const objects = makeThreadArtifactObjects(
      {
        put,
        get,
        delete: remove,
      } as unknown as R2.ReadWriteBucketClient,
      runtimeContext,
    );
    const key = "thread-artifacts/v1/11111111-1111-4111-8111-111111111111";
    yield* objects.put({
      key,
      sizeBytes: bytes.length,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    expect(put).toHaveBeenCalledWith(key, expect.any(ReadableStream), {
      contentLength: bytes.length,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    yield* objects.verify({ key, sizeBytes: bytes.length, sha256: hex(sha256(bytes)) });
    expect(get).toHaveBeenCalledWith(key);
    expect(
      yield* Effect.flip(
        objects.verify({
          key,
          sizeBytes: bytes.length,
          sha256: "0".repeat(64),
        }),
      ),
    ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "checksum" });
    yield* objects.remove(key);
    expect(remove).toHaveBeenCalledWith(key);
  }),
);

it.effect("does not verify a missing or truncated object", () =>
  Effect.gen(function* () {
    let missing = true;
    const get = vi.fn(() =>
      Effect.succeed(
        missing
          ? null
          : {
              size: 10,
              body: Stream.make(new Uint8Array(3)),
            },
      ),
    );
    const objects = makeThreadArtifactObjects(
      { get } as unknown as R2.ReadWriteBucketClient,
      runtimeContext,
    );
    expect(
      yield* Effect.flip(
        objects.verify({
          key: "thread-artifacts/v1/missing",
          sha256: "0".repeat(64),
          sizeBytes: 10,
        }),
      ),
    ).toMatchObject({ _tag: "ThreadArtifactObjectError" });
    missing = false;
    expect(
      yield* Effect.flip(
        objects.verify({
          key: "thread-artifacts/v1/truncated",
          sha256: "0".repeat(64),
          sizeBytes: 10,
        }),
      ),
    ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "checksum" });
  }),
);
