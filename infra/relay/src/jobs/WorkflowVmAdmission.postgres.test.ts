import { describe, expect, it } from "@effect/vitest";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Statement from "effect/unstable/sql/Statement";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import {
  respondToWorkflowJob,
  runRepositoryWorkflow,
  saveRepositoryWorkflow,
} from "../http/WorkflowsApi.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import { GithubApp, GithubRequestFailed } from "../tenancy/GithubApp.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { Repositories, layer as repositories } from "../tenancy/Repositories.ts";
import { makeThreadVmPolicyStore } from "../threads/ThreadVmPolicy.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { definition, seed } from "../workflowEvents/test-fixture.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import { refreshWorkflowJob } from "./WorkflowDispatcher.ts";
import { Workflows, layer as workflows } from "./Workflows.ts";

const request = {
  workflowId: "vm",
  expectedTargetKind: "vm",
  instruction: "Implement the issue.",
  requestId: "fixture-submission",
} as const;
const withPrincipal = (userId: string) =>
  Effect.provideService(RelayClientPrincipal, { userId, token: "fixture" });

const setup = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  const fs = yield* FileSystem.FileSystem;
  for (const name of [
    "20260819121924_amused_blue_blade",
    "20261028130056_codex_vm_connections",
    "20261103125456_workflow_run_configuration",
  ]) {
    const path = new URL(`../../migrations/postgres/${name}/migration.sql`, import.meta.url)
      .pathname;
    const migration = yield* fs.readFileString(path);
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) yield* sql.unsafe(statement);
    }
  }
  yield* seed;
  yield* sql`CREATE TABLE relay_thread_vm_policies (
    organization_id text PRIMARY KEY,
    workflow_policy_revision integer NOT NULL DEFAULT 1,
    max_running_workflow_vms integer NOT NULL DEFAULT 10
  )`;
  // This admission fixture omits the native VM migration chain. The queued Cancel
  // path can retire an unused preparation, so provide its four empty lookup tables.
  yield* sql`CREATE TABLE relay_thread_placements (
    thread_id text PRIMARY KEY, workflow_job_id text, organization_id text,
    repository_id text, environment_id text
  )`;
  yield* sql`CREATE TABLE relay_thread_vm_allocations (
    allocation_id text PRIMARY KEY, thread_id text, resource_kind text,
    state text, compute_ref text, deleted_at text
  )`;
  yield* sql`CREATE TABLE relay_thread_vm_provisions (allocation_id text PRIMARY KEY)`;
  yield* sql`CREATE TABLE relay_thread_vm_capacity (
    operation_id text PRIMARY KEY, allocation_id text, state text
  )`;
  yield* sql`
    INSERT INTO relay_github_installations VALUES ('org','42','example','Organization','owner','2026','2026')
  `;
  yield* sql`
    INSERT INTO relay_codex_vm_connections
      (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
    VALUES ('org','codex','issuer','subject','client','connected','sealed','2099-01-01','2026')
  `;
  yield* saveRepositoryWorkflow("repo", {
    workflowId: request.workflowId,
    expectedRevision: 0,
    definition: { ...definition, target: { kind: "vm", baseBranch: null } },
    archived: false,
  }).pipe(withPrincipal("maintainer"));
});

