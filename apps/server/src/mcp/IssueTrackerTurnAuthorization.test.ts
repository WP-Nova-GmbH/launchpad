import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ClientOrchestrationCommand, EnvironmentId } from "@t3tools/contracts";
import { issueTrackerCommandDigest } from "@t3tools/shared/issueTrackerTurn";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore, SecretStoreConcurrentReadError } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  readTurnAuthorization,
  saveCommandAuthorization,
} from "./IssueTrackerTurnAuthorization.ts";

const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
  runtimeMode: "full-access",
  interactionMode: "default",
  type: "thread.prompt.enqueue",
  commandId: "command",
  threadId: "thread",
  createdAt: "2026-10-02T00:00:00.000Z",
  message: { messageId: "message", text: "Read WP-218", attachments: [] },
  issueTrackerAuthorization: "secret-grant",
});
const setup = Effect.fnUntraced(function* () {
  const digest = yield* issueTrackerCommandDigest(command);
  const claims = {
    environmentId: EnvironmentId.make("environment"),
    threadId: "thread",
    commandId: "command",
    commandDigest: digest,
    ownerUserId: "alice",
    expiresAt: 4102444800000,
    connections: { linear: "v1" },
  };
  const values = new Map<string, Uint8Array>();
  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    create: (name, value) =>
      Effect.suspend(() => {
        if (values.has(name))
          return Effect.fail(new SecretStoreConcurrentReadError({ resource: "test" }));
        values.set(name, value);
        return Effect.void;
      }),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ T3CODE_RELAY_URL: "https://relay.test" }),
    ),
    Layer.succeed(ServerSecretStore, store),
    Layer.mock(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(claims))),
      ),
    ),
  );
  return { claims, values, layer };
});

describe("personal turn authorization storage", () => {
  it.effect("keeps the credential in protected storage and can recover it for its thread", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const id = yield* saveCommandAuthorization(command, "alice").pipe(Effect.provide(test.layer));
      expect(id).toBe("command");
      const saved = yield* readTurnAuthorization(id, "thread").pipe(Effect.provide(test.layer));
      expect(saved?.authorization).toBe("secret-grant");
      expect(
        yield* readTurnAuthorization(id, "another-thread").pipe(Effect.provide(test.layer)),
      ).toBeNull();
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect.each(["owner", "environment", "thread", "command", "digest"] as const)(
    "rejects mismatched %s before persisting credentials",
    (mismatch) =>
      Effect.gen(function* () {
        const test = yield* setup();
        if (mismatch === "environment") test.claims.environmentId = EnvironmentId.make("other");
        if (mismatch === "thread") test.claims.threadId = "other";
        if (mismatch === "command") test.claims.commandId = "other";
        if (mismatch === "digest") test.claims.commandDigest = "b".repeat(64);
        expect(
          yield* saveCommandAuthorization(command, mismatch === "owner" ? "bob" : "alice").pipe(
            Effect.provide(test.layer),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "OrchestrationDispatchCommandError" });
        expect(test.values.size).toBe(0);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("duplicate command IDs cannot replace an admitted user's access", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      yield* saveCommandAuthorization(command, "alice").pipe(Effect.provide(test.layer));
      test.claims.ownerUserId = "bob";
      expect(
        yield* saveCommandAuthorization(command, "bob").pipe(
          Effect.provide(test.layer),
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "OrchestrationDispatchCommandError" });
      expect(
        (yield* readTurnAuthorization("command", "thread").pipe(Effect.provide(test.layer)))?.claims
          .ownerUserId,
      ).toBe("alice");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("expired queued grants are removed and cannot resume after restart", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      test.claims.expiresAt = -1;
      yield* saveCommandAuthorization(command).pipe(Effect.provide(test.layer));
      expect(
        yield* readTurnAuthorization("command", "thread").pipe(Effect.provide(test.layer)),
      ).toBeNull();
      expect(test.values.size).toBe(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
