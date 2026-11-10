import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RelayEnvironmentPrincipal, RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Redacted } from "effect";
import type { SandboxInfo } from "e2b";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "node:crypto";
import * as Stream from "effect/Stream";
import { uploadPortableThreadArtifact } from "../http/ThreadArtifactsApi.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeLocalThreadArtifactObjects } from "./ThreadArtifactLocalObjects.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadVmActivityWorker } from "./ThreadVmActivityWorker.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmCancelledSetupCleanupWorker } from "./ThreadVmCancelledSetupCleanupWorker.ts";
import { makeThreadVmServerWorker } from "./ThreadVmServerWorker.ts";
import { makeThreadVmSetupStore } from "./ThreadVmSetupStore.ts";
import { makeThreadVmSetupWorker } from "./ThreadVmSetupWorker.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmPolicyStore } from "./ThreadVmPolicy.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { advanceWorkflowVmPreparation } from "../jobs/WorkflowVmPreparation.ts";
import type { WorkflowResultSaving } from "@t3tools/contracts/workflows";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { Machines } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { WorkflowVmPreparation } from "../jobs/WorkflowVmPreparation.ts";
import { deliverPendingWorkflowJobs } from "../jobs/WorkflowDispatcher.ts";
import { WorkflowWake } from "../jobs/WorkflowWake.ts";
import { refreshWorkflowJobForClient, respondToWorkflowJob } from "../http/WorkflowsApi.ts";
import { Workflows, type WorkflowDispatchScope, layer as workflows } from "../jobs/Workflows.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import {
  admitPortableThreadWork,
  completePortableThreadWork,
} from "../http/ThreadEnvironmentApi.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const database = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
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

