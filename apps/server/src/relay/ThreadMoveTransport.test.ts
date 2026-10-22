import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadArtifactReceipt } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { makeThreadMoveTransport } from "./ThreadMoveTransport.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const owner = {
  threadId: "thread-1",
  environmentId: "environment-1",
  relayUrl: "https://relay.test",
  operationId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
};
const file = {
  artifactId: "00000000-0000-4000-8000-000000000002",
  operationId: owner.operationId,
  kind: "workspace" as const,
  sha256: "a".repeat(64),
  sizeBytes: 64 * 1024 * 1024,
};
const receipt: RelayThreadArtifactReceipt = {
  ...file,
  threadId: ThreadId.make(owner.threadId),
  state: "complete",
};

it.effect("reports a move failure with its current participant credential and generation", () =>
  Effect.gen(function* () {
    const detail = "Codex could not resume the transferred conversation.";
    const move = {
      threadId: ThreadId.make(owner.threadId),
      operationId: owner.operationId,
      actorUserId: "actor",
      sourceEnvironmentId: EnvironmentId.make(owner.environmentId),
      expectedGeneration: owner.generation,
      destinationEnvironmentId: EnvironmentId.make("destination"),
      destinationProjectId: ProjectId.make("project"),
      phase: "frozen",
      sourceCursor: 1,
      manifestSha256: "b".repeat(64),
      manifestArtifactId: file.artifactId,
      failureDetail: "The first resume failure.",
    };
    const transport = makeThreadMoveTransport(
      (participant) =>
        makeExecutorRelayApiClient({
          url: participant.relayUrl,
          issuer: participant.relayUrl,
          environmentCredential: "current-credential",
        }),
      () => Effect.die("Failure reporting does not upload artifacts"),
    );
    const reported = yield* transport.failed(owner, detail).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe(
              `${owner.relayUrl}/v1/environments/${owner.environmentId}/threads/${owner.threadId}/moves/${owner.operationId}/failed`,
            );
            expect(request.headers.authorization).toBe("Bearer current-credential");
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag === "Uint8Array")
              expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
                generation: owner.generation,
                detail,
              });
            return HttpClientResponse.fromWeb(request, Response.json(move));
          }),
        ),
      ),
    );
    expect(reported.failureDetail).toBe(move.failureDetail);
  }),
);

it.effect("waits for a large move upload receipt after two minutes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const confirmed = yield* Deferred.make<RelayThreadArtifactReceipt>();
    const transport = makeThreadMoveTransport(
      () => Effect.die("An upload uses its own streaming client"),
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(confirmed))),
    );
    const upload = yield* transport.upload(owner, file, Stream.empty).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 minutes");
    yield* Deferred.succeed(confirmed, receipt);
    expect(yield* Fiber.join(upload)).toEqual(receipt);
  }),
);

it.effect("still bounds a move upload whose receipt never arrives", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const transport = makeThreadMoveTransport(
      () => Effect.die("An upload uses its own streaming client"),
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const upload = yield* transport
      .upload(owner, file, Stream.empty)
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(upload)).toMatchObject({
      _tag: "ThreadMoveError",
      threadId: owner.threadId,
    });
  }),
);
