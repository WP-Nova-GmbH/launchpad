import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { WorkflowDefinition, type RepositoryWorkflow } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import * as Workflows from "../jobs/Workflows.ts";
import { validateWorkflowTarget } from "../jobs/WorkflowTarget.ts";
import { layer as machinesLayer } from "../machines/Machines.ts";
import { layer as repositoriesLayer } from "../tenancy/Repositories.ts";
import {
  OrganizationProjectCatalog,
  layer as catalogLayer,
} from "../projects/OrganizationProjectCatalog.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { databaseUrl, withDatabase, transport } from "../workflowSources/test-fixture.ts";
import {
  configured,
  seed,
  definition,
  trigger,
  clock,
  issue,
  receive,
  counts,
} from "./test-fixture.ts";
import { prepare } from "./Preparation.ts";
import * as Routing from "./Routing.ts";
import * as Fence from "./Fence.ts";
import * as Store from "../workflowSources/Store.ts";
if (!databaseUrl) throw new Error("Legacy Save tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");
const decodeDefinition = Schema.decodeEffect(WorkflowDefinition);
const push = { kind: "action", id: "push", title: "Push", action: "push" } as const;
const openPr = { kind: "action", id: "pr", title: "Open PR", action: "open_pull_request" } as const;
const result = {
  accepted: false,
  threadId: null,
  workflowResult: {
    protocol: 8,
    outcome: "missing",
    detail: null,
    progress: null,
    actions: ["push", "open_pull_request"],
  },
} as const;
const target = Layer.mergeAll(machinesLayer, repositoriesLayer, catalogLayer);
const metadata = transport(() =>
  Response.json({
    data: { organization: { id: "workspace" }, team: { id: "team", archivedAt: null } },
  }),
);
const testDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withDatabase(
    configured(
      effect.pipe(
        Effect.provide([
          target,
          metadata,
          Layer.mock(EnvironmentConnector)({ dispatchJob: () => Effect.succeed(result) }),
        ]),
      ),
    ),
  );
