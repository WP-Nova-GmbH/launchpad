import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi";

import { RelayConfiguration } from "../Config.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { ConnectionStore, type ConnectionRecord } from "../issueTrackers/ConnectionStore.ts";
import { Machines, type MachineRecord } from "../machines/Machines.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { issueTrackersApi, issueTrackersServerApi } from "./IssueTrackersApi.ts";

const timestamp = "2026-09-30T09:00:00.000Z";
const record: ConnectionRecord = {
  organizationId: "org-a",
  service: "jira",
  version: "version",
  status: "connected",
  accountLabel: "team.atlassian.net",
  payloadSealed: "secret-ciphertext",
  authorizationId: null,
  replacement: null,
  pendingStateHash: null,
  pendingExpiresAt: null,
  updatedByUserId: "admin",
  updatedAt: timestamp,
};
const machine: MachineRecord = {
  machineId: "machine",
  organizationId: "org-a",
  role: "agent_executor",
  label: "Executor",
  computeKind: "self_hosted",
  computeRef: null,
  seedExpiresAt: timestamp,
  environmentId: "env-a",
  environmentPublicKey: "key-a",
  endpointHttpBaseUrl: null,
  endpointWsBaseUrl: null,
  endpointProviderKind: null,
  createdByUserId: "admin",
  enrolledAt: timestamp,
  deprovisionedAt: null,
  createdAt: timestamp,
};
const config = RelayConfiguration.of({
  relayIssuer: "https://relay.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk"),
  clerkPublishableKey: "public",
  clerkJwtAudience: "relay",
  apnsDeliveryJobSigningSecret: Redacted.make("push"),
  cloudMintPrivateKey: Redacted.make("mint"),
  cloudMintPublicKey: "mint-public",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const headers = { authorization: "Bearer test" };

function setup(
  input: {
    role?: "member" | "admin";
    machine?: MachineRecord | null;
    organizationId?: string;
  } = {},
) {
  const seen: string[] = [];
  const deps = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RelayConfiguration, config),
    Layer.mock(RelaySecretBox, {}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected upstream call")),
    ),
    Layer.mock(ConnectionStore, {
      list: (organizationId) => {
        seen.push(`list:${organizationId}`);
        return Effect.succeed(organizationId === "org-a" ? [record] : []);
      },
      withLock: (key, use) => {
        seen.push(`lock:${key.organizationId}:${key.service}`);
        return use(null);
      },
      get: ({ organizationId }) => {
        seen.push(`get:${organizationId}`);
        return Effect.succeed(null);
      },
      remove: ({ organizationId, service }) => {
        seen.push(`remove:${organizationId}:${service}`);
        return Effect.void;
      },
    }),
    Layer.mock(Organizations, {
      getMembershipForUser: ({ userId }) =>
        Effect.succeed({
          userId,
          role: input.role ?? "member",
          joinedAt: timestamp,
          organization: {
            organizationId: input.organizationId ?? "org-a",
            name: "Team",
            createdAt: timestamp,
          },
        }),
    }),
    Layer.mock(Machines, {
      getActiveByEnvironmentId: () =>
        Effect.succeed(input.machine === undefined ? machine : input.machine),
    }),
  );
  const auth = Layer.mergeAll(
    Layer.succeed(RelayClientAuth, {
      clientBearer: (effect) =>
        Effect.provideService(effect, RelayClientPrincipal, { userId: "caller", token: "test" }),
    }),
    Layer.succeed(RelayEnvironmentAuth, {
      environmentBearer: (effect) =>
        Effect.provideService(effect, RelayEnvironmentPrincipal, {
          environmentId: "env-a",
          environmentPublicKey: "key-a",
        }),
    }),
  );
  const layer = Layer.mergeAll(issueTrackersApi, issueTrackersServerApi).pipe(
    HttpRouter.provideRequest(deps),
    Layer.provide(deps),
    Layer.provideMerge(auth),
    Layer.provideMerge(HttpServer.layerServices),
  );
  const api = HttpApi.make("RelayApi").add(
    RelayApi.groups.issueTrackers,
    RelayApi.groups.issueTrackersServer,
  );
  return {
    seen,
    client: HttpApiTest.groups(api, ["issueTrackers", "issueTrackersServer"]).pipe(
      Effect.provide(layer),
    ),
  };
}

