import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { RelayConfiguration } from "../Config.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { runRepositoryWorkflow, saveRepositoryWorkflow } from "../http/WorkflowsApi.ts";
import { Workflows, layer as workflows } from "../jobs/Workflows.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { layer as repositories } from "../tenancy/Repositories.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
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
  definition,
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

const vmInput = {
  workflowId: "flow",
  expectedRevision: 0,
  definition: { ...definition, target: { kind: "vm", baseBranch: "release/1.x" } },
  archived: false,
} as const;
const testVmAuthoring = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  testDb(
    program.pipe(
      Effect.provide([workflows, organizations, repositories, machines, catalog, noSummaryIo]),
      Effect.provideService(ThreadVmRuntimeConfiguration, { settings: undefined }),
      Effect.provideService(RelayClientPrincipal, { userId: "maintainer", token: "fixture" }),
    ),
  );

describe("VM workflow authoring (PostgreSQL)", () => {
  it.live("saves without a machine or model catalog and rejects Run before creating a job", () =>
    testVmAuthoring(
      Effect.gen(function* () {
        const store = yield* Workflows;
        const saved = yield* saveRepositoryWorkflow("repo", vmInput);
        expect(saved.definition.target).toEqual(vmInput.definition.target);
        expect(yield* store.get(vmInput.workflowId)).toEqual(saved);
        expect(
          yield* Effect.flip(
            runRepositoryWorkflow("repo", {
              workflowId: saved.workflowId,
              instruction: "Test",
              expectedTargetKind: "vm",
            }),
          ),
        ).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Running VM workflows is not available yet.",
        });
        expect(yield* store.listJobs("repo")).toEqual([]);
      }),
    ),
  );

  it.live("rejects stale Run forms after switching execution targets in either direction", () =>
    testVmAuthoring(
      Effect.gen(function* () {
        yield* seed;
        const machine = yield* save("flow", trigger, false);
        const store = yield* Workflows;
        const rejectStaleRun = Effect.fnUntraced(function* (expectedTargetKind: "machine" | "vm") {
          const error = yield* Effect.flip(
            runRepositoryWorkflow("repo", {
              workflowId: machine.workflowId,
              instruction: "Test",
              expectedTargetKind,
            }),
          );
          expect(error).toMatchObject({
            _tag: "WorkflowInvalidError",
            message:
              "The workflow execution target changed. Review the saved target and try again.",
          });
          expect(yield* store.listJobs("repo")).toEqual([]);
        });

        const vm = yield* saveRepositoryWorkflow("repo", {
          ...vmInput,
          expectedRevision: machine.revision,
        });
        yield* rejectStaleRun("machine");

        yield* saveRepositoryWorkflow("repo", {
          ...vmInput,
          expectedRevision: vm.revision,
          definition: machine.definition,
        });
        yield* rejectStaleRun("vm");
      }),
    ),
  );

  for (const operation of ["creating a VM workflow", "switching a VM workflow to Machine"] as const)
    it.live(`rechecks maintainer access when ${operation} with omitted automation`, () =>
      testVmAuthoring(
        Effect.gen(function* () {
          const store = yield* Workflows;
          const previous =
            operation === "switching a VM workflow to Machine"
              ? yield* saveRepositoryWorkflow("repo", vmInput)
              : null;
          if (previous) yield* seed;
          const input = previous
            ? { ...vmInput, expectedRevision: previous.revision, definition }
            : vmInput;
          const sql = (yield* RelayDb).$client;
          const error = yield* saveRepositoryWorkflow("repo", input).pipe(
            Effect.provideService(Workflows, {
              ...store,
              save: (...args) =>
                sql`DELETE FROM relay_repository_access WHERE repository_id='repo' AND user_id='maintainer'`.pipe(
                  Effect.orDie,
                  Effect.andThen(store.save(...args)),
                ),
            }),
            Effect.flip,
          );
          expect(error).toMatchObject({
            _tag: "WorkflowInvalidError",
            message: "Repository maintainer access is required.",
          });
          expect(yield* store.get(vmInput.workflowId)).toEqual(previous);
          if (previous) {
            const converted = yield* saveRepositoryWorkflow("repo", input).pipe(
              Effect.provideService(RelayClientPrincipal, { userId: "owner", token: "fixture" }),
            );
            expect(converted).toMatchObject({
              definition,
              revision: previous.revision + 1,
              automation: { enabled: false, trigger: null },
            });
            expect(yield* store.get(vmInput.workflowId)).toEqual(converted);
          }
        }),
      ),
    );

  it.live("rejects inherited On but accepts explicit Off plus VM, preserving the trigger", () =>
    testVmAuthoring(
      Effect.gen(function* () {
        yield* seed;
        const previous = yield* save();
        const store = yield* Workflows;
        const input = { ...vmInput, expectedRevision: previous.revision };
        const message = /Turn off automatic triggering/;
        expect((yield* Effect.flip(saveRepositoryWorkflow("repo", input))).message).toMatch(
          message,
        );
        expect(
          (yield* Effect.flip(store.save("org", "repo", input, { userId: "maintainer" }))).message,
        ).toMatch(message);
        const off = { enabled: false, trigger };
        const saved = yield* saveRepositoryWorkflow("repo", { ...input, automation: off });
        expect(saved.automation).toEqual(off);
        expect(yield* summaries("repo")).toEqual([
          { workflowId: saved.workflowId, revision: saved.revision, state: "off", reason: null },
        ]);
        expect(
          yield* Effect.flip(saveRepositoryWorkflow("repo", { ...input, automation: off })),
        ).toMatchObject({
          _tag: "WorkflowConflictError",
        });
        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        expect((yield* counts).jobs).toBe(0);
      }),
    ),
  );

  it.live("permits archive and restore of an unchanged VM definition with a stale model", () =>
    testVmAuthoring(
      Effect.gen(function* () {
        const store = yield* Workflows;
        const stale = {
          ...vmInput.definition,
          steps: [
            {
              ...definition.steps[0]!,
              kind: "agent" as const,
              instruction: "Implement",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "previously-verified",
              },
            },
          ],
        };
        const saved = yield* store.save(
          "org",
          "repo",
          { ...vmInput, definition: stale },
          { userId: "maintainer" },
        );
        const archive = {
          ...vmInput,
          definition: stale,
          expectedRevision: saved.revision,
          archived: true,
        };
        const archived = yield* saveRepositoryWorkflow("repo", archive);
        expect(archived.archived).toBe(true);
        const restore = { ...archive, expectedRevision: archived.revision, archived: false };
        expect(
          yield* Effect.flip(
            saveRepositoryWorkflow("repo", {
              ...restore,
              definition: { ...stale, name: "Changed" },
            }),
          ),
        ).toMatchObject({ _tag: "WorkflowInvalidError", message: /managed default/ });
        expect(yield* saveRepositoryWorkflow("repo", restore)).toMatchObject({
          archived: false,
          definition: stale,
          automation: { enabled: false, trigger: null },
        });
      }),
    ),
  );
});

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
