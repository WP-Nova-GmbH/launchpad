import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Machines, layer as machinesLayer } from "../machines/Machines.ts";
import { Repositories, layer as repositoriesLayer } from "../tenancy/Repositories.ts";
import {
  OrganizationProjectCatalog,
  layer as catalogLayer,
} from "../projects/OrganizationProjectCatalog.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import * as Workflows from "../jobs/Workflows.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Sources from "../workflowSources/Sources.ts";
import { databaseUrl, withDatabase, transport } from "../workflowSources/test-fixture.ts";
import {
  configured,
  seed,
  trigger,
  definition,
  counts,
  enableBeforeEvent,
  clock,
  issue,
  receive,
} from "./test-fixture.ts";
import { prepare } from "./Preparation.ts";
import { RelayDb } from "../db.ts";
if (!databaseUrl) throw new Error("Preparation tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");
const target = Layer.mergeAll(machinesLayer, repositoriesLayer, catalogLayer);
const selection = {
  data: {
    organization: { id: "workspace" },
    team: { id: "team", archivedAt: null },
    state: { id: "ready", archivedAt: null, team: { id: "team" } },
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  },
};
const input = {
  workflowId: "flow",
  expectedRevision: 0,
  definition,
  archived: false,
  automation: { enabled: true, trigger },
};
const testDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withDatabase(
    configured(effect.pipe(Effect.provide([target, Layer.mock(EnvironmentConnector)({})]))),
  );