describe("issue tracker authorization", () => {
  it.effect("members see only their organization's metadata and no credentials", () =>
    Effect.gen(function* () {
      const own = setup();
      const client = yield* own.client;
      const result = yield* client.issueTrackers.listConnections({ headers });
      expect(result).toEqual({
        linearAvailable: false,
        connections: [
          {
            service: "jira",
            status: "connected",
            accountLabel: "team.atlassian.net",
            updatedAt: timestamp,
          },
        ],
      });
      expect(own.seen).toEqual(["list:org-a"]);
      const other = setup({ organizationId: "org-b" });
      expect(
        (yield* (yield* other.client).issueTrackers.listConnections({ headers })).connections,
      ).toEqual([]);
      expect(other.seen).toEqual(["list:org-b"]);
    }),
  );

  it.effect("members cannot connect or disconnect either service", () =>
    Effect.gen(function* () {
      const harness = setup();
      const client = yield* harness.client;
      const errors = yield* Effect.all({
        linear: client.issueTrackers.startLinear({ headers }).pipe(Effect.flip),
        jira: client.issueTrackers
          .connectJira({
            headers,
            payload: { siteUrl: "https://team.atlassian.net", apiKey: "secret", issue: "LP-1" },
          })
          .pipe(Effect.flip),
        disconnectLinear: client.issueTrackers
          .disconnect({ headers, params: { service: "linear" } })
          .pipe(Effect.flip),
        confirm: client.issueTrackers
          .confirmLinearReplacement({ headers, payload: { proposalId: "proposal" } })
          .pipe(Effect.flip),
        cancel: client.issueTrackers
          .cancelLinearReplacement({ headers, payload: { proposalId: "proposal" } })
          .pipe(Effect.flip),
        disconnectJira: client.issueTrackers
          .disconnect({ headers, params: { service: "jira" } })
          .pipe(Effect.flip),
      });
      for (const error of Object.values(errors))
        expect(error._tag).toBe("RelayTenancyForbiddenError");
      expect(harness.seen).toEqual([]);
    }),
  );

  it.effect("admin disconnect is bound to the caller's organization", () =>
    Effect.gen(function* () {
      const harness = setup({ role: "admin", organizationId: "org-b" });
      const client = yield* harness.client;
      expect(
        yield* client.issueTrackers.disconnect({ headers, params: { service: "jira" } }),
      ).toEqual({ ok: true });
      expect(harness.seen).toEqual(["remove:org-b:jira"]);
    }),
  );

  it.effect("replacement endpoints derive the organization from current membership", () =>
    Effect.gen(function* () {
      const harness = setup({ role: "admin", organizationId: "org-b" });
      const client = yield* harness.client;
      expect(
        yield* client.issueTrackers
          .confirmLinearReplacement({ headers, payload: { proposalId: "org-a-proposal" } })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(
        (yield* client.issueTrackers.cancelLinearReplacement({
          headers,
          payload: { proposalId: "org-a-proposal" },
        })).connections,
      ).toEqual([]);
      expect(harness.seen).toEqual(["lock:org-b:linear", "lock:org-b:linear", "list:org-b"]);
    }),
  );

  it.effect("executor reads derive the organization from enrollment", () =>
    Effect.gen(function* () {
      const harness = setup();
      const client = yield* harness.client;
      const error = yield* client.issueTrackersServer
        .readIssue({
          params: { environmentId: EnvironmentId.make("env-a"), service: "jira" },
          payload: { issue: "LP-1" },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "RelayIssueTrackerError", code: "not_configured" });
      expect(harness.seen).toEqual(["get:org-a"]);
    }),
  );

  it.effect("personal machines, review hosts, and mismatched credentials cannot read", () =>
    Effect.gen(function* () {
      for (const found of [
        null,
        { ...machine, role: "review_host" as const },
        { ...machine, environmentPublicKey: "other" },
      ]) {
        const harness = setup({ machine: found });
        const client = yield* harness.client;
        const error = yield* client.issueTrackersServer
          .readIssue({
            params: { environmentId: EnvironmentId.make("env-a"), service: "linear" },
            payload: { issue: "LP-1" },
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("RelayAuthInvalidError");
        expect(harness.seen).toEqual([]);
      }
      const harness = setup();
      const error = yield* (yield* harness.client).issueTrackersServer
        .readIssue({
          params: { environmentId: EnvironmentId.make("env-b"), service: "jira" },
          payload: { issue: "LP-1" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("RelayAuthInvalidError");
      expect(harness.seen).toEqual([]);
    }),
  );
});

it.effect.each(["readComments", "readImages", "viewImage"] as const)(
  "enforces managed executor identity before %s follow-ups",
  (operation) =>
    Effect.gen(function* () {
      for (const found of [
        null,
        { ...machine, role: "review_host" as const },
        { ...machine, environmentPublicKey: "other" },
        machine,
      ]) {
        const harness = setup({ machine: found });
        const client = yield* harness.client;
        const input = {
          params: { environmentId: EnvironmentId.make("env-a") },
          payload: { reference: "sealed-reference" },
        };
        const failures = {
          readComments: client.issueTrackersServer.readComments(input).pipe(Effect.flip),
          readImages: client.issueTrackersServer.readImages(input).pipe(Effect.flip),
          viewImage: client.issueTrackersServer.viewImage(input).pipe(Effect.flip),
        };
        const error = yield* failures[operation];
        if (found === machine) {
          expect(error).toMatchObject({ _tag: "RelayIssueTrackerError", code: "conflict" });
          expect(harness.seen).toEqual(["get:org-a"]);
        } else {
          expect(error._tag).toBe("RelayAuthInvalidError");
          expect(harness.seen).toEqual([]);
        }
      }
    }),
);
