import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowSourceError } from "@t3tools/contracts/relay";
import * as Linear from "./Linear.ts";
import { configLayer, transport, tokenReply } from "./test-fixture.ts";

const isSourceError = Schema.is(WorkflowSourceError);

describe("native Linear workflow adapter", () => {
  it.effect("uses fixed native endpoints, read/user consent and PKCE S256", () =>
    Effect.gen(function* () {
      const url = new URL(
        yield* Linear.authorizationUrl({ state: "csrf-state", verifier: "private-verifier" }),
      );
      expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        actor: "user",
        scope: "read",
        state: "csrf-state",
        prompt: "consent",
        code_challenge_method: "S256",
        redirect_uri: "https://relay.test/oauth/workflow-sources/linear/callback",
      });
      expect(url.searchParams.get("code_challenge")).toHaveLength(43);
      const tokens = yield* Linear.exchange({ code: "code", verifier: "verifier" });
      expect(tokens).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    }).pipe(
      Effect.provide([
        configLayer,
        transport((req) => {
          expect(req.url).toBe("https://api.linear.app/oauth/token");
          return Response.json(tokenReply);
        }),
      ]),
    ),
  );
  for (const [code, expected] of [
    ["invalid_client", "service_configuration"],
    ["unauthorized_client", "service_configuration"],
    ["invalid_grant", "reconnect_required"],
  ] as const)
    it.effect(`classifies refresh ${code} as ${expected}`, () =>
      Effect.gen(function* () {
        const error = yield* Linear.exchange({ refreshToken: "refresh" }).pipe(Effect.flip);
        expect(error).toMatchObject({ code: expected });
      }).pipe(
        Effect.provide([
          configLayer,
          transport(() => Response.json({ error: code }, { status: 401 })),
        ]),
      ),
    );
  it.effect("rejects partial GraphQL success without returning its data", () =>
    Effect.gen(function* () {
      const error = yield* Linear.identity("access").pipe(Effect.flip);
      expect(isSourceError(error)).toBe(true);
      expect(error).toMatchObject({ code: "unavailable" });
    }).pipe(
      Effect.provide(
        transport(() =>
          Response.json({
            data: { organization: { id: "workspace", name: "Private" } },
            errors: [{ message: "private provider diagnostics" }],
          }),
        ),
      ),
    ),
  );
  it.effect("recognizes GraphQL rate limits on HTTP 400 and retains a bounded retry deadline", () =>
    Effect.gen(function* () {
      const error = yield* Linear.identity("access").pipe(Effect.flip);
      expect(error).toMatchObject({ code: "rate_limited" });
      if (isSourceError(error)) expect(error.retryAt).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        transport(() =>
          Response.json(
            { errors: [{ extensions: { code: "RATELIMITED" } }] },
            { status: 400, headers: { "retry-after": "30" } },
          ),
        ),
      ),
    ),
  );
  it.effect("bounds provider response bytes", () =>
    Effect.gen(function* () {
      expect(yield* Linear.identity("access").pipe(Effect.flip)).toMatchObject({
        code: "unavailable",
      });
    }).pipe(Effect.provide(transport(() => new Response("x".repeat(524_289))))),
  );
  it.effect("pages team metadata and rejects a workspace mismatch", () =>
    Effect.gen(function* () {
      const error = yield* Linear.metadata("access", "expected", "teams", undefined, null, 50).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ code: "workspace_mismatch" });
    }).pipe(
      Effect.provide(
        transport(() =>
          Response.json({
            data: {
              organization: { id: "other" },
              page: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          }),
        ),
      ),
    ),
  );
  for (const kind of ["states", "labels"] as const) {
    it.effect(`reads effective ${kind} for the selected team with bounded pagination`, () =>
      Effect.gen(function* () {
        const result = yield* Linear.metadata("access", "workspace", kind, "team", "previous", 25);
        expect(result).toEqual({
          items: [{ id: "effective", name: "Inherited value" }],
          after: "next",
        });
      }).pipe(
        Effect.provide(
          transport((request) => {
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag === "Uint8Array") {
              const body = JSON.parse(new TextDecoder().decode(request.body.body));
              expect(body.variables).toEqual({ first: 25, after: "previous", team: "team" });
              expect(body.query).toContain(
                kind === "states" ? "states(first:$first,after:$after)" : "isGroup:{eq:false}",
              );
              if (kind === "labels") {
                expect(body.query).toContain("{team:{id:{eq:$team}}}");
                expect(body.query).toContain("{team:{null:true}}");
              }
            }
            const page = {
              nodes: [
                { id: "effective", name: "Inherited value", archivedAt: null },
                { id: "archived", name: "Old", archivedAt: "2026-01-01" },
              ],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            };
            return Response.json({
              data: {
                organization: { id: "workspace" },
                ...(kind === "states"
                  ? { page: { id: "team", page } }
                  : { team: { id: "team" }, page }),
              },
            });
          }),
        ),
      ),
    );
  }
  it.effect("rejects inaccessible team metadata rather than offering incomplete choices", () =>
    Effect.gen(function* () {
      const result = yield* Linear.metadata("access", "workspace", "labels", "team", null, 25).pipe(
        Effect.flip,
      );
      expect(result).toMatchObject({ code: "unavailable" });
    }).pipe(
      Effect.provide(
        transport(() =>
          Response.json({
            data: {
              organization: { id: "workspace" },
              team: null,
              page: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          }),
        ),
      ),
    ),
  );
});
