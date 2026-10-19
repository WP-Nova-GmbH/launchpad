import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { RelayConfiguration } from "../Config.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import * as Layer from "effect/Layer";
import * as Routing from "./Routing.ts";
import { RelayDb } from "../db.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Sources from "../workflowSources/Sources.ts";
import { databaseUrl, withDatabase, transport } from "../workflowSources/test-fixture.ts";
import {
  configured,
  seed,
  save,
  trigger,
  clock,
  issue,
  receive,
  counts,
  webhookConfig,
} from "./test-fixture.ts";
import { summaries } from "./Summaries.ts";
if (!databaseUrl) throw new Error("Authoring tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");
const testDb = <A, E, R>(effect: Effect.Effect<A, E, R>) => withDatabase(configured(effect));
const selected = {
  data: {
    organization: { id: "workspace" },
    team: { id: "team", name: "Engineering", archivedAt: null },
    state: { id: "ready", name: "Ready", archivedAt: null, team: { id: "team" } },
    labels: {
      nodes: [{ id: "global", name: "Feature", archivedAt: null, isGroup: false, team: null }],
      pageInfo: { hasNextPage: false },
    },
  },
};
const query = { grantId: "grant", teamId: "team", stateId: "ready", labelIds: ["global"] };
describe("workflow authoring reads (PostgreSQL)", () => {
  it.live("derives Off and On without a provider request or an online executor", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const enabled = yield* save("enabled");
        const disabled = yield* save("disabled", trigger, false);
        const result = yield* summaries("repo");
        expect(result).toEqual(
          expect.arrayContaining([
            {
              workflowId: enabled.workflowId,
              revision: enabled.revision,
              state: "on",
              reason: null,
            },
            {
              workflowId: disabled.workflowId,
              revision: disabled.revision,
              state: "off",
              reason: null,
            },
          ]),
        );
        expect(Store.json(result)).not.toMatch(/payload_sealed|refresh_token|delivery_evidence/);
        expect(yield* summaries("repo-2")).toEqual([]);
      }),
    ),
  );
  for (const [name, change, expected] of [
    [
      "another team's delivery",
      'UPDATE relay_workflow_connections SET delivery_evidence=jsonb_set(delivery_evidence,\'{teams}\', \'{"another":{"created":true,"entered":true}}\')',
      "selected team",
    ],
    [
      "withdrawn repository consent",
      "UPDATE relay_workflow_repository_grants SET revoked=true",
      "permission",
    ],
    ["removed owner", "DELETE FROM relay_organization_members WHERE user_id='owner'", "permission"],
    [
      "disconnected source",
      "UPDATE relay_workflow_connections SET status='disconnected',payload_sealed=NULL",
      "reconnect",
    ],
    [
      "changed source epoch",
      "UPDATE relay_workflow_connections SET authorization_epoch=authorization_epoch+1",
      "selected team",
    ],
    ["removed checkout", "DELETE FROM relay_organization_projects", "execution target"],
  ])
    it.live(`shows needs attention for ${name}`, () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          yield* save();
          yield* (yield* RelayDb).$client.unsafe(change!);
          const [summary] = yield* summaries("repo");
          expect(summary?.state).toBe("needs_attention");
          expect(summary?.reason).toContain(expected);
        }),
      ),
    );
  it.live("resolves exact selected names, global label provenance and exact-team delivery", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        let requests = 0;
        const result = yield* Sources.selection("repo", "maintainer", query).pipe(
          Effect.provide(
            transport(() => {
              requests++;
              return Response.json(selected);
            }),
          ),
        );
        expect(requests).toBe(1);
        expect(result).toMatchObject({
          team: { id: "team", name: "Engineering" },
          state: { id: "ready", name: "Ready" },
          labels: [{ id: "global", name: "Feature", teamId: null }],
          issues: [],
          deliveryReady: true,
        });
        const missing = yield* Sources.selection("repo", "maintainer", {
          ...query,
          teamId: "missing",
        }).pipe(Effect.provide(transport(() => Response.json(selected))));
        expect(missing.issues.map((issue) => issue.field)).toEqual(
          expect.arrayContaining(["team", "state"]),
        );
        expect(missing.deliveryReady).toBe(false);
      }),
    ),
  );
  it.live("does not query Linear for another repository, withdrawn grant or reader", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        let requests = 0;
        const http = transport(() => {
          requests++;
          return Response.json(selected);
        });
        for (const [repo, user] of [
          ["repo-2", "owner"],
          ["repo", "reader"],
        ]) {
          expect(
            (yield* Sources.selection(repo!, user!, query).pipe(Effect.provide(http), Effect.exit))
              ._tag,
          ).toBe("Failure");
        }
        yield* Store.withdraw("owner", "grant", "repo");
        expect(
          (yield* Sources.selection("repo", "maintainer", query).pipe(
            Effect.provide(http),
            Effect.exit,
          ))._tag,
        ).toBe("Failure");
        expect(requests).toBe(0);
      }),
    ),
  );
  it.live("rechecks authorization after the selected-ID request completes", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const http = HttpClient.make((req) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(HttpClientResponse.fromWeb(req, Response.json(selected))),
          ),
        );
        const request = yield* Sources.selection("repo", "maintainer", query).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Sources.disconnect("owner", "connection", 1);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.await(request))._tag).toBe("Failure");
      }),
    ),
  );
});