describe("automation enable preparation (PostgreSQL)", () => {
  it.live("validates selection and protocol once, reuses proof offline, and creates no job", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const calls: string[] = [];
        const metadata = transport((req) => {
          calls.push(req.url);
          return Response.json(selection);
        });
        const connector = Layer.mock(EnvironmentConnector)({
          dispatchJob: (probe) => {
            calls.push("status");
            expect(probe.workflowControl?.operation).toBe("status");
            expect(probe.workflowOrigin).toEqual({ kind: "manual", userId: "maintainer" });
            return Effect.succeed({
              accepted: false,
              threadId: null,
              workflowResult: {
                protocol: 8,
                outcome: "missing",
                detail: null,
                progress: null,
                actions: ["push", "open_pull_request"],
              },
            });
          },
        });
        const context = yield* prepare("org", "repo", "maintainer", input, null).pipe(
          Effect.provide([metadata, connector]),
        );
        const store = yield* Workflows.make;
        const saved = yield* store.save("org", "repo", input, context);
        expect(calls).toEqual(["https://api.linear.app/graphql", "status"]);
        const cached = yield* prepare(
          "org",
          "repo",
          "maintainer",
          { ...input, expectedRevision: 1, definition: { ...definition, name: "Rename" } },
          saved,
        ).pipe(
          Effect.provide([
            transport(() => {
              throw new Error("No metadata read expected");
            }),
            Layer.mock(EnvironmentConnector)({}),
          ]),
        );
        expect(cached).toEqual(context);
        expect(
          (yield* store.save(
            "org",
            "repo",
            { ...input, expectedRevision: 1, definition: { ...definition, name: "Rename" } },
            cached,
          )).revision,
        ).toBe(2);
        expect((yield* counts).jobs).toBe(0);
      }),
    ),
  );
  it.live("rechecks Linear selection on re-enable while reusing the unchanged offline target", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Workflows.make;
        const valid = transport(() => Response.json(selection));
        const first = yield* prepare("org", "repo", "maintainer", input, null).pipe(
          Effect.provide([
            valid,
            Layer.mock(EnvironmentConnector)({
              dispatchJob: () =>
                Effect.succeed({
                  accepted: false,
                  threadId: null,
                  workflowResult: { protocol: 8, outcome: "missing", detail: null, progress: null },
                }),
            }),
          ]),
        );
        const enabled = yield* store.save("org", "repo", input, first);
        const off = yield* store.save(
          "org",
          "repo",
          { ...input, expectedRevision: enabled.revision, automation: { enabled: false, trigger } },
          { userId: "maintainer" },
        );
        const retry = { ...input, expectedRevision: off.revision };
        const error = yield* prepare("org", "repo", "maintainer", retry, off).pipe(
          Effect.provide(
            transport(() => Response.json({ data: { ...selection.data, team: null } })),
          ),
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "WorkflowInvalidError" });
        const again = yield* prepare("org", "repo", "maintainer", retry, off).pipe(
          Effect.provide(valid),
        );
        expect((yield* store.save("org", "repo", retry, again)).automation.enabled).toBe(true);
      }),
    ),
  );
  it.live.each([7, 8] as const)(
    "requires protocol 8 and each selected publishing action (protocol %s)",
    (protocol) =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const selected = {
            ...input,
            definition: {
              ...definition,
              steps: [
                ...definition.steps,
                { kind: "action" as const, id: "push", title: "Push", action: "push" as const },
              ],
            },
          };
          const result = yield* prepare("org", "repo", "maintainer", selected, null).pipe(
            Effect.provide([
              transport(() => Response.json(selection)),
              Layer.mock(EnvironmentConnector)({
                dispatchJob: () =>
                  Effect.succeed({
                    accepted: false,
                    threadId: null,
                    workflowResult: {
                      protocol,
                      outcome: "missing",
                      progress: null,
                      detail: null,
                      actions: [],
                    },
                  }),
              }),
            ]),
            Effect.flip,
          );
          expect(result).toMatchObject({ _tag: "WorkflowInvalidError" });
          expect((yield* counts).jobs).toBe(0);
        }),
      ),
  );
  it.live("validates exact state/team/labels and returns actionable source errors", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const c = (yield* Store.connection("connection"))!;
        for (const selected of [
          { ...trigger, teamId: "missing" },
          { ...trigger, event: "entered_status" as const, stateId: "other" },
          { ...trigger, labelIds: ["missing"] },
        ])
          expect(
            yield* Sources.validateTrigger(c, selected).pipe(
              Effect.provide(transport(() => Response.json(selection))),
              Effect.flip,
            ),
          ).toMatchObject({ code: "invalid_input" });
        const error = yield* prepare(
          "org",
          "repo",
          "maintainer",
          {
            ...input,
            automation: { enabled: true, trigger: { ...trigger, labelIds: ["missing"] } },
          },
          null,
        ).pipe(
          Effect.provide([
            transport(() => Response.json(selection)),
            Layer.mock(EnvironmentConnector)({}),
          ]),
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "The selected Linear team, state or labels are unavailable.",
        });
      }),
    ),
  );
  it.live("holds no authority locks over metadata HTTP and rechecks withdrawal before Save", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* enableBeforeEvent("existing");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const http = HttpClient.make((req) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(HttpClientResponse.fromWeb(req, Response.json(selection))),
          ),
        );
        const preflight = yield* prepare("org", "repo", "maintainer", input, null).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provide(
            Layer.mock(EnvironmentConnector)({
              dispatchJob: () =>
                Effect.succeed({
                  accepted: false,
                  threadId: null,
                  workflowResult: { protocol: 8, outcome: "missing", progress: null, detail: null },
                }),
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        yield* Store.withdraw("maintainer", "grant", "repo");
        yield* Deferred.succeed(release, undefined);
        const context = yield* Fiber.join(preflight);
        const store = yield* Workflows.make;
        expect(yield* store.save("org", "repo", input, context).pipe(Effect.flip)).toMatchObject({
          _tag: "WorkflowInvalidError",
        });
        expect(yield* store.get("flow")).toBeNull();
        expect((yield* counts).jobs).toBe(1);
      }),
    ),
  );
  it.live("can disable/archive a broken source without metadata or target calls", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        yield* enableBeforeEvent();
        yield* Store.withdraw("maintainer", "grant", "repo");
        const store = yield* Workflows.make;
        const saved = yield* store.get("flow");
        const next = { ...input, expectedRevision: 1, archived: true };
        const context = yield* prepare("org", "repo", "maintainer", next, saved);
        expect(context).toEqual({ userId: "maintainer" });
        expect((yield* store.save("org", "repo", next, context)).automation.enabled).toBe(false);
      }),
    ),
  );
  for (const mutation of [
    "deprovision",
    "remove-machine",
    "remove-project",
    "rebind-project",
    "remove-alias",
    "delete-repository",
  ] as const)
    it.live(`rejects an enabled Save when ${mutation} wins during preflight`, () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const repositories = yield* Repositories;
          yield* repositories.addAlias({
            repositoryId: "repo",
            organizationId: "org",
            canonicalKey: "github.com/example/alternate",
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const preflight = yield* prepare("org", "repo", "maintainer", input, null).pipe(
            Effect.provide([
              transport(() => Response.json(selection)),
              Layer.mock(EnvironmentConnector)({
                dispatchJob: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as({
                      accepted: false,
                      threadId: null,
                      workflowResult: {
                        protocol: 8,
                        outcome: "missing",
                        detail: null,
                        progress: null,
                      },
                    }),
                  ),
              }),
            ]),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          if (mutation === "deprovision")
            yield* (yield* Machines).deprovision({ machineId: "machine" });
          else if (mutation === "remove-machine")
            yield* (yield* Machines).remove({ machineId: "machine" });
          else if (mutation === "delete-repository")
            yield* (yield* RelayDb).$client.withTransaction(
              repositories.deleteRepository({ repositoryId: "repo" }),
            );
          else if (mutation === "remove-alias")
            yield* repositories.removeAlias({
              repositoryId: "repo",
              canonicalKey: "github.com/example/repository",
            });
          else
            yield* (yield* OrganizationProjectCatalog).replace({
              organizationId: "org",
              machineId: "machine",
              environmentId: "environment",
              revision: 2,
              projects:
                mutation === "remove-project"
                  ? []
                  : [
                      {
                        projectId: definition.projectId,
                        title: "Rebound",
                        repositoryCanonicalKey: "github.com/example/alternate",
                        createdAt: "2026-10-01T00:00:00.000Z",
                        updatedAt: "2026-10-01T00:00:00.000Z",
                      },
                    ],
            });
          yield* Deferred.succeed(release, undefined);
          const proof = yield* Fiber.join(preflight);
          const store = yield* Workflows.make;
          expect(yield* store.save("org", "repo", input, proof).pipe(Effect.flip)).toMatchObject({
            _tag: "WorkflowInvalidError",
          });
          expect(yield* store.get("flow")).toBeNull();
          expect((yield* counts).jobs).toBe(0);
        }),
      ),
    );
});