const enable = Effect.fn(function* (next = definition) {
  const store = yield* Workflows.make;
  const input = {
    workflowId: "flow",
    expectedRevision: 0,
    definition: next,
    archived: false,
    automation: { enabled: true, trigger },
  };
  const proof = yield* prepare("org", "repo", "maintainer", input, null);
  const saved = yield* store.save("org", "repo", input, proof);
  const sql = (yield* RelayDb).$client;
  yield* sql`UPDATE relay_repository_workflows SET effective_after=${Store.iso((yield* clock) - 5000)} WHERE workflow_id='flow'`;
  return saved;
});
// Reproduce the old relay API's read-only preflight and store's complete record replacement.
const legacySave = Effect.fn(function* (previous: RepositoryWorkflow, next: WorkflowDefinition) {
  yield* decodeDefinition(next);
  yield* validateWorkflowTarget("org", "repo", next);
  const record = {
    workflowId: previous.workflowId,
    organizationId: previous.organizationId,
    repositoryId: previous.repositoryId,
    revision: previous.revision + 1,
    definition: next,
    archived: previous.archived,
    createdAt: previous.createdAt,
    updatedAt: yield* Fence.timestamp,
  };
  const sql = (yield* RelayDb).$client;
  yield* sql`UPDATE relay_repository_workflows SET revision=${record.revision},record=${sql.json(record)} WHERE workflow_id=${previous.workflowId} AND revision=${previous.revision}`;
  return (yield* (yield* Workflows.make).get(previous.workflowId))!;
});
const ordered = Effect.fn(function* <A, E, R, B, F, S>(
  first: Effect.Effect<A, E, R>,
  second: Effect.Effect<B, F, S>,
) {
  const sql = (yield* RelayDb).$client;
  const ready = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const writer = yield* sql
    .withTransaction(
      first.pipe(
        Effect.tap(() => Deferred.succeed(ready, undefined)),
        Effect.tap(() => Deferred.await(release)),
      ),
    )
    .pipe(Effect.forkChild);
  yield* Deferred.await(ready);
  const contender = yield* second.pipe(Effect.forkChild);
  yield* Deferred.succeed(release, undefined);
  yield* Fiber.join(writer);
  yield* Fiber.join(contender);
});
const project = {
  projectId: definition.projectId,
  title: "Repository",
  repositoryCanonicalKey: "github.com/example/repository",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("legacy workflow Save compatibility (PostgreSQL)", () => {
  it.live.each(["environment", "project", "add-action", "remove-action"])(
    "disables automation and clears validation on legacy %s changes",
    (change) =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const saved = yield* enable(
            change === "remove-action"
              ? { ...definition, steps: [...definition.steps, push] }
              : definition,
          );
          const before = (yield* Routing.read("flow"))!;
          const sql = (yield* RelayDb).$client;
          let next = definition;
          if (change === "environment") {
            yield* sql`INSERT INTO relay_machines(machine_id,organization_id,role,label,compute_kind,seed_hash,seed_expires_at,environment_id,environment_public_key,created_by_user_id,enrolled_at,created_at,updated_at)
        SELECT 'other-machine',organization_id,role,label,compute_kind,'other-seed',seed_expires_at,'other-environment','other-public',created_by_user_id,enrolled_at,created_at,updated_at FROM relay_machines WHERE machine_id='machine'`;
            yield* (yield* OrganizationProjectCatalog).replace({
              organizationId: "org",
              machineId: "other-machine",
              environmentId: "other-environment",
              revision: 1,
              projects: [project],
            });
            next = { ...definition, environmentId: EnvironmentId.make("other-environment") };
          } else if (change === "project") {
            yield* (yield* OrganizationProjectCatalog).replace({
              organizationId: "org",
              machineId: "machine",
              environmentId: "environment",
              revision: 2,
              projects: [project, { ...project, projectId: ProjectId.make("other-project") }],
            });
            next = { ...definition, projectId: ProjectId.make("other-project") };
          } else if (change === "add-action")
            next = { ...definition, steps: [...definition.steps, push] };
          const updated = yield* legacySave(saved, next);
          expect(updated.definition).toEqual(next);
          expect(updated.automation).toEqual({ enabled: false, trigger });
          const row = (yield* Routing.read("flow"))!;
          expect(row.target_capability).toBeNull();
          expect(row.routing_generation).toBe(before.routing_generation);
          expect(row.effective_after).toBe(before.effective_after);
          expect((yield* receive(issue(yield* clock))).status).toBe(200);
          expect(yield* counts).toEqual({ occurrences: 1, jobs: 0, admissions: 0 });
        }),
      ),
  );

  it.live("preserves automation and its proof for a legacy rename and agent edit", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const saved = yield* enable();
        const before = (yield* Routing.read("flow"))!;
        const updated = yield* legacySave(saved, {
          ...definition,
          name: "Renamed",
          steps: definition.steps.map((step) =>
            step.kind === "agent" ? { ...step, instruction: "New instructions" } : step,
          ),
        });
        expect(updated.automation).toEqual(saved.automation);
        expect((yield* Routing.read("flow"))?.target_capability).toEqual(before.target_capability);
        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        expect((yield* counts).jobs).toBe(1);
      }),
    ),
  );

  it.live("treats publishing actions as a set for legacy ordering and duplicates", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const saved = yield* enable({
          ...definition,
          steps: [...definition.steps, push, openPr, { ...push, id: "push-again" }],
        });
        const before = (yield* Routing.read("flow"))!;
        const updated = yield* legacySave(saved, {
          ...definition,
          steps: [
            ...definition.steps,
            { ...push, id: "push-again", title: "Push again" },
            push,
            openPr,
          ],
        });
        expect(updated.automation?.enabled).toBe(true);
        expect((yield* Routing.read("flow"))?.target_capability).toEqual(before.target_capability);
        expect((yield* receive(issue(yield* clock))).status).toBe(200);
        expect((yield* counts).jobs).toBe(1);
      }),
    ),
  );

  it.live("requires fresh action validation before re-enabling after a legacy edit", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const saved = yield* enable();
        const before = (yield* Routing.read("flow"))!;
        const disabled = yield* legacySave(saved, {
          ...definition,
          steps: [...definition.steps, push],
        });
        expect(disabled.automation?.enabled).toBe(false);
        const input = {
          workflowId: "flow",
          expectedRevision: disabled.revision,
          definition: disabled.definition,
          archived: false,
          automation: { enabled: true, trigger },
        };
        let probes = 0;
        const unsupported = Layer.mock(EnvironmentConnector)({
          dispatchJob: () =>
            Effect.sync(() => {
              probes++;
              return { ...result, workflowResult: { ...result.workflowResult, actions: [] } };
            }),
        });
        expect(
          yield* prepare("org", "repo", "maintainer", input, disabled).pipe(
            Effect.provide(unsupported),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "WorkflowInvalidError" });
        expect(probes).toBe(1);
        expect((yield* Routing.read("flow"))?.record.automation?.enabled).toBe(false);
        const proof = yield* prepare("org", "repo", "maintainer", input, disabled);
        const enabled = yield* (yield* Workflows.make).save("org", "repo", input, proof);
        expect(enabled.automation?.enabled).toBe(true);
        expect((yield* Routing.read("flow"))?.routing_generation).toBe(
          before.routing_generation + 1,
        );
        expect((yield* Routing.read("flow"))?.target_capability).toEqual(proof.proof);
      }),
    ),
  );

  for (const admissionFirst of [false, true])
    it.live(
      `preserves admitted jobs when ${admissionFirst ? "admission" : "legacy Save"} wins`,
      () =>
        testDb(
          Effect.gen(function* () {
            yield* seed;
            const saved = yield* enable();
            const payload = issue(yield* clock);
            const sql = (yield* RelayDb).$client;
            const edit = legacySave(saved, { ...definition, steps: [...definition.steps, push] });
            if (admissionFirst) yield* ordered(receive(payload), edit);
            else yield* ordered(edit, receive(payload));
            expect((yield* Routing.read("flow"))?.record.automation?.enabled).toBe(false);
            expect((yield* receive(issue(payload.webhookTimestamp + 1))).status).toBe(200);
            const jobs = yield* sql<{
              record: { environmentId: string; workflow: unknown };
            }>`SELECT record FROM relay_workflow_jobs`;
            expect(jobs).toHaveLength(admissionFirst ? 1 : 0);
            for (const job of jobs)
              expect(job.record).toMatchObject({
                environmentId: definition.environmentId,
                workflow: null,
              });
          }),
        ),
    );
});
