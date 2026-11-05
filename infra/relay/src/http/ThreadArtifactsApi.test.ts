import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Reproduces a real Node request socket closing during upload retries.
import * as NodeHttp from "node:http";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { makeLocalThreadArtifactObjects } from "../threads/ThreadArtifactLocalObjects.ts";
import { ThreadArtifactObjectError } from "../threads/ThreadArtifactObjects.ts";
import { boundedArtifactBody } from "./ThreadArtifactsApi.ts";

describe("bounded artifact HTTP body", () => {
  for (const [size, chunks, allowed] of [
    [0, [], true],
    [3, [[1], [2, 3]], true],
    [3, [[1], [2]], false],
    [2, [[1, 2, 3]], false],
  ] as const) {
    it.effect(`requires exactly ${size} bytes across ${chunks.length} chunks (${allowed})`, () =>
      Effect.gen(function* () {
        const body = boundedArtifactBody(
          Stream.fromIterable(chunks.map((chunk) => Uint8Array.from(chunk))),
          size,
        );
        if (allowed)
          expect(
            Array.from(yield* Stream.runCollect(body)).flatMap((part) => Array.from(part)),
          ).toEqual(chunks.flat());
        else
          expect(yield* Effect.flip(Stream.runDrain(body))).toMatchObject({
            _tag: "ThreadArtifactObjectError",
          });
      }),
    );
  }
  it.effect("stops consuming after a body exceeds its immutable size", () =>
    Effect.gen(function* () {
      let consumed = 0;
      const body = Stream.fromIterable([
        new Uint8Array(2),
        new Uint8Array(2),
        new Uint8Array(2),
      ]).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            consumed++;
          }),
        ),
      );
      yield* Effect.flip(Stream.runDrain(boundedArtifactBody(body, 3)));
      expect(consumed).toBe(2);
    }),
  );
});

it.effect("replies successfully when a large HTTP upload retries an already stored object", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifact-http-retry-" });
      const objects = makeLocalThreadArtifactObjects(fs, root);
      const key = "thread-artifacts/v1/14414414-4144-4144-8144-144144144144";
      const part = new Uint8Array(64 * 1024);
      const parts = Array.from({ length: 32 }, () => part);
      const sizeBytes = part.byteLength * parts.length;
      const hash = NodeCrypto.createHash("sha256");
      for (const value of parts) hash.update(value);
      const sha256 = hash.digest("hex");
      let received = 0;
      const requests = yield* Queue.unbounded<{
        request: NodeHttp.IncomingMessage;
        response: NodeHttp.ServerResponse;
      }>();
      const server = NodeHttp.createServer((request, response) => {
        Queue.offerUnsafe(requests, { request, response });
      });
      yield* Stream.fromQueue(requests).pipe(
        Stream.runForEach(({ request, response }) =>
          Effect.gen(function* () {
            const body = NodeStream.fromReadable({
              evaluate: () => request,
              onError: () => new ThreadArtifactObjectError({ operation: "read upload" }),
            }).pipe(
              Stream.tap((value) =>
                Effect.sync(() => {
                  received += value.byteLength;
                }),
              ),
            );
            yield* Effect.gen(function* () {
              const upload = yield* Stream.toReadableStreamEffect(
                boundedArtifactBody(body, sizeBytes),
              );
              yield* objects
                .put({ key, body: upload, sizeBytes })
                .pipe(
                  Effect.andThen(objects.verify({ key, sha256, sizeBytes })),
                  Effect.ensuring(Effect.promise(() => upload.cancel().catch(() => {}))),
                );
            }).pipe(
              Effect.match({
                onSuccess: () => {
                  response.writeHead(200);
                  response.end("stored");
                },
                onFailure: () => {
                  response.writeHead(500);
                  response.end("upload failed");
                },
              }),
            );
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", resolve);
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
      const client = yield* HttpClient.HttpClient;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = yield* client.execute(
          HttpClientRequest.put(`http://127.0.0.1:${address.port}/upload`).pipe(
            HttpClientRequest.bodyStream(Stream.fromIterable(parts), {
              contentType: "application/octet-stream",
              contentLength: sizeBytes,
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe("stored");
      }
      expect(received).toBe(2 * sizeBytes);
      yield* objects.verify({ key, sha256, sizeBytes });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, FetchHttpClient.layer))),
);