const noSummaryIo = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Readiness must not call Linear")),
  ),
  Layer.mock(EnvironmentConnector)({
    dispatchJob: () => Effect.die("Readiness must not probe an executor"),
  }),
);
it.live(
  "same-source reconnect restores On after current team delivery without another workflow Save",
  () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* save();
        const original = yield* Routing.read("flow");
        const source = (yield* Store.connection("connection"))!;
        yield* Sources.disconnect("owner", "connection", source.authorization_epoch);
        expect((yield* summaries("repo"))[0]?.state).toBe("needs_attention");
        const owner = yield* Store.attempt("owner", "native-app");
        const begin = yield* Sources.begin("owner", {
          attemptId: "reconnect",
          expectedVersion: owner?.version ?? 0,
          connectionId: "connection",
        });
        const state = new URL(begin.authorization!.url).searchParams.get("state")!;
        expect(yield* Sources.callback(state, "fixture-code")).toBe("connection");
        expect((yield* summaries("repo"))[0]?.reason).toContain("selected team");
        const time = (yield* clock) + 1000;
        expect((yield* receive(issue(time))).status).toBe(200);
        expect((yield* counts).jobs).toBe(0);
        expect((yield* summaries("repo"))[0]?.state).toBe("needs_attention");
        expect(
          (yield* receive(issue(time + 1, { action: "update", updatedFrom: { stateId: "todo" } })))
            .status,
        ).toBe(200);
        expect((yield* summaries("repo").pipe(Effect.provide(noSummaryIo)))[0]).toMatchObject({
          state: "on",
          reason: null,
        });
        expect((yield* receive(issue(time + 2))).status).toBe(200);
        expect((yield* counts).jobs).toBe(1);
        expect(yield* Routing.read("flow")).toEqual(original);
      }),
    ),
);
it.live(
  "requires current exact-team evidence after a delivery configuration change, not a new enable proof",
  () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* save();
        const sql = (yield* RelayDb).$client;
        const original = yield* Routing.read("flow");
        const currentConfig = {
          ...webhookConfig,
          linearWorkflowWebhook: {
            ...webhookConfig.linearWorkflowWebhook,
            generation: "coverage-2",
          },
        };
        expect(
          (yield* summaries("repo").pipe(
            Effect.provideService(RelayConfiguration, currentConfig),
          ))[0]?.reason,
        ).toContain("selected team");
        for (const [epoch, teams] of [
          [0, { team: { created: true, entered: true } }],
          [1, { other: { created: true, entered: true } }],
          [1, { team: { created: true, entered: false } }],
        ] as const) {
          yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=${sql.json({ generation: "coverage-2", epoch, teams })}`;
          expect(
            (yield* summaries("repo").pipe(
              Effect.provideService(RelayConfiguration, currentConfig),
            ))[0]?.state,
          ).toBe("needs_attention");
        }
        yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=${sql.json({ generation: "coverage-2", epoch: 1, teams: { team: { created: true, entered: true } } })}`;
        expect(
          (yield* summaries("repo").pipe(
            Effect.provideService(RelayConfiguration, currentConfig),
            Effect.provide(noSummaryIo),
          ))[0]?.state,
        ).toBe("on");
        expect(yield* Routing.read("flow")).toEqual(original);
        yield* sql`UPDATE relay_organization_projects SET repository_canonical_key='github.com/example/another'`;
        expect(
          (yield* summaries("repo").pipe(
            Effect.provideService(RelayConfiguration, currentConfig),
          ))[0]?.reason,
        ).toContain("execution target");
      }),
    ),
);