const testAdmission = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  withDatabase(
    setup.pipe(
      Effect.andThen(program),
      Effect.provide([
        workflows,
        organizations,
        repositories,
        machines,
        catalog,
        Layer.mock(EnvironmentConnector)({
          dispatchJob: () => Effect.die("Queued VM admission must not dispatch to a Machine"),
        }),
        Layer.mock(GithubApp)({
          resolveRepositoryBranch: () =>
            Effect.succeed({ branch: "main", commitSha: "a".repeat(40) }),
        }),
      ]),
      Effect.provideService(ThreadVmRuntimeConfiguration, {
        settings: {
          compute: {
            apiUrl: "https://compute.test",
            sandboxUrl: "https://sandbox.test",
            apiKey: Redacted.make("fixture"),
            templateId: "runner:fixture",
            hostAddresses: ["192.0.2.10"],
            timeoutMs: 600_000,
          },
          templateBuildId: "fixture",
          workflowExecutionEnabled: true,
          workflowModelCatalog: { defaultModel: "fixture-model", models: [] },
          hostId: "host",
          maxRunningVms: 1,
          publicRelayUrl: "https://relay.test",
          autoPauseEnabled: false,
          autoBackupEnabled: false,
          autoDeleteEnabled: false,
          replacementEnabled: false,
          restoreEnabled: false,
          resetEnabled: false,
        },
      }),
      withPrincipal("reader"),
    ),
  );

const setWorkflowVmLimit = Effect.fnUntraced(function* (maxRunningVms: number) {
  const policy = makeThreadVmPolicyStore((yield* RelayDb).$client);
  const current = yield* policy.getWorkflow("org");
  yield* policy.updateWorkflow({ ...current, maxRunningVms });
});

const pauseGithubProbe = Effect.fnUntraced(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const stalled = runRepositoryWorkflow("repo", request).pipe(
    Effect.provide(
      Layer.mock(GithubApp)({
        resolveRepositoryBranch: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ branch: "main", commitSha: "a".repeat(40) }),
          ),
      }),
    ),
  );
  return { entered, release, stalled };
});

