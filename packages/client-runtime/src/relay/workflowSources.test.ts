import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayRepositoryId, WorkflowSourceError } from "@t3tools/contracts/relay";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as Tenancy from "./managedRelayTenancy.ts";
import * as Sources from "./workflowSources.ts";
const snapshot = { configured: true, canManage: true, sources: [], eligible: [] };
function layer(fetchFn: typeof fetch) {
  const http = remoteHttpClientLayer(fetchFn);
  return Tenancy.layer({ relayUrl: "https://relay.test" }).pipe(Layer.provideMerge(http));
}
describe("workflow source client", () => {
  it.effect("uses relay bearer authorization and preserves exact consent identity", () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    return Effect.gen(function* () {
      const client = yield* Sources.client;
      const repo = RelayRepositoryId.make("repo");
      yield* client.repository("token", repo);
      yield* client.allow("token", repo, {
        connectionId: "connection",
        grantId: "intent",
        previousGrantId: "revoked",
      });
      expect(requests).toEqual([
        { url: "https://relay.test/v1/repositories/repo/workflow-sources", body: null },
        {
          url: "https://relay.test/v1/repositories/repo/workflow-sources/allow",
          body: { connectionId: "connection", grantId: "intent", previousGrantId: "revoked" },
        },
      ]);
    }).pipe(
      Effect.provide(
        layer(async (input, init) => {
          const req = new Request(input, init);
          expect(req.headers.get("authorization")).toBe("Bearer token");
          requests.push({ url: req.url, body: req.body ? await req.json() : null });
          return Response.json(snapshot);
        }),
      ),
    );
  });
  it.effect("preserves typed recovery errors and identifies access loss", () =>
    Effect.gen(function* () {
      const client = yield* Sources.client;
      const error = yield* client
        .repository("token", RelayRepositoryId.make("repo"))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "forbidden" });
      expect(Sources.accessRejected(error)).toBe(true);
      expect(
        Sources.accessRejected(
          new WorkflowSourceError({ code: "unavailable", message: "Offline" }),
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        layer(async () =>
          Response.json(
            { _tag: "WorkflowSourceError", code: "forbidden", message: "Access removed" },
            { status: 400 },
          ),
        ),
      ),
    ),
  );
  it.effect("decodes a Begin link independently of a newer owner snapshot", () =>
    Effect.gen(function* () {
      const client = yield* Sources.client;
      const result = yield* client.begin("token", {
        attemptId: "A",
        expectedVersion: 0,
        connectionId: null,
      });
      expect(result.authorization).toEqual({
        applicationId: "app",
        attemptId: "A",
        url: "https://linear.app/oauth/authorize?state=A",
      });
      expect(result.owner.attempt?.attemptId).toBe("B");
      expect(result.owner.withdrawableGrants).toEqual([
        { grantId: "hidden", connectionId: "owned", repositoryName: null },
      ]);
    }).pipe(
      Effect.provide(
        layer(async () =>
          Response.json({
            authorization: {
              applicationId: "app",
              attemptId: "A",
              url: "https://linear.app/oauth/authorize?state=A",
            },
            owner: {
              configured: true,
              applicationId: "app",
              version: 2,
              attempt: {
                attemptId: "B",
                connectionId: null,
                expiresAt: 600000,
                status: "pending",
                error: null,
              },
              connections: [],
              repositories: [],
              grants: [],
              withdrawableGrants: [
                { grantId: "hidden", connectionId: "owned", repositoryName: null },
              ],
            },
          }),
        ),
      ),
    ),
  );
});
