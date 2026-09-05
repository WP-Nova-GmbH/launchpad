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
import * as OrganizationSkills from "./OrganizationSkills.ts";

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

const skill = (name: string, version: string) => ({
  name,
  description: `${name} skill`,
  version,
  files: [{ path: "SKILL.md", content: `---\nname: ${name}\n---\n` }],
});

function skillsResponse(skills: ReadonlyArray<unknown>) {
  return new Response(JSON.stringify({ skills }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeService(input: {
  readonly secrets?: ReadonlyMap<string, string>;
  readonly respond: (request: HttpClientRequest.HttpClientRequest, index: number) => Response;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const service = OrganizationSkills.make.pipe(
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

describe("diffOrganizationSkills", () => {
  it("reports appearances, version changes, and removals", () => {
    const previous = new Map([
      ["review", skill("review", "1")],
      ["deploy", skill("deploy", "1")],
      ["docs", skill("docs", "1")],
    ]);
    const next = new Map([
      ["review", skill("review", "2")],
      ["deploy", skill("deploy", "1")],
      ["release", skill("release", "1")],
    ]);
    expect([...OrganizationSkills.diffOrganizationSkills(previous, next)].sort()).toEqual([
      "docs",
      "release",
      "review",
    ]);
  });
});

describe("OrganizationSkills", () => {
  it.effect("does nothing on a machine that is not an enrolled executor", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        secrets: new Map(),
        respond: () => skillsResponse([]),
      });
      const skills = yield* service;
      expect(yield* skills.refresh).toBe(false);
      expect(requests).toHaveLength(0);
      expect((yield* skills.current).size).toBe(0);
    }),
  );

  it.effect("fetches the executor's skills and announces what changed", () =>
    Effect.gen(function* () {
      const { requests, service } = makeService({
        respond: (_request, index) =>
          index === 1
            ? skillsResponse([skill("review", "1"), skill("deploy", "1")])
            : skillsResponse([skill("review", "2")]),
      });
      const skills = yield* service;
      const changes = yield* skills.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      // Let the subscription attach before the first publish.
      yield* Effect.yieldNow;

      expect(yield* skills.refresh).toBe(true);
      expect(requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/environment-1/skills",
      );
      expect(requests[0]?.headers.authorization).toBe("Bearer t3env_credential");
      const first = yield* skills.current;
      expect([...first.keys()].sort()).toEqual(["deploy", "review"]);
      expect(first.get("review")?.files).toEqual([
        { path: "SKILL.md", content: "---\nname: review\n---\n" },
      ]);

      expect(yield* skills.refresh).toBe(true);
      const second = yield* skills.current;
      expect([...second.keys()]).toEqual(["review"]);
      expect(second.get("review")?.version).toBe("2");

      const announced = yield* Fiber.join(changes);
      expect([...announced].map((set) => [...set].sort())).toEqual([
        ["deploy", "review"],
        ["deploy", "review"],
      ]);
    }),
  );

  it.effect("keeps the last good set when the relay does not answer", () =>
    Effect.gen(function* () {
      const { service } = makeService({
        respond: (_request, index) =>
          index === 1
            ? skillsResponse([skill("review", "1")])
            : new Response("nope", { status: 503 }),
      });
      const skills = yield* service;
      expect(yield* skills.refresh).toBe(true);
      expect(yield* skills.refresh).toBe(false);
      expect([...(yield* skills.current).keys()]).toEqual(["review"]);
    }),
  );
});
