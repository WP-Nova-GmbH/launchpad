import * as Stream from "effect/Stream";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeThreadExecutionAuthority } from "./ThreadExecutionAuthority.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const work = {
  threadId: "thread",
  environmentId: "environment",
  relayUrl: "https://relay.test",
  generation: 4,
  workId: "provider:turn-1",
  kind: "provider" as const,
};
describe("thread execution authority transport", () => {
  it.effect(
    "uses the current environment credential and refuses a changed relay or environment before networking",
    () => {
      const values = new Map([
        [RELAY_URL_SECRET, "https://relay.test/"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "first-token"],
      ]);
      const calls: Array<{ url: string; authorization: string; body: unknown }> = [];
      return Effect.gen(function* () {
        const authority = yield* makeThreadExecutionAuthority;
        assert.deepEqual(yield* authority.admit(work), { completed: false, newlyAdmitted: true });
        values.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "rotated-token");
        yield* authority.complete(work);
        assert.deepEqual(calls, [
          {
            url: "https://relay.test/v1/environments/environment/threads/thread/work/admit",
            authorization: "Bearer first-token",
            body: { generation: 4, workId: "provider:turn-1" },
          },
          {
            url: "https://relay.test/v1/environments/environment/threads/thread/work/complete",
            authorization: "Bearer rotated-token",
            body: { generation: 4, workId: "provider:turn-1" },
          },
        ]);
        const event: OrchestrationEvent = {
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread"),
          sequence: 7,
          eventId: EventId.make("event"),
          occurredAt: "2026-10-02T06:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread"),
            archivedAt: "2026-10-02T06:00:00.000Z",
            updatedAt: "2026-10-02T06:00:00.000Z",
          },
        };
        yield* authority.history.append(work, event);
        assert.deepEqual(calls[2], {
          url: "https://relay.test/v1/environments/environment/threads/thread/history",
          authorization: "Bearer rotated-token",
          body: { generation: 4, event },
        });
        assert.isNull(yield* authority.commands.next(work));
        yield* authority.commands.acknowledge(work, "command", { status: "accepted", sequence: 7 });
        assert.deepEqual(calls.slice(3), [
          {
            url: "https://relay.test/v1/environments/environment/threads/thread/commands/next",
            authorization: "Bearer rotated-token",
            body: { generation: 4 },
          },
          {
            url: "https://relay.test/v1/environments/environment/threads/thread/commands/ack",
            authorization: "Bearer rotated-token",
            body: {
              generation: 4,
              commandId: "command",
              receipt: { status: "accepted", sequence: 7 },
            },
          },
        ]);
        for (const changed of [
          { ...work, relayUrl: "https://other.test" },
          { ...work, environmentId: "other" },
          { ...work, relayUrl: "https://relay.test/?credential=leak" },
        ])
          assert.equal(
            (yield* Effect.flip(authority.admit(changed)))._tag,
            "ThreadExecutionRelayError",
          );
        values.delete(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        assert.equal((yield* Effect.flip(authority.admit(work)))._tag, "ThreadExecutionRelayError");
        assert.lengthOf(calls, 5);
      }).pipe(
        Effect.provideService(ServerSecretStore, {
          get: (name) =>
            Effect.sync(() => {
              const value = values.get(name);
              return value === undefined
                ? Option.none()
                : Option.some(new TextEncoder().encode(value));
            }),
          set: () => Effect.void,
          create: () => Effect.void,
          remove: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        }),
        Effect.provideService(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              assert.equal(request.body._tag, "Uint8Array");
              const body =
                request.body._tag === "Uint8Array"
                  ? decodeJson(new TextDecoder().decode(request.body.body))
                  : null;
              calls.push({ url: request.url, authorization: request.headers.authorization!, body });
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/admit")
                    ? { completed: false, newlyAdmitted: true }
                    : request.url.endsWith("/history")
                      ? { cursor: 1 }
                      : request.url.endsWith("/next")
                        ? null
                        : { ok: true },
                ),
              );
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "uses only the installed VM thread credential and never falls back to a broad identity",
    () => {
      const record = {
        operationId: "operation",
        scope: {
          allocationId: "allocation",
          threadId: "thread",
          repositoryId: "repository",
          generation: 4,
        },
        environmentId: "environment",
        relayUrl: "https://relay.test",
        relayIssuer: "https://issuer.test",
        environmentCredential: "vm-token",
        cloudMintPublicKey: "key",
      };
      const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
      let stored = encode(record);
      let calls = 0;
      return Effect.gen(function* () {
        const authority = yield* makeThreadExecutionAuthority;
        yield* authority.admit(work);
        for (const changed of [
          { ...work, threadId: "other" },
          { ...work, generation: 5 },
          { ...work, environmentId: "other" },
          { ...work, relayUrl: "https://other.test" },
        ]) {
          assert.equal(
            (yield* Effect.flip(authority.admit(changed)))._tag,
            "ThreadExecutionRelayError",
          );
        }
        stored = "corrupt";
        assert.equal((yield* Effect.flip(authority.admit(work)))._tag, "ThreadExecutionRelayError");
        assert.equal(calls, 1);
      }).pipe(
        Effect.provideService(ServerSecretStore, {
          get: (name) =>
            Effect.sync(() =>
              Option.some(
                new TextEncoder().encode(
                  name === THREAD_VM_IDENTITY_SECRET ? stored : "broad-credential",
                ),
              ),
            ),
          set: () => Effect.void,
          create: () => Effect.void,
          remove: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        }),
        Effect.provideService(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              calls++;
              assert.equal(request.headers.authorization, "Bearer vm-token");
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ completed: false, newlyAdmitted: true }),
              );
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "streams checkpoint bytes and uses current credentials for each publication request",
    () => {
      let credential = "first-token";
      const file = {
        artifactId: "00000000-0000-4000-8000-000000000076",
        operationId: "00000000-0000-5000-8000-000000000076",
        kind: "native" as const,
        sha256: "a".repeat(64),
        sizeBytes: 3,
      };
      const nativeReceipt = {
        threadId: work.threadId,
        operationId: file.operationId,
        turnId: "turn",
        sourceEnvironmentId: work.environmentId,
        generation: 4,
        sourceSequence: 7,
        nativeThreadId: "01900000-0000-7000-8000-000000000076",
        nativeManifestSha256: "b".repeat(64),
        archiveSha256: "c".repeat(64),
        manifestArtifactId: file.artifactId,
        manifestSha256: file.sha256,
      };
      const attachmentReceipt = {
        threadId: work.threadId,
        operationId: file.operationId,
        turnId: "turn",
        sourceEnvironmentId: work.environmentId,
        generation: 4,
        sourceSequence: 7,
        nativeArchiveSha256: nativeReceipt.archiveSha256,
        attachmentManifestSha256: "d".repeat(64),
        manifestArtifactId: file.artifactId,
        manifestSha256: file.sha256,
      };
      const calls: Array<{ path: string; authorization: string; body: unknown }> = [];
      return Effect.gen(function* () {
        const authority = yield* makeThreadExecutionAuthority;
        const uploaded = yield* authority.checkpoints.upload(
          work,
          file,
          Stream.make(Uint8Array.from([1]), Uint8Array.from([2, 3])),
        );
        assert.equal(uploaded.artifactId, file.artifactId);
        credential = "rotated-token";
        assert.deepEqual(
          yield* authority.checkpoints.publishNative(work, {
            operationId: file.operationId,
            manifestArtifactId: file.artifactId,
          }),
          nativeReceipt,
        );
        assert.deepEqual(
          yield* authority.checkpoints.publishAttachments(work, {
            operationId: file.operationId,
            manifestArtifactId: file.artifactId,
            nativeCheckpointOperationId: file.operationId,
          }),
          attachmentReceipt,
        );
        assert.deepEqual(
          calls.map((call) => [call.path, call.authorization]),
          [
            [
              `/v1/environments/environment/threads/thread/artifacts/${file.artifactId}`,
              "Bearer first-token",
            ],
            [
              "/v1/environments/environment/threads/thread/checkpoints/native",
              "Bearer rotated-token",
            ],
            [
              "/v1/environments/environment/threads/thread/checkpoints/attachments",
              "Bearer rotated-token",
            ],
          ],
        );
        assert.deepEqual(calls[0]?.body, [1, 2, 3]);
        assert.deepEqual(calls[2]?.body, {
          generation: 4,
          operationId: file.operationId,
          manifestArtifactId: file.artifactId,
          nativeCheckpointOperationId: file.operationId,
        });
        const before = calls.length;
        yield* Effect.flip(
          authority.checkpoints.upload(
            { ...work, relayUrl: "https://untrusted.test" },
            file,
            Stream.empty,
          ),
        );
        assert.equal(calls.length, before);
      }).pipe(
        Effect.provideService(ServerSecretStore, {
          get: (name) =>
            Effect.succeed(
              name === RELAY_URL_SECRET
                ? Option.some(new TextEncoder().encode("https://relay.test"))
                : name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET
                  ? Option.some(new TextEncoder().encode(credential))
                  : Option.none(),
            ),
          set: () => Effect.void,
          create: () => Effect.void,
          remove: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        }),
        Effect.provideService(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(work.environmentId)),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const path = new URL(request.url).pathname;
              let body: unknown;
              if (request.body._tag === "Stream") {
                assert.equal(request.body.contentLength, 3);
                assert.deepEqual(Object.fromEntries(request.urlParams), {
                  generation: "4",
                  operationId: file.operationId,
                  kind: "native",
                  sha256: file.sha256,
                  sizeBytes: "3",
                });
                body = Array.from(
                  yield* Stream.runCollect(
                    request.body.stream.pipe(
                      Stream.mapError(() => ({ _tag: "TestBodyFailure" as const })),
                    ),
                  ).pipe(Effect.orDie),
                ).flatMap((part) => Array.from(part));
              } else {
                assert.equal(request.body._tag, "Uint8Array");
                body =
                  request.body._tag === "Uint8Array"
                    ? decodeJson(new TextDecoder().decode(request.body.body))
                    : null;
              }
              calls.push({ path, authorization: request.headers.authorization!, body });
              const result = path.endsWith("/attachments")
                ? attachmentReceipt
                : path.endsWith("/native")
                  ? nativeReceipt
                  : { ...file, threadId: work.threadId, state: "complete" };
              return HttpClientResponse.fromWeb(request, Response.json(result));
            }),
          ),
        ),
      );
    },
  );
});
