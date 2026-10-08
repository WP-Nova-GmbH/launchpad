import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ManagedRelayTenancy from "./managedRelayTenancy.ts";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";

function testLayer(fetchFn: typeof globalThis.fetch) {
  return ManagedRelayTenancy.layer({ relayUrl: "https://relay.example.test" }).pipe(
    Layer.provide(remoteHttpClientLayer(fetchFn)),
  );
}

describe("organization issue tracker client", () => {
  it.effect("uses the current organization's bearer for listing and changing connections", () => {
    const requests: { url: string; method: string; bearer: string | null; body: unknown }[] = [];
    const connection = {
      service: "jira",
      status: "connected",
      accountLabel: "Team Jira",
      updatedAt: "2026-09-30T10:00:00Z",
    };
    const fetchFn = (async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        bearer: request.headers.get("authorization"),
        body: request.body ? await request.json() : null,
      });
      if (request.method === "DELETE") return Response.json({ ok: true });
      if (request.url.includes("/replacement/"))
        return Response.json({ connections: [connection] });
      if (request.method === "POST")
        return Response.json({
          authorizationUrl: "https://linear.app/oauth/authorize?state=test-state",
          authorizationId: "attempt",
          connection: { ...connection, service: "linear", status: "connecting" },
        });
      return Response.json({ connections: [connection] });
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      const result = yield* client.listIssueTrackerConnections({ clerkToken: "member-token" });
      expect(result.connections).toEqual([connection]);
      yield* client.startLinearAuthorization({ clerkToken: "admin-token" });
      yield* client.disconnectIssueTracker({ clerkToken: "admin-token", service: "jira" });
      yield* client.confirmLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      yield* client.cancelLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      expect(requests).toEqual([
        {
          url: "https://relay.example.test/v1/user/issue-trackers",
          method: "GET",
          bearer: "Bearer member-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/user/issue-trackers/linear/authorize",
          method: "POST",
          bearer: "Bearer admin-token",
          body: { writes: false },
        },
        {
          url: "https://relay.example.test/v1/user/issue-trackers/jira",
          method: "DELETE",
          bearer: "Bearer admin-token",
          body: null,
        },
        ...["confirm", "cancel"].map((action) => ({
          url: `https://relay.example.test/v1/user/issue-trackers/linear/replacement/${action}`,
          method: "POST",
          bearer: "Bearer admin-token",
          body: { proposalId: "proposal" },
        })),
      ]);
    }).pipe(Effect.provide(testLayer(fetchFn)));
  });

  it.effect(
    "keeps an actionable authorization failure instead of an opaque transport error",
    () => {
      const message = "Atlassian denied authorization. Check your Jira access.";
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "RelayIssueTrackerError",
              code: "forbidden",
              message,
              traceId: "trace-jira-access",
            },
            { status: 400 },
          ),
        )) satisfies typeof globalThis.fetch;

      return Effect.gen(function* () {
        const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
        const error = yield* client
          .startJiraAuthorization({
            clerkToken: "admin-token",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ManagedRelayRequestFailedError");
        if (error._tag !== "ManagedRelayRequestFailedError" || !error.relayError)
          throw new Error("Expected a typed relay failure");
        expect(relayProtectedErrorMessage(error.relayError)).toBe(message);
        expect(error.traceId).toBe("trace-jira-access");
      }).pipe(Effect.provide(testLayer(fetchFn)));
    },
  );
});

it.effect("starts Jira OAuth with only the administrator's relay session", () => {
  const requests: Request[] = [];
  const fetchFn = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      authorizationUrl: "https://mcp.atlassian.com/v1/authorize?state=test",
      authorizationId: "attempt",
      connection: {
        service: "jira",
        status: "connecting",
        accountLabel: null,
        updatedAt: "2026-10-01",
      },
    });
  }) satisfies typeof globalThis.fetch;
  return Effect.gen(function* () {
    const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
    const result = yield* client.startJiraAuthorization({
      clerkToken: "admin-token",
    });
    expect(result.authorizationUrl).toContain("mcp.atlassian.com");
    const request = requests[0]!;
    expect(request.url).toBe("https://relay.example.test/v1/user/issue-trackers/jira/authorize");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer admin-token");
    expect(yield* Effect.promise(() => request.json())).toEqual({ writes: false });
  }).pipe(Effect.provide(testLayer(fetchFn)));
});

it.effect.each(["select", "cancel"] as const)(
  "sends the %s action with the exact Jira authorization attempt",
  (action) => {
    const requests: Request[] = [];
    const fetchFn = (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ connections: [] });
    }) satisfies typeof globalThis.fetch;
    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      if (action === "select")
        yield* client.selectJiraSite({
          clerkToken: "admin-token",
          payload: { authorizationId: "attempt", cloudId: "cloud" },
        });
      else
        yield* client.cancelJiraSelection({
          clerkToken: "admin-token",
          authorizationId: "attempt",
        });
      const request = requests[0]!;
      expect(request.url).toBe(
        `https://relay.example.test/v1/user/issue-trackers/jira/${action === "select" ? "select-site" : "cancel-selection"}`,
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer admin-token");
      expect(yield* Effect.promise(() => request.json())).toEqual(
        action === "select"
          ? { authorizationId: "attempt", cloudId: "cloud" }
          : { authorizationId: "attempt" },
      );
    }).pipe(Effect.provide(testLayer(fetchFn)));
  },
);
