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
      if (request.method === "PUT") return Response.json(connection);
      if (request.method === "DELETE") return Response.json({ ok: true });
      if (request.url.includes("/replacement/"))
        return Response.json({ connections: [connection], linearAvailable: true });
      if (request.method === "POST")
        return Response.json({
          authorizationUrl: "https://linear.app/oauth/authorize?state=test-state",
          authorizationId: "attempt",
          connection: { ...connection, service: "linear", status: "connecting" },
        });
      return Response.json({ connections: [connection], linearAvailable: true });
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const client = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
      const result = yield* client.listIssueTrackerConnections({ clerkToken: "member-token" });
      expect(result.connections).toEqual([connection]);
      yield* client.startLinearAuthorization({ clerkToken: "admin-token" });
      const payload = {
        siteUrl: "https://team.atlassian.net",
        apiKey: "fixture-key",
        issue: "TEAM-1",
      };
      expect(yield* client.connectJira({ clerkToken: "admin-token", payload })).toEqual(connection);
      yield* client.disconnectIssueTracker({ clerkToken: "admin-token", service: "jira" });
      yield* client.confirmLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      yield* client.cancelLinearReplacement({ clerkToken: "admin-token", proposalId: "proposal" });
      expect(requests).toEqual([
        {
          url: "https://relay.example.test/v1/organization/issue-trackers",
          method: "GET",
          bearer: "Bearer member-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/organization/issue-trackers/linear/authorize",
          method: "POST",
          bearer: "Bearer admin-token",
          body: null,
        },
        {
          url: "https://relay.example.test/v1/organization/issue-trackers/jira",
          method: "PUT",
          bearer: "Bearer admin-token",
          body: payload,
        },
        {
          url: "https://relay.example.test/v1/organization/issue-trackers/jira",
          method: "DELETE",
          bearer: "Bearer admin-token",
          body: null,
        },
        ...["confirm", "cancel"].map((action) => ({
          url: `https://relay.example.test/v1/organization/issue-trackers/linear/replacement/${action}`,
          method: "POST",
          bearer: "Bearer admin-token",
          body: { proposalId: "proposal" },
        })),
      ]);
    }).pipe(Effect.provide(testLayer(fetchFn)));
  });

  it.effect("keeps an actionable issue access failure instead of an opaque transport error", () => {
    const message = "The service account cannot read this issue. Check its Jira access.";
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
        .connectJira({
          clerkToken: "admin-token",
          payload: {
            siteUrl: "https://team.atlassian.net",
            apiKey: "fixture-key",
            issue: "TEAM-1",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ManagedRelayRequestFailedError");
      if (error._tag !== "ManagedRelayRequestFailedError" || !error.relayError)
        throw new Error("Expected a typed relay failure");
      expect(relayProtectedErrorMessage(error.relayError)).toBe(message);
      expect(error.traceId).toBe("trace-jira-access");
    }).pipe(Effect.provide(testLayer(fetchFn)));
  });
});
