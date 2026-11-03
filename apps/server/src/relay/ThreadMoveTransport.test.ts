import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayTenancyNotFoundError,
  type RelayThreadArtifactReceipt,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
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
const moveResponse = {
  threadId: owner.threadId,
  operationId: owner.operationId,
  actorUserId: "actor",
  sourceEnvironmentId: owner.environmentId,
  expectedGeneration: owner.generation,
  destinationEnvironmentId: "destination",
  destinationProjectId: "project",
  phase: "preparing",
  sourceCursor: null,
  manifestSha256: null,
  manifestArtifactId: null,
};

it.effect("allows admission retry only when the exact move is absent", () =>
  Effect.gen(function* () {
    const transport = makeThreadMoveTransport(
      () =>
        makeExecutorRelayApiClient({
          url: owner.relayUrl,
          issuer: owner.relayUrl,
          environmentCredential: "current-token",
        }),
      () => Effect.die("No artifact upload"),
    );
    const lookup = (reason: RelayTenancyNotFoundError["reason"]) =>
      transport.getIfStarted(owner).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  new RelayTenancyNotFoundError({
                    code: "tenancy_not_found",
                    reason,
                    traceId: "move-test",
                  }),
                  { status: 404 },
                ),
              ),
            ),
          ),
        ),
      );
    expect(yield* lookup("thread_move_not_found")).toBeNull();
    expect((yield* Effect.flip(lookup("thread_not_found")))._tag).toBe("ThreadMoveError");
  }),
);

it.effect("advertises receiver formats on the existing authenticated move poll", () =>
  Effect.gen(function* () {
    const transport = makeThreadMoveTransport(
      () =>
        makeExecutorRelayApiClient({
          url: owner.relayUrl,
          issuer: owner.relayUrl,
          environmentCredential: "receiver-credential",
        }),
      () => Effect.die("A pending-move poll does not upload artifacts"),
    );
    const result = yield* transport.pending(owner, null).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.url).toBe(
              `${owner.relayUrl}/v1/environments/${owner.environmentId}/thread-moves`,
            );
            expect(request.headers.authorization).toBe("Bearer receiver-credential");
            if (request.body._tag !== "Uint8Array") throw new Error("Expected move-poll body");
            expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
              after: null,
              limit: 50,
              threadTransferFormats: ["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"],
            });
            return HttpClientResponse.fromWeb(request, Response.json({ entries: [], next: null }));
          }),
        ),
      ),
    );
    expect(result).toEqual({ entries: [], next: null });
  }),
);

for (const advertised of [
  undefined,
  ["launchpad-thread-chunks-v1"],
  ["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"],
])
  it.effect(
    `offers v2 only when relay health advertises a supported v2 reader (${advertised?.join() ?? "legacy"})`,
    () =>
      Effect.gen(function* () {
        const transport = makeThreadMoveTransport(
          () =>
            makeExecutorRelayApiClient({
              url: owner.relayUrl,
              issuer: owner.relayUrl,
              environmentCredential: "current-token",
            }),
          () => Effect.die("No artifact upload"),
        );
        const formats = yield* transport.sourceFormats(owner).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                expect(request.url).toBe(owner.relayUrl + "/health");
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    ok: true,
                    service: "relay",
                    ...(advertised ? { threadTransferFormats: advertised } : {}),
                  }),
                );
              }),
            ),
          ),
        );
        expect(formats).toEqual(
          advertised?.includes("launchpad-thread-chunks-v2")
            ? ["launchpad-thread-chunks-v1", "launchpad-thread-chunks-v2"]
            : ["launchpad-thread-chunks-v1"],
        );
      }),
  );

