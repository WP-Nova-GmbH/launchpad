import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Deferred, Effect, Fiber, FileSystem, Layer, Redacted, Schema } from "effect";
import * as NodeCrypto from "node:crypto";
import {
  RelayClientPrincipal,
  RelayEnvironmentPrincipal,
  RelayRepositoryId,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WORKFLOW_PROTOCOL, type WorkflowJobProgress } from "@t3tools/contracts/workflows";
import { RelayDb, RelayTransactions } from "../db.ts";
import {
  EnvironmentConnector,
  EnvironmentMintRequestFailed,
} from "../environments/EnvironmentConnector.ts";
import {
  authorizeWorkflowRepository,
  refreshWorkflowJobForClient,
  respondToWorkflowJob,
} from "../http/WorkflowsApi.ts";
import { readThreadVmReviewSecrets } from "../http/ThreadEnvironmentApi.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { layer as repositories } from "../tenancy/Repositories.ts";
import { RelaySecretBox, layer as secretBox } from "../auth/SecretBox.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { makeThreadVmCapacityStore } from "../threads/ThreadVmCapacityStore.ts";
import { makeThreadVmProvisionStore } from "../threads/ThreadVmProvisionStore.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { configLayer } from "../workflowSources/test-fixture.ts";
import { updateRepositoryWorkflowConfiguration } from "./RepositoryWorkflowConfiguration.ts";
import {
  resolveWorkflowRunSetupConfiguration,
  resolveWorkflowRunAttemptConfiguration,
  withFrozenWorkflowRunConfiguration,
  type WorkflowRunSetupClaim,
} from "./WorkflowRunConfiguration.ts";
import { readWorkflowVmBinding, requireWorkflowVmViewer } from "./WorkflowVmBinding.ts";
import { refreshWorkflowJob } from "./WorkflowDispatcher.ts";
import { advanceWorkflowVmPreparation } from "./WorkflowVmPreparation.ts";
import { layer as workflows, Workflows } from "./Workflows.ts";

const databaseUrl = process.env.LAUNCHPAD_WORKFLOW_RUN_CONFIG_TEST_DATABASE_URL;
const database = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/u.test(new URL(databaseUrl).pathname))
      return yield* Effect.die("Use a disposable launchpad_vm_test_* database");
    const sql = yield* PgClient.PgClient;
    const fs = yield* FileSystem.FileSystem;
    const root = new URL("../../migrations/postgres/", import.meta.url).pathname;
    for (const name of (yield* fs.readDirectory(root)).toSorted()) {
      const source = yield* fs.readFileString(`${root}/${name}/migration.sql`);
      yield* sql.withTransaction(
        Effect.forEach(source.split("--> statement-breakpoint"), (statement) =>
          sql.unsafe(statement),
        ),
      );
    }
  }),
).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl ?? "") })),
);
const services = Layer.merge(database, secretBox.pipe(Layer.provide(configLayer)));

