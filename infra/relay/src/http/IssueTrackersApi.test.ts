import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayIssueTrackerTurnAuth,
  RelayIssueTrackerTurnPrincipal,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi";

import { RelayConfiguration } from "../Config.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { ConnectionStore, type ConnectionRecord } from "../issueTrackers/ConnectionStore.ts";
import {
  WriteOperationStore,
  type WriteOperationRecord,
} from "../issueTrackers/WriteOperationStore.ts";
import { executeWithBudget, issueTrackersApi, issueTrackersServerApi } from "./IssueTrackersApi.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-09-30T09:00:00.000Z";
const record: ConnectionRecord = {
  ownerUserId: "caller",
  service: "jira",
  version: "version",
  status: "connected",
  writesEnabled: false,
  writeGeneration: 0,
  accountLabel: "team.atlassian.net",
  payloadSealed: "secret-ciphertext",
  authorizationId: null,
  replacement: null,
  jiraSelection: null,
  pendingOAuthSealed: null,
  pendingStateHash: null,
  pendingExpiresAt: null,
  updatedByUserId: "admin",
  updatedAt: timestamp,
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
    userId?: string;
    organizationId?: string;
    connection?: ConnectionRecord;
    writeOperation?: WriteOperationRecord;
  } = {},
) {
  const seen: string[] = [];
  const deps = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RelayConfiguration, config),
    Layer.mock(RelaySecretBox, { open: () => Effect.succeed("invalid") }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected upstream call")),
    ),
    Layer.mock(ConnectionStore, {
      list: (organizationId) => {
        seen.push(`list:${organizationId}`);
        return Effect.succeed(organizationId === "caller" ? [input.connection ?? record] : []);
      },
      withLock: (key, use) => {
        seen.push(`lock:${key.ownerUserId}:${key.service}`);
        return use(null);
      },
      get: ({ ownerUserId }) => {
        seen.push(`get:${ownerUserId}`);
        return Effect.succeed(null);
      },
      remove: ({ ownerUserId, service }) => {
        seen.push(`remove:${ownerUserId}:${service}`);
        return Effect.void;
      },
    }),
    Layer.mock(WriteOperationStore, {
      get: () => Effect.succeed(input.writeOperation ?? null),
      approve: () =>
        Effect.sync(() => {
          seen.push("approve");
          return input.writeOperation!;
        }),
    }),
  );
  const auth = Layer.mergeAll(
    Layer.succeed(RelayIssueTrackerTurnAuth, {
      turnBearer: (effect) =>
        Effect.provideService(effect, RelayIssueTrackerTurnPrincipal, {
          ownerUserId: "caller",
          environmentId: EnvironmentId.make("env-a"),
          threadId: "thread",
          commandId: "command",
          commandDigest: "a".repeat(64),
          expiresAt: 4102444800000,
          connections: { jira: "version", linear: "version" },
          writeGenerations: { jira: 4 },
        }),
    }),
    Layer.succeed(RelayClientAuth, {
      clientBearer: (effect) =>
        Effect.provideService(effect, RelayClientPrincipal, {
          userId: input.userId ?? "caller",
          token: "test",
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
  const approvedWrite = {
    operationId: "write-1",
    ownerUserId: "caller",
    environmentId: "env-a",
    threadId: "thread",
    commandId: "command",
    providerSessionId: "session-1",
    service: "jira",
    connectionVersion: "version",
    writeGeneration: 4,
    runtimeMode: "approval-required",
    state: "ready",
    approvedByUserId: "caller",
    expiresAt: "2099-01-01T00:00:00.000Z",
  } as WriteOperationRecord;

  it.effect("verifies an owner's supervised approval or rejection without executing it", () =>
    Effect.gen(function* () {
      const payload = { operationId: "write-1", providerSessionId: "session-1" };
      const params = { environmentId: EnvironmentId.make("env-a") };
      const approved = setup({ writeOperation: approvedWrite });
      expect(
        yield* (yield* approved.client).issueTrackersServer.verifyWriteDecision({
          params,
          payload,
        }),
      ).toEqual({ decision: "accept" });
      expect(approved.seen).not.toContain("approve");
      const rejected = setup({
        writeOperation: { ...approvedWrite, state: "rejected", approvedByUserId: null },
      });
      expect(
        yield* (yield* rejected.client).issueTrackersServer.verifyWriteDecision({
          params,
          payload,
        }),
      ).toEqual({ decision: "decline" });
      const undecided = setup({
        writeOperation: { ...approvedWrite, approvedByUserId: null },
      });
      expect(
        yield* (yield* undecided.client).issueTrackersServer.verifyWriteDecision({
          params,
          payload,
        }),
      ).toEqual({ decision: null });
    }),
  );

  it.effect.each([
    ["owner", { ownerUserId: "other" }],
    ["environment", { environmentId: "other" }],
    ["thread", { threadId: "other" }],
    ["command", { commandId: "other" }],
    ["session", { providerSessionId: "other" }],
    ["connection", { connectionVersion: "other" }],
    ["generation", { writeGeneration: 5 }],
    ["full access", { runtimeMode: "full-access" }],
  ] as const)("does not attest a mismatched %s write", ([_field, changed]) =>
    Effect.gen(function* () {
      const harness = setup({ writeOperation: { ...approvedWrite, ...changed } });
      const error = yield* (yield* harness.client).issueTrackersServer
        .verifyWriteDecision({
          params: { environmentId: EnvironmentId.make("env-a") },
          payload: { operationId: "write-1", providerSessionId: "session-1" },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "not_found" });
    }),
  );

  it.effect("settles a claimed write before the relay request deadline", () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      let state: "ready" | "executing" | "outcome_unknown" = "ready";
      const work = Effect.acquireUseRelease(
        Effect.sync(() => {
          state = "executing";
        }).pipe(Effect.andThen(Deferred.succeed(claimed, undefined))),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            state = "outcome_unknown";
          }),
      );
      const pending = yield* executeWithBudget(work, "write-1", "env-a").pipe(
        Effect.provideService(RelayIssueTrackerTurnPrincipal, {
          ownerUserId: "caller",
          environmentId: EnvironmentId.make("env-a"),
          threadId: "thread",
          commandId: "command",
          commandDigest: "a".repeat(64),
          expiresAt: 4102444800000,
          connections: { jira: "version" },
        }),
        Effect.provide(
          Layer.mock(WriteOperationStore, {
            get: () =>
              Effect.succeed({
                operationId: "write-1",
                ownerUserId: "caller",
                threadId: "thread",
                environmentId: "env-a",
                state,
                resultUrl: null,
              } as WriteOperationRecord),
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(claimed);
      yield* TestClock.adjust("7 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ state: "outcome_unknown" });
      expect(state).toBe("outcome_unknown");
    }),
  );
  it.effect("does not accept a collaborator's approval for a personal connection", () =>
    Effect.gen(function* () {
      const harness = setup({
        userId: "collaborator",
        writeOperation: {
          operationId: "write-1",
          ownerUserId: "caller",
        } as WriteOperationRecord,
      });
      const result = yield* (yield* harness.client).issueTrackers
        .decideWrite({
          headers,
          payload: { operationId: "write-1", decision: "approve" },
        })
        .pipe(Effect.flip);
      expect(result).toMatchObject({ code: "not_found" });
      expect(harness.seen).not.toContain("approve");
    }),
  );

  it.effect(
    "personal connection metadata is scoped to the authenticated user, not organization membership",
    () =>
      Effect.gen(function* () {
        const harness = setup({ role: "member", organizationId: "another-organization" });
        const result = yield* (yield* harness.client).issueTrackers.listConnections({ headers });
        expect(result.connections[0]?.accountLabel).toBe("team.atlassian.net");
        expect(harness.seen).toEqual(["list:caller"]);
        expect(result.connections[0]).not.toHaveProperty("payloadSealed");
      }),
  );

  it.effect("a member disconnects only their own connection", () =>
    Effect.gen(function* () {
      const harness = setup({ role: "member", organizationId: "another-organization" });
      expect(
        yield* (yield* harness.client).issueTrackers.disconnect({
          headers,
          params: { service: "linear" },
        }),
      ).toEqual({ ok: true });
      expect(harness.seen).toEqual(["remove:caller:linear"]);
    }),
  );

  it.effect("does not expose another user's connections", () =>
    Effect.gen(function* () {
      const harness = setup({ userId: "other" });
      expect(
        (yield* (yield* harness.client).issueTrackers.listConnections({ headers })).connections,
      ).toEqual([]);
      expect(harness.seen).toEqual(["list:other"]);
    }),
  );

  it.effect("replacement and Jira site decisions look up only the caller's records", () =>
    Effect.gen(function* () {
      const harness = setup({ userId: "other" });
      const client = yield* harness.client;
      expect(
        yield* client.issueTrackers
          .confirmLinearReplacement({ headers, payload: { proposalId: "someone-elses-proposal" } })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* client.issueTrackers
          .selectJiraSite({
            headers,
            payload: { authorizationId: "someone-elses-attempt", cloudId: "cloud" },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* client.issueTrackers
          .cancelJiraSelection({ headers, payload: { authorizationId: "someone-elses-attempt" } })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      expect(harness.seen).toEqual(["lock:other:linear", "get:other", "lock:other:jira"]);
    }),
  );

  it.effect("reads never fall back to an organization connection", () =>
    Effect.gen(function* () {
      const harness = setup();
      const result = yield* (yield* harness.client).issueTrackersServer
        .readIssue({
          params: { environmentId: EnvironmentId.make("env-a"), service: "jira" },
          payload: { issue: "WP-1" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("RelayAuthInvalidError");
      expect(harness.seen).toEqual(["get:caller"]);
    }),
  );

  it.effect.each(["readComments", "readImages", "viewImage"] as const)(
    "rejects a grant for the wrong environment before %s",
    (operation) =>
      Effect.gen(function* () {
        const harness = setup();
        const client = yield* harness.client;
        const input = {
          params: { environmentId: EnvironmentId.make("another-environment") },
          payload: { reference: "source" },
        };
        const result = yield* operation === "readComments"
          ? client.issueTrackersServer.readComments(input).pipe(Effect.flip)
          : operation === "readImages"
            ? client.issueTrackersServer.readImages(input).pipe(Effect.flip)
            : client.issueTrackersServer.viewImage(input).pipe(Effect.flip);
        expect(result._tag).toBe("RelayAuthInvalidError");
        expect(harness.seen).toEqual([]);
      }),
  );

  it.effect.each(["admin", "member"] as const)(
    "the owner can choose Jira sites regardless of organization role: %s",
    (role) =>
      Effect.gen(function* () {
        const connection: ConnectionRecord = {
          ...record,
          authorizationId: "attempt",
          pendingExpiresAt: "2099-01-01T00:00:00Z",
          jiraSelection: {
            payloadSealed: "private-pending-grant",
            sites: [
              { cloudId: "cloud", siteUrl: "https://team.atlassian.net", accountLabel: "Team" },
            ],
          },
        };
        const result = yield* (yield* setup({ role, connection })
          .client).issueTrackers.listConnections({ headers });
        expect(result.connections[0]?.jiraSites).toEqual(connection.jiraSelection!.sites);
        expect(yield* encodeJson(result)).not.toContain("private-pending-grant");
      }),
  );
});