for (const failure of ["unavailable", "transport", "unsupported", "credential"] as const)
  it.effect(`does not select a legacy encoding when relay discovery fails (${failure})`, () =>
    Effect.gen(function* () {
      const transport = makeThreadMoveTransport(
        () =>
          failure === "credential"
            ? Effect.fail({ _tag: "CredentialUnavailable" as const })
            : makeExecutorRelayApiClient({
                url: owner.relayUrl,
                issuer: owner.relayUrl,
                environmentCredential: "current-token",
              }),
        () => Effect.die("No artifact upload"),
      );
      const result = yield* transport.sourceFormats(owner).pipe(
        Effect.flip,
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            failure === "transport"
              ? Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error("Connection unavailable"),
                    }),
                  }),
                )
              : Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    failure === "unavailable"
                      ? new Response(null, { status: 503 })
                      : Response.json({
                          ok: true,
                          service: "relay",
                          threadTransferFormats: ["future-format"],
                        }),
                  ),
                ),
          ),
        ),
      );
      expect(result).toMatchObject({ _tag: "ThreadMoveError", threadId: owner.threadId });
    }),
  );

it.effect("does not select a legacy encoding when relay discovery times out", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const transport = makeThreadMoveTransport(
      () =>
        makeExecutorRelayApiClient({
          url: owner.relayUrl,
          issuer: owner.relayUrl,
          environmentCredential: "current-token",
        }),
      () => Effect.die("No artifact upload"),
    );
    const probe = yield* transport.sourceFormats(owner).pipe(
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(probe)).toMatchObject({
      _tag: "ThreadMoveError",
      threadId: owner.threadId,
    });
  }),
);

it.effect(
  "selects an encoding with only the current participant generation and rejects unknown policies",
  () =>
    Effect.gen(function* () {
      let future = false;
      const transport = makeThreadMoveTransport(
        () =>
          makeExecutorRelayApiClient({
            url: owner.relayUrl,
            issuer: owner.relayUrl,
            environmentCredential: "current-token",
          }),
        () => Effect.die("No artifact upload"),
      );
      const program = Effect.gen(function* () {
        expect((yield* transport.selectEncoding(owner)).transferEncodingPolicy).toBe(
          "workspace-raw-v2-8MiB",
        );
        future = true;
        expect((yield* Effect.flip(transport.get(owner)))._tag).toBe("ThreadMoveError");
      });
      yield* program.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              if (!future) {
                expect(request.url).toBe(
                  `${owner.relayUrl}/v1/environments/${owner.environmentId}/threads/${owner.threadId}/moves/${owner.operationId}/encoding`,
                );
                if (request.body._tag !== "Uint8Array") throw new Error("Expected generation body");
                expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
                  generation: owner.generation,
                });
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  ...moveResponse,
                  transferEncodingPolicy: future ? "future-policy" : "workspace-raw-v2-8MiB",
                }),
              );
            }),
          ),
        ),
      );
    }),
);

it.effect(
  "reports a move failure with its current participant credential, generation and attempt",
  () =>
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
      for (const attempt of [undefined, 27]) {
        const reported = yield* transport.failed(owner, detail, attempt).pipe(
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
                    ...(attempt === undefined ? {} : { attempt }),
                  });
                return HttpClientResponse.fromWeb(request, Response.json(move));
              }),
            ),
          ),
        );
        expect(reported.failureDetail).toBe(move.failureDetail);
      }
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

it.effect(
  "reports informational progress with the participant generation and a small acknowledgement",
  () =>
    Effect.gen(function* () {
      const report = {
        attempt: 1,
        revision: 2,
        stage: "uploading" as const,
        completedBytes: 64,
        totalBytes: 128,
        completedArtifacts: 1,
        totalArtifacts: 2,
      };
      const transport = makeThreadMoveTransport(
        (participant) =>
          makeExecutorRelayApiClient({
            url: participant.relayUrl,
            issuer: participant.relayUrl,
            environmentCredential: "current-credential",
          }),
        () => Effect.die("Progress does not upload an artifact"),
      );
      const result = yield* transport.progress(owner, report).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              expect(request.url).toBe(
                `${owner.relayUrl}/v1/environments/${owner.environmentId}/threads/${owner.threadId}/moves/${owner.operationId}/progress`,
              );
              expect(request.headers.authorization).toBe("Bearer current-credential");
              if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
              expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
                generation: owner.generation,
                ...report,
              });
              return HttpClientResponse.fromWeb(request, Response.json({ accepted: true }));
            }),
          ),
        ),
      );
      expect(result).toEqual({ accepted: true });
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
