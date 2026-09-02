import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_MACHINE_IDENTITY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrganizationProviderAccounts from "./OrganizationProviderAccounts.ts";

const environmentId = EnvironmentId.make("environment-1");

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const executorSecrets = new Map([
  [RELAY_URL_SECRET, "https://relay.example.test"],
  [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "t3env_credential"],
  [
    CLOUD_MACHINE_IDENTITY,
    JSON.stringify({ machineId: "machine-1", organizationId: "org-1", role: "agent_executor" }),
  ],
]);

function secretStore(values: ReadonlyMap<string, string>) {
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      const value = values.get(name);
      return Effect.succeed(
        value === undefined ? Option.none() : Option.some(new TextEncoder().encode(value)),
      );
    },
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  });
}

const account = (provider: string, version: string) => ({
  provider,
  label: `${provider} account`,
  version,
  payload: { kind: "env", name: "X_KEY", value: "secret" },
});

function accountsResponse(accounts: ReadonlyArray<unknown>) {
  return new Response(JSON.stringify({ accounts }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeService(input: {
  readonly secrets?: ReadonlyMap<string, string>;
  readonly respond: (request: HttpClientRequest.HttpClientRequest, index: number) => Response;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const service = OrganizationProviderAccounts.make.pipe(
    Effect.provideService(
      ServerSecretStore.ServerSecretStore,
      secretStore(input.secrets ?? executorSecrets),
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(request, input.respond(request, requests.length));
        }),
      ),
    ),
  );
  return { requests, service };
}

describe("diffProviderAccounts", () => {
  it("reports appearances, version changes, and removals", () => {
    const previous = new Map([
      ["codex", account("codex", "1")],
      ["cursor", account("cursor", "1")],
      ["opencode", account("opencode", "1")],
    ] as const);
    const next = new Map([
      ["codex", account("codex", "2")],
      ["cursor", account("cursor", "1")],
      ["claudeAgent", account("claudeAgent", "1")],
    ] as const);
    expect(
      [
        ...OrganizationProviderAccounts.diffProviderAccounts(previous as never, next as never),
      ].sort(),
    ).toEqual(["claudeAgent", "codex", "opencode"]);
  });
});

describe("OrganizationProviderAccounts", () => {
  it.effect("does nothing on a machine that is not an enrolled executor", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        secrets: new Map(),
        respond: () => accountsResponse([]),
      });
      const accounts = yield* service;
      expect(yield* accounts.refresh).toBe(false);
      expect(requests).toHaveLength(0);
      expect((yield* accounts.current).size).toBe(0);
    }),
  );

  it.effect("fetches the executor's accounts and announces what changed", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        respond: (_request, index) =>
          index === 1
            ? accountsResponse([account("codex", "1"), account("cursor", "1")])
            : accountsResponse([account("codex", "2")]),
      });
      const accounts = yield* service;
      const changes = yield* accounts.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      // Let the subscription attach before the first publish.
      yield* Effect.yieldNow;

      expect(yield* accounts.refresh).toBe(true);
      expect(requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/environment-1/provider-accounts",
      );
      expect(requests[0]?.headers.authorization).toBe("Bearer t3env_credential");
      const first = yield* accounts.current;
      expect([...first.keys()].sort()).toEqual(["codex", "cursor"]);
      expect(first.get("codex")?.payload).toEqual({ kind: "env", name: "X_KEY", value: "secret" });

      expect(yield* accounts.refresh).toBe(true);
      const second = yield* accounts.current;
      expect([...second.keys()]).toEqual(["codex"]);
      expect(second.get("codex")?.version).toBe("2");

      const announced = yield* Fiber.join(changes);
      expect([...announced].map((set) => [...set].sort())).toEqual([
        ["codex", "cursor"],
        ["codex", "cursor"],
      ]);
    }),
  );

  it.effect("keeps the last good set when the relay does not answer", () =>
    Effect.gen(function* () {
      const { service } = makeService({
        respond: (_request, index) =>
          index === 1
            ? accountsResponse([account("codex", "1")])
            : new Response("nope", { status: 503 }),
      });
      const accounts = yield* service;
      expect(yield* accounts.refresh).toBe(true);
      expect(yield* accounts.refresh).toBe(false);
      expect([...(yield* accounts.current).keys()]).toEqual(["codex"]);
    }),
  );
});