const seed = Effect.fnUntraced(function* (input: {
  hostId: string;
  organizationId?: string;
  personal?: boolean;
  automatic?: boolean;
  kind?: "create" | "resume";
}) {
  const sql = yield* PgClient.PgClient;
  const organizationId = input.organizationId ?? NodeCrypto.randomUUID();
  const repositoryId = NodeCrypto.randomUUID();
  const workflowJobId = NodeCrypto.randomUUID();
  const threadId = input.personal ? NodeCrypto.randomUUID() : `workflow:${workflowJobId}`;
  const allocationId = NodeCrypto.randomUUID();
  const operationId = NodeCrypto.randomUUID();
  const ownerUserId = NodeCrypto.randomUUID();
  const placements = makeThreadPlacementStore(sql);
  const capacity = makeThreadVmCapacityStore(sql);
  yield* capacity.configure(input.hostId, 100);
  if (input.personal) {
    yield* placements.enroll({
      threadId,
      organizationId,
      repositoryId,
      ownerUserId,
      environmentId: NodeCrypto.randomUUID(),
      projectId: NodeCrypto.randomUUID(),
    });
  } else {
    const workflow = {
      workflowId: NodeCrypto.randomUUID(),
      organizationId,
      repositoryId,
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
            id: "agent",
            title: "Implement",
            instruction: "Implement",
            modelSelection: null,
          },
        ],
      },
    };
    const record = {
      jobId: workflowJobId,
      workflowId: workflow.workflowId,
      repositoryId,
      runtime: { kind: "vm", threadId },
      origin: input.automatic
        ? {
            kind: "automation",
            organizationId,
            repositoryId,
            workflowId: workflow.workflowId,
            occurrenceId: NodeCrypto.randomUUID(),
            source: {
              provider: "linear",
              applicationId: "app",
              workspaceId: "workspace",
              connectionId: NodeCrypto.randomUUID(),
              grantId: "grant",
            },
          }
        : { kind: "manual", userId: ownerUserId },
      requiredProtocol: 9,
      instruction: "Implement",
      status: "preparing",
      detail: null,
      workflow,
      progress: null,
      createdAt: "2026",
      updatedAt: "2026",
    };
    yield* sql`INSERT INTO relay_workflow_jobs
      (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
      VALUES(${workflowJobId},${repositoryId},${organizationId},${input.automatic ? null : ownerUserId},'preparing',${sql.json(record)},0,'2026','2026')`;
    yield* placements.prepareWorkflow({
      threadId,
      workflowJobId,
      organizationId,
      repositoryId,
      operationId,
    });
  }
  const kind = input.kind ?? "create";
  const computeRef = kind === "resume" ? NodeCrypto.randomUUID() : null;
  yield* sql`INSERT INTO relay_thread_vm_allocations
    (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state,compute_ref,runtime_protocol)
    VALUES(${allocationId},${threadId},${organizationId},${input.personal ? "personal" : "organization_workflow"},
      ${input.personal ? ownerUserId : null},'template',${kind === "resume" ? "paused" : "creating"},${computeRef},'native-v1')`;
  if (kind === "resume")
    yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref)
      VALUES(${NodeCrypto.randomUUID()},${allocationId},${input.hostId},'create','released',${computeRef})`;
  yield* capacity.request({ operationId, allocationId, hostId: input.hostId, kind });
  return {
    sql,
    placements,
    capacity,
    organizationId,
    repositoryId,
    threadId,
    workflowJobId,
    allocationId,
    operationId,
    ownerUserId,
    hostId: input.hostId,
  };
});

const activeWorkflow = Effect.fnUntraced(function* (automatic = false) {
  const f = yield* seed({ hostId: NodeCrypto.randomUUID(), automatic });
  const environmentId = NodeCrypto.randomUUID();
  const credentialId = NodeCrypto.randomUUID();
  const connectionId = NodeCrypto.randomUUID();
  const computeRef = NodeCrypto.randomUUID();
  yield* f.capacity.admitNext(f.hostId, "all");
  yield* f.capacity.beginExecution(f.operationId);
  yield* f.capacity.recordCreated(f.operationId, computeRef);
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at)
    VALUES(${f.repositoryId},${f.organizationId},'Workflow work','2026','2026')`;
  yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${computeRef}
    WHERE allocation_id=${f.allocationId}`;
  yield* f.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase,workflow_snapshot)
    VALUES(${f.allocationId},${f.operationId},1,'created',${f.sql.json({
      canonicalKey: "github.com/acme/example",
      installationId: "1",
      branch: "main",
      commitSha: "a".repeat(40),
      templateBuildId: "build",
    })})`;
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
    VALUES(${credentialId},${environmentId},'workflow-key',${credentialId},'2026','2026')`;
  yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
    VALUES(${environmentId},${f.allocationId},${f.threadId},${f.repositoryId},1,'workflow-key',${credentialId})`;
  yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
    VALUES(${f.allocationId},${f.operationId},${credentialId},${environmentId},'workflow-key',${credentialId},'response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
  yield* f.placements.assignWorkflow({ ...f, environmentId });
  yield* f.sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
    VALUES(${f.allocationId},'github.com/acme/example','main',${"a".repeat(40)},'ready',${environmentId},${"b".repeat(64)})`;
  yield* f.sql`INSERT INTO relay_thread_vm_codex_auth(allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id,acknowledged_connection_id)
    VALUES(${f.allocationId},${environmentId},1,${f.threadId},${f.organizationId},'organization',${connectionId},${connectionId})`;
  yield* f.sql`UPDATE relay_workflow_jobs SET status='running',record=record ||
    jsonb_build_object('status','running','startAttempted',true,'vmAdmission',jsonb_build_object('codexConnectionId',${connectionId}::text,'hasSecrets',false))
    WHERE job_id=${f.workflowJobId}`;
  yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
  const principal = {
    environmentId,
    environmentPublicKey: "workflow-key",
    credentialId,
    threadVm: {
      allocationId: f.allocationId,
      threadId: ThreadId.make(f.threadId),
      repositoryId: f.repositoryId,
      generation: 1,
    },
  };
  const owner = { threadId: f.threadId, environmentId, generation: 1 };
  return { ...f, principal, owner };
});

const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(NodeEffectCrypto.layer),
  Layer.provideMerge(
    Layer.succeed(RelaySecretBox, {
      seal: () => Effect.die("No workflow VM credentials may be issued in P01"),
      open: () => Effect.die("No workflow VM credentials may be read in P01"),
    }),
  ),
);

const pausedSandbox = (
  computeRef: string,
  allocationId: string,
  operationId: string,
  threadId: string,
): SandboxInfo => ({
  sandboxId: computeRef,
  templateId: "template",
  network: { allowPublicTraffic: false },
  lifecycle: { onTimeout: "pause", autoResume: false },
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": allocationId,
    "launchpad.operation_id": operationId,
    "launchpad.thread_id": threadId,
    "launchpad.generation": "1",
  },
  startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  endAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  state: "paused",
  cpuCount: 2,
  memoryMB: 4096,
  envdVersion: "test",
});

describe.skipIf(!databaseUrl)("workflow VM ownership and capacity foundation (Postgres)", () => {
  it.layer(services)((it) => {
    for (const [index, outcome] of [
      "stopped",
      "stopped-while-running",
      "stopped-at-review",
      "stopped-while-cancelling",
      "stopped-after-cancellation-acknowledged",
      "stopped-after-cancellation-revoked",
      "cancelled",
      "cancelled-after-native-pause",
      "cancel-revoked-after-native-pause",
      "acknowledged-cancel-after-native-pause",
      "stale-build-reserved",
      "stale-template-waiting",
      "stale-build-cancelled",
      "checkout-failed",
      "checkout-failed-after-disconnect",
      "checkout-failed-after-replacement",
      "checkout-prepared-after-replacement",
      "checkout-replaced-during-mint",
      "checkout-failure-from-stale-claim",
      "checkout-unconfirmed",
      "checkout-cancelled",
      "checkout-failed-recovered",
      "checkout-failed-recovered-after-disconnect",
      "checkout-failed-recovered-after-replacement",
      "checkout-recovery-unknown",
      "checkout-recovery-timeout",
      "checkout-recovery-cancelled",
      "checkout-recovery-stale-claim",
    ].entries()) {
      it.effect(`freezes one workflow preparation when admitted, then its VM is ${outcome}`, () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const first = yield* seed({ hostId, personal: true });
          const { sql, organizationId, repositoryId, ownerUserId } = first;
          const jobId = NodeCrypto.randomBytes(32).toString("hex");
          const threadId = `workflow:${jobId}`;
          const workflowId = NodeCrypto.randomUUID();
          const workflow = {
            workflowId,
            organizationId,
            repositoryId,
            revision: 1,
            archived: false,
            createdAt: "2026",
            updatedAt: "2026",
            definition: {
              name: "Queued VM",
              target: { kind: "vm", baseBranch: null },
              steps: [
                {
                  kind: "agent",
                  id: "agent",
                  title: "Implement",
                  instruction: "Implement",
                  modelSelection: null,
                },
              ],
            },
          };
          yield* sql`INSERT INTO relay_organizations VALUES (${organizationId},'Organization','2026','2026')`;
          yield* sql`INSERT INTO relay_organization_members VALUES (${organizationId},${ownerUserId},'admin','2026','2026')`;
          yield* sql`INSERT INTO relay_repositories VALUES (${repositoryId},${organizationId},'Repository','2026','2026')`;
          const canonicalKey = `github.com/workflow-fifo/${outcome}`;
          yield* sql`INSERT INTO relay_repository_aliases VALUES (${canonicalKey},${repositoryId},${organizationId},'2026')`;
          const installationId = String(4321 + index);
          const codexConnectionId = `fifo-codex-${outcome}`;
          yield* sql`INSERT INTO relay_github_installations VALUES (${organizationId},${installationId},'workflow-fifo','Organization',${ownerUserId},'2026','2026')`;
          yield* sql`INSERT INTO relay_codex_vm_connections
          (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
          VALUES (${organizationId},${codexConnectionId},'issuer','subject','client','connected','sealed','2099-01-01','2026')`;
          yield* sql`INSERT INTO relay_repository_workflows (workflow_id,repository_id,revision,record)
          VALUES (${workflowId},${repositoryId},1,${sql.json(workflow)})`;
          yield* sql`INSERT INTO relay_workflow_jobs
          (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
          VALUES (${jobId},${repositoryId},${organizationId},${ownerUserId},'queued',${sql.json({
            jobId,
            repositoryId,
            workflowId,
            instruction: "Implement",
            status: "queued",
            workflow: null,
            runtime: null,
            detail: null,
            progress: null,
            createdAt: "2026",
            updatedAt: "2026",
            origin: { kind: "manual", userId: ownerUserId },
            vmAdmission: { codexConnectionId, hasSecrets: false },
            queueReason: { code: "vm_waiting_capacity", retryAt: null },
          })},0,'2026','2026')`;
          const store = yield* Workflows;
          const advance = Effect.gen(function* () {
            const row = (yield* store.claim(jobId))!;
            return yield* advanceWorkflowVmPreparation(row, row.leaseUntil!).pipe(
              Effect.ensuring(store.release(jobId, row.leaseUntil!).pipe(Effect.orDie)),
            );
          }).pipe(
            Effect.provideService(ThreadVmRuntimeConfiguration, {
              settings: {
                hostId,
                maxRunningVms: 1,
                workflowExecutionEnabled: true,
                workflowModelCatalog: { defaultModel: "default-model", models: [] },
                templateBuildId: "pinned-build",
                publicRelayUrl: "https://relay.test",
                compute: {
                  apiUrl: "https://compute.test",
                  sandboxUrl: "https://sandbox.test",
                  apiKey: Redacted.make("fixture"),
                  templateId: "template:tag",
                  hostAddresses: ["192.0.2.10"],
                  timeoutMs: 600_000,
                },
                autoPauseEnabled: false,
                autoBackupEnabled: false,
                autoDeleteEnabled: false,
                replacementEnabled: false,
                restoreEnabled: false,
                resetEnabled: false,
              },
            }),
            Effect.provideService(RelaySecretBox, {
              seal: () => Effect.succeed("sealed-test"),
              open: () => Effect.die("No read needed"),
            }),
            Effect.provide(
              Layer.mock(GithubApp)({
                resolveRepositoryBranch: () =>
                  Effect.succeed({ branch: "main", commitSha: "a".repeat(40) }),
              }),
            ),
          );
          expect((yield* advance).status).toBe("queued");
          expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "waiting" });
          expect(yield* first.placements.getAny(threadId)).toMatchObject({
            environmentId: null,
            workflowJobId: jobId,
          });
          expect(
            yield* sql`SELECT 1 FROM relay_workflow_run_configurations WHERE job_id=${jobId}`,
          ).toHaveLength(0);
          expect(
            (yield* first.capacity.admitNext(hostId, { workflowEnabled: true }))?.operationId,
          ).toBe(first.operationId);
          yield* first.capacity.cancelUnstarted(first.operationId);

          expect(yield* advance).toMatchObject({
            status: "preparing",
            runtime: { kind: "vm", threadId },
          });
          expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "reserved" });
          expect(
            yield* makeThreadVmProvisionStore(sql).get(jobId, "organization_workflow"),
          ).toMatchObject({
            phase: "pending",
            workflowSnapshot: {
              canonicalKey,
              commitSha: "a".repeat(40),
              templateBuildId: "pinned-build",
            },
          });
          expect(
            yield* sql`SELECT thread_id FROM relay_workflow_run_configurations WHERE job_id=${jobId}`,
          ).toEqual([{ thread_id: threadId }]);
          if (outcome.startsWith("stale-")) {
            const waiting = outcome === "stale-template-waiting";
            const cancelled = outcome === "stale-build-cancelled";
            const next = yield* seed({ hostId, personal: true });
            yield* first.capacity.configure(hostId, 1);
            if (waiting) {
              yield* sql`UPDATE relay_thread_vm_capacity SET state='waiting' WHERE operation_id=${jobId}`;
              expect((yield* first.capacity.admitNext(hostId, "personal"))?.operationId).toBe(
                next.operationId,
              );
              yield* sql`UPDATE relay_codex_vm_connections SET status='disconnected'
                WHERE organization_id=${organizationId}`;
            }
            if (cancelled) {
              const before = (yield* store.getJob(jobId))!;
              yield* store.updateJob(
                before,
                { ...before.record, status: "cancelling" },
                { userId: ownerUserId, response: { operation: "cancel" } },
              );
            }
            const worker = makeThreadVmProvisionWorker(
              sql,
              {
                create: () => Effect.die("Stale workflows must not create a VM"),
                findOperation: () => Effect.die("The VM has never started"),
                recoverIngress: () => Effect.die("No VM was created"),
              },
              waiting ? "new-template:tag" : "template:tag",
              hostId,
              Effect.void,
              {
                enabled: true,
                buildId: waiting ? "pinned-build" : "new-build",
                verifyTemplate: () => Effect.die("Stale workflows must not verify a tag"),
              },
            );
            expect(yield* worker.runOne()).toBe(true);
            expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "released" });
            expect(yield* advance).toMatchObject({
              status: cancelled ? "cancelled" : "failed",
              detail: expect.stringContaining(cancelled ? "Cancelled" : "saved workflow VM build"),
              queueReason: null,
            });
            expect(yield* worker.runOne()).toBe(false);
            expect(yield* first.capacity.get(next.operationId)).toMatchObject({
              state: "reserved",
            });
            return;
          }
          yield* sql`UPDATE relay_thread_vm_provisions SET error_code='setup_access_denied'
            WHERE allocation_id=${jobId}`;
          expect(yield* advance).toMatchObject({
            status: "preparing",
            queueReason: { code: "target_invalid" },
            detail: expect.stringContaining("GitHub App"),
          });
          yield* sql`UPDATE relay_thread_vm_provisions SET error_code='startup_unconfirmed'
            WHERE allocation_id=${jobId}`;
          expect(yield* advance).toMatchObject({
            status: "preparing",
            queueReason: null,
            detail: expect.stringContaining("confirmed startup"),
          });
          const sandboxId = `fifo-sandbox-${outcome}`;
          if (outcome.startsWith("checkout-")) {
            const environmentId = NodeCrypto.randomUUID();
            const credentialId = NodeCrypto.randomUUID();
            yield* sql`UPDATE relay_thread_vm_capacity SET state='started',compute_ref=${sandboxId}
              WHERE operation_id=${jobId}`;
            yield* sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${sandboxId}
              WHERE allocation_id=${jobId}`;
            yield* sql`UPDATE relay_thread_vm_provisions SET phase='created' WHERE allocation_id=${jobId}`;
            yield* sql`INSERT INTO relay_environment_credentials
              (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
              VALUES(${credentialId},${environmentId},'checkout-key',${credentialId},'2026','2026')`;
            yield* sql`INSERT INTO relay_thread_vm_bindings
              (environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
              VALUES(${environmentId},${jobId},${threadId},${repositoryId},1,'checkout-key',${credentialId})`;
            yield* sql`INSERT INTO relay_thread_vm_enrollments
              (allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
              VALUES(${jobId},${jobId},${credentialId},${environmentId},'checkout-key',${credentialId},
                'test-response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
            yield* first.placements.assignWorkflow({
              threadId,
              workflowJobId: jobId,
              allocationId: jobId,
              operationId: jobId,
              environmentId,
            });
            const cancel = Effect.gen(function* () {
              const before = (yield* store.getJob(jobId))!;
              yield* store.updateJob(
                before,
                { ...before.record, status: "cancelling" },
                {
                  userId: ownerUserId,
                  response: { operation: "cancel" },
                },
              );
            }).pipe(Effect.orDie);
            const disconnect = sql`DELETE FROM relay_github_installations
              WHERE organization_id=${organizationId}`;
            const replace = sql`UPDATE relay_github_installations SET installation_id=${String(5321 + index)}
              WHERE organization_id=${organizationId}`;
            const successorClaim = NodeCrypto.randomUUID();
            const recovery =
              outcome.includes("recovered") || outcome.startsWith("checkout-recovery-");
            const fallback =
              outcome === "checkout-recovery-unknown" || outcome === "checkout-recovery-timeout";
            const probeStarted = yield* Deferred.make<void>();
            let deliveries = 0;
            let mints = 0;
            let probes = 0;
            const worker = makeThreadVmSetupWorker(
              sql,
              (_sandboxId, environmentId, input) =>
                Effect.gen(function* () {
                  deliveries++;
                  if (recovery && deliveries === 1) {
                    if (outcome.endsWith("after-disconnect")) yield* disconnect;
                    if (outcome.endsWith("after-replacement")) yield* replace;
                    return yield* new ThreadVmComputeError({
                      operation: "setup",
                      message: "Original checkout reply was lost",
                    });
                  }
                  if (
                    outcome === "checkout-failed-after-disconnect" ||
                    outcome === "checkout-failure-from-stale-claim" ||
                    outcome === "checkout-cancelled"
                  )
                    yield* disconnect;
                  if (outcome === "checkout-cancelled") yield* cancel;
                  if (outcome === "checkout-failure-from-stale-claim")
                    yield* sql`UPDATE relay_thread_vm_provisions SET claim_id=${successorClaim}
                      WHERE allocation_id=${jobId}`;
                  if (
                    outcome === "checkout-failed-after-replacement" ||
                    outcome === "checkout-prepared-after-replacement"
                  )
                    yield* replace;
                  if (outcome === "checkout-prepared-after-replacement")
                    return {
                      status: "prepared",
                      receipt: {
                        version: 1,
                        operationId: input.workspace.operationId,
                        environmentId: EnvironmentId.make(environmentId),
                        projectId: ProjectId.make(`vm:${threadId}`),
                        scope: input.workspace.scope,
                        workspaceRoot: "/workspace/project",
                        revision: input.workspace.revision,
                        sequence: 1,
                        execution: "frozen",
                      },
                    } as const;
                  return {
                    status: "blocked",
                    code:
                      outcome === "checkout-unconfirmed" || fallback
                        ? "setup_unconfirmed"
                        : "repository_unavailable",
                  } as const;
                }).pipe(Effect.catchTag("SqlError", Effect.die)),
              hostId,
              "organization_workflow",
              (id, request) =>
                Effect.gen(function* () {
                  probes++;
                  expect(id).toBe(sandboxId);
                  expect(request).toMatchObject({
                    environmentId,
                    templateId: "template:tag",
                    workspace: {
                      operationId: jobId,
                      scope: { allocationId: jobId, threadId, repositoryId, generation: 1 },
                      canonicalKey,
                      revision: "a".repeat(40),
                    },
                  });
                  if (outcome === "checkout-recovery-timeout") {
                    yield* Deferred.succeed(probeStarted, undefined);
                    return yield* Effect.never;
                  }
                  if (fallback) return null;
                  if (outcome === "checkout-recovery-cancelled") yield* cancel;
                  if (outcome === "checkout-recovery-stale-claim")
                    yield* sql`UPDATE relay_thread_vm_provisions SET claim_id=${successorClaim}
                    WHERE allocation_id=${jobId}`;
                  return "repository_unavailable" as const;
                }).pipe(Effect.orDie),
            );
            const runSetup = worker.runOne().pipe(
              Effect.provide(
                Layer.mock(GithubApp)({
                  mintRepositoryToken: () =>
                    Effect.gen(function* () {
                      mints++;
                      if (outcome === "checkout-replaced-during-mint") yield* replace;
                      return { token: "fixture", expiresAt: "2099-01-01" };
                    }).pipe(Effect.orDie),
                }),
              ),
            );
            expect(yield* runSetup).toBe(true);
            expect(probes).toBe(0);
            const setup = makeThreadVmSetupStore(sql).getFor(jobId, "organization_workflow");
            if (recovery) {
              expect((yield* setup)?.phase).toBe("running");
              expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "started" });
              yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp()
                WHERE allocation_id=${jobId}`;
              if (outcome === "checkout-recovery-timeout") {
                const retry = yield* runSetup.pipe(Effect.forkChild);
                yield* Deferred.await(probeStarted);
                yield* TestClock.adjust("8 seconds");
                expect(yield* Fiber.join(retry)).toBe(true);
              } else {
                expect(yield* runSetup).toBe(true);
              }
              expect(probes).toBe(1);
            }
            expect(deliveries).toBe(
              outcome === "checkout-replaced-during-mint" ? 0 : fallback ? 2 : 1,
            );
            expect(mints).toBe(fallback ? 2 : 1);
            const checkoutFailed = outcome.startsWith("checkout-failed");
            expect((yield* setup)?.phase).toBe(checkoutFailed ? "failed" : "running");
            const startup = makeThreadVmServerWorker(
              sql,
              () => Effect.die("Checkout did not succeed"),
              hostId,
              "organization_workflow",
            );
            expect(yield* startup.runOne()).toBe(false);
            const checkoutAccessDenied =
              outcome === "checkout-prepared-after-replacement" ||
              outcome === "checkout-replaced-during-mint";
            if (
              outcome === "checkout-failure-from-stale-claim" ||
              outcome === "checkout-recovery-stale-claim"
            ) {
              expect(
                yield* makeThreadVmProvisionStore(sql).get(jobId, "organization_workflow"),
              ).toMatchObject({ claimId: successorClaim, allocationState: "running" });
              expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "started" });
              return;
            }
            if (outcome === "checkout-unconfirmed" || checkoutAccessDenied || fallback) {
              expect(yield* advance).toMatchObject({
                status: "preparing",
                detail: expect.stringContaining(
                  checkoutAccessDenied ? "GitHub App" : "Retrying VM setup",
                ),
              });
              expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "started" });
              expect(yield* makeThreadVmAllocationStore(sql).getAny(jobId)).toMatchObject({
                state: "running",
              });
              return;
            }
            if (checkoutFailed) {
              expect(yield* makeThreadVmAllocationStore(sql).getAny(jobId)).toMatchObject({
                state: "deleting",
              });
              expect(yield* advance).toMatchObject({
                status: "preparing",
                detail: expect.stringContaining("checkout failed"),
              });
              yield* cancel;
            }
            const expected = checkoutFailed ? "preparing" : "cancelling";
            expect((yield* advance).status).toBe(expected);
            const makeCleanupDue = sql`UPDATE relay_thread_vm_provisions
              SET retry_at=clock_timestamp()-interval '1 second' WHERE allocation_id=${jobId}`;
            const cleanup = (destroy: Effect.Effect<void, ThreadVmComputeError>) =>
              makeThreadVmCancelledSetupCleanupWorker(
                sql,
                {
                  inspect: (id) =>
                    Effect.sync(() => {
                      expect(id).toBe(sandboxId);
                      return null;
                    }),
                  destroy: (id) =>
                    Effect.sync(() => expect(id).toBe(sandboxId)).pipe(Effect.andThen(destroy)),
                },
                hostId,
              ).runOne();
            yield* makeCleanupDue;
            expect(
              yield* cleanup(
                new ThreadVmComputeError({
                  operation: "destroy",
                  message: "Native deletion acknowledgement was lost",
                }),
              ),
            ).toBe(true);
            expect((yield* advance).status).toBe(expected);
            expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "started" });
            yield* makeCleanupDue;
            expect(yield* cleanup(Effect.void)).toBe(true);
            expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "released" });
            expect((yield* advance).status).toBe(checkoutFailed ? "failed" : "cancelled");
            return;
          }
          yield* sql`UPDATE relay_thread_vm_provisions SET phase='created' WHERE allocation_id=${jobId}`;
          yield* sql`UPDATE relay_thread_vm_capacity SET state='released',compute_ref=${sandboxId} WHERE operation_id=${jobId}`;
          yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',compute_ref=${sandboxId}
          WHERE allocation_id=${jobId}`;
          expect(yield* advance).toMatchObject({
            status: "preparing",
            queueReason: { code: "environment_offline" },
            detail: expect.stringContaining("paused"),
          });
          if (outcome.startsWith("stopped")) {
            const acknowledged = outcome === "stopped-after-cancellation-acknowledged";
            const cancelling =
              acknowledged ||
              outcome === "stopped-while-cancelling" ||
              outcome === "stopped-after-cancellation-revoked";
            if (outcome !== "stopped") {
              const status = cancelling
                ? "cancelling"
                : outcome === "stopped-at-review"
                  ? "awaiting_review"
                  : "running";
              const before = (yield* store.getJob(jobId))!;
              const checkpoint =
                status === "awaiting_review"
                  ? {
                      checkpointId: "review",
                      checkpointRef: "refs/checkpoint",
                      turnId: "turn",
                      checkpointTurnCount: 1,
                    }
                  : null;
              const pending =
                cancelling && !acknowledged
                  ? { userId: ownerUserId, response: { operation: "cancel" as const } }
                  : checkpoint
                    ? {
                        userId: ownerUserId,
                        response: {
                          operation: "approve" as const,
                          checkpointId: checkpoint.checkpointId,
                          expectedRevision: 5,
                        },
                      }
                    : null;
              const active = yield* store.updateJob(
                before,
                {
                  ...before.record,
                  status,
                  startAttempted: true,
                  detail: null,
                  queueReason: null,
                  progress: {
                    threadId: ThreadId.make(threadId),
                    revision: 5,
                    status: cancelling && !acknowledged ? "running" : status,
                    detail: null,
                    checkpoint,
                    retryableCancellation: cancelling,
                  },
                },
                pending,
              );
              expect(yield* advance).toMatchObject({
                status,
                progress: active.record.progress,
                detail: expect.stringContaining("VM is paused"),
                queueReason: { code: "environment_offline", retryAt: null },
              });
              const paused = (yield* store.getJob(jobId))!;
              expect(paused.pendingControl).toEqual(pending);
              yield* advance;
              expect((yield* store.getJob(jobId))?.revision).toBe(paused.revision);
              if (acknowledged || outcome === "stopped-after-cancellation-revoked")
                yield* sql`DELETE FROM relay_organization_members WHERE organization_id=${organizationId}
                  AND user_id=${ownerUserId}`;
            }
            // A later definitive 404 after native pause is observed by the lease worker.
            expect(
              yield* makeThreadVmLeaseWorker(
                sql,
                () => Effect.die("A paused workflow must not renew or wake."),
                hostId,
                { inspect: () => Effect.succeed(null) },
              ).runOne("paused"),
            ).toBe(true);
            const status =
              acknowledged || outcome === "stopped-while-cancelling" ? "cancelled" : "failed";
            expect(yield* advance).toMatchObject({
              status,
              queueReason: null,
              detail: expect.stringContaining(
                outcome === "stopped"
                  ? "stopped before execution"
                  : status === "cancelled"
                    ? "Cancelled after"
                    : "result could not be confirmed",
              ),
              ...(outcome === "stopped"
                ? { progress: null }
                : { progress: { status, retryableCancellation: false } }),
            });
            const settled = (yield* store.getJob(jobId))!;
            expect(settled.pendingControl).toBeNull();
            expect((yield* advance).status).toBe(status);
            expect((yield* store.getJob(jobId))?.revision).toBe(settled.revision);
          } else {
            const afterPause = outcome.endsWith("native-pause");
            const acknowledged = outcome === "acknowledged-cancel-after-native-pause";
            const revoked = outcome === "cancel-revoked-after-native-pause";
            const before = (yield* store.getJob(jobId))!;
            yield* store.updateJob(
              before,
              {
                ...before.record,
                status: "cancelling",
                ...(afterPause
                  ? {
                      startAttempted: true,
                      progress: {
                        threadId: ThreadId.make(threadId),
                        revision: 5,
                        status: acknowledged ? "cancelling" : "awaiting_review",
                        detail: null,
                        checkpoint: acknowledged
                          ? null
                          : {
                              checkpointId: "review",
                              checkpointRef: "refs/checkpoint",
                              turnId: "turn",
                              checkpointTurnCount: 1,
                            },
                        retryableCancellation: false,
                      },
                    }
                  : {}),
              },
              acknowledged ? null : { userId: ownerUserId, response: { operation: "cancel" } },
            );
            const revokeMembership = sql`DELETE FROM relay_organization_members
              WHERE organization_id=${organizationId} AND user_id=${ownerUserId}`;
            if (afterPause) {
              // Older paused rows only gain authority after native identity is verified.
              expect(yield* advance).toMatchObject({
                status: "cancelling",
                queueReason: { code: "environment_offline" },
              });
              expect(
                yield* makeThreadVmLeaseWorker(
                  sql,
                  () => Effect.die("A paused workflow must not renew or wake."),
                  hostId,
                  {
                    inspect: () => Effect.succeed(pausedSandbox(sandboxId, jobId, jobId, threadId)),
                  },
                ).runOne("paused"),
              ).toBe(true);
              if (revoked) {
                yield* revokeMembership;
                expect(yield* advance).toMatchObject({
                  status: "awaiting_review",
                  detail: expect.stringContaining("no longer has permission"),
                });
                expect((yield* store.getJob(jobId))?.pendingControl).toBeNull();
                expect(yield* makeThreadVmAllocationStore(sql).getAny(jobId)).toMatchObject({
                  state: "paused",
                });
                return;
              }
            }
            expect(yield* advance).toMatchObject({
              status: "cancelling",
              vmCancellationConfirmed: true,
            });
            yield* revokeMembership;
            expect((yield* advance).status).toBe("cancelling");
            const destroys: string[] = [];
            const retryDelete = outcome === "cancelled-after-native-pause";
            const matching: SandboxInfo = {
              ...pausedSandbox(sandboxId, jobId, jobId, threadId),
              state: "running",
            };
            let inspected: SandboxInfo | null = retryDelete
              ? {
                  ...matching,
                  metadata: { ...matching.metadata, "launchpad.generation": "2" },
                }
              : null;
            let acknowledgedDelete = !retryDelete;
            const worker = makeThreadVmCancelledSetupCleanupWorker(
              sql,
              {
                inspect: (id) =>
                  Effect.sync(() => {
                    expect(id).toBe(sandboxId);
                    return inspected;
                  }),
                destroy: (id) =>
                  Effect.gen(function* () {
                    destroys.push(id);
                    if (!acknowledgedDelete)
                      return yield* new ThreadVmComputeError({
                        operation: "destroy",
                        message: "Native deletion acknowledgement was lost",
                      });
                  }),
              },
              hostId,
            );
            if (retryDelete) {
              expect(yield* worker.runOne()).toBe(true);
              expect(destroys).toEqual([]);
              const retryDue = sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp()-interval '1 second'
                WHERE allocation_id=${jobId}`;
              yield* retryDue;
              // An out-of-band resume does not renew this VM or change its identity.
              inspected = matching;
              expect(yield* worker.runOne()).toBe(true);
              expect(destroys).toEqual([sandboxId]);
              expect((yield* advance).status).toBe("cancelling");
              expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "released" });
              yield* retryDue;
              inspected = null;
              acknowledgedDelete = true;
            }
            expect(yield* worker.runOne()).toBe(true);
            expect(destroys).toEqual(retryDelete ? [sandboxId, sandboxId] : [sandboxId]);
            expect((yield* advance).status).toBe("cancelled");
            expect(yield* first.capacity.get(jobId)).toMatchObject({ state: "released" });
          }
        }).pipe(Effect.provide(workflows)),
      );
    }

    it.effect(
      "claims untouched workflow setup before an interrupted attempt whose claim expired",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const enqueue = Effect.fnUntraced(function* (secondsAgo: number) {
            const f = yield* seed({ hostId });
            const { sql, allocationId, operationId } = f;
            const credentialId = NodeCrypto.randomUUID();
            const environmentId = NodeCrypto.randomUUID();
            yield* sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${allocationId}
            WHERE allocation_id=${allocationId}`;
            yield* sql`INSERT INTO relay_thread_vm_provisions
            (allocation_id,operation_id,generation,phase,workflow_snapshot,retry_at)
            VALUES(${allocationId},${operationId},1,'created','{}'::jsonb,
              clock_timestamp()-${secondsAgo}*interval '1 second')`;
            yield* sql`INSERT INTO relay_environment_credentials
            (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
            VALUES(${credentialId},${environmentId},'setup-key',${credentialId},'2026','2026')`;
            yield* sql`INSERT INTO relay_thread_vm_enrollments
            (allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
            VALUES(${allocationId},${operationId},${credentialId},${environmentId},'setup-key',${credentialId},
              'test-response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
            yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision)
            VALUES(${allocationId},'github.com/fixture/setup','main',${"a".repeat(40)})`;
            return f;
          });
          const first = yield* enqueue(600);
          const provisions = makeThreadVmProvisionStore(first.sql);
          expect(
            yield* provisions.claimSetup("interrupted", hostId, "organization_workflow"),
          ).toMatchObject({ allocationId: first.allocationId });
          const next = yield* enqueue(120);
          yield* first.sql`UPDATE relay_thread_vm_provisions
          SET claim_until = claim_until - interval '3 minutes', retry_at = retry_at - interval '3 minutes'
          WHERE allocation_id = ${first.allocationId}`;
          expect(
            yield* provisions.claimSetup("untouched", hostId, "organization_workflow"),
          ).toMatchObject({
            allocationId: next.allocationId,
          });
          expect(
            yield* provisions.claimSetup("retry", hostId, "organization_workflow"),
          ).toMatchObject({
            allocationId: first.allocationId,
          });
        }),
    );

    it.effect(
      "releases an unused workflow reservation and reconciles an uncertain first create",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const f = yield* seed({ hostId });
          const personal = yield* seed({ hostId, personal: true });
          const sql = f.sql;
          yield* sql`INSERT INTO relay_organizations VALUES (${f.organizationId},'Organization','2026','2026')`;
          yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
          VALUES (${f.repositoryId},${f.organizationId},'Repository','2026','2026')`;
          yield* sql`UPDATE relay_workflow_jobs SET record=record||'{"vmAdmission":{"codexConnectionId":"codex","hasSecrets":false}}'::jsonb
          WHERE job_id=${f.workflowJobId}`;
          yield* sql`INSERT INTO relay_codex_vm_connections
          (organization_id,connection_id,issuer,subject,client_id,status,updated_at)
          VALUES (${f.organizationId},'codex','issuer','subject','client','disconnected','2026')`;
          const snapshot = {
            canonicalKey: "github.com/acme/example",
            installationId: "1",
            branch: "main",
            commitSha: "a".repeat(40),
            templateBuildId: "frozen-build",
          };
          yield* sql`INSERT INTO relay_thread_vm_provisions
          (allocation_id,operation_id,generation,workflow_snapshot)
          VALUES (${f.allocationId},${f.operationId},1,${sql.json(snapshot)})`;
          yield* f.capacity.configure(hostId, 1);
          expect((yield* f.capacity.admitNext(hostId, "all"))?.operationId).toBe(f.operationId);

          let creates = 0;
          let lookups = 0;
          let tagAvailable = true;
          const makeWorker = (templateId: string, buildId: string) =>
            makeThreadVmProvisionWorker(
              sql,
              {
                create: (_input, template) =>
                  Effect.gen(function* () {
                    expect(template).toBe("template");
                    creates++;
                    return yield* new ThreadVmComputeError({
                      operation: "create",
                      message: "Lost create reply",
                    });
                  }),
                findOperation: (operationId) =>
                  Effect.sync(() => {
                    expect(operationId).toBe(f.operationId);
                    lookups++;
                    return [];
                  }),
                recoverIngress: () => Effect.die("No compute identity was returned"),
              },
              templateId,
              hostId,
              Effect.void,
              {
                enabled: true,
                buildId,
                verifyTemplate: (template, build) =>
                  Effect.gen(function* () {
                    expect(template).toBe("template");
                    expect(build).toBe(snapshot.templateBuildId);
                    if (!tagAvailable)
                      return yield* new ThreadVmComputeError({
                        operation: "verify runner",
                        message: "Tag lookup failed temporarily",
                      });
                  }),
              },
            );
          const worker = makeWorker("template", snapshot.templateBuildId);
          expect(yield* worker.runOne()).toBe(true);
          expect(creates).toBe(0);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("waiting");
          expect(
            yield* makeThreadVmProvisionStore(sql).get(f.allocationId, "organization_workflow"),
          ).toMatchObject({
            errorCode: "workflow_codex_unavailable",
            workflowSnapshot: snapshot,
          });
          expect(
            (yield* f.capacity.admitNext(hostId, { workflowEnabled: true }))?.operationId,
          ).toBe(personal.operationId);
          yield* personal.capacity.cancelUnstarted(personal.operationId);
          yield* sql`UPDATE relay_codex_vm_connections SET status='connected',payload_sealed='sealed',expires_at='2099-01-01'
          WHERE organization_id=${f.organizationId}`;
          tagAvailable = false;
          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect(creates).toBe(0);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("waiting");
          expect(
            yield* makeThreadVmProvisionStore(sql).get(f.allocationId, "organization_workflow"),
          ).toMatchObject({ errorCode: "workflow_template_unverified" });
          tagAvailable = true;
          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect(creates).toBe(1);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          expect(yield* makeWorker("new-template", "new-build").runOne()).toBe(true);
          expect(creates).toBe(1);
          expect(lookups).toBe(1);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
        }),
    );

    for (const nativeState of ["paused", "deleted"] as const) {
      it.effect(`renews a workflow VM lease and releases capacity when it is ${nativeState}`, () =>
        Effect.gen(function* () {
          const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
          const computeRef = NodeCrypto.randomUUID();
          yield* f.capacity.admitNext(f.hostId, "all");
          yield* f.capacity.beginExecution(f.operationId);
          yield* f.capacity.recordCreated(f.operationId, computeRef);
          yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${computeRef}
            WHERE allocation_id=${f.allocationId}`;
          yield* f.sql`INSERT INTO relay_thread_vm_provisions
            (allocation_id,operation_id,generation,phase,workflow_snapshot)
            VALUES (${f.allocationId},${f.operationId},1,'created',${f.sql.json({
              canonicalKey: "github.com/acme/example",
              installationId: "1",
              branch: "main",
              commitSha: "a".repeat(40),
              templateBuildId: "build",
            })})`;
          let renewals = 0;
          const running = makeThreadVmLeaseWorker(
            f.sql,
            (sandboxId, identity) =>
              Effect.sync(() => {
                expect(sandboxId).toBe(computeRef);
                expect(identity.scope.generation).toBe(1);
                renewals++;
              }),
            f.hostId,
          );
          for (let minute = 0; minute <= 12; minute += 4) {
            yield* f.sql`UPDATE relay_thread_vm_leases
              SET attempted_at=clock_timestamp()-interval '5 minutes',renewed_at=clock_timestamp()-interval '5 minutes'
              WHERE allocation_id=${f.allocationId}`;
            expect(yield* running.runOne()).toBe(true);
          }
          expect(renewals).toBe(4);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
          yield* f.sql`UPDATE relay_thread_vm_leases
            SET attempted_at=clock_timestamp()-interval '5 minutes',renewed_at=clock_timestamp()-interval '5 minutes'
            WHERE allocation_id=${f.allocationId}`;
          const unavailable = makeThreadVmLeaseWorker(
            f.sql,
            () =>
              Effect.fail(
                new ThreadVmComputeError({ operation: "lease", message: "VM is not running" }),
              ),
            f.hostId,
            {
              inspect: () =>
                Effect.succeed(
                  nativeState === "deleted"
                    ? null
                    : pausedSandbox(computeRef, f.allocationId, f.operationId, f.threadId),
                ),
            },
          );
          expect(yield* unavailable.runOne()).toBe(true);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("released");
          expect((yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId))?.state).toBe(
            nativeState,
          );
          if (nativeState === "paused") {
            yield* f.sql`UPDATE relay_thread_vm_leases SET attempted_at=clock_timestamp()-interval '2 minutes'
              WHERE allocation_id=${f.allocationId}`;
            expect(
              yield* makeThreadVmLeaseWorker(
                f.sql,
                () => Effect.die("A paused workflow must not renew or wake."),
                f.hostId,
                {
                  inspect: () =>
                    Effect.succeed(
                      pausedSandbox(computeRef, f.allocationId, f.operationId, f.threadId),
                    ),
                },
              ).runOne("paused"),
            ).toBe(true);
            expect((yield* f.capacity.get(f.operationId))?.state).toBe("released");
            expect(yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId)).toMatchObject({
              state: "paused",
              computeRef,
            });
          }
        }),
      );
    }

    it.effect("keeps preparatory workflow metadata outside personal reads and execution", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        expect(yield* f.placements.get(f.threadId)).toBeNull();
        expect(yield* f.placements.prepareWorkflow(f)).toMatchObject({
          workflowJobId: f.workflowJobId,
        });
        expect(yield* f.placements.getAny(f.threadId)).toMatchObject({
          audience: "repository",
          workflowJobId: f.workflowJobId,
          ownerUserId: null,
          environmentId: null,
          projectId: null,
          generation: 1,
        });
        const allocations = makeThreadVmAllocationStore(f.sql);
        expect(yield* allocations.get(f.allocationId)).toBeNull();
        expect(yield* allocations.getAny(f.allocationId)).toMatchObject({
          resourceKind: "organization_workflow",
          ownerUserId: null,
        });
        const denied = yield* Effect.flip(
          f.placements.admit({
            threadId: f.threadId,
            environmentId: "forged",
            generation: 1,
            workId: "forged",
          }),
        );
        expect(denied._tag).toBe("ThreadPlacementConflict");
        expect(
          yield* Effect.isFailure(f.placements.assignWorkflow({ ...f, environmentId: "forged" })),
        ).toBe(true);
      }),
    );

    it.effect("prepares only the logical thread bound to an active VM job", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        const workflowJobId = NodeCrypto.randomUUID();
        const threadId = NodeCrypto.randomUUID();
        const wrongThreadId = NodeCrypto.randomUUID();
        const input = { ...f, workflowJobId, threadId, operationId: NodeCrypto.randomUUID() };
        yield* f.sql`INSERT INTO relay_workflow_jobs
          (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
          SELECT ${workflowJobId},repository_id,organization_id,submitter_user_id,'preparing',
            record || jsonb_build_object('jobId',${workflowJobId}::text,
              'runtime',jsonb_build_object('kind','vm','threadId',${threadId}::text)),0,'2026','2026'
          FROM relay_workflow_jobs WHERE job_id=${f.workflowJobId}`;
        expect(yield* f.placements.getAny(threadId)).toBeNull();
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...input, threadId: wrongThreadId }),
          ),
        ).toBe(true);
        expect(yield* f.placements.getAny(wrongThreadId)).toBeNull();
        yield* f.sql`UPDATE relay_workflow_jobs SET status='done' WHERE job_id=${workflowJobId}`;
        expect(yield* Effect.isFailure(f.placements.prepareWorkflow(input))).toBe(true);
        expect(yield* f.placements.getAny(threadId)).toBeNull();
        yield* f.sql`UPDATE relay_workflow_jobs SET status='preparing' WHERE job_id=${workflowJobId}`;
        expect(yield* f.placements.prepareWorkflow(input)).toMatchObject({
          threadId,
          workflowJobId,
          environmentId: null,
        });
      }),
    );

    it.effect("uploads saved artifacts only through the exact current shared VM credential", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "p05-guest-upload-" });
          const objects = makeLocalThreadArtifactObjects(fs, root);
          const asVm = <A, E, R>(action: Effect.Effect<A, E, R>) =>
            action.pipe(
              Effect.provideService(RelayEnvironmentPrincipal, f.principal),
              Effect.provideService(ThreadArtifactObjectStorage, objects),
            );
          const bytes = new TextEncoder().encode("saved diff");
          const input = {
            ...f.owner,
            artifactId: NodeCrypto.randomUUID(),
            operationId: NodeCrypto.randomUUID(),
            kind: "workspace" as const,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
            body: Stream.succeed(bytes),
          };
          expect(yield* asVm(uploadPortableThreadArtifact(input))).toMatchObject({
            artifactId: input.artifactId,
            state: "complete",
          });
          expect(
            (yield* Effect.result(asVm(uploadPortableThreadArtifact({ ...input, generation: 2 }))))
              ._tag,
          ).toBe("Failure");
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.principal.credentialId}`;
          const artifactId = NodeCrypto.randomUUID();
          expect(
            (yield* Effect.result(asVm(uploadPortableThreadArtifact({ ...input, artifactId }))))
              ._tag,
          ).toBe("Failure");
          expect(
            yield* f.sql`SELECT 1 FROM relay_thread_artifacts WHERE artifact_id=${artifactId}`,
          ).toHaveLength(0);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    it.effect("admits and completes workflow setup and successive Agent work idempotently", () =>
      Effect.gen(function* () {
        const f = yield* activeWorkflow();
        const asVm = Effect.provideService(RelayEnvironmentPrincipal, f.principal);
        const activity = makeThreadVmActivityStore(f.sql);
        for (const workId of [
          "setup:checkout",
          "terminal:setup",
          "provider:agent-1",
          "provider:agent-2",
        ]) {
          const work = { ...f.owner, workId };
          const revision = Number((yield* activity.get(f.allocationId))?.revision ?? 0);
          expect(yield* admitPortableThreadWork(work).pipe(asVm)).toEqual({
            completed: false,
            newlyAdmitted: true,
          });
          expect(yield* activity.get(f.allocationId)).toMatchObject({
            revision: BigInt(revision + 1),
            activity: "unknown",
            idleSince: null,
            lastWorkAt: expect.anything(),
          });
          expect(yield* admitPortableThreadWork(work).pipe(asVm)).toEqual({
            completed: false,
            newlyAdmitted: false,
          });
          expect(Number((yield* activity.get(f.allocationId))?.revision)).toBe(revision + 1);
          expect(yield* completePortableThreadWork(work).pipe(asVm)).toEqual({ ok: true });
          expect(Number((yield* activity.get(f.allocationId))?.revision)).toBe(revision + 2);
          expect(yield* completePortableThreadWork(work).pipe(asVm)).toEqual({ ok: true });
          expect(Number((yield* activity.get(f.allocationId))?.revision)).toBe(revision + 2);
          expect(yield* admitPortableThreadWork(work).pipe(asVm)).toEqual({
            completed: true,
            newlyAdmitted: false,
          });
          expect(
            yield* f.sql`SELECT completed FROM relay_thread_execution_admissions
              WHERE thread_id=${f.threadId} AND work_id=${workId}`,
          ).toEqual([{ completed: true }]);
        }
      }),
    );

    for (const invalid of [
      "paused",
      "deleted",
      "legacy",
      "wrong-environment",
      "wrong-generation",
      "wrong-credential",
      "wrong-repository",
      "revoked-binding",
      "revoked-credential",
      "unacknowledged-codex",
      "not-started",
      "done",
      "cancelling",
    ] as const) {
      it.effect(`rejects ${invalid} workflow work without persisting an admission`, () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          let principal = f.principal;
          let owner = f.owner;
          if (invalid === "paused")
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='paused' WHERE allocation_id=${f.allocationId}`;
          if (invalid === "deleted")
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          if (invalid === "legacy")
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.allocationId}`;
          if (invalid === "wrong-environment")
            owner = { ...owner, environmentId: NodeCrypto.randomUUID() };
          if (invalid === "wrong-generation") owner = { ...owner, generation: 2 };
          if (invalid === "wrong-credential")
            principal = { ...principal, credentialId: NodeCrypto.randomUUID() };
          if (invalid === "wrong-repository")
            principal = {
              ...principal,
              threadVm: { ...principal.threadVm, repositoryId: NodeCrypto.randomUUID() },
            };
          if (invalid === "revoked-binding")
            yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          if (invalid === "revoked-credential")
            yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='2026' WHERE credential_id=${principal.credentialId}`;
          if (invalid === "unacknowledged-codex")
            yield* f.sql`UPDATE relay_thread_vm_codex_auth SET acknowledged_connection_id=NULL WHERE allocation_id=${f.allocationId}`;
          if (invalid === "not-started")
            yield* f.sql`UPDATE relay_workflow_jobs SET record=record || '{"startAttempted":false}'::jsonb WHERE job_id=${f.workflowJobId}`;
          if (invalid === "done" || invalid === "cancelling")
            yield* f.sql`UPDATE relay_workflow_jobs SET status=${invalid} WHERE job_id=${f.workflowJobId}`;
          expect(
            yield* Effect.isFailure(
              admitPortableThreadWork({ ...owner, workId: "provider:rejected" }).pipe(
                Effect.provideService(RelayEnvironmentPrincipal, principal),
              ),
            ),
          ).toBe(true);
          expect(
            yield* f.sql`SELECT work_id FROM relay_thread_execution_admissions WHERE thread_id=${f.threadId}`,
          ).toEqual([]);
          expect(yield* makeThreadVmActivityStore(f.sql).get(f.allocationId)).toBeNull();
        }),
      );
    }

    it.effect("records workflow work without enabling personal idle inspection or deadlines", () =>
      Effect.gen(function* () {
        const f = yield* activeWorkflow();
        const activity = makeThreadVmActivityStore(f.sql);
        yield* activity.recordWork(f.allocationId);
        expect(yield* Effect.isFailure(activity.beginInspection(f.allocationId))).toBe(true);
        expect(
          yield* Effect.isFailure(
            activity.finishInspection({
              allocationId: f.allocationId,
              revision: 1,
              activity: "idle",
            }),
          ),
        ).toBe(true);
        expect(
          yield* makeThreadVmActivityWorker(
            f.sql,
            () => Effect.die("Personal inspection must not touch a workflow VM"),
            f.hostId,
          ).runOne(),
        ).toBe(false);
        expect(
          yield* f.sql`SELECT revision,activity,idle_since,pause_due_at,delete_due_at
            FROM relay_thread_vm_activity WHERE allocation_id=${f.allocationId}`,
        ).toEqual([
          {
            revision: 1n,
            activity: "unknown",
            idle_since: null,
            pause_due_at: null,
            delete_due_at: null,
          },
        ]);
      }),
    );

    it.effect("assigns only its installed allocation and makes exact assignment idempotent", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        const environmentId = NodeCrypto.randomUUID();
        const credentialId = NodeCrypto.randomUUID();
        yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${NodeCrypto.randomUUID()} WHERE allocation_id=${f.allocationId}`;
        yield* f.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase)
          VALUES(${f.allocationId},${f.operationId},1,'created')`;
        yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES(${credentialId},${environmentId},'test-key',${credentialId},'2026','2026')`;
        yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
          VALUES(${environmentId},${f.allocationId},${f.threadId},${f.repositoryId},1,'test-key',${credentialId})`;
        yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
          VALUES(${f.allocationId},${f.operationId},${credentialId},${environmentId},'test-key',${credentialId},'test-response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
        const input = { ...f, environmentId };
        expect(yield* f.placements.assignWorkflow(input)).toMatchObject({
          environmentId,
          projectId: `vm:${f.threadId}`,
        });
        expect(yield* f.placements.assignWorkflow(input)).toMatchObject({
          environmentId,
          generation: 1,
        });
        expect(yield* f.placements.get(f.threadId)).toBeNull();
        expect(
          yield* Effect.isFailure(
            f.placements.assignWorkflow({ ...input, environmentId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(
            f.placements.assignWorkflow({ ...input, workflowJobId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
      }),
    );

    it.effect("rejects duplicate job placements and tenant or owner mismatches", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...f, threadId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...f, organizationId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_placements
          (thread_id,organization_id,repository_id,audience,owner_user_id,environment_id,project_id)
          VALUES(${NodeCrypto.randomUUID()},${f.organizationId},${f.repositoryId},'private',NULL,'environment','project')`),
        ).toBe(true);
        yield* f.sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE operation_id=${f.operationId}`;
        yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at='2026' WHERE allocation_id=${f.allocationId}`;
        const replacementAllocationId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_thread_vm_allocations
          (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state)
          VALUES(${replacementAllocationId},${f.threadId},${f.organizationId},'organization_workflow',NULL,'template','creating')`;
        expect(
          yield* makeThreadVmAllocationStore(f.sql).getAny(replacementAllocationId),
        ).toMatchObject({ threadId: f.threadId });
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_vm_allocations
          (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state)
          VALUES(${NodeCrypto.randomUUID()},${NodeCrypto.randomUUID()},${f.organizationId},'organization_workflow',NULL,'template','creating')`),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_placements
          (thread_id,organization_id,repository_id,audience,owner_user_id,workflow_job_id,environment_id,project_id,generation,operation_id)
          VALUES(${NodeCrypto.randomUUID()},${NodeCrypto.randomUUID()},${f.repositoryId},'repository',NULL,${f.workflowJobId},NULL,NULL,1,${NodeCrypto.randomUUID()})`),
        ).toBe(true);
      }),
    );

    it.effect("defaults to personal admission before legacy workers claim work", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const workflow = yield* seed({ hostId });
        const personal = yield* seed({ hostId, personal: true });
        yield* workflow.capacity.configure(hostId, 1);
        yield* workflow.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation)
          VALUES(${workflow.allocationId},${workflow.operationId},1)`;
        let externalCalls = 0;
        const worker = makeThreadVmProvisionWorker(
          workflow.sql,
          {
            create: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
            findOperation: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
            recoverIngress: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
          },
          "template",
          hostId,
        );
        expect(yield* worker.runOne()).toBe(false);
        expect(externalCalls).toBe(0);
        expect((yield* workflow.capacity.get(workflow.operationId))?.state).toBe("waiting");
        expect((yield* workflow.capacity.get(personal.operationId))?.state).toBe("reserved");
        expect(
          yield* makeThreadVmProvisionStore(workflow.sql).claim(NodeCrypto.randomUUID(), hostId),
        ).toBeNull();
        for (const fixture of [workflow, personal])
          yield* fixture.sql`INSERT INTO relay_thread_deletions
            (thread_id,operation_id,owner_user_id,requester_user_id,generation,host_id,phase)
            VALUES(${fixture.threadId},${NodeCrypto.randomUUID()},${fixture.ownerUserId},${fixture.ownerUserId},1,${hostId},'stopping')`;
        expect(yield* makeThreadDeletionStore(workflow.sql).claim(hostId)).toMatchObject({
          threadId: personal.threadId,
        });
        const [untouched] = yield* workflow.sql<{
          claimId: string | null;
        }>`SELECT claim_id AS "claimId" FROM relay_thread_deletions WHERE thread_id=${workflow.threadId}`;
        expect(untouched?.claimId).toBeNull();
      }),
    );

    it.effect(
      "uses default ten, keeps uncertain and warm slots charged, and releases only confirmed capacity",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const organizationId = NodeCrypto.randomUUID();
          const entries = yield* Effect.forEach(Array.from({ length: 11 }), () =>
            seed({ hostId, organizationId }),
          );
          const first = entries[0]!;
          for (let index = 0; index < 10; index++)
            expect(yield* first.capacity.admitNext(hostId, "all")).not.toBeNull();
          expect(yield* first.capacity.admitNext(hostId, "all")).toBeNull();
          yield* first.capacity.beginExecution(first.operationId);
          yield* first.sql`UPDATE relay_workflow_jobs SET status='done' WHERE job_id=${first.workflowJobId}`;
          expect(yield* first.capacity.admitNext(hostId, "all")).toBeNull();
          expect(yield* Effect.isFailure(first.capacity.cancelUnstarted(first.operationId))).toBe(
            true,
          );
          yield* first.capacity.cancelUnstarted(entries[1]!.operationId);
          expect((yield* first.capacity.admitNext(hostId, "all"))?.operationId).toBe(
            entries[10]!.operationId,
          );
        }),
    );

    it.effect("skips organization-blocked head demand without bypassing eligible FIFO", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const blocked = yield* seed({ hostId });
        yield* makeThreadVmPolicyStore(blocked.sql).updateWorkflow({
          organizationId: blocked.organizationId,
          revision: 1,
          maxRunningVms: 0,
        });
        const next = yield* seed({ hostId });
        const last = yield* seed({ hostId, personal: true });
        expect((yield* next.capacity.admitNext(hostId, "all"))?.operationId).toBe(next.operationId);
        expect((yield* last.capacity.admitNext(hostId, "all"))?.operationId).toBe(last.operationId);
        expect((yield* blocked.capacity.get(blocked.operationId))?.state).toBe("waiting");
      }),
    );

    it.effect("serializes cross-host create and resume against one organization allowance", () =>
      Effect.gen(function* () {
        const organizationId = NodeCrypto.randomUUID();
        const create = yield* seed({ hostId: NodeCrypto.randomUUID(), organizationId });
        const resume = yield* seed({
          hostId: NodeCrypto.randomUUID(),
          organizationId,
          kind: "resume",
        });
        yield* makeThreadVmPolicyStore(create.sql).updateWorkflow({
          organizationId,
          revision: 1,
          maxRunningVms: 1,
        });
        const results = yield* Effect.all(
          [
            create.capacity.admitNext(create.hostId, "all"),
            resume.capacity.admitNext(resume.hostId, "all"),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        yield* makeThreadVmPolicyStore(create.sql).updateWorkflow({
          organizationId,
          revision: 2,
          maxRunningVms: 0,
        });
        const admitted = results.find((row) => row !== null)!;
        expect((yield* create.capacity.get(admitted.operationId))?.state).toBe("reserved");
        expect(yield* create.capacity.admitNext(create.hostId, "all")).toBeNull();
        expect(yield* resume.capacity.admitNext(resume.hostId, "all")).toBeNull();
      }),
    );

    it.effect("keeps the host ceiling across organizations and personal resources", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const first = yield* seed({ hostId });
        const second = yield* seed({ hostId, personal: true });
        yield* first.capacity.configure(hostId, 1);
        const results = yield* Effect.all(
          Array.from({ length: 6 }, () => first.capacity.admitNext(hostId, "all")),
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.operationId).toBe(first.operationId);
        expect((yield* second.capacity.get(second.operationId))?.state).toBe("waiting");
      }),
    );

    it.effect(
      "allows private FK requests to progress while admission holds host and organization locks",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const workflow = yield* seed({ hostId });
          const personal = yield* seed({
            hostId,
            organizationId: workflow.organizationId,
            personal: true,
          });
          const policies = makeThreadVmPolicyStore(workflow.sql);
          yield* policies.updateWorkflow({
            organizationId: workflow.organizationId,
            revision: 1,
            maxRunningVms: 10,
          });
          yield* personal.capacity.cancelUnstarted(personal.operationId);
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const admission = yield* workflow.sql
            .withTransaction(
              Effect.gen(function* () {
                const admitted = yield* workflow.capacity.admitNext(hostId, "all");
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
                return admitted;
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(held);
          const edit = yield* policies
            .updateWorkflow({
              organizationId: workflow.organizationId,
              revision: 2,
              maxRunningVms: 0,
            })
            .pipe(Effect.forkScoped);
          const nextOperationId = NodeCrypto.randomUUID();
          yield* personal.sql.withTransaction(
            Effect.gen(function* () {
              yield* personal.sql`SELECT organization_id FROM relay_thread_vm_policies WHERE organization_id=${workflow.organizationId} FOR SHARE`;
              yield* personal.capacity.request({
                operationId: nextOperationId,
                allocationId: personal.allocationId,
                hostId,
                kind: "create",
              });
            }),
          );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(admission))?.operationId).toBe(workflow.operationId);
          expect((yield* Fiber.join(edit)).maxRunningVms).toBe(0);
          expect((yield* personal.capacity.get(nextOperationId))?.state).toBe("waiting");
        }),
    );
    it.effect(
      "selects only unfinished terminal VM saves and requested retries with the existing scopes",
      () =>
        Effect.gen(function* () {
          const store = yield* Workflows;
          for (const status of ["done", "failed", "cancelled"] as const) {
            for (const automatic of [false, true]) {
              const f = yield* activeWorkflow(automatic);
              const current = (yield* store.getJob(f.workflowJobId))!;
              const occurrenceId =
                current.record.origin?.kind === "automation"
                  ? current.record.origin.occurrenceId
                  : NodeCrypto.randomUUID();
              const connectionId =
                current.record.origin?.kind === "automation"
                  ? current.record.origin.source.connectionId
                  : NodeCrypto.randomUUID();
              const record = {
                ...current.record,
                status,
                requiredProtocol: 9,
                progress: {
                  revision: 1,
                  threadId: ThreadId.make(f.threadId),
                  status,
                  detail: null,
                  checkpoint: null,
                  hasThread: true,
                  executionReleased: true,
                  resultSaving: {
                    publicationId: NodeCrypto.randomUUID(),
                    resultId: null,
                    state: "saving" as const,
                    detail: null,
                    retryable: false,
                  },
                },
              };
              yield* f.sql`UPDATE relay_workflow_jobs SET status=${status},record=${f.sql.json(record)},submitter_user_id=${automatic ? null : f.ownerUserId} WHERE job_id=${f.workflowJobId}`;
              yield* f.sql`INSERT INTO relay_workflow_admissions VALUES(${occurrenceId},${record.workflowId},${f.workflowJobId},${f.organizationId},${f.repositoryId},${connectionId},'grant',1,1,1,1)`;
              const ids = (scope = {}) =>
                store.pendingJobs(scope).pipe(Effect.map((rows) => rows.map((row) => row.jobId)));
              expect(yield* ids()).toContain(f.workflowJobId);
              expect(yield* ids({ occurrenceId })).toEqual([f.workflowJobId]);
              expect(yield* ids({ connectionId })).toEqual([f.workflowJobId]);
              expect(yield* ids({ occurrenceId: "another-event" })).not.toContain(f.workflowJobId);
              expect(yield* ids({ connectionId: "another-connection" })).not.toContain(
                f.workflowJobId,
              );
              expect(yield* ids({ environmentId: "another-environment" })).not.toContain(
                f.workflowJobId,
              );
              yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{progress,resultSaving,state}','"failed"') WHERE job_id=${f.workflowJobId}`;
              expect(yield* ids({ occurrenceId })).toEqual([]);
              const retry = {
                userId: f.ownerUserId,
                response: {
                  operation: "retry_saving",
                  publicationId: record.progress.resultSaving.publicationId,
                  expectedRevision: 1,
                },
              };
              yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json(retry)} WHERE job_id=${f.workflowJobId}`;
              expect(yield* ids({ occurrenceId })).toEqual([f.workflowJobId]);
              yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=NULL,record=record #- '{progress,resultSaving}' WHERE job_id=${f.workflowJobId}`;
              expect(yield* ids({ occurrenceId })).toEqual([]);
            }
          }
        }).pipe(Effect.provide(workflows)),
    );

    it.effect(
      "reconciles automatic terminal save, failure, retry and acknowledgement through the worker without reopening execution",
      () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow(true);
          const current = yield* (yield* Workflows).getJob(f.workflowJobId);
          const origin = current!.record.origin!;
          if (origin.kind !== "automation") return yield* Effect.die("Expected automatic fixture");
          const occurrenceId = origin.occurrenceId;
          const connectionId = origin.source.connectionId;
          const publicationId = NodeCrypto.randomUUID();
          const record = {
            ...current!.record,
            status: "cancelled" as const,
            requiredProtocol: 9,
            progress: {
              revision: 1,
              threadId: ThreadId.make(f.threadId),
              status: "cancelled" as const,
              detail: null,
              checkpoint: null,
              hasThread: true,
              executionReleased: true,
              resultSaving: {
                publicationId,
                resultId: null,
                state: "saving" as const,
                detail: null,
                retryable: false,
              },
            },
          };
          yield* f.sql`UPDATE relay_workflow_jobs SET status='cancelled',record=${f.sql.json(record)},submitter_user_id=NULL WHERE job_id=${f.workflowJobId}`;
          yield* f.sql`INSERT INTO relay_workflow_admissions VALUES(${occurrenceId},${record.workflowId},${f.workflowJobId},${f.organizationId},${f.repositoryId},${connectionId},'grant',1,1,1,1)`;
          const operations: string[] = [];
          const wakeScopes: unknown[] = [];
          let saving: WorkflowResultSaving | undefined = {
            ...record.progress.resultSaving,
            state: "failed",
            retryable: true,
            detail: "Upload failed",
          };
          const proof = Effect.gen(function* () {
            const store = yield* Workflows;
            const context =
              yield* Effect.context<
                Effect.Services<ReturnType<typeof deliverPendingWorkflowJobs>>
              >();
            const wake = {
              wake: (scope?: WorkflowDispatchScope) => {
                wakeScopes.push(scope);
                return deliverPendingWorkflowJobs(scope).pipe(Effect.provide(context));
              },
            };
            yield* refreshWorkflowJobForClient(f.workflowJobId).pipe(
              Effect.provideService(WorkflowWake, wake),
            );
            let saved = (yield* store.getJob(f.workflowJobId))!;
            expect(saved.record.progress?.resultSaving?.state).toBe("failed");
            expect(yield* store.pendingJobs({ occurrenceId })).toHaveLength(0);
            saving = { ...record.progress.resultSaving };
            yield* respondToWorkflowJob(
              { repositoryId: f.repositoryId, jobId: f.workflowJobId },
              {
                operation: "retry_saving",
                publicationId,
                expectedRevision: saved.record.progress!.revision,
              },
            ).pipe(
              Effect.provideService(WorkflowWake, wake),
              Effect.provideService(RelayClientPrincipal, { userId: f.ownerUserId, token: "test" }),
            );
            saved = (yield* store.getJob(f.workflowJobId))!;
            expect(saved.pendingControl).toBeNull();
            expect(saved.record.progress?.resultSaving?.state).toBe("saving");
            saving = undefined;
            // The periodic worker also settles storage without an open client view.
            yield* deliverPendingWorkflowJobs({ occurrenceId });
            saved = (yield* store.getJob(f.workflowJobId))!;
            expect(saved.record.progress?.resultSaving).toBeUndefined();
            expect(saved.record.status).toBe("cancelled");
            expect(saved.record.progress?.status).toBe("cancelled");
            expect(saved.record.progress?.revision).toBe(1);
            expect(yield* store.pendingJobs({ occurrenceId })).toHaveLength(0);
            expect(operations).toEqual(["status", "retry_saving", "status"]);
            expect(wakeScopes).toEqual([{ occurrenceId }, { occurrenceId }]);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentConnector)({
                  dispatchJob: (input) =>
                    Effect.sync(() => {
                      operations.push(input.workflowControl!.operation);
                      return {
                        accepted: true,
                        workflowResult: {
                          protocol: 9,
                          outcome: "accepted",
                          detail: null,
                          // A guest cannot reopen terminal execution, even with a newer revision.
                          progress: {
                            ...record.progress,
                            revision: 2,
                            status: "running",
                            resultSaving: saving,
                          },
                        },
                      };
                    }),
                }),
                Layer.mock(Organizations)({
                  getMembershipForUser: ({ userId }) =>
                    Effect.succeed({
                      userId,
                      role: "admin",
                      joinedAt: "now",
                      organization: {
                        organizationId: f.organizationId,
                        name: "Test",
                        createdAt: "now",
                      },
                    }),
                }),
                Layer.mock(Repositories)({
                  getById: () =>
                    Effect.succeed({
                      repositoryId: f.repositoryId,
                      organizationId: f.organizationId,
                      name: "Test",
                      canonicalKeys: [],
                      createdAt: "now",
                    }),
                  getAccess: () => Effect.succeed("maintainer"),
                }),
                Layer.mock(Machines)({}),
                Layer.mock(OrganizationProjectCatalog)({}),
                Layer.succeed(WorkflowVmPreparation, {
                  advance: () =>
                    Effect.die(
                      "Storage reconciliation cannot provision, resume, run setup or start an Agent",
                    ),
                }),
              ),
            ),
          );
          yield* proof;
        }).pipe(Effect.provide(workflows)),
    );
  });
});