const fixture = Effect.fnUntraced(function* (role: "admin" | "member" = "admin") {
  const sql = yield* PgClient.PgClient;
  const box = yield* RelaySecretBox;
  const organizationId = NodeCrypto.randomUUID();
  const repositoryId = NodeCrypto.randomUUID();
  const userId = NodeCrypto.randomUUID();
  const scope = { organizationId, repositoryId };
  yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at)
    VALUES (${organizationId},'test','2026','2026')`;
  yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
    VALUES (${organizationId},${userId},${role},'2026','2026')`;
  yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at)
    VALUES (${repositoryId},${organizationId},'test','2026','2026')`;
  if (role === "member")
    yield* sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at)
      VALUES (${repositoryId},${organizationId},${userId},'developer','2026','2026')`;
  const write = (
    expectedRevision: number,
    mutation: RelayUpdateRepositoryWorkflowConfiguration["mutation"],
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT repository_id FROM relay_repositories WHERE repository_id=${repositoryId} FOR NO KEY UPDATE`;
        return yield* updateRepositoryWorkflowConfiguration(sql, box, scope, {
          expectedRevision,
          mutation,
        });
      }),
    );
  const queue = Effect.fnUntraced(function* (automatic = false) {
    const jobId = NodeCrypto.randomUUID();
    const threadId = NodeCrypto.randomUUID();
    const workflowJobId = jobId;
    const workflowId = NodeCrypto.randomUUID();
    const operationId = NodeCrypto.randomUUID();
    const identity = { jobId, threadId, ...scope };
    const record = {
      jobId,
      repositoryId,
      workflowId,
      status: "queued",
      instruction: "Implement",
      workflow: null,
      origin: automatic
        ? {
            kind: "automation",
            ...scope,
            workflowId,
            occurrenceId: "event",
            source: {
              provider: "linear",
              applicationId: "app",
              workspaceId: "workspace",
              connectionId: "connection",
              grantId: "grant",
            },
          }
        : { kind: "manual", userId },
      requiredProtocol: 9,
      runtime: null,
      detail: null,
      progress: null,
      createdAt: "2026",
      updatedAt: "2026",
    };
    yield* sql`INSERT INTO relay_workflow_jobs
      (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
      VALUES (${jobId},${repositoryId},${organizationId},${automatic ? null : userId},'queued',${sql.json(record)},0,'2026','2026')`;
    const accept = sql`UPDATE relay_workflow_jobs SET status='preparing',record=${sql.json({
      ...record,
      status: "preparing",
      runtime: { kind: "vm", threadId },
      workflow: {
        workflowId,
        ...scope,
        revision: 1,
        archived: false,
        createdAt: "2026",
        updatedAt: "2026",
        definition: {
          name: "VM test",
          target: { kind: "vm", baseBranch: null },
          steps: [
            {
              kind: "agent",
              id: "implement",
              title: "Implement",
              instruction: "Edit the repository",
              modelSelection: null,
            },
            {
              kind: "review",
              id: "review",
              title: "Review",
              role: "member",
              reworkStepId: "implement",
            },
          ],
        },
      },
    })} WHERE job_id=${jobId}`.pipe(Effect.asVoid);
    const freeze = withFrozenWorkflowRunConfiguration(sql, box, identity, accept);
    const placements = makeThreadPlacementStore(sql);
    const install = Effect.fnUntraced(function* (assigned = true) {
      const allocationId = NodeCrypto.randomUUID();
      const environmentId = NodeCrypto.randomUUID();
      const credentialId = NodeCrypto.randomUUID();
      const computeRef = NodeCrypto.randomUUID();
      const claimId = NodeCrypto.randomUUID();
      const claim: WorkflowRunSetupClaim = {
        ...identity,
        allocationId,
        operationId,
        generation: 1,
        environmentId,
        credentialId,
        computeRef,
        claimId,
      };
      yield* placements.prepareWorkflow({ ...identity, workflowJobId, operationId });
      yield* sql`INSERT INTO relay_thread_vm_allocations
        (allocation_id,thread_id,organization_id,resource_kind,template_id,state,compute_ref,runtime_protocol)
        VALUES (${allocationId},${threadId},${organizationId},'organization_workflow','template','running',${computeRef},'native-v1')`;
      yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase,claim_id,claim_until)
        VALUES (${allocationId},${operationId},1,'created',${claimId},clock_timestamp()+interval '2 minutes')`;
      yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision)
        VALUES (${allocationId},'github.com/test/repo','main',${"a".repeat(40)})`;
      yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
        VALUES (${credentialId},${environmentId},'key',${credentialId},'2026','2026')`;
      yield* sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
        VALUES (${environmentId},${allocationId},${threadId},${repositoryId},1,'key',${credentialId})`;
      yield* sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
        VALUES (${allocationId},${operationId},${credentialId},${environmentId},'key',${credentialId},'test-response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
      const assign = placements.assignWorkflow({ ...claim, workflowJobId });
      if (assigned) yield* assign;
      return { claim, assign };
    });
    return { identity, accept, freeze, install };
  });
  return { sql, box, scope, userId, write, queue };
});

const secret = (value: string) => ({ kind: "setSecret" as const, name: "NPM_TOKEN", value });
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe.skipIf(!databaseUrl)("workflow run configuration (Postgres)", () => {
  it.layer(services)((it) => {
    for (const cancellation of [
      "none",
      "before",
      "after",
      "revoked",
      "racing_before",
      "racing_revoked",
    ] as const) {
      it.effect(`settles a rejected initial VM create with ${cancellation} cancellation`, () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const run = yield* f.queue();
          yield* run.accept;
          const { jobId } = run.identity;
          const threadId = `workflow:${jobId}`;
          const identity = {
            allocationId: jobId,
            operationId: jobId,
            generation: 1,
            threadId,
            resourceKind: "organization_workflow" as const,
          };
          yield* f.sql`UPDATE relay_workflow_jobs SET record=record || ${f.sql.json({
            runtime: { kind: "vm", threadId },
            vmAdmission: { codexConnectionId: "codex", hasSecrets: false },
            startAttempted: false,
          })} WHERE job_id=${jobId}`;
          yield* makeThreadPlacementStore(f.sql).prepareWorkflow({
            ...f.scope,
            threadId,
            workflowJobId: jobId,
            operationId: jobId,
          });
          yield* f.sql`INSERT INTO relay_thread_vm_allocations
            (allocation_id,thread_id,organization_id,resource_kind,template_id,state,runtime_protocol)
            VALUES (${jobId},${threadId},${f.scope.organizationId},'organization_workflow','template','creating','native-v1')`;
          const snapshot = {
            canonicalKey: "github.com/test/repo",
            installationId: "42",
            branch: "main",
            commitSha: "a".repeat(40),
            templateBuildId: "build",
          };
          yield* f.sql`INSERT INTO relay_thread_vm_provisions
            (allocation_id,operation_id,generation,phase,workflow_snapshot)
            VALUES (${jobId},${jobId},1,'creating',${f.sql.json(snapshot)})`;
          yield* f.sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision)
            VALUES (${jobId},${snapshot.canonicalKey},${snapshot.branch},${snapshot.commitSha})`;
          yield* makeThreadVmCapacityStore(f.sql).configure(jobId, 1);
          yield* f.sql`INSERT INTO relay_thread_vm_capacity
            (operation_id,allocation_id,host_id,kind,state)
            VALUES (${jobId},${jobId},${jobId},'create','started')`;
          const cancel = f.sql`UPDATE relay_workflow_jobs SET status='cancelling',
            record=record || '{"status":"cancelling"}',
            pending_control=${f.sql.json({ userId: f.userId, response: { operation: "cancel" } })}
            WHERE job_id=${jobId}`;
          const racing = cancellation === "racing_before" || cancellation === "racing_revoked";
          const revoked = cancellation === "revoked" || cancellation === "racing_revoked";
          const cancelled = cancellation === "before" || cancellation === "racing_before";
          if (cancelled || revoked) yield* cancel;
          const provisions = makeThreadVmProvisionStore(f.sql);
          const marker = cancelled || revoked ? "create_rejected_after_cancel" : "create_rejected";
          const reject = Effect.gen(function* () {
            expect(yield* provisions.rejectCreate(identity)).toBe(true);
            expect((yield* provisions.get(jobId, "organization_workflow"))?.errorCode).toBe(marker);
          });
          if (!racing) yield* reject;
          if (cancellation === "after") {
            yield* cancel;
            expect(yield* provisions.rejectCreate(identity)).toBe(true);
            expect((yield* provisions.get(jobId, "organization_workflow"))?.errorCode).toBe(marker);
          }
          if (revoked)
            yield* f.sql`DELETE FROM relay_organization_members
              WHERE organization_id=${f.scope.organizationId} AND user_id=${f.userId}`;
          yield* Effect.gen(function* () {
            const store = yield* Workflows;
            const advance = Effect.gen(function* () {
              const row = yield* store.claim(jobId);
              expect(row).not.toBeNull();
              if (!row?.leaseUntil) return yield* Effect.die("Expected a workflow lease");
              return yield* advanceWorkflowVmPreparation(row, row.leaseUntil).pipe(
                Effect.ensuring(store.release(jobId, row.leaseUntil).pipe(Effect.orDie)),
              );
            });
            if (racing) {
              const checkedCancellation = yield* Deferred.make<void>();
              const receiptRecorded = yield* Deferred.make<void>();
              const staleAdvance = yield* Effect.forkChild(
                advance.pipe(
                  Effect.provideService(Workflows, {
                    ...store,
                    canSettleVmCancellation: (row) =>
                      store.canSettleVmCancellation(row).pipe(
                        Effect.tap(() => Deferred.succeed(checkedCancellation, undefined)),
                        Effect.tap(() => Deferred.await(receiptRecorded)),
                      ),
                  }),
                ),
              );
              // Preparation has been read, but cancellation has not locked the job yet.
              yield* Deferred.await(checkedCancellation);
              yield* reject;
              const afterReceipt = yield* store.getJob(jobId);
              yield* reject;
              expect((yield* store.getJob(jobId))?.revision).toBe(afterReceipt?.revision);
              yield* Deferred.succeed(receiptRecorded, undefined);
              expect(yield* Fiber.join(staleAdvance)).toMatchObject({ status: "cancelling" });
              expect(yield* store.getJob(jobId)).toMatchObject({
                pendingControl: { userId: f.userId, response: { operation: "cancel" } },
                record: { status: "cancelling" },
              });
            }
            const settled = yield* advance;
            expect(settled).toMatchObject({
              status: cancelled ? "cancelled" : "failed",
              detail: cancelled
                ? "Cancelled before the workflow VM was created."
                : "VM creation was rejected. Check the compute host configuration and start a new run.",
              queueReason: null,
            });
            expect(yield* store.getJob(jobId)).toMatchObject({
              record: settled,
              pendingControl: null,
            });
            if (!cancelled) {
              if (revoked)
                yield* f.sql`INSERT INTO relay_organization_members
                  (organization_id,user_id,role,created_at,updated_at)
                  VALUES (${f.scope.organizationId},${f.userId},'admin','2026','2026')`;
              expect(
                yield* respondToWorkflowJob(
                  { repositoryId: f.scope.repositoryId, jobId },
                  { operation: "cancel" },
                ),
              ).toMatchObject({ status: "failed", detail: settled.detail });
              expect(yield* store.getJob(jobId)).toMatchObject({
                record: settled,
                pendingControl: null,
              });
            }
          }).pipe(
            Effect.provideService(ThreadVmRuntimeConfiguration, { settings: undefined }),
            Effect.provideService(RelayClientPrincipal, { userId: f.userId, token: "admin" }),
            Effect.provide(
              Layer.mergeAll(
                organizations,
                repositories,
                machines,
                catalog,
                workflows,
                Layer.mock(EnvironmentConnector)({}),
                EffectNodeCrypto.layer,
              ).pipe(
                Layer.provideMerge(RelayTransactions.layer),
                Layer.provideMerge(Layer.effect(RelayDb, PgDrizzle.makeWithDefaults())),
              ),
            ),
          );
        }),
      );
    }

    it.effect("keeps the first snapshot across rotation, removal and replay", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(0, { kind: "setVariable", name: "APP_MODE", value: "  test\n" });
        yield* f.write(1, secret("original-canary"));
        const first = yield* f.queue();
        expect(yield* first.freeze).toEqual({ sourceRevision: 2, hasSecrets: true });
        const { claim } = yield* first.install();
        yield* f.write(2, secret("replacement-canary"));
        const second = yield* f.queue(true);
        expect(yield* second.freeze).toEqual({ sourceRevision: 3, hasSecrets: true });
        const next = yield* second.install();
        yield* f.write(3, { kind: "delete", name: "NPM_TOKEN" });
        expect(
          yield* withFrozenWorkflowRunConfiguration(
            f.sql,
            f.box,
            first.identity,
            Effect.die("replay cannot accept again"),
          ),
        ).toEqual({ sourceRevision: 2, hasSecrets: true });
        const resolved = yield* resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim);
        expect(resolved).toMatchObject({ sourceRevision: 2, hasSecrets: true });
        expect(String(resolved.values)).not.toContain("original-canary");
        expect(Redacted.value(resolved.values)).toEqual([
          { kind: "variable", name: "APP_MODE", value: "  test\n" },
          { kind: "secret", name: "NPM_TOKEN", value: "original-canary" },
        ]);
        expect(
          Redacted.value(
            (yield* resolveWorkflowRunSetupConfiguration(f.sql, f.box, next.claim)).values,
          ),
        ).toEqual([
          { kind: "variable", name: "APP_MODE", value: "  test\n" },
          { kind: "secret", name: "NPM_TOKEN", value: "replacement-canary" },
        ]);
        const [stored] = yield* f.sql<{ sealed_payload: string }>`SELECT sealed_payload
          FROM relay_workflow_run_configurations WHERE job_id=${first.identity.jobId}`;
        expect(stored?.sealed_payload).toMatch(/^v1\./u);
        expect(stored?.sealed_payload).not.toContain("original-canary");
        expect(stored?.sealed_payload).not.toContain("APP_MODE");
      }),
    );

    it.effect(
      "keeps an explicit empty snapshot and requires current maintainer access for secrets",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("member");
          const empty = yield* f.queue();
          expect(yield* empty.freeze).toEqual({ sourceRevision: 0, hasSecrets: false });
          const { claim } = yield* empty.install();
          yield* f.write(0, secret("secret-canary"));
          expect(
            Redacted.value(
              (yield* resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim)).values,
            ),
          ).toEqual([]);
          const queued = yield* f.queue();
          expect(yield* Effect.flip(queued.freeze)).toMatchObject({ reason: "not_allowed" });
          expect(
            yield* f.sql`SELECT status FROM relay_workflow_jobs WHERE job_id=${queued.identity.jobId}`,
          ).toEqual([{ status: "queued" }]);
          expect(
            yield* f.sql`SELECT 1 FROM relay_workflow_run_configurations WHERE job_id=${queued.identity.jobId}`,
          ).toHaveLength(0);
          yield* f.sql`UPDATE relay_repository_access SET role='maintainer' WHERE repository_id=${f.scope.repositoryId} AND user_id=${f.userId}`;
          expect(yield* queued.freeze).toEqual({ sourceRevision: 1, hasSecrets: true });
        }),
    );

    it.effect(
      "rolls back a freeze with failed acceptance and rejects missing accepted storage",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const run = yield* f.queue();
          const aborted = withFrozenWorkflowRunConfiguration(
            f.sql,
            f.box,
            run.identity,
            Effect.andThen(run.accept, Effect.fail("lost authority")),
          );
          expect(yield* Effect.flip(aborted)).toMatchObject({ reason: "storage" });
          expect(
            yield* f.sql`SELECT status FROM relay_workflow_jobs WHERE job_id=${run.identity.jobId}`,
          ).toEqual([{ status: "queued" }]);
          expect(
            yield* f.sql`SELECT 1 FROM relay_workflow_run_configurations WHERE job_id=${run.identity.jobId}`,
          ).toHaveLength(0);
          yield* run.accept;
          const { claim } = yield* run.install();
          expect(yield* Effect.flip(run.freeze)).toMatchObject({ reason: "unavailable" });
          expect(
            yield* Effect.flip(resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim)),
          ).toMatchObject({ reason: "unavailable" });
        }),
    );

    it.effect("denies stale claims and mismatched VM authority before opening the payload", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const run = yield* f.queue();
        yield* run.freeze;
        const { claim, assign } = yield* run.install(false);
        const withoutOpening = { ...f.box, open: () => Effect.die("opened before authorization") };
        const reject = (overrides: Partial<WorkflowRunSetupClaim> = {}) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(
                resolveWorkflowRunSetupConfiguration(f.sql, withoutOpening, {
                  ...claim,
                  ...overrides,
                }),
              ),
            ).toMatchObject({ reason: "unavailable" });
          });
        yield* reject();
        yield* assign;
        for (const overrides of [
          { jobId: "different-job" },
          { organizationId: "different-org" },
          { threadId: "different-thread" },
          { repositoryId: "different-repo" },
          { generation: 2 },
          { environmentId: "wrong-environment" },
          { credentialId: "wrong-credential" },
          { claimId: "competing-claim" },
          { computeRef: "wrong-compute" },
        ])
          yield* reject(overrides);
        yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until=clock_timestamp()-interval '1 second' WHERE allocation_id=${claim.allocationId}`;
        yield* reject();
        yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until=clock_timestamp()+interval '2 minutes' WHERE allocation_id=${claim.allocationId}`;
        yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json({ response: { operation: "cancel" } })} WHERE job_id=${claim.jobId}`;
        yield* reject();
        yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=NULL,status='cancelling' WHERE job_id=${claim.jobId}`;
        yield* reject();
        yield* f.sql`UPDATE relay_workflow_jobs SET status='preparing' WHERE job_id=${claim.jobId}`;
        yield* f.sql`UPDATE relay_thread_vm_setups SET phase='ready',environment_id=${claim.environmentId},receipt_sha256=${"a".repeat(64)} WHERE allocation_id=${claim.allocationId}`;
        yield* reject();
        yield* f.sql`UPDATE relay_thread_vm_setups SET phase='pending' WHERE allocation_id=${claim.allocationId}`;
        const replacement = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES (${replacement},${claim.environmentId},'key',${replacement},'2026','2026')`;
        yield* f.sql`UPDATE relay_thread_vm_enrollments SET credential_id=${replacement} WHERE allocation_id=${claim.allocationId}`;
        yield* reject();
        yield* f.sql`UPDATE relay_thread_vm_enrollments SET credential_id=${claim.credentialId} WHERE allocation_id=${claim.allocationId}`;
        yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='2026' WHERE credential_id=${claim.credentialId}`;
        yield* reject();
      }),
    );

    it.effect("rejects ciphertext transplanted from a different workflow job", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.queue();
        const second = yield* f.queue();
        yield* first.freeze;
        yield* second.freeze;
        const { claim } = yield* first.install();
        yield* f.sql`UPDATE relay_workflow_run_configurations SET sealed_payload=(SELECT sealed_payload
          FROM relay_workflow_run_configurations WHERE job_id=${second.identity.jobId}) WHERE job_id=${first.identity.jobId}`;
        expect(
          yield* Effect.flip(resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim)),
        ).toMatchObject({ reason: "unavailable" });
      }),
    );

    it.effect("binds viewer access and frozen values to the exact active VM and attempt", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const viewer = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
          VALUES (${f.scope.organizationId},${viewer},'member','2026','2026')`;
        yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at)
          VALUES (${f.scope.repositoryId},${f.scope.organizationId},${viewer},'developer','2026','2026')`;
        yield* f.write(0, { kind: "setVariable", name: "APP_MODE", value: "test" });
        yield* f.write(1, secret("initial-canary"));
        const run = yield* f.queue();
        yield* run.freeze;
        const { claim } = yield* run.install();
        yield* f.write(2, { kind: "setVariable", name: "APP_MODE", value: "changed" });
        yield* f.write(3, secret("rotated-canary"));
        const {
          jobId,
          organizationId,
          repositoryId,
          threadId,
          allocationId,
          operationId,
          environmentId,
          generation,
        } = claim;
        const expected = {
          jobId,
          organizationId,
          repositoryId,
          allocationId,
          operationId,
          generation,
          threadId: ThreadId.make(threadId),
          environmentId: EnvironmentId.make(environmentId),
          projectId: ProjectId.make(`vm:${threadId}`),
        };
        const snapshot = {
          canonicalKey: "github.com/test/repo",
          installationId: "42",
          branch: "main",
          commitSha: "a".repeat(40),
          templateBuildId: "build",
        };
        yield* f.sql`UPDATE relay_thread_vm_provisions SET workflow_snapshot=${f.sql.json(snapshot)}
          WHERE allocation_id=${allocationId}`;
        yield* f.sql`UPDATE relay_thread_vm_setups SET phase='ready',
          environment_id=${environmentId},receipt_sha256=${"a".repeat(64)}
          WHERE allocation_id=${allocationId}`;
        yield* f.sql`UPDATE relay_workflow_jobs SET record=record || ${f.sql.json({
          vmAdmission: { codexConnectionId: "codex", hasSecrets: true },
          startAttempted: true,
        })}
          WHERE job_id=${jobId}`;
        const resolveBinding = readWorkflowVmBinding(f.sql, expected);
        expect((yield* resolveBinding.pipe(Effect.flip))._tag).toBe("RelayTenancyNotFoundError");
        yield* f.sql`INSERT INTO relay_thread_vm_codex_auth
          (allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id,acknowledged_connection_id)
          VALUES (${allocationId},${environmentId},1,${threadId},${organizationId},'organization','codex','codex')`;
        yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${threadId}`;
        expect(yield* resolveBinding).toMatchObject({ binding: expected, snapshot });
        expect(
          (yield* readWorkflowVmBinding(f.sql, {
            ...expected,
            generation: 2,
          }).pipe(Effect.flip))._tag,
        ).toBe("RelayTenancyNotFoundError");
        yield* requireWorkflowVmViewer(f.sql, expected, viewer);
        const principal = {
          environmentId,
          credentialId: claim.credentialId,
          environmentPublicKey: "key",
          threadVm: {
            threadId: expected.threadId,
            allocationId,
            repositoryId: RelayRepositoryId.make(repositoryId),
            generation,
          },
        };
        const reviewSecrets = (guest = principal, requested = expected) =>
          readThreadVmReviewSecrets(requested).pipe(
            Effect.provideService(RelayEnvironmentPrincipal, guest),
            Effect.provide(Layer.effect(RelayDb, PgDrizzle.makeWithDefaults())),
          );
        expect(Redacted.value(yield* reviewSecrets())).toEqual(["initial-canary"]);
        expect(
          yield* reviewSecrets({ ...principal, credentialId: "other-guest" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
        expect(
          yield* reviewSecrets(principal, { ...expected, jobId: "other-run" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });

        const setupId = `workflow:${jobId}:start`;
        const agentId = `server:prompt-claim:${NodeCrypto.randomUUID()}`;
        const setupAttempt = {
          purpose: "setup" as const,
          attemptId: setupId,
          commandId: setupId,
          stepId: "implement",
          stepGeneration: 0,
        };
        const agentAttempt = {
          ...setupAttempt,
          purpose: "agent" as const,
          attemptId: agentId,
          commandId: agentId,
        };
        const resolve = (attempt: typeof setupAttempt | typeof agentAttempt) =>
          resolveWorkflowRunAttemptConfiguration(f.sql, f.box, expected, attempt);
        for (const attempt of [setupAttempt, setupAttempt, agentAttempt])
          expect(yield* resolve(attempt)).toEqual({
            environment: { APP_MODE: "test", NPM_TOKEN: "initial-canary" },
            hasSecrets: true,
            secretNames: ["NPM_TOKEN"],
          });
        expect(
          yield* resolve({ ...agentAttempt, stepGeneration: 1 }).pipe(Effect.flip),
        ).toMatchObject({ reason: "not_allowed" });
        yield* f.sql`UPDATE relay_workflow_jobs SET pending_control='{"response":{"operation":"cancel"}}'
          WHERE job_id=${jobId}`;
        expect(yield* resolve(setupAttempt).pipe(Effect.flip)).toMatchObject({
          reason: "not_allowed",
        });
        const progress: WorkflowJobProgress = {
          status: "awaiting_review",
          threadId: expected.threadId,
          revision: 1,
          detail: null,
          checkpoint: {
            kind: "review",
            role: "member",
            checkpointId: "review",
            turnId: "turn",
            checkpointRef: "head",
            checkpointTurnCount: 1,
          },
        };
        yield* f.sql`UPDATE relay_workflow_jobs SET status='awaiting_review',pending_control=NULL,
          record=record || ${f.sql.json({ status: "awaiting_review", progress })}
          WHERE job_id=${jobId}`;
        let offline = true;
        let oldProtocol = false;
        let revokeDuringProbe = false;
        let approvals = 0;
        const revokeViewer = f.sql`DELETE FROM relay_repository_access
          WHERE repository_id=${repositoryId} AND user_id=${viewer}`;
        const connector = Layer.mock(EnvironmentConnector)({
          dispatchJob: (input) =>
            Effect.gen(function* () {
              expect(input.workflowVmBinding).toEqual(expected);
              expect(input.repositoryCanonicalKey).toBe(snapshot.canonicalKey);
              expect(input.baseBranch).toBe(snapshot.branch);
              if (offline)
                return yield* new EnvironmentMintRequestFailed({
                  environmentId,
                  operation: "dispatch-job",
                  cause: "Offline fixture",
                });
              if (revokeDuringProbe && input.workflowControl?.operation === "status")
                yield* revokeViewer.pipe(Effect.orDie);
              const approved = input.workflowControl?.operation === "approve";
              if (approved) approvals += 1;
              return {
                accepted: true,
                workflowResult: {
                  protocol: oldProtocol ? 8 : WORKFLOW_PROTOCOL,
                  outcome: "accepted",
                  detail: null,
                  progress: approved
                    ? { ...progress, status: "done", revision: 2, checkpoint: null }
                    : progress,
                },
              };
            }),
        });
        yield* Effect.gen(function* () {
          const scope = { repositoryId, jobId };
          const response = { checkpointId: "review", expectedRevision: 1 };
          expect(
            (yield* respondToWorkflowJob(scope, {
              operation: "request_changes",
              ...response,
              text: "Try again",
            }).pipe(Effect.flip))._tag,
          ).toBe("RelayTenancyForbiddenError");
          expect(
            yield* respondToWorkflowJob(scope, { operation: "approve", ...response }),
          ).toMatchObject({ responsePending: true, pendingResponseOperation: "approve" });
          yield* authorizeWorkflowRepository(repositoryId);
          expect(yield* refreshWorkflowJobForClient(jobId)).toMatchObject({
            status: "awaiting_review",
            detail:
              "Could not reach the workflow VM or confirm its response. Launchpad will retry automatically.",
            progress,
            responsePending: true,
            pendingResponseOperation: "approve",
          });
          expect(approvals).toBe(0);
          offline = false;
          oldProtocol = true;
          yield* authorizeWorkflowRepository(repositoryId);
          expect(yield* refreshWorkflowJobForClient(jobId)).toMatchObject({
            status: "awaiting_review",
            detail: "Update this environment before responding to this workflow.",
            progress,
            responsePending: true,
            pendingResponseOperation: "approve",
          });
          expect(approvals).toBe(0);
          oldProtocol = false;
          revokeDuringProbe = true;
          expect((yield* refreshWorkflowJob(jobId))?.detail).toContain("no longer has permission");
          expect(approvals).toBe(0);
          revokeDuringProbe = false;
          yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at)
            VALUES (${repositoryId},${organizationId},${viewer},'developer','2026','2026')`;
          expect(
            (yield* respondToWorkflowJob(scope, { operation: "approve", ...response })).status,
          ).toBe("done");
          yield* authorizeWorkflowRepository(repositoryId);
          const completed = yield* refreshWorkflowJobForClient(jobId);
          expect(completed).toMatchObject({ status: "done", detail: null, responsePending: false });
          expect(completed).not.toHaveProperty("pendingResponseOperation");
          expect((yield* refreshWorkflowJob(jobId))?.status).toBe("done");
          expect((yield* refreshWorkflowJob(jobId))?.status).toBe("done");
          expect(approvals).toBe(1);
        }).pipe(
          Effect.provideService(RelayClientPrincipal, { userId: viewer, token: "viewer" }),
          Effect.provide(
            Layer.mergeAll(
              organizations,
              repositories,
              machines,
              catalog,
              workflows,
              connector,
              EffectNodeCrypto.layer,
            ).pipe(
              Layer.provideMerge(RelayTransactions.layer),
              Layer.provideMerge(Layer.effect(RelayDb, PgDrizzle.makeWithDefaults())),
            ),
          ),
        );
        expect(Redacted.value(yield* reviewSecrets())).toEqual(["initial-canary"]);
        yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='2026'
          WHERE credential_id=${claim.credentialId}`;
        expect(yield* reviewSecrets().pipe(Effect.flip)).toMatchObject({
          _tag: "RelayTenancyNotFoundError",
        });
        yield* revokeViewer;
        expect(
          (yield* requireWorkflowVmViewer(f.sql, expected, viewer).pipe(Effect.flip))._tag,
        ).toBe("RelayTenancyNotFoundError");
      }),
    );

    it.effect("rejects a sealed entry without a kind or with a conflicting secret marker", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(0, secret("secret-canary"));
        const run = yield* f.queue();
        yield* run.freeze;
        const { claim } = yield* run.install();
        const entry = { name: "NPM_TOKEN", value: "secret-canary" };
        for (const { values, reason } of [
          { values: [entry], reason: "storage" },
          { values: [{ ...entry, kind: "variable" }], reason: "unavailable" },
        ]) {
          const payload = yield* encodePayload({
            purpose: "workflow-run-configuration-v1",
            ...run.identity,
            sourceRevision: 1,
            hasSecrets: true,
            values,
          });
          const sealed = yield* f.box.seal(payload);
          yield* f.sql`UPDATE relay_workflow_run_configurations SET sealed_payload=${sealed}
            WHERE job_id=${run.identity.jobId}`;
          expect(
            yield* Effect.flip(resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim)),
          ).toMatchObject({ reason });
        }
      }),
    );

    it.effect(
      "orders resolution against repository removal without deleting the frozen snapshot",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.write(0, secret("removal-canary"));
          const run = yield* f.queue();
          yield* run.freeze;
          const { claim } = yield* run.install();
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const pausedBox = {
            ...f.box,
            open: (sealed: string) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(f.box.open(sealed)),
              ),
          };
          const opening = yield* Effect.forkChild(
            resolveWorkflowRunSetupConfiguration(f.sql, pausedBox, claim),
          );
          yield* Deferred.await(entered);
          const locked = yield* Effect.exit(f.sql`SELECT repository_id FROM relay_repositories
          WHERE repository_id=${f.scope.repositoryId} FOR UPDATE NOWAIT`);
          yield* Deferred.succeed(resume, undefined);
          expect(locked._tag).toBe("Failure");
          expect(Redacted.value((yield* Fiber.join(opening)).values)).toEqual([
            { kind: "secret", name: "NPM_TOKEN", value: "removal-canary" },
          ]);
          yield* f.sql`DELETE FROM relay_repositories WHERE repository_id=${f.scope.repositoryId}`;
          expect(
            yield* f.sql`SELECT 1 FROM relay_repository_workflow_configurations WHERE repository_id=${f.scope.repositoryId}`,
          ).toHaveLength(0);
          expect(
            yield* f.sql`SELECT has_secrets FROM relay_workflow_run_configurations WHERE job_id=${claim.jobId}`,
          ).toEqual([{ has_secrets: true }]);
          expect(
            yield* Effect.flip(resolveWorkflowRunSetupConfiguration(f.sql, f.box, claim)),
          ).toMatchObject({ reason: "unavailable" });
        }),
    );
  });
});
