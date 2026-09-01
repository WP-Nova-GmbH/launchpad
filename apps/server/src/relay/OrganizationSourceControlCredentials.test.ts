import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
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
import * as OrganizationSourceControlCredentials from "./OrganizationSourceControlCredentials.ts";

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

function tokenResponse(token: string, expiresAt: string) {
  return new Response(JSON.stringify({ token, expiresAt, accountLogin: "acme" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const notConnectedResponse = () =>
  new Response(
    JSON.stringify({
      _tag: "RelayTenancyNotFoundError",
      code: "tenancy_not_found",
      reason: "github_not_connected",
      traceId: "trace-1",
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );

function makeService(input: {
  readonly secrets?: ReadonlyMap<string, string>;
  readonly respond: (request: HttpClientRequest.HttpClientRequest, index: number) => Response;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const service = OrganizationSourceControlCredentials.make.pipe(
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

describe("OrganizationSourceControlCredentials", () => {
  it.effect("asks the relay as the enrolled environment and caches the token", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        respond: () => tokenResponse("ghs_first", "1970-01-01T01:00:00.000Z"),
      });
      const credentials = yield* service;

      const first = yield* credentials.github;
      const second = yield* credentials.github;

      expect(first?.token).toBe("ghs_first");
      expect(first?.accountLogin).toBe("acme");
      expect(second).toBe(first);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/environment-1/source-control/github/installation-token",
      );
      expect(requests[0]?.headers.authorization).toBe("Bearer t3env_credential");
    }),
  );

  it.effect("refreshes before the token expires", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        respond: (_request, index) =>
          index === 1
            ? tokenResponse("ghs_first", "1970-01-01T01:00:00.000Z")
            : tokenResponse("ghs_second", "1970-01-01T02:00:00.000Z"),
      });
      const credentials = yield* service;

      expect((yield* credentials.github)?.token).toBe("ghs_first");
      yield* TestClock.adjust(Duration.minutes(50));
      expect((yield* credentials.github)?.token).toBe("ghs_first");
      yield* TestClock.adjust(Duration.minutes(6));
      expect((yield* credentials.github)?.token).toBe("ghs_second");
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect(
    "treats an organization without GitHub as no credential, and does not nag the relay",
    () =>
      Effect.gen(function* () {
        const { requests, service } = makeService({ respond: notConnectedResponse });
        const credentials = yield* service;

        expect(yield* credentials.github).toBeNull();
        expect(yield* credentials.github).toBeNull();
        expect(requests).toHaveLength(1);

        yield* TestClock.adjust(Duration.seconds(61));
        expect(yield* credentials.github).toBeNull();
        expect(requests).toHaveLength(2);
      }),
  );

  it.effect("never calls the relay from a personal machine", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        secrets: new Map(),
        respond: () => tokenResponse("ghs_unexpected", "1970-01-01T01:00:00.000Z"),
      });
      const credentials = yield* service;

      expect(yield* credentials.github).toBeNull();
      expect(requests).toHaveLength(0);
    }),
  );
});