describe.skipIf(!databaseUrl)("manual VM admission (PostgreSQL)", () => {
  it.live("admits one queued job and replays it after the gate or prerequisites change", () =>
    testAdmission(
      Effect.gen(function* () {
        const run = runRepositoryWorkflow("repo", request);
        const [first, second] = yield* Effect.all([run, run], { concurrency: 2 });
        expect(first.jobId).toBe(second.jobId);
        expect(first).toMatchObject({
          status: "queued",
          runtime: null,
          vmAdmission: { codexConnectionId: "codex", hasSecrets: false },
        });
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_codex_vm_connections SET status='disconnected' WHERE organization_id='org'`;
        yield* sql`INSERT INTO relay_repository_workflow_configurations VALUES
          ('repo',1,'[{"kind":"secret","name":"NPM_TOKEN","sealed":"fixture","bytes":7}]'::jsonb)`;
        yield* setWorkflowVmLimit(0);
        const gateOff = Effect.provideService(ThreadVmRuntimeConfiguration, {
          settings: undefined,
        });
        const replay = yield* runRepositoryWorkflow("repo", { ...request, replayOnly: true }).pipe(
          gateOff,
        );
        expect(replay.jobId).toBe(first.jobId);
        const conflict = yield* runRepositoryWorkflow("repo", {
          ...request,
          instruction: "Different instruction",
        }).pipe(gateOff, Effect.flip);
        expect(conflict._tag).toBe("WorkflowConflictError");
        expect(yield* (yield* Workflows).listJobs("repo")).toHaveLength(1);
      }),
    ),
  );

  it.live("leaves failed prerequisites and unresolved receipt lookups jobless", () =>
    testAdmission(
      Effect.gen(function* () {
        const lookup = yield* runRepositoryWorkflow("repo", { ...request, replayOnly: true }).pipe(
          Effect.flip,
        );
        expect(lookup._tag).toBe("WorkflowSubmissionPendingError");
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_codex_vm_connections SET status='disconnected' WHERE organization_id='org'`;
        const rejected = yield* runRepositoryWorkflow("repo", request).pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: expect.stringContaining("Connect Codex"),
        });
        expect(yield* (yield* Workflows).listJobs("repo")).toHaveLength(0);
      }),
    ),
  );

  it.live("returns the accepted receipt when a concurrent preflight fails", () =>
    testAdmission(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const stalled = yield* runRepositoryWorkflow("repo", request).pipe(
          Effect.provide(
            Layer.mock(GithubApp)({
              resolveRepositoryBranch: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    new GithubRequestFailed({
                      operation: "read-branch",
                      status: 404,
                      cause: "fixture",
                    }),
                  ),
                ),
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const winner = yield* runRepositoryWorkflow("repo", request);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(stalled)).jobId).toBe(winner.jobId);
        expect(yield* (yield* Workflows).listJobs("repo")).toHaveLength(1);
      }),
    ),
  );

  it.live("does not replay a concurrent receipt after repository access is revoked", () =>
    testAdmission(
      Effect.gen(function* () {
        const { entered, release, stalled } = yield* pauseGithubProbe();
        const waiting = yield* stalled.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        const accepted = yield* runRepositoryWorkflow("repo", request);
        const sql = (yield* RelayDb).$client;
        yield* sql`DELETE FROM relay_repository_access WHERE repository_id='repo' AND user_id='reader'`;
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(waiting))._tag).toBe("RelayTenancyNotFoundError");
        expect((yield* (yield* Workflows).listJobs("repo")).map(({ jobId }) => jobId)).toEqual([
          accepted.jobId,
        ]);
      }),
    ),
  );

  it.live("rejects a zero limit before GitHub and after an in-flight preflight", () =>
    testAdmission(
      Effect.gen(function* () {
        const { entered, release, stalled } = yield* pauseGithubProbe();
        const waiting = yield* stalled.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* setWorkflowVmLimit(0);
        yield* Deferred.succeed(release, undefined);
        const disabled = {
          _tag: "WorkflowInvalidError",
          message: expect.stringContaining("Workflow VMs are disabled"),
        };
        expect(yield* Fiber.join(waiting)).toMatchObject(disabled);
        expect(
          yield* runRepositoryWorkflow("repo", request).pipe(
            Effect.provide(
              Layer.mock(GithubApp)({
                resolveRepositoryBranch: () => Effect.die("Disabled limit must skip GitHub"),
              }),
            ),
            Effect.flip,
          ),
        ).toMatchObject(disabled);
        expect(yield* (yield* Workflows).listJobs("repo")).toHaveLength(0);
        yield* setWorkflowVmLimit(1);
        expect(yield* runRepositoryWorkflow("repo", request)).toMatchObject({ status: "queued" });
      }),
    ),
  );

  it.live("does not admit an alias that became ambiguous during GitHub preflight", () =>
    testAdmission(
      Effect.gen(function* () {
        const { entered, release, stalled } = yield* pauseGithubProbe();
        const waiting = yield* stalled.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* (yield* Repositories).addAlias({
          organizationId: "org",
          repositoryId: "repo",
          canonicalKey: "github.com/example/another-repository",
        });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(waiting))._tag).toBe("WorkflowInvalidError");
        expect(yield* (yield* Workflows).listJobs("repo")).toHaveLength(0);
      }),
    ),
  );

  for (const actor of ["reader", "admin"] as const) {
    it.live(`holds the ${actor}'s current authority at the queued cancellation write`, () =>
      testAdmission(
        Effect.gen(function* () {
          const queued = yield* runRepositoryWorkflow("repo", request);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const cancellation = yield* respondToWorkflowJob(
            { repositoryId: "repo", jobId: queued.jobId },
            { operation: "cancel" },
          ).pipe(
            withPrincipal(actor),
            Effect.provideService(Statement.CurrentTransformer, (statement) => {
              const [query, values] = statement.compile();
              return query.startsWith('update "relay_workflow_jobs"') &&
                values.includes("cancelled")
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(statement),
                  )
                : Effect.succeed(statement);
            }),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          const sql = (yield* RelayDb).$client;
          const probes = [
            sql`SELECT 1 FROM relay_organization_members
              WHERE organization_id='org' AND user_id=${actor} FOR UPDATE NOWAIT`,
            sql`SELECT 1 FROM relay_repositories
              WHERE organization_id='org' AND repository_id='repo' FOR NO KEY UPDATE NOWAIT`,
          ];
          if (actor === "reader")
            probes.push(sql`SELECT 1 FROM relay_repository_access
              WHERE repository_id='repo' AND user_id=${actor} FOR UPDATE NOWAIT`);
          try {
            for (const probe of probes) {
              expect(yield* Effect.flip(probe)).toMatchObject({
                _tag: "SqlError",
                reason: { _tag: "LockTimeoutError" },
              });
            }
          } finally {
            yield* Deferred.succeed(release, undefined);
          }
          expect((yield* Fiber.join(cancellation)).status).toBe("cancelled");
        }),
      ),
    );
  }

  it.live("withdraws a revoked queued cancellation and lets a maintainer cancel the run", () =>
    testAdmission(
      Effect.gen(function* () {
        const queued = yield* runRepositoryWorkflow("repo", request);
        const store = yield* Workflows;
        const row = (yield* store.getJob(queued.jobId))!;
        yield* store.updateJob(
          row,
          { ...row.record, status: "cancelling" },
          { userId: "reader", response: { operation: "cancel" } },
        );
        const sql = (yield* RelayDb).$client;
        yield* sql`DELETE FROM relay_repository_access WHERE repository_id='repo' AND user_id='reader'`;
        expect(yield* refreshWorkflowJob(queued.jobId)).toMatchObject({
          status: "queued",
          detail: expect.stringContaining("no longer has permission"),
        });
        expect((yield* store.getJob(queued.jobId))?.pendingControl).toBeNull();

        const cancelled = yield* respondToWorkflowJob(
          { repositoryId: "repo", jobId: queued.jobId },
          { operation: "cancel" },
        ).pipe(withPrincipal("maintainer"));
        expect(cancelled.status).toBe("cancelled");
      }),
    ),
  );

  it.live(
    "allows the developer to cancel their admitted secret-free run after secrets are added",
    () =>
      testAdmission(
        Effect.gen(function* () {
          const queued = yield* runRepositoryWorkflow("repo", request);
          const sql = (yield* RelayDb).$client;
          const threadId = `workflow:${queued.jobId}`;
          yield* sql`INSERT INTO relay_thread_placements VALUES (${threadId},${queued.jobId},'org','repo',NULL)`;
          yield* sql`INSERT INTO relay_thread_vm_allocations VALUES
            (${queued.jobId},${threadId},'organization_workflow','creating',NULL,NULL)`;
          yield* sql`INSERT INTO relay_thread_vm_capacity VALUES (${queued.jobId},${queued.jobId},'waiting')`;
          yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role)
          VALUES ('org','another-developer','member')`;
          yield* sql`INSERT INTO relay_repository_access(repository_id,user_id,organization_id,role)
          VALUES ('repo','another-developer','org','developer')`;
          const cancel = respondToWorkflowJob(
            { repositoryId: "repo", jobId: queued.jobId },
            { operation: "cancel" },
          );
          const other = yield* cancel.pipe(withPrincipal("another-developer"), Effect.flip);
          expect(other._tag).toBe("RelayTenancyForbiddenError");
          yield* sql`
          INSERT INTO relay_repository_workflow_configurations VALUES
            ('repo',1,'[{"kind":"secret","name":"NPM_TOKEN","sealed":"fixture","bytes":7}]'::jsonb)
        `;
          const denied = yield* runRepositoryWorkflow("repo", {
            ...request,
            requestId: "another-run",
          }).pipe(Effect.flip);
          expect(denied._tag).toBe("RelayTenancyForbiddenError");
          const result = yield* cancel;
          expect(result.status).toBe("cancelled");
          expect(
            yield* sql`SELECT state FROM relay_thread_vm_allocations WHERE allocation_id=${queued.jobId}`,
          ).toEqual([{ state: "deleted" }]);
          expect(
            yield* sql`SELECT state FROM relay_thread_vm_capacity WHERE operation_id=${queued.jobId}`,
          ).toEqual([{ state: "released" }]);
        }),
      ),
  );
});
