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
import {
  confirmThreadVmRestoreActivation,
  getThreadVmRestoreRecovery,
  readThreadVmRestoreArtifact,
} from "../http/ThreadVmRestoreRecoveryApi.ts";
import {
  EnvironmentCredentials,
  layer as environmentCredentials,
} from "../environments/EnvironmentCredentials.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeLocalThreadArtifactObjects } from "./ThreadArtifactLocalObjects.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadVmActivityWorker } from "./ThreadVmActivityWorker.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { makeThreadVmBackupStore } from "./ThreadVmBackupStore.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmFinalSaveDeletionWorker } from "./ThreadVmFinalSaveDeletionWorker.ts";
import { makeThreadVmFinalSaveWorker } from "./ThreadVmFinalSaveWorker.ts";
import { makeThreadVmFinalSaveStore } from "./ThreadVmFinalSaveStore.ts";
import { makeThreadVmRestoreServingStore } from "./ThreadVmRestoreServingStore.ts";
import { makeThreadVmRestoreServingWorker } from "./ThreadVmRestoreServingWorker.ts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import { makeThreadVmRestoreImportStore } from "./ThreadVmRestoreImportStore.ts";
import { makeThreadVmRestoreWorker } from "./ThreadVmRestoreWorker.ts";
import { makeThreadVmRestoreStore } from "./ThreadVmRestoreStore.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeWorkflowVmRecovery, readWorkflowVmRecoveries } from "./WorkflowVmRecovery.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmResumeWorker } from "./ThreadVmResumeWorker.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmCancelledSetupCleanupWorker } from "./ThreadVmCancelledSetupCleanupWorker.ts";
import { makeThreadVmServerWorker } from "./ThreadVmServerWorker.ts";
import { makeThreadVmSetupStore } from "./ThreadVmSetupStore.ts";
import { makeThreadVmSetupWorker } from "./ThreadVmSetupWorker.ts";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { E2BRestoreError } from "../machines/E2BRestoreClient.ts";
import { makeThreadVmPolicyStore } from "./ThreadVmPolicy.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import {
  advanceWorkflowVmPreparation,
  workflowVmPreparationLayer,
} from "../jobs/WorkflowVmPreparation.ts";
import type {
  RepositoryWorkflowJob,
  WorkflowResultSaving,
  WorkflowSavedResult,
  WorkflowVmDispatchBinding,
  WorkflowVmPublishingRequest,
} from "@t3tools/contracts/workflows";
import {
  handleWorkflowVmPublishing,
  readWorkflowVmPublishing,
} from "../jobs/WorkflowVmPublishing.ts";
import {
  EnvironmentConnector,
  EnvironmentMintRequestTimedOut,
} from "../environments/EnvironmentConnector.ts";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { RelayConfiguration } from "../Config.ts";
import { Organizations, layer as organizations } from "../tenancy/Organizations.ts";
import { Repositories, layer as repositories } from "../tenancy/Repositories.ts";
import { Machines } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { WorkflowVmPreparation } from "../jobs/WorkflowVmPreparation.ts";
import { deliverPendingWorkflowJobs, refreshWorkflowJob } from "../jobs/WorkflowDispatcher.ts";
import { WorkflowWake } from "../jobs/WorkflowWake.ts";
import { refreshWorkflowJobForClient, respondToWorkflowJob } from "../http/WorkflowsApi.ts";
import { Workflows, type WorkflowDispatchScope, layer as workflows } from "../jobs/Workflows.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import * as AutomaticOffers from "../workflowEvents/AutomaticOffer.ts";
import { config as relayConfig } from "../workflowSources/test-fixture.ts";
import {
  admitPortableThreadWork,
  cancelThreadVmPause,
  completePortableThreadWork,
  confirmThreadVmPauseActivation,
  freezeThreadVmPause,
  getThreadVmPause,
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
  stableWorkflowIdentity?: boolean;
  kind?: "create" | "resume";
}) {
  const sql = yield* PgClient.PgClient;
  const organizationId = input.organizationId ?? NodeCrypto.randomUUID();
  const repositoryId = NodeCrypto.randomUUID();
  const workflowJobId = NodeCrypto.randomUUID();
  const threadId = input.personal ? NodeCrypto.randomUUID() : `workflow:${workflowJobId}`;
  const allocationId = input.stableWorkflowIdentity ? workflowJobId : NodeCrypto.randomUUID();
  const operationId = input.stableWorkflowIdentity ? workflowJobId : NodeCrypto.randomUUID();
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
              applicationId: input.stableWorkflowIdentity ? `app:${organizationId}` : "app",
              workspaceId: "workspace",
              connectionId: NodeCrypto.randomUUID(),
              grantId: input.stableWorkflowIdentity ? NodeCrypto.randomUUID() : "grant",
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

const activeWorkflow = Effect.fnUntraced(function* (
  automatic = false,
  stableWorkflowIdentity = false,
) {
  const f = yield* seed({ hostId: NodeCrypto.randomUUID(), automatic, stableWorkflowIdentity });
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

const installLinearAdmission = Effect.fnUntraced(function* (
  f: Effect.Success<ReturnType<typeof seed>>,
) {
  const { sql, workflowJobId, organizationId, repositoryId } = f;
  const [job] = yield* sql<{
    record: RepositoryWorkflowJob;
  }>`SELECT record FROM relay_workflow_jobs WHERE job_id=${workflowJobId}`;
  const record = job!.record;
  const origin = record.origin!;
  if (origin.kind !== "automation") return yield* Effect.die("Expected an automatic workflow");
  const source = origin.source;
  const linearWorkflow = { clientId: source.applicationId, organizationId };
  const codexConnectionId = record.vmAdmission?.codexConnectionId ?? NodeCrypto.randomUUID();
  const event = {
    issueId: "issue",
    teamId: "team",
    stateId: "ready",
    labelIds: [],
    identifier: "ENG-1",
    title: "Original title",
    url: "https://linear.app/test/issue/ENG-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    issueUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
  yield* sql`INSERT INTO relay_organizations VALUES (${organizationId},'Organization','2026','2026')`;
  yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
    VALUES (${repositoryId},${organizationId},'Repository','2026','2026') ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO relay_repository_workflows (workflow_id,repository_id,revision,record)
    VALUES (${record.workflowId},${repositoryId},1,${sql.json(record.workflow!)})`;
  yield* sql`INSERT INTO relay_codex_vm_connections
    (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
    VALUES (${organizationId},${codexConnectionId},'issuer','subject','client','connected','sealed','2099-01-01','2026')`;
  yield* sql`INSERT INTO relay_workflow_authorizations (organization_id,application_id,connection_id,status)
    VALUES (${organizationId},${source.applicationId},${source.connectionId},'connected')`;
  yield* sql`INSERT INTO relay_workflow_connections
    (connection_id,organization_id,application_id,workspace_id,workspace_name,viewer_name,status,activated_at,payload_sealed,health)
    VALUES (${source.connectionId},${organizationId},${source.applicationId},${source.workspaceId},'Workspace',
      'Linear App','connected','2026','sealed','{"code":"healthy","retryAt":null}')`;
  yield* sql`INSERT INTO relay_workflow_repository_grants (grant_id,connection_id,organization_id,repository_id,generation,created_at)
    VALUES (${source.grantId},${source.connectionId},${organizationId},${repositoryId},1,'2026')`;
  yield* sql`INSERT INTO relay_workflow_admissions
    VALUES (${origin.occurrenceId},${record.workflowId},${workflowJobId},${organizationId},${repositoryId},
      ${source.connectionId},${source.grantId},1,1,1,1)`;
  yield* sql`UPDATE relay_workflow_jobs SET status='preparing',repository_canonical_key='github.com/acme/example',record=${sql.json(
    {
      ...record,
      event,
      status: "preparing",
      startAttempted: false,
      vmAdmission: { codexConnectionId, hasSecrets: true },
    },
  )} WHERE job_id=${workflowJobId}`;
  return { linearWorkflow, source, codexConnectionId, event };
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

const refreshAutomaticVm = (
  f: Effect.Success<ReturnType<typeof seed>>,
  linearWorkflow: NonNullable<RelayConfiguration["Service"]["linearWorkflow"]>,
  issueResponse: Effect.Effect<Response>,
  dispatchJob: EnvironmentConnector["Service"]["dispatchJob"],
  workflowExecutionEnabled = true,
) =>
  refreshWorkflowJob(f.workflowJobId).pipe(
    Effect.provide(
      Layer.merge(AutomaticOffers.layer, workflowVmPreparationLayer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(EnvironmentConnector)({ dispatchJob }),
            Layer.mock(Organizations)({}),
            Layer.mock(Repositories)({}),
            Layer.mock(Machines)({}),
            Layer.mock(OrganizationProjectCatalog)({}),
            Layer.mock(GithubApp)({}),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((req) =>
                issueResponse.pipe(
                  Effect.map((response) => HttpClientResponse.fromWeb(req, response)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.provideService(RelaySecretBox, {
      seal: () => Effect.die("Issue reads should not seal credentials"),
      open: () =>
        Effect.succeed(
          JSON.stringify({
            accessToken: "fixture",
            refreshToken: "fixture",
            expiresAt: 4_102_444_800_000,
          }),
        ),
    }),
    Effect.provideService(RelayConfiguration, { ...relayConfig, linearWorkflow }),
    Effect.provideService(ThreadVmRuntimeConfiguration, {
      settings: {
        workflowExecutionEnabled,
        hostId: f.hostId,
        maxRunningVms: 1,
        templateBuildId: "build",
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
  );

const issueResponse = (title: string) =>
  Response.json({
    data: {
      organization: { id: "workspace" },
      issue: {
        id: "issue",
        identifier: "ENG-1",
        title,
        url: "https://linear.app/test/issue/ENG-1",
        description: "Current requirements",
        updatedAt: "2026-01-01T00:00:00.000Z",
        team: { id: "team", name: "Team" },
        state: { id: "done", name: "Done" },
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    },
  });

const pausedSandbox = (
  computeRef: string,
  allocationId: string,
  operationId: string,
  threadId: string,
  generation = 1,
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
    "launchpad.generation": String(generation),
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
    it.effect(
      "keeps provider-paused publishing owned and requires a matching backup after source loss",
      () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          const { sql, workflowJobId, organizationId, ownerUserId, threadId, allocationId } = f;
          const fs = yield* FileSystem.FileSystem;
          const objects = makeLocalThreadArtifactObjects(fs, yield* fs.makeTempDirectoryScoped());
          const workflowStore = yield* Workflows;
          const job = (yield* workflowStore.getJob(workflowJobId))!.record;
          const push = {
            kind: "action",
            id: "push",
            title: "Push branch",
            action: "push",
          } as const;
          const actionId = `workflow:${workflowJobId}:action:push:0`;
          const action = {
            actionId,
            stepId: push.id,
            generation: 0,
            operation: "push",
            state: "uncertain",
            detail: null,
            commitSha: "a".repeat(40),
            pullRequestUrl: null,
            retryable: true,
          } as const;
          const record: RepositoryWorkflowJob = {
            ...job,
            status: "paused",
            workflow: {
              ...job.workflow!,
              definition: {
                ...job.workflow!.definition,
                steps: [...job.workflow!.definition.steps, push],
              },
            },
            progress: {
              revision: 5,
              status: "paused",
              threadId: ThreadId.make(threadId),
              checkpoint: null,
              detail: null,
              stepId: push.id,
              generation: 0,
              actions: [action],
            },
          };
          yield* sql`INSERT INTO relay_organizations VALUES(${organizationId},'Organization','2026','2026')`;
          yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
          const retry = () =>
            sql.json({
              userId: ownerUserId,
              responseId: NodeCrypto.randomUUID(),
              response: { operation: "retry_action", actionId, expectedRevision: 5 },
            });
          yield* sql`UPDATE relay_workflow_jobs SET status='paused',record=${sql.json(record)},pending_control=${retry()}
            WHERE job_id=${workflowJobId}`;
          yield* sql`INSERT INTO relay_workflow_vm_publications(job_id,action_id,record) VALUES(${workflowJobId},${actionId},${sql.json(
            {
              ...action,
              stepGeneration: 0,
              resultTurnId: "turn",
              checkpointRef: "refs/t3/result",
              tree: "b".repeat(40),
              parent: "c".repeat(40),
              oldRemoteSha: null,
              canonicalKey: "github.com/acme/example",
              installationId: "1",
              branch: "launchpad/test",
              baseBranch: "main",
              recoverySource: null,
              outcome: null,
              binding: {
                ...f.principal.threadVm,
                environmentId: f.owner.environmentId,
                jobId: workflowJobId,
                organizationId,
                operationId: f.operationId,
                projectId: `vm:${threadId}`,
              },
            },
          )})`;
          const commandId = NodeCrypto.randomUUID();
          yield* sql`INSERT INTO relay_workflow_vm_publish_commands(command_id,job_id,action_id,allocation_id,generation,pid,process_identity)
          VALUES(${commandId},${workflowJobId},${actionId},${allocationId},1,42,'native-owner')`;
          const [allocation] = yield* sql<{ computeRef: string }>`SELECT compute_ref AS "computeRef"
          FROM relay_thread_vm_allocations WHERE allocation_id=${allocationId}`;
          yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',native_paused_generation=1
            WHERE allocation_id=${allocationId}`;
          yield* sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE allocation_id=${allocationId}`;
          const recover = makeWorkflowVmRecovery(sql, objects);
          const parked = (yield* workflowStore.claim(workflowJobId))!;
          const blocked = yield* recover.advance(parked, parked.leaseUntil!, () =>
            Effect.die("A paused native publishing command must keep its ownership."),
          );
          expect(blocked?.vmRecovery?.detail).toContain("confirm that publishing stopped");
          expect(blocked?.detail).toContain("Saved results are still available");
          expect(blocked?.progress?.executionReleased).not.toBe(true);
          expect((yield* workflowStore.getJob(workflowJobId))?.pendingControl).toBeNull();
          expect(
            yield* sql`SELECT 1 FROM relay_workflow_vm_publish_commands
            WHERE command_id=${commandId} AND stopped_at IS NULL`,
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT 1 FROM relay_thread_vm_capacity
            WHERE allocation_id=${allocationId} AND state<>'released'`,
          ).toEqual([]);
          expect(
            yield* sql`SELECT 1 FROM relay_thread_vm_restores WHERE thread_id=${threadId}`,
          ).toEqual([]);
          yield* workflowStore.release(workflowJobId, parked.leaseUntil!);
          yield* sql`UPDATE relay_workflow_jobs SET pending_control=${retry()} WHERE job_id=${workflowJobId}`;
          expect(
            yield* makeThreadVmFinalSaveStore(sql, objects).reconcileMissingWorkflowSource({
              allocationId,
              threadId,
              hostId: f.hostId,
              generation: 1,
              computeRef: allocation!.computeRef,
              provisionOperationId: f.operationId,
            }),
          ).toBe(true);
          const claimed = (yield* workflowStore.claim(workflowJobId))!;
          const unavailable = yield* recover.advance(claimed, claimed.leaseUntil!);
          expect(unavailable?.vmRecovery?.state).toBe("recovery_error");
          expect(
            yield* sql`SELECT operation_id FROM relay_thread_vm_restores WHERE thread_id=${threadId}`,
          ).toEqual([]);
          expect((yield* workflowStore.getJob(workflowJobId))?.pendingControl).toBeNull();
          yield* workflowStore.release(workflowJobId, claimed.leaseUntil!);
          yield* sql`UPDATE relay_workflow_jobs SET status='cancelling',record=jsonb_set(record,'{status}','"cancelling"'::jsonb),
          pending_control=${sql.json({ userId: ownerUserId, response: { operation: "cancel" } })} WHERE job_id=${workflowJobId}`;
          const cancelling = (yield* workflowStore.claim(workflowJobId))!;
          const cancelled = yield* recover.advance(cancelling, cancelling.leaseUntil!);
          expect(cancelled?.status).toBe("cancelled");
          expect(cancelled?.progress?.executionReleased).toBe(true);
          expect(cancelled?.publicationOutcome?.state).toBe("unknown");
        }).pipe(Effect.provide(Layer.merge(workflows, NodeFileSystem.layer))),
    );

    it.effect("cold publishing Retry catalogs a pinned backup once after source loss", () =>
      Effect.gen(function* () {
        const f = yield* activeWorkflow();
        const {
          sql,
          allocationId,
          organizationId,
          ownerUserId,
          repositoryId,
          threadId,
          workflowJobId,
        } = f;
        const fs = yield* FileSystem.FileSystem;
        const objects = makeLocalThreadArtifactObjects(fs, yield* fs.makeTempDirectoryScoped());
        const store = yield* Workflows;
        const job = (yield* store.getJob(workflowJobId))!.record;
        const { computeRef } = (yield* makeThreadVmAllocationStore(sql).getAny(allocationId))!;
        const backupOperationId = NodeCrypto.randomUUID();
        const retentionOperationId = NodeCrypto.randomUUID();
        const captureOperationId = NodeCrypto.randomUUID();
        const nativeCheckpointOperationId = NodeCrypto.randomUUID();
        const attachmentOperationId = NodeCrypto.randomUUID();
        const publicationId = NodeCrypto.randomUUID();
        const workflowCheckpoint = {
          jobId: workflowJobId,
          checkpointId: "review-before-publishing",
          checkpointGeneration: 0,
          publicationId,
          publicationRevision: 1,
        };
        const binding = {
          ...f.principal.threadVm,
          jobId: workflowJobId,
          organizationId,
          environmentId: f.owner.environmentId,
          operationId: f.operationId,
          projectId: `vm:${threadId}`,
        };
        const sha256 = "a".repeat(64);
        const manifests = [
          { operationId: nativeCheckpointOperationId, artifactId: NodeCrypto.randomUUID() },
          { operationId: attachmentOperationId, artifactId: NodeCrypto.randomUUID() },
        ] as const;
        // Seed the already verified conversation and attachment manifests. The restore checks both pins.
        for (const { operationId, artifactId } of manifests) {
          yield* sql`INSERT INTO relay_thread_artifacts
            (artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
            VALUES(${artifactId},${threadId},${operationId},'manifest',${artifactId},${sha256},1,'complete')`;
          yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id)
            VALUES(${artifactId},${`native-checkpoint:${nativeCheckpointOperationId}`})`;
        }
        const point = {
          sourceEnvironmentId: f.owner.environmentId,
          generation: 1,
          sourceSequence: 0,
          nativeThreadId: NodeCrypto.randomUUID(),
        };
        yield* sql`INSERT INTO relay_thread_native_checkpoints
          (operation_id,thread_id,turn_id,capture_operation_id,source_environment_id,generation,source_sequence,
            native_thread_id,native_manifest_sha256,archive_sha256,manifest_artifact_id,manifest_sha256,artifact_count)
          VALUES(${nativeCheckpointOperationId},${threadId},'agent-turn',${captureOperationId},
            ${point.sourceEnvironmentId},${point.generation},${point.sourceSequence},${point.nativeThreadId},
            ${sha256},${sha256},${manifests[0].artifactId},${sha256},2)`;
        yield* sql`INSERT INTO relay_thread_attachment_checkpoints
          (native_checkpoint_operation_id,operation_id,manifest_artifact_id,manifest_sha256,attachment_manifest_sha256,artifact_count)
          VALUES(${nativeCheckpointOperationId},${attachmentOperationId},${manifests[1].artifactId},${sha256},${sha256},1)`;
        yield* sql`INSERT INTO relay_workflow_recovery_records
          (publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest)
          VALUES(${publicationId},${workflowJobId},${threadId},1,${NodeCrypto.randomUUID()},${sha256},1,${sql.json({ binding })})`;
        yield* sql`INSERT INTO relay_thread_vm_backups
          (operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,source_receipt)
          VALUES(${backupOperationId},${allocationId},1,${computeRef},${backupOperationId},'pending',${sql.json(
            {
              allocationId,
              computeRef,
              threadId,
              generation: 1,
              environmentId: f.owner.environmentId,
              provisionOperationId: f.operationId,
              captureOperationId,
              bootId: NodeCrypto.randomUUID(),
              sealEpoch: 1,
              sourceSequence: point.sourceSequence,
              nativeCheckpointOperationId,
              workflowCheckpoint,
            },
          )})`;
        const backups = makeThreadVmBackupStore(sql);
        const capture = (yield* backups.claim(f.hostId))!;
        expect(yield* backups.beginCapture(capture)).toBe(true);
        const sourceBuildId = NodeCrypto.randomUUID();
        expect(
          yield* backups.recordCapture(capture, {
            snapshotId: backupOperationId,
            sourceTemplateId: backupOperationId,
            sourceBuildId,
          }),
        ).toBe(true);
        yield* makeThreadVmBackupRetentionStore(sql).pin({
          threadId,
          backupOperationId,
          operationId: retentionOperationId,
        });
        yield* makeThreadNativeCheckpointStore(sql, objects).pinCompleteForOperation({
          threadId,
          operationId: retentionOperationId,
          checkpointOperationId: nativeCheckpointOperationId,
          expected: point,
        });

        const step = {
          kind: "action",
          id: "open-pr",
          title: "Open PR",
          action: "open_pull_request",
        } as const;
        const push = { kind: "action", id: "push", title: "Push branch", action: "push" } as const;
        const actionId = `workflow:${workflowJobId}:action:${step.id}:0`;
        const action = {
          actionId,
          stepId: step.id,
          generation: 0,
          operation: step.action,
          state: "uncertain",
          detail: null,
          commitSha: "b".repeat(40),
          pullRequestUrl: "https://github.com/acme/example/pull/1",
          retryable: true,
        } as const;
        const record: RepositoryWorkflowJob = {
          ...job,
          status: "paused",
          workflow: {
            ...job.workflow!,
            definition: {
              ...job.workflow!.definition,
              steps: [...job.workflow!.definition.steps, push, step],
            },
          },
          progress: {
            revision: 5,
            status: "paused",
            threadId: ThreadId.make(threadId),
            checkpoint: null,
            detail: null,
            stepId: step.id,
            generation: 0,
            actions: [action],
          },
        };
        yield* sql`UPDATE relay_workflow_jobs SET status='paused',record=${sql.json(record)} WHERE job_id=${workflowJobId}`;
        yield* sql`INSERT INTO relay_workflow_vm_publications(job_id,action_id,record)
          VALUES(${workflowJobId},${actionId},${sql.json({
            ...action,
            stepGeneration: 0,
            resultTurnId: "agent-turn",
            checkpointRef: "refs/t3/result",
            tree: "c".repeat(40),
            parent: "a".repeat(40),
            oldRemoteSha: action.commitSha,
            canonicalKey: "github.com/acme/example",
            installationId: "1",
            branch: `launchpad/${workflowJobId}`,
            baseBranch: "main",
            binding,
            recoverySource: { backupOperationId, retentionOperationId },
            outcome: null,
          })})`;
        yield* sql`INSERT INTO relay_organizations VALUES(${organizationId},'Organization','2026','2026')`;
        yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
        yield* sql`INSERT INTO relay_thread_vm_policies(organization_id) VALUES(${organizationId}) ON CONFLICT DO NOTHING`;
        expect(
          yield* makeThreadVmFinalSaveStore(sql, objects).reconcileMissingWorkflowSource({
            allocationId,
            threadId,
            hostId: f.hostId,
            generation: 1,
            computeRef: computeRef!,
            provisionOperationId: f.operationId,
          }),
        ).toBe(true);
        expect(
          yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks WHERE thread_id=${threadId}`,
        ).toEqual([]);

        const retry = respondToWorkflowJob(
          { repositoryId, jobId: workflowJobId },
          { operation: "retry_action", actionId, expectedRevision: 5 },
        ).pipe(
          Effect.provideService(RelayClientPrincipal, { userId: ownerUserId, token: "test" }),
          Effect.provideService(ThreadArtifactObjectStorage, objects),
          Effect.provide(
            Layer.mergeAll(
              organizations,
              repositories,
              Layer.mock(EnvironmentConnector)({ dispatchJob: () => Effect.die("Source is gone") }),
              Layer.mock(Machines)({}),
              Layer.mock(OrganizationProjectCatalog)({}),
            ),
          ),
        );
        expect((yield* retry).responsePending).toBe(true);
        const retryId = (yield* store.getJob(workflowJobId))!.pendingControl!.responseId!;
        expect((yield* retry).responsePending).toBe(true);
        expect((yield* store.getJob(workflowJobId))!.pendingControl?.responseId).toBe(retryId);
        const disks = yield* sql<{ operationId: string }>`SELECT d.operation_id AS "operationId",
          d.backup_operation_id AS "backupOperationId",d.restore_operation_id AS "restoreOperationId",
          s.completed_at=a.deleted_at::timestamptz AS "usesSourceDeletionTime"
          FROM relay_thread_vm_saved_disks d JOIN relay_thread_vm_final_saves s USING(operation_id)
          JOIN relay_thread_vm_allocations a ON a.allocation_id=s.allocation_id
          WHERE d.thread_id=${threadId}`;
        expect(disks).toEqual([
          {
            operationId: expect.any(String),
            backupOperationId,
            restoreOperationId: retryId,
            usesSourceDeletionTime: true,
          },
        ]);
        expect(
          yield* sql`SELECT operation_id AS "operationId",allocation_id AS "allocationId",
          saved_disk_operation_id AS "savedDiskOperationId", phase
          FROM relay_thread_vm_restores WHERE thread_id=${threadId}`,
        ).toEqual([
          {
            operationId: retryId,
            allocationId: retryId,
            savedDiskOperationId: disks[0]!.operationId,
            phase: "pending",
          },
        ]);
        expect(
          yield* sql`SELECT a.allocation_id AS "allocationId",c.operation_id AS "capacityId"
          FROM relay_thread_vm_allocations a JOIN relay_thread_vm_capacity c USING(allocation_id)
          WHERE a.thread_id=${threadId} AND a.deleted_at IS NULL`,
        ).toEqual([
          {
            allocationId: retryId,
            capacityId: retryId,
          },
        ]);
      }).pipe(Effect.provide(Layer.merge(workflows, NodeFileSystem.layer))),
    );

    for (const outcome of [
      "resumed",
      "cancelled",
      "revoked",
      "started",
      "started-revoked",
      "started-codex-disconnected",
      "connect-uncertain",
      "connect-expired",
      "native-resumed",
      "native-repaused-unacknowledged",
      "native-repaused-acknowledged",
      "native-uncertain",
      "native-unissued",
      "native-cancelled",
      "native-terminal",
    ] as const)
      it.effect(`orders a checkpoint wake and fences ${outcome} resume requests`, () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow(true);
          const { sql, organizationId, ownerUserId, workflowJobId, allocationId, threadId } = f;
          const older = yield* seed({ hostId: f.hostId, personal: true });
          yield* f.capacity.configure(f.hostId, 1);
          yield* sql`INSERT INTO relay_organizations VALUES(${organizationId},'Organization','2026','2026')`;
          yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
          yield* sql`INSERT INTO relay_codex_vm_connections
            (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
            SELECT organization_id,record#>>'{vmAdmission,codexConnectionId}','issuer',${ownerUserId},'client','connected','sealed','2099-01-01','2026'
            FROM relay_workflow_jobs WHERE job_id=${workflowJobId}`;
          const responseId = NodeCrypto.randomUUID();
          const review = {
            kind: "review",
            checkpointId: "review-1",
            turnId: "turn-1",
            checkpointRef: "ref-1",
            checkpointTurnCount: 1,
          };
          const checkpoint =
            outcome === "native-unissued"
              ? {
                  kind: "input",
                  checkpointId: "input-1",
                  stepId: "input",
                  role: "member",
                  question: "Continue?",
                  generation: 0,
                }
              : review;
          const waitStatus = outcome === "native-unissued" ? "awaiting_input" : "awaiting_review";
          const workflowCheckpoint = {
            jobId: workflowJobId,
            checkpointId: checkpoint.checkpointId,
            checkpointGeneration: 0,
            publicationId: NodeCrypto.randomUUID(),
            publicationRevision: 1,
          };
          yield* sql`UPDATE relay_workflow_jobs SET status=${waitStatus},record=record || ${sql.json(
            {
              status: waitStatus,
              progress: {
                status: waitStatus,
                revision: 4,
                threadId,
                checkpoint,
                detail: null,
                hasThread: true,
              },
            },
          )},pending_control=${sql.json({
            userId: ownerUserId,
            responseId,
            response: {
              ...(outcome === "native-unissued"
                ? { operation: "input", text: "Continue" }
                : { operation: "approve" }),
              expectedRevision: 4,
              checkpointId: checkpoint.checkpointId,
            },
          })} WHERE job_id=${workflowJobId}`;
          const resume = makeThreadVmResumeStore(sql);
          const rePaused = outcome.startsWith("native-repaused-");
          const computeRef = (yield* makeThreadVmAllocationStore(sql).getAny(allocationId))!
            .computeRef!;
          const inspect = () =>
            Effect.succeed(pausedSandbox(computeRef, allocationId, f.operationId, threadId));
          const lease = makeThreadVmLeaseWorker(
            sql,
            () => Effect.fail(new ThreadVmComputeError({ operation: "lease", message: "Paused" })),
            f.hostId,
            { inspect },
          );
          const managedPause = sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase,workflow_checkpoint,source_receipt)
            VALUES(${allocationId},${NodeCrypto.randomUUID()},1,'completed',${sql.json(workflowCheckpoint)},${sql.json({ workflowCheckpoint })})`;
          let unissuedPause: string | null = null;
          if (outcome.startsWith("native-")) {
            const { publicationId } = workflowCheckpoint;
            yield* sql`INSERT INTO relay_workflow_recovery_records(publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest)
              VALUES(${publicationId},${workflowJobId},${threadId},1,${NodeCrypto.randomUUID()},${"a".repeat(64)},1,${sql.json(
                {
                  supportsVmCheckpointRecovery: true,
                  binding: {
                    jobId: workflowJobId,
                    threadId,
                    environmentId: f.owner.environmentId,
                    generation: 1,
                  },
                },
              )})`;
            yield* sql`INSERT INTO relay_workflow_recovery_heads(job_id,publication_id,revision)
              VALUES(${workflowJobId},${publicationId},1)`;
            if (outcome === "native-uncertain") {
              yield* sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,capture_started_at)
                VALUES(${NodeCrypto.randomUUID()},${allocationId},1,${computeRef},${NodeCrypto.randomUUID()},'creating',clock_timestamp())`;
            }
            if (outcome === "native-unissued") {
              unissuedPause = NodeCrypto.randomUUID();
              const backupId = NodeCrypto.randomUUID();
              const bootId = NodeCrypto.randomUUID();
              const receipt = {
                allocationId,
                computeRef,
                threadId,
                generation: 1,
                environmentId: f.owner.environmentId,
                provisionOperationId: f.operationId,
                captureOperationId: unissuedPause,
                bootId,
                sealEpoch: 1,
                sourceSequence: 1,
                nativeCheckpointOperationId: null,
                workflowCheckpoint,
              };
              yield* sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase,source_receipt)
                VALUES(${backupId},${allocationId},1,${computeRef},${backupId},'pending',${sql.json(receipt)})`;
              yield* sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase,workflow_checkpoint,source_receipt,source_sequence,source_frozen_at,boot_id,backup_operation_id)
                VALUES(${allocationId},${unissuedPause},1,'pending',${sql.json(workflowCheckpoint)},${sql.json(receipt)},1,clock_timestamp(),${bootId},${backupId})`;
              expect(
                yield* makeThreadVmBackupWorker(
                  sql,
                  {
                    inspect,
                    snapshot: () =>
                      Effect.die("An unissued backup of a paused workflow must not start"),
                    findSnapshot: () => Effect.die("An unissued backup has no snapshot to find"),
                    restore: {
                      resolveNamedSnapshot: () => Effect.die("No snapshot was created"),
                      resolveFailedNamedSnapshot: () => Effect.die("No snapshot was created"),
                    },
                  },
                  f.hostId,
                  false,
                ).runOne(),
              ).toBe(true);
              expect(
                yield* sql`SELECT phase FROM relay_thread_vm_pauses WHERE operation_id=${unissuedPause}`,
              ).toEqual([{ phase: "cancelled" }]);
              expect(
                yield* sql`SELECT phase FROM relay_thread_vm_backups WHERE operation_id=${backupId}`,
              ).toEqual([{ phase: "retired" }]);
            } else expect(yield* lease.runOne()).toBe(true);
            if (outcome === "native-uncertain") {
              expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
              expect((yield* makeThreadVmAllocationStore(sql).getAny(allocationId))?.state).toBe(
                "running",
              );
              expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
                true,
              );
              expect(yield* f.capacity.get(responseId)).toBeNull();
              return;
            }
            expect((yield* f.capacity.get(f.operationId))?.state).toBe("released");
            expect((yield* makeThreadVmAllocationStore(sql).getAny(allocationId))?.state).toBe(
              "paused",
            );
            expect(
              (yield* readWorkflowVmRecoveries(sql, [workflowJobId])).get(workflowJobId)?.state,
            ).toBe("paused");
            if (outcome === "native-cancelled" || outcome === "native-terminal") {
              let outstandingConnect: Effect.Success<ReturnType<typeof resume.claim>> = null;
              if (outcome === "native-cancelled") {
                yield* f.capacity.cancelUnstarted(older.operationId);
                yield* resume.requestWorkflow(threadId, workflowJobId);
                expect(
                  (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
                ).toBe(responseId);
                outstandingConnect = (yield* resume.claim(f.hostId))!;
                yield* resume.beginConnect(outstandingConnect, true);
              }
              const status = outcome === "native-cancelled" ? "cancelling" : "done";
              yield* sql`UPDATE relay_workflow_jobs SET status=${status},record=record || ${sql.json({ status })},
                pending_control=${outcome === "native-cancelled" ? sql.json({ userId: ownerUserId, response: { operation: "cancel" } }) : null}
                WHERE job_id=${workflowJobId}`;
              expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
                true,
              );
              if (outstandingConnect) {
                const fs = yield* FileSystem.FileSystem;
                const objects = makeLocalThreadArtifactObjects(
                  fs,
                  yield* fs.makeTempDirectoryScoped(),
                );
                const store = yield* Workflows;
                const advance = Effect.gen(function* () {
                  const row = (yield* store.claim(workflowJobId))!;
                  return yield* makeWorkflowVmRecovery(sql, objects)
                    .advance(row, row.leaseUntil!)
                    .pipe(
                      Effect.ensuring(
                        store.release(workflowJobId, row.leaseUntil!).pipe(Effect.orDie),
                      ),
                    );
                });
                expect(yield* advance).toMatchObject({ status: "cancelling" });
                expect((yield* f.capacity.get(responseId))?.state).toBe("started");
                expect(yield* resume.settleConnect(outstandingConnect)).toBe(true);
                yield* resume.defer(outstandingConnect);
                yield* sql`UPDATE relay_thread_vm_resumes SET retry_at=clock_timestamp() WHERE operation_id=${responseId}`;
                expect(
                  yield* makeThreadVmResumeWorker(
                    sql,
                    { inspect, recoverIngress: () => Effect.die("Cancel must not connect the VM") },
                    { reopenAfterResume: () => Effect.die("Cancel must keep the VM paused") },
                    f.hostId,
                    true,
                  ).runOne(),
                ).toBe(true);
                expect(yield* advance).toMatchObject({
                  status: "cancelled",
                  progress: { executionReleased: true },
                });
                expect((yield* f.capacity.get(responseId))?.state).toBe("released");
                expect((yield* store.getJob(workflowJobId))?.pendingControl).toBeNull();
              } else expect(yield* f.capacity.get(responseId)).toBeNull();
              expect((yield* makeThreadVmAllocationStore(sql).getAny(allocationId))?.state).toBe(
                "paused",
              );
              return;
            }
            if (rePaused) yield* managedPause;
          } else {
            yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',native_paused_generation=1 WHERE allocation_id=${allocationId}`;
            yield* sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE operation_id=${f.operationId}`;
            yield* managedPause;
          }
          expect((yield* resume.requestWorkflow(threadId, workflowJobId)).operationId).toBe(
            responseId,
          );
          expect((yield* resume.requestWorkflow(threadId, workflowJobId)).operationId).toBe(
            responseId,
          );
          expect(
            (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
          ).toBe(older.operationId);
          expect(yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true })).toBeNull();
          yield* f.capacity.cancelUnstarted(older.operationId);
          expect(
            (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
          ).toBe(responseId);
          const claim = (yield* resume.claim(f.hostId))!;
          expect(claim).toMatchObject({ operationId: responseId, workflowJobId });
          if (outcome === "connect-uncertain" || outcome === "connect-expired") {
            const recovery = () =>
              readWorkflowVmRecoveries(sql, [workflowJobId]).pipe(
                Effect.map((rows) => rows.get(workflowJobId)),
              );
            yield* resume.beginConnect(claim, true);
            expect(yield* recovery()).toEqual({ state: "resuming" });
            if (outcome === "connect-uncertain") yield* resume.defer(claim);
            else
              yield* sql`UPDATE relay_thread_vm_resumes SET claim_until=clock_timestamp() - interval '1 second'
                WHERE operation_id=${responseId}`;
            const blocked = {
              state: "recovery_error",
              detail:
                "Launchpad could not confirm that the workflow VM resumed. Saved results are still available.",
            };
            expect(yield* recovery()).toEqual(blocked);
            expect(yield* makeThreadVmResumeStore(sql).claim(f.hostId)).toBeNull();
            expect((yield* f.capacity.get(responseId))?.state).toBe("started");
            expect(
              yield* sql`SELECT pending_control->>'responseId' AS response_id
              FROM relay_workflow_jobs WHERE job_id=${workflowJobId}`,
            ).toEqual([{ response_id: responseId }]);
            if (outcome === "connect-uncertain") {
              yield* sql`UPDATE relay_workflow_jobs SET status='cancelling',record=jsonb_set(record,'{status}','"cancelling"')
                WHERE job_id=${workflowJobId}`;
              expect(yield* recovery()).toEqual(blocked);
              expect(yield* resume.cancelWorkflow(threadId, workflowJobId)).toBe("started");
            } else {
              yield* sql`UPDATE relay_thread_vm_resumes SET generation=2 WHERE operation_id=${responseId}`;
              expect(yield* recovery()).toEqual({
                state: "recovery_error",
                detail:
                  "There is no verified VM backup for this workflow checkpoint. Saved results are still available.",
              });
              yield* sql`UPDATE relay_thread_vm_resumes SET generation=1 WHERE operation_id=${responseId}`;
            }
            expect(
              yield* resume.settleConnect({ ...claim, claimId: NodeCrypto.randomUUID() }),
            ).toBe(false);
            expect(yield* resume.settleConnect(claim)).toBe(true);
            expect(
              yield* Effect.flip(resume.finishPower(claim, "late-routing-fixture")),
            ).toMatchObject({
              _tag: "ThreadVmResumeConflict",
            });
            expect(yield* recovery()).toEqual({ state: "resuming" });
            return;
          }
          if (outcome === "started-codex-disconnected") {
            yield* resume.beginConnect(claim, true);
            expect(yield* resume.settleConnect(claim)).toBe(true);
            expect(yield* resume.finishPower(claim, "routing-fixture")).toBe(true);
            yield* resume.defer(claim);
            const connection = (yield* sql<{
              id: string;
            }>`SELECT connection_id AS id FROM relay_codex_vm_connections
              WHERE organization_id=${organizationId}`)[0]!;
            yield* sql`UPDATE relay_codex_vm_connections SET status='disconnected' WHERE organization_id=${organizationId}`;
            yield* sql`UPDATE relay_thread_vm_resumes SET retry_at=clock_timestamp() WHERE operation_id=${responseId}`;
            const waitingPosition = sql<{
              position: string;
            }>`SELECT position::text FROM relay_thread_vm_capacity
              WHERE operation_id=${responseId}`;
            const position = yield* waitingPosition;
            const worker = makeThreadVmResumeWorker(
              sql,
              {
                inspect,
                recoverIngress: () => Effect.die("Parking must never call Connect"),
              },
              { reopenAfterResume: () => Effect.die("The guest is paused") },
              f.hostId,
              true,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect(yield* resume.get(allocationId)).toMatchObject({
              phase: "waiting",
              operationId: responseId,
            });
            expect(yield* waitingPosition).toEqual(position);
            expect((yield* f.capacity.get(responseId))?.state).toBe("waiting");
            expect(yield* makeThreadVmAllocationStore(sql).getAny(allocationId)).toMatchObject({
              state: "paused",
            });
            expect(
              yield* sql`SELECT sealed_traffic_access_token FROM relay_thread_vm_allocations
              WHERE allocation_id=${allocationId}`,
            ).toEqual([{ sealed_traffic_access_token: null }]);
            expect(yield* worker.runOne()).toBe(false);
            const competitor = yield* seed({ hostId: f.hostId });
            yield* f.capacity.configure(f.hostId, 1);
            const competitorConnectionId = NodeCrypto.randomUUID();
            yield* sql`INSERT INTO relay_organizations VALUES(${competitor.organizationId},'Competitor','2026','2026')`;
            yield* sql`INSERT INTO relay_codex_vm_connections
              (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
              VALUES(${competitor.organizationId},${competitorConnectionId},'issuer','different','client','connected','sealed','2099-01-01','2026')`;
            yield* sql`UPDATE relay_workflow_jobs SET record=record || ${sql.json({ vmAdmission: { codexConnectionId: competitorConnectionId, hasSecrets: false } })}
              WHERE job_id=${competitor.workflowJobId}`;
            yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase,workflow_snapshot)
              VALUES(${competitor.allocationId},${competitor.operationId},1,'pending','{}')`;
            expect(
              (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
            ).toBe(competitor.operationId);
            yield* f.capacity.cancelUnstarted(competitor.operationId);
            yield* sql`UPDATE relay_codex_vm_connections SET status='connected',connection_id=${NodeCrypto.randomUUID()}
              WHERE organization_id=${organizationId}`;
            expect(yield* worker.runOne()).toBe(false);
            yield* sql`UPDATE relay_codex_vm_connections SET connection_id=${connection.id}
              WHERE organization_id=${organizationId}`;
            expect(
              (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
            ).toBe(responseId);
            const next = (yield* resume.claim(f.hostId))!;
            expect(next.claimId).not.toBe(claim.claimId);
            yield* resume.beginConnect(next, true);
            expect(yield* resume.settleConnect(claim)).toBe(false);
            expect(yield* resume.settleConnect(next)).toBe(true);
            expect(yield* resume.finishPower(next, "routing-fixture")).toBe(true);
            expect(yield* resume.complete(next)).toBe(true);
            return;
          }
          if (
            outcome === "resumed" ||
            outcome === "native-resumed" ||
            outcome === "native-unissued" ||
            rePaused
          ) {
            if (outcome === "native-resumed") expect(claim.pauseOperationId).toBeNull();
            if (outcome === "native-unissued") expect(claim.pauseOperationId).toBe(unissuedPause);
            yield* resume.beginConnect(claim, true);
            expect(yield* resume.settleConnect(claim)).toBe(true);
            expect(yield* resume.finishPower(claim, "routing-fixture")).toBe(true);
            expect(yield* resume.complete(claim)).toBe(true);
            expect((yield* resume.get(allocationId))?.phase).toBe("completed");
            expect(yield* makeThreadVmAllocationStore(sql).getAny(allocationId)).toMatchObject({
              state: "running",
              computeRef: claim.computeRef,
            });
            expect((yield* f.capacity.get(responseId))?.state).toBe("started");
            if (!rePaused) return;
            expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
              true,
            );
            if (outcome === "native-repaused-acknowledged")
              yield* sql`UPDATE relay_thread_vm_pauses SET source_reopened_at=clock_timestamp() WHERE allocation_id=${allocationId}`;
            yield* sql`DELETE FROM relay_thread_vm_leases WHERE allocation_id=${allocationId}`;
            expect(yield* lease.runOne()).toBe(true);
            expect((yield* f.capacity.get(responseId))?.state).toBe("released");
            const pendingDispatch = sql`UPDATE relay_workflow_jobs SET pending_control=pending_control || ${sql.json({ checkpointDispatch: { allocationId } })} WHERE job_id=${workflowJobId}`;
            yield* pendingDispatch;
            expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
              true,
            );
            yield* sql`UPDATE relay_workflow_jobs SET pending_control=pending_control - 'checkpointDispatch' WHERE job_id=${workflowJobId}`;
            yield* sql`DELETE FROM relay_organization_members WHERE organization_id=${organizationId} AND user_id=${ownerUserId}`;
            expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
              true,
            );
            yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
            const queued = yield* seed({ hostId: f.hostId, personal: true });
            yield* f.capacity.configure(f.hostId, 1);
            expect(yield* resume.requestWorkflow(threadId, workflowJobId)).toMatchObject({
              phase: "waiting",
              operationId: responseId,
            });
            expect(yield* resume.requestWorkflow(threadId, workflowJobId)).toMatchObject({
              phase: "waiting",
              operationId: responseId,
            });
            if (outcome === "native-repaused-acknowledged") {
              const replacement = NodeCrypto.randomUUID();
              yield* sql`UPDATE relay_workflow_jobs SET pending_control=jsonb_set(pending_control,'{responseId}',to_jsonb(${replacement}::text))
                WHERE job_id=${workflowJobId}`;
              expect(yield* Effect.isFailure(resume.requestWorkflow(threadId, workflowJobId))).toBe(
                true,
              );
              expect(yield* resume.cancelWorkflow(threadId, workflowJobId)).toBe("released");
              expect((yield* resume.requestWorkflow(threadId, workflowJobId)).operationId).toBe(
                replacement,
              );
              expect((yield* f.capacity.get(responseId))?.state).toBe("released");
              return;
            }
            expect(
              (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
            ).toBe(queued.operationId);
            yield* f.capacity.cancelUnstarted(queued.operationId);
            expect(
              (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
            ).toBe(responseId);
            const next = (yield* resume.claim(f.hostId))!;
            yield* resume.beginConnect(next, true);
            expect(yield* resume.settleConnect(claim)).toBe(false);
            expect(yield* resume.settleConnect(next)).toBe(true);
            expect(yield* resume.finishPower(next, "routing-fixture")).toBe(true);
            expect(yield* resume.complete(next)).toBe(true);
            return;
          }
          if (outcome === "started" || outcome === "started-revoked")
            yield* resume.beginConnect(claim, true);
          if (outcome === "started-revoked") {
            expect(yield* resume.settleConnect(claim)).toBe(true);
            expect(yield* resume.finishPower(claim, "routing-fixture")).toBe(true);
          }
          if (outcome === "revoked" || outcome === "started-revoked") {
            yield* sql`DELETE FROM relay_organization_members WHERE organization_id=${organizationId} AND user_id=${ownerUserId}`;
          } else {
            yield* sql`UPDATE relay_workflow_jobs SET status='cancelling',record=jsonb_set(record,'{status}','"cancelling"'),pending_control=${sql.json(
              {
                userId: ownerUserId,
                response: { operation: "cancel" },
              },
            )} WHERE job_id=${workflowJobId}`;
          }
          if (outcome === "started" || outcome === "started-revoked") {
            expect(yield* resume.cancelWorkflow(threadId, workflowJobId)).toBe("started");
            expect((yield* f.capacity.get(responseId))?.state).toBe("started");
            expect(yield* resume.claim(f.hostId)).toBeNull();
            if (outcome === "started") expect(yield* resume.settleConnect(claim)).toBe(true);
            yield* resume.defer(claim);
            yield* sql`UPDATE relay_thread_vm_resumes SET retry_at=clock_timestamp() WHERE operation_id=${responseId}`;
            const retry = (yield* resume.claim(f.hostId))!;
            expect(retry.capacityState).toBe("started");
            expect(yield* Effect.flip(resume.beginConnect(retry))).toMatchObject({
              _tag: "ThreadVmResumeConflict",
            });
            expect(
              yield* sql`SELECT connect_claim_id FROM relay_thread_vm_resumes WHERE operation_id=${responseId}`,
            ).toEqual([{ connect_claim_id: null }]);
            if (outcome === "started-revoked") {
              expect((yield* makeThreadVmAllocationStore(sql).getAny(allocationId))?.state).toBe(
                "running",
              );
            }
            expect(yield* resume.releaseInactiveWorkflowWake(retry)).toBe(true);
            expect((yield* makeThreadVmAllocationStore(sql).getAny(allocationId))?.state).toBe(
              "paused",
            );
          } else {
            expect(yield* Effect.flip(resume.beginConnect(claim, true))).toMatchObject({
              _tag: "ThreadVmResumeConflict",
            });
            expect((yield* f.capacity.get(responseId))?.state).toBe("reserved");
            expect(yield* resume.cancelWorkflow(threadId, workflowJobId)).toBe("released");
          }
          expect((yield* f.capacity.get(responseId))?.state).toBe("released");
          expect(yield* resume.get(allocationId)).toBeNull();
        }).pipe(Effect.provide(Layer.merge(workflows, NodeFileSystem.layer))),
      );

    for (const cancelDuring of ["status", "approve"] as const)
      it.effect(`preserves the cancellation winner during checkpoint ${cancelDuring}`, () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          const { sql, organizationId, ownerUserId, workflowJobId, threadId, repositoryId } = f;
          yield* sql`INSERT INTO relay_organizations VALUES(${organizationId},'Organization','2026','2026')`;
          yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
          const progress = {
            status: "awaiting_review" as const,
            revision: 4,
            threadId: ThreadId.make(threadId),
            detail: null,
            hasThread: true,
            checkpoint: {
              checkpointId: "checkpoint",
              turnId: "turn",
              checkpointRef: "ref",
              checkpointTurnCount: 1,
            },
          };
          const responseId = NodeCrypto.randomUUID();
          yield* sql`UPDATE relay_workflow_jobs SET status='awaiting_review',
            record=record || ${sql.json({ status: progress.status, progress })},
            pending_control=${sql.json({
              userId: ownerUserId,
              responseId,
              response: {
                operation: "approve",
                expectedRevision: progress.revision,
                checkpointId: progress.checkpoint.checkpointId,
              },
            })} WHERE job_id=${workflowJobId}`;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const operations: string[] = [];
          yield* Effect.gen(function* () {
            const store = yield* Workflows;
            const refreshing = yield* refreshWorkflowJob(workflowJobId).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            expect(
              (yield* store.getJob(workflowJobId))?.pendingControl?.checkpointDispatch
                ?.allocationId,
            ).toBe(cancelDuring === "approve" ? f.allocationId : undefined);
            yield* respondToWorkflowJob(
              { jobId: workflowJobId, repositoryId },
              { operation: "cancel" },
            );
            let cancelling = yield* store.getJob(workflowJobId);
            expect(cancelling?.pendingControl?.response.operation).toBe("cancel");
            expect(cancelling?.pendingControl?.supersededCheckpoint?.responseId).toBe(
              cancelDuring === "approve" ? responseId : undefined,
            );
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(refreshing);
            cancelling = yield* store.getJob(workflowJobId);
            expect(cancelling?.status).toBe("cancelling");
            expect((yield* refreshWorkflowJob(workflowJobId))?.status).toBe("cancelled");
            expect(operations).toEqual(
              cancelDuring === "approve" ? ["status", "approve", "cancel"] : ["status", "cancel"],
            );
          }).pipe(
            Effect.provide([
              workflows,
              Layer.mock(EnvironmentConnector)({
                dispatchJob: (input) =>
                  Effect.gen(function* () {
                    const operation = input.workflowControl!.operation;
                    operations.push(operation);
                    if (operation === cancelDuring) {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(release);
                      if (operation === "approve")
                        return yield* new EnvironmentMintRequestTimedOut({
                          environmentId: f.principal.environmentId,
                          operation: "dispatch-job",
                          timeoutMs: 10,
                        });
                    }
                    return {
                      accepted: true,
                      workflowResult: {
                        protocol: 9,
                        outcome: "accepted" as const,
                        detail: null,
                        progress:
                          operation === "cancel"
                            ? {
                                ...progress,
                                status: "cancelled" as const,
                                revision: 6,
                                checkpoint: null,
                                executionReleased: true,
                              }
                            : operation === "approve"
                              ? {
                                  ...progress,
                                  status: "running" as const,
                                  revision: 5,
                                  checkpoint: null,
                                }
                              : progress,
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
                    organization: { organizationId, name: "Test", createdAt: "now" },
                  }),
              }),
              Layer.mock(Repositories)({
                getById: () =>
                  Effect.succeed({
                    repositoryId,
                    organizationId,
                    name: "Test",
                    canonicalKeys: [],
                    createdAt: "now",
                  }),
                getAccess: () => Effect.succeed("maintainer"),
              }),
              Layer.mock(Machines)({}),
              Layer.mock(OrganizationProjectCatalog)({}),
            ]),
            Effect.provideService(RelayClientPrincipal, { userId: ownerUserId, token: "test" }),
          );
        }),
      );

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
                {
                  kind: "agent",
                  id: "explicit",
                  title: "Check",
                  instruction: "Check",
                  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
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
                workflowModelCatalog: {
                  defaultModel: "gpt-6-astra",
                  models: [
                    { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null },
                    { slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null },
                  ],
                },
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

          const managedDefault = {
            instanceId: "codex",
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          expect(yield* advance).toMatchObject({
            status: "preparing",
            runtime: { kind: "vm", threadId },
            workflow: {
              definition: {
                steps: [
                  { id: "agent", modelSelection: managedDefault },
                  { id: "explicit", modelSelection: { instanceId: "codex", model: "gpt-6-astra" } },
                ],
              },
            },
          });
          expect(
            yield* sql`SELECT initial_state::jsonb->'modelSelection' AS model_selection
            FROM relay_thread_vm_setups WHERE allocation_id=${jobId}`,
          ).toEqual([{ model_selection: managedDefault }]);
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
            if (outcome !== "stopped") {
              const environmentId = NodeCrypto.randomUUID();
              const credentialId = NodeCrypto.randomUUID();
              yield* sql`INSERT INTO relay_environment_credentials
                (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
                VALUES(${credentialId},${environmentId},'stopped-key',${credentialId},'2026','2026')`;
              yield* sql`INSERT INTO relay_thread_vm_bindings
                (environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
                VALUES(${environmentId},${jobId},${threadId},${repositoryId},1,'stopped-key',${credentialId})`;
              yield* sql`UPDATE relay_thread_placements SET environment_id=${environmentId},
                project_id=${`vm:${threadId}`},operation_id=NULL WHERE thread_id=${threadId}`;
            }
            const fs = yield* FileSystem.FileSystem;
            const saves = makeThreadVmFinalSaveStore(
              sql,
              makeLocalThreadArtifactObjects(fs, yield* fs.makeTempDirectoryScoped()),
            );
            expect(
              yield* makeThreadVmLeaseWorker(
                sql,
                () => Effect.die("A paused workflow must not renew or wake."),
                hostId,
                { inspect: () => Effect.succeed(null) },
                saves.reconcileMissingWorkflowSource,
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
        }).pipe(Effect.provide(Layer.merge(workflows, NodeFileSystem.layer))),
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

    it.effect(
      "parks a first Create during Linear reconnect and restores the same reservation",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const f = yield* seed({ hostId, automatic: true, stableWorkflowIdentity: true });
          const { linearWorkflow, source } = yield* installLinearAdmission(f);
          const personal = yield* seed({ hostId, personal: true });
          const sql = f.sql;
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
          expect(
            (yield* f.capacity.admitNext(hostId, { workflowEnabled: true, linearWorkflow }))
              ?.operationId,
          ).toBe(f.operationId);
          let reconnect = true;
          let creates = 0;
          let reconciliations = 0;
          const worker = makeThreadVmProvisionWorker(
            sql,
            {
              create: (input) =>
                Effect.gen(function* () {
                  expect(input.operationId).toBe(f.operationId);
                  creates++;
                  return yield* new ThreadVmComputeError({
                    operation: "create",
                    message: "Lost reply",
                  });
                }),
              recoverIngress: () => Effect.die("No sandbox was found"),
              findOperation: (operationId) =>
                Effect.sync(() => {
                  expect(operationId).toBe(f.operationId);
                  reconciliations++;
                  return [];
                }),
            },
            "template",
            hostId,
            Effect.void,
            {
              enabled: true,
              buildId: snapshot.templateBuildId,
              linearWorkflow,
              verifyTemplate: () =>
                Effect.gen(function* () {
                  if (reconnect)
                    yield* sql`UPDATE relay_workflow_authorizations
                  SET exchange_lease_until='2099-01-01T00:00:00.000Z'
                  WHERE organization_id=${f.organizationId}`;
                }).pipe(Effect.orDie),
            },
          );
          const run = worker
            .runOne()
            .pipe(Effect.provideService(RelayConfiguration, { ...relayConfig, linearWorkflow }));
          expect(yield* run).toBe(true);
          expect(creates).toBe(0);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("waiting");
          expect(
            yield* makeThreadVmProvisionStore(sql).get(f.allocationId, "organization_workflow"),
          ).toMatchObject({ errorCode: "source_unavailable", workflowSnapshot: snapshot });

          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          expect(
            (yield* f.capacity.admitNext(hostId, { workflowEnabled: true, linearWorkflow }))
              ?.operationId,
          ).toBe(personal.operationId);
          yield* personal.capacity.cancelUnstarted(personal.operationId);
          reconnect = false;
          yield* sql`UPDATE relay_workflow_authorizations SET exchange_lease_until=NULL WHERE organization_id=${f.organizationId}`;
          expect(yield* run).toBe(true);
          expect(creates).toBe(1);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
          yield* sql`UPDATE relay_workflow_repository_grants SET revoked=true WHERE grant_id=${source.grantId}`;
          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
          expect(yield* run).toBe(true);
          expect(creates).toBe(1);
          expect(reconciliations).toBe(1);
        }),
    );

    for (const change of ["disconnect-codex", "replace-codex", "withdraw-linear"] as const) {
      it.effect(`blocks first automatic VM Start when ${change} wins during the issue read`, () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow(true, true);
          const { linearWorkflow, source } = yield* installLinearAdmission(f);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const issue = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.map(() => issueResponse("Current title")),
          );
          const dispatched: string[] = [];
          const refresh = refreshAutomaticVm(f, linearWorkflow, issue, (input) =>
            Effect.sync(() => {
              dispatched.push(input.workflowControl!.operation);
              return {
                accepted: false,
                workflowResult: { protocol: 9, outcome: "missing", detail: null, progress: null },
              };
            }),
          );
          const fiber = yield* refresh.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          if (change === "disconnect-codex")
            yield* f.sql`UPDATE relay_codex_vm_connections SET status='disconnected',payload_sealed=NULL,
              expires_at=NULL WHERE organization_id=${f.organizationId}`;
          if (change === "replace-codex")
            yield* f.sql`UPDATE relay_codex_vm_connections SET connection_id=${NodeCrypto.randomUUID()}
              WHERE organization_id=${f.organizationId}`;
          if (change === "withdraw-linear")
            yield* f.sql`UPDATE relay_workflow_repository_grants SET revoked=true WHERE grant_id=${source.grantId}`;
          yield* Deferred.succeed(release, undefined);
          const blocked = yield* Fiber.join(fiber);
          expect(blocked).toMatchObject({
            status: "preparing",
            startAttempted: false,
            runtime: { kind: "vm", threadId: f.threadId },
            queueReason: {
              code:
                change === "disconnect-codex"
                  ? "vm_waiting_codex"
                  : change === "replace-codex"
                    ? "vm_codex_replaced"
                    : "source_withdrawn",
            },
          });
          expect(blocked?.issueSnapshot).toBeUndefined();
          expect(dispatched).toEqual(["status"]);
          expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
        }).pipe(Effect.provide(workflows)),
      );
    }

    it.effect(
      "rechecks a refused automatic VM Start and retains an ambiguous Start when disabled",
      () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow(true, true);
          const { linearWorkflow, source } = yield* installLinearAdmission(f);
          const store = yield* Workflows;
          const requests: Array<{ instruction: string; binding: WorkflowVmDispatchBinding }> = [];
          let reads = 0;
          let statusConfirmed = false;
          const issue = Effect.sync(() => issueResponse(`Issue read ${++reads}`));
          const dispatch: EnvironmentConnector["Service"]["dispatchJob"] = (input) =>
            Effect.gen(function* () {
              if (input.workflowControl?.operation === "start") {
                const saved = (yield* store.getJob(f.workflowJobId).pipe(Effect.orDie))!.record;
                expect(saved.startAttempted).toBe(true);
                expect(saved.instruction).toBe(input.instruction);
                expect(saved.issueSnapshot?.description).toBe("Current requirements");
                requests.push({
                  instruction: input.instruction,
                  binding: input.workflowVmBinding!,
                });
                if (requests.length === 2)
                  return yield* new EnvironmentMintRequestTimedOut({
                    environmentId: input.environmentId,
                    operation: "dispatch-job",
                    timeoutMs: 5000,
                  });
                return {
                  accepted: false,
                  workflowResult: { protocol: 9, outcome: "busy", detail: null, progress: null },
                } as const;
              }
              return statusConfirmed
                ? ({
                    accepted: true,
                    workflowResult: {
                      protocol: 9,
                      outcome: "accepted",
                      detail: null,
                      progress: {
                        revision: 1,
                        status: "preparing",
                        threadId: ThreadId.make(f.threadId),
                        detail: null,
                        checkpoint: null,
                      },
                    },
                  } as const)
                : ({
                    accepted: false,
                    workflowResult: {
                      protocol: 9,
                      outcome: "missing",
                      detail: null,
                      progress: null,
                    },
                  } as const);
            });
          const refresh = (enabled = true) =>
            refreshAutomaticVm(f, linearWorkflow, issue, dispatch, enabled);
          const retryDue = f.sql`UPDATE relay_workflow_jobs SET record=record #- '{queueReason}'
          WHERE job_id=${f.workflowJobId}`;
          expect(yield* refresh(false)).toMatchObject({
            queueReason: { code: "vm_execution_disabled" },
            startAttempted: false,
          });
          expect(reads).toBe(0);
          expect(requests).toEqual([]);

          yield* retryDue;
          const refused = yield* refresh();
          expect(refused).toMatchObject({
            startAttempted: false,
            queueReason: { code: "environment_busy" },
            runtime: { kind: "vm", threadId: f.threadId },
          });
          expect(refused?.issueSnapshot).toBeUndefined();

          yield* retryDue;
          const uncertain = yield* refresh();
          expect(uncertain?.startAttempted).toBe(true);
          expect(uncertain?.issueSnapshot?.title).toBe("Issue read 2");
          yield* f.sql`UPDATE relay_workflow_repository_grants SET revoked=true WHERE grant_id=${source.grantId}`;
          const retry = yield* refresh(false);
          expect(retry?.issueSnapshot).toEqual(uncertain?.issueSnapshot);
          expect(requests).toHaveLength(2);
          expect((yield* refresh())?.issueSnapshot).toEqual(uncertain?.issueSnapshot);
          expect(requests).toHaveLength(3);
          expect(requests[2]).toEqual(requests[1]);
          expect(requests[1]?.binding).toEqual(requests[0]?.binding);
          expect(reads).toBe(2);

          statusConfirmed = true;
          expect((yield* refresh(false))?.progress?.threadId).toBe(f.threadId);
          expect(requests).toHaveLength(3);
        }).pipe(Effect.provide(workflows)),
    );

    for (const afterRestart of [false, true]) {
      it.effect(
        `cleans up a VM after a signed cancellation tombstone without a pending requester (restart: ${afterRestart})`,
        () =>
          Effect.gen(function* () {
            const f = yield* activeWorkflow(true, true);
            const { linearWorkflow } = yield* installLinearAdmission(f);
            if (afterRestart) {
              yield* f.sql`UPDATE relay_workflow_jobs SET status='cancelling',
              record=record||'{"status":"cancelling","startAttempted":false,"vmCancellationConfirmed":true}'::jsonb
              WHERE job_id=${f.workflowJobId}`;
            } else {
              yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{startAttempted}','true')
              WHERE job_id=${f.workflowJobId}`;
            }
            const refresh = refreshAutomaticVm(
              f,
              linearWorkflow,
              Effect.die("A confirmed cancellation must not read Linear"),
              (input) =>
                Effect.sync(() => {
                  expect(afterRestart).toBe(false);
                  expect(input.workflowControl?.operation).toBe("status");
                  return {
                    accepted: true,
                    workflowResult: {
                      protocol: 9,
                      outcome: "cancelled",
                      detail: null,
                      progress: null,
                    },
                  };
                }),
              false,
            );
            expect(yield* refresh).toMatchObject({
              status: "cancelling",
              vmCancellationConfirmed: true,
              startAttempted: false,
            });
            expect((yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId))?.state).toBe(
              "deleting",
            );
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp()
          WHERE allocation_id=${f.allocationId}`;
            yield* f.sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE operation_id=${f.operationId}`;
            expect((yield* refresh)?.status).toBe("cancelled");
          }).pipe(Effect.provide(workflows)),
      );
    }

    for (const nativeState of ["paused", "deleted"] as const) {
      it.effect(`renews a workflow VM lease and releases capacity when it is ${nativeState}`, () =>
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          const computeRef = (yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId))!
            .computeRef!;
          const fs = yield* FileSystem.FileSystem;
          const saves = makeThreadVmFinalSaveStore(
            f.sql,
            makeLocalThreadArtifactObjects(fs, yield* fs.makeTempDirectoryScoped()),
          );
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
            saves.reconcileMissingWorkflowSource,
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
        }).pipe(Effect.provide(NodeFileSystem.layer)),
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

    it.effect("authorizes GitHub reads only for the active saved publishing action", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* activeWorkflow();
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "p07-publish-auth-" });
          const canonicalKey = `github.com/acme/workflow-${f.workflowJobId}`;
          const installationId = "42";
          yield* f.sql`INSERT INTO relay_github_installations VALUES
            (${f.organizationId},${installationId},'acme','Organization',${f.ownerUserId},'2026','2026')`;
          yield* f.sql`INSERT INTO relay_repository_aliases
            (canonical_key,repository_id,organization_id,created_at)
            VALUES (${canonicalKey},${f.repositoryId},${f.organizationId},'2026')`;
          yield* f.sql`UPDATE relay_thread_vm_provisions SET workflow_snapshot=workflow_snapshot ||
            jsonb_build_object('canonicalKey',${canonicalKey}::text,'installationId',${installationId}::text,
              'workflowPublishing',true) WHERE allocation_id=${f.allocationId}`;
          const savedResult: WorkflowSavedResult = {
            resultId: NodeCrypto.randomUUID(),
            stepId: "agent",
            turnId: "agent-turn",
            turnCount: 1,
            outcome: "completed",
            createdAt: "2026-11-18T13:00:00Z",
            checkpointRef: "refs/t3/checkpoints/p07",
            baselineCommitId: "a".repeat(40),
            commitId: "b".repeat(40),
            treeId: "c".repeat(40),
            patch: {
              artifactId: NodeCrypto.randomUUID(),
              sha256: "e".repeat(64),
              sizeBytes: 0,
            },
          };
          yield* f.sql`INSERT INTO relay_workflow_saved_results
            (result_id,job_id,thread_id,turn_id,revision,result,native_checkpoint_operation_id)
            VALUES (${savedResult.resultId},${f.workflowJobId},${f.threadId},${savedResult.turnId},
              1,${f.sql.json(savedResult)},${NodeCrypto.randomUUID()})`;
          const actionFor = (stepGeneration: number): WorkflowVmPublishingRequest["action"] => ({
            actionId: `workflow:${f.workflowJobId}:action:push:${stepGeneration}`,
            stepId: "push",
            stepGeneration,
            operation: "push",
            resultTurnId: savedResult.turnId,
            checkpointRef: savedResult.checkpointRef,
            tree: savedResult.treeId,
            parent: savedResult.baselineCommitId,
            commitSha: null,
            oldRemoteSha: null,
            pullRequestUrl: null,
          });
          const action = actionFor(1);
          const progress = {
            revision: 2,
            generation: action.stepGeneration,
            threadId: ThreadId.make(f.threadId),
            detail: null,
          };
          const checkpoint = {
            checkpointId: "review-result",
            turnId: savedResult.turnId,
            checkpointRef: savedResult.checkpointRef,
          };
          yield* f.sql`UPDATE relay_workflow_jobs SET status='awaiting_review',
            repository_canonical_key=${canonicalKey},
            pending_control=${f.sql.json({
              userId: f.ownerUserId,
              response: {
                operation: "approve",
                checkpointId: checkpoint.checkpointId,
                expectedRevision: progress.revision,
              },
            })},
            record=jsonb_set(record || ${f.sql.json({
              status: "awaiting_review",
              progress: { ...progress, status: "awaiting_review", stepId: "review", checkpoint },
            })},'{workflow,definition,steps}',record#>'{workflow,definition,steps}' || ${f.sql.json(
              [
                { kind: "review", id: "review", title: "Review", role: "maintainer" },
                { kind: "action", id: "push", title: "Push", action: "push" },
              ],
            )}) WHERE job_id=${f.workflowJobId}`;

          const bot = { name: "launchpad[bot]", email: "launchpad[bot]@users.noreply.github.com" };
          const credential = { token: "fixture-token", expiresAt: "2099-01-01T00:00:00Z" };
          const minted: Parameters<GithubApp["Service"]["mintRepositoryToken"]>[0][] = [];
          const github = Layer.mock(GithubApp)({
            gitMetadata: Effect.succeed({
              status: "ready",
              appId: "42",
              appSlug: "launchpad",
              botUserId: 42,
              ...bot,
            }),
            mintRepositoryToken: (input) =>
              Effect.sync(() => {
                minted.push(input);
                return credential;
              }),
          });
          const publishing = (
            requestedAction: WorkflowVmPublishingRequest["action"],
            request: WorkflowVmPublishingRequest["request"] = {
              kind: "credential",
              access: "read",
            },
          ) =>
            handleWorkflowVmPublishing({
              ...f.owner,
              jobId: f.workflowJobId,
              action: requestedAction,
              request,
            }).pipe(
              Effect.provideService(RelayEnvironmentPrincipal, f.principal),
              Effect.provideService(
                ThreadArtifactObjectStorage,
                makeLocalThreadArtifactObjects(fs, root),
              ),
              Effect.provide(github),
            );
          expect(yield* publishing(action)).toEqual({ kind: "waiting_progress" });
          expect(yield* readWorkflowVmPublishing(f.sql, f.workflowJobId)).toBeNull();
          expect(minted).toEqual([]);

          yield* f.sql`UPDATE relay_workflow_jobs SET status='running',pending_control=NULL,
            record=record || ${f.sql.json({
              status: "running",
              progress: {
                ...progress,
                revision: progress.revision + 1,
                status: "running",
                stepId: "push",
                checkpoint: null,
                actions: [
                  {
                    actionId: action.actionId,
                    stepId: "push",
                    generation: action.stepGeneration,
                    operation: "push",
                    state: "running",
                    detail: null,
                    commitSha: null,
                    pullRequestUrl: null,
                    retryable: false,
                  },
                ],
              },
            })} WHERE job_id=${f.workflowJobId}`;
          expect(yield* publishing(actionFor(2))).toEqual({ kind: "waiting_progress" });
          expect(yield* readWorkflowVmPublishing(f.sql, f.workflowJobId)).toBeNull();
          expect(minted).toEqual([]);
          expect(yield* publishing(action)).toEqual({ kind: "credential", ...credential, bot });
          expect(yield* readWorkflowVmPublishing(f.sql, f.workflowJobId)).toMatchObject({
            actionId: action.actionId,
            resultTurnId: savedResult.turnId,
            commitSha: null,
          });
          for (const request of [
            { kind: "credential", access: "push" },
            { kind: "arm", commandId: NodeCrypto.randomUUID(), pid: 42, identity: "owned" },
          ] as const) {
            expect(yield* Effect.flip(publishing(action, request))).toMatchObject({
              _tag: "RelayTenancyNotFoundError",
            });
          }
          expect(minted).toEqual([{ canonicalKey, installationId, access: "read" }]);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
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

    for (const change of ["replacement allocation", "new FIFO position"] as const) {
      it.effect(`does not reserve a stale capacity candidate after ${change}`, () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const warm = yield* seed({ hostId, kind: "resume" });
          const { sql } = warm;
          const replacement = yield* seed({ hostId, organizationId: warm.organizationId });
          const selected = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const gatedSql = new Proxy(sql, {
            apply(target, thisArg, args) {
              const query = Reflect.apply(target, thisArg, args) as ReturnType<typeof sql.unsafe>;
              return args[0]?.[0]?.includes(
                "UPDATE relay_thread_vm_capacity c SET state = 'reserved'",
              )
                ? Deferred.succeed(selected, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.andThen(query),
                  )
                : query;
            },
          });
          const previous = yield* makeThreadVmCapacityStore(gatedSql)
            .admitNext(hostId, "all")
            .pipe(Effect.forkScoped);
          yield* Deferred.await(selected);
          if (change === "replacement allocation") {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM relay_thread_vm_capacity WHERE operation_id=${warm.operationId}`;
                yield* sql`UPDATE relay_thread_vm_capacity SET operation_id=${warm.operationId} WHERE operation_id=${replacement.operationId}`;
              }),
            );
          } else {
            yield* sql`UPDATE relay_thread_vm_capacity SET position=DEFAULT WHERE operation_id=${warm.operationId}`;
          }
          yield* Deferred.succeed(proceed, undefined);
          expect(yield* Fiber.join(previous)).toBeNull();
          expect((yield* warm.capacity.get(warm.operationId))?.state).toBe("waiting");
          expect((yield* warm.capacity.admitNext(hostId, "all"))?.operationId).toBe(
            change === "replacement allocation" ? warm.operationId : replacement.operationId,
          );
        }),
      );
    }

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
    it.effect("reconciles same-revision VM saves before delivering a queued Review response", () =>
      Effect.gen(function* () {
        const { sql, organizationId, ownerUserId, workflowJobId, threadId, repositoryId } =
          yield* activeWorkflow();
        yield* sql`INSERT INTO relay_organizations VALUES(${organizationId},'Test','2026','2026')`;
        yield* sql`INSERT INTO relay_organization_members VALUES(${organizationId},${ownerUserId},'admin','2026','2026')`;
        const progress = {
          status: "awaiting_review" as const,
          revision: 4,
          generation: 0,
          threadId: ThreadId.make(threadId),
          detail: null,
          hasThread: true,
          checkpoint: {
            checkpointId: "checkpoint",
            turnId: "turn",
            checkpointRef: "ref",
            checkpointTurnCount: 1,
          },
        };
        const pending = {
          userId: ownerUserId,
          responseId: NodeCrypto.randomUUID(),
          response: {
            operation: "request_changes" as const,
            expectedRevision: progress.revision,
            checkpointId: progress.checkpoint.checkpointId,
            text: "Update the saved result",
          },
        };
        yield* sql`UPDATE relay_workflow_jobs SET status=${progress.status},
          record=record || ${sql.json({ status: progress.status, progress })},
          pending_control=${sql.json(pending)} WHERE job_id=${workflowJobId}`;
        const saving: WorkflowResultSaving = {
          publicationId: NodeCrypto.randomUUID(),
          resultId: null,
          state: "saving",
          detail: null,
          retryable: false,
        };
        const failed: WorkflowResultSaving = {
          ...saving,
          state: "failed",
          detail: "Save failed",
          retryable: true,
        };
        let reported: NonNullable<RepositoryWorkflowJob["progress"]> = {
          ...progress,
          resultSaving: saving,
        };
        const operations: string[] = [];
        yield* Effect.gen(function* () {
          const store = yield* Workflows;
          const refresh = refreshWorkflowJob(workflowJobId);
          expect((yield* refresh)?.progress?.resultSaving).toEqual(saving);
          expect((yield* store.getJob(workflowJobId))?.pendingControl).toEqual(pending);
          reported = { ...progress, resultSaving: failed };
          expect((yield* refresh)?.progress?.resultSaving).toEqual(failed);
          expect((yield* store.getJob(workflowJobId))?.pendingControl).toEqual(pending);
          reported = { ...progress, checkpoint: { ...progress.checkpoint, checkpointId: "other" } };
          expect((yield* refresh)?.progress?.resultSaving).toEqual(failed);
          expect(operations).toEqual(["status", "status", "status"]);
          reported = progress;
          expect((yield* refresh)?.progress).toMatchObject({ status: "running", revision: 5 });
          expect((yield* store.getJob(workflowJobId))?.pendingControl).toBeNull();
          expect(operations).toEqual(["status", "status", "status", "status", "request_changes"]);
        }).pipe(
          Effect.provide([
            workflows,
            Layer.mock(EnvironmentConnector)({
              dispatchJob: (input) =>
                Effect.sync(() => {
                  const operation = input.workflowControl!.operation;
                  operations.push(operation);
                  return {
                    accepted: true,
                    workflowResult: {
                      protocol: 9,
                      outcome: "accepted",
                      detail: null,
                      progress:
                        operation === "status"
                          ? reported
                          : { ...progress, status: "running", revision: 5, checkpoint: null },
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
                  organization: { organizationId, name: "Test", createdAt: "now" },
                }),
            }),
            Layer.mock(Repositories)({
              getById: () =>
                Effect.succeed({
                  repositoryId,
                  organizationId,
                  name: "Test",
                  canonicalKeys: [],
                  createdAt: "now",
                }),
              getAccess: () => Effect.succeed("maintainer"),
            }),
            Layer.mock(Machines)({}),
            Layer.mock(OrganizationProjectCatalog)({}),
          ]),
        );
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
    for (const scenario of [
      "idle-revoked",
      "idle-restore",
      "restore-codex-parking",
      "restored-native-cancel",
      "restore-cancelled-after-commit",
      "restore-revoked-after-commit",
      "loss-before-pause",
      "loss-after-pause",
      "loss-while-parked",
      "loss-after-reconnect",
      "loss-mismatched-backup",
      "loss-cancel",
      "loss-cancel-during-deletion",
    ] as const) {
      const revokeResponse = scenario === "idle-revoked";
      const sourceLoss = scenario.startsWith("loss-");
      const parkRestore = scenario === "restore-codex-parking";
      const abortCommitted =
        scenario === "restore-cancelled-after-commit" ||
        scenario === "restore-revoked-after-commit";
      it.effect(
        sourceLoss
          ? `reconciles the exact workflow source on ${scenario}`
          : revokeResponse
            ? "saves an automatic pre-Agent Input checkpoint, preserves it past expiry and restores only that checkpoint"
            : parkRestore
              ? "parks a cold Input restore until its original Codex connection returns"
              : scenario === "restored-native-cancel"
                ? "cancels Input after native pause of its restored VM"
                : abortCommitted
                  ? `preserves the current saved checkpoint on ${scenario}`
                  : "authorizes workflow pause and cold restore with the current VM credential",
        () =>
          Effect.gen(function* () {
            const f = yield* activeWorkflow(true);
            const fs = yield* FileSystem.FileSystem;
            const objects = makeLocalThreadArtifactObjects(fs, yield* fs.makeTempDirectoryScoped());
            const credentials = yield* EnvironmentCredentials.pipe(
              Effect.provide(environmentCredentials),
            );
            const sourceToken = NodeCrypto.randomUUID();
            const hash = (token: string) =>
              NodeCrypto.createHash("sha256").update(token).digest("base64url");
            yield* f.sql`UPDATE relay_environment_credentials SET credential_hash=${hash(sourceToken)}
            WHERE credential_id=${f.principal.credentialId}`;
            const authenticated = yield* credentials.authenticate(sourceToken);
            if (authenticated._tag !== "Some")
              return yield* Effect.die("Missing source credential");
            expect(authenticated.value).toEqual(f.principal);
            const asVm = <A, E, R>(
              effect: Effect.Effect<A, E, R>,
              principal = authenticated.value,
            ) =>
              effect.pipe(
                Effect.provideService(RelayEnvironmentPrincipal, principal),
                Effect.provideService(ThreadArtifactObjectStorage, objects),
              );
            const job = (yield* (yield* Workflows).getJob(f.workflowJobId))!.record;
            const checkpoint = {
              kind: "input",
              stepId: "setup-input",
              checkpointId: "input-before-agent",
              generation: 0,
              role: "maintainer",
              question: "Which build?",
            } as const;
            const progress = {
              status: "awaiting_input",
              revision: 1,
              threadId: ThreadId.make(f.threadId),
              detail: null,
              checkpoint,
              hasThread: true,
            } as const;
            const publicationId = NodeCrypto.randomUUID();
            const stateBytes = Buffer.from("workflow recovery state");
            const state = {
              artifactId: NodeCrypto.randomUUID(),
              sha256: NodeCrypto.createHash("sha256").update(stateBytes).digest("hex"),
              sizeBytes: stateBytes.length,
            };
            yield* asVm(
              uploadPortableThreadArtifact({
                ...f.owner,
                ...state,
                operationId: publicationId,
                kind: "workspace",
                body: Stream.succeed(stateBytes),
              }),
            );
            const manifest = {
              format: "workflow-recovery-v1",
              supportsVmCheckpointRecovery: true,
              publicationId,
              revision: 1,
              sourceSequence: 0,
              binding: {
                ...f.principal.threadVm,
                environmentId: f.owner.environmentId,
                jobId: f.workflowJobId,
                organizationId: f.organizationId,
                operationId: f.operationId,
                projectId: `vm:${f.threadId}`,
              },
              state,
              nativeCheckpointOperationId: null,
              result: null,
            };
            yield* f.sql`UPDATE relay_workflow_jobs SET status='awaiting_input',submitter_user_id=NULL,
          record=${f.sql.json({ ...job, status: "awaiting_input", progress })} WHERE job_id=${f.workflowJobId}`;
            yield* f.sql`INSERT INTO relay_workflow_recovery_records
          (publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest)
          VALUES(${publicationId},${f.workflowJobId},${f.threadId},1,${NodeCrypto.randomUUID()},${"1".repeat(64)},1,${f.sql.json(manifest)})`;
            yield* f.sql`INSERT INTO relay_workflow_recovery_heads VALUES(${f.workflowJobId},${publicationId},1)`;
            yield* f.sql`INSERT INTO relay_thread_vm_policies (organization_id) VALUES (${f.organizationId}) ON CONFLICT DO NOTHING`;
            const activity = makeThreadVmActivityStore(f.sql);
            yield* activity.recordWork(f.allocationId);
            const makeIdle = f.sql`UPDATE relay_thread_vm_activity SET activity='idle',observed_at=clock_timestamp(),
            idle_since=clock_timestamp()-interval '10 days' WHERE allocation_id=${f.allocationId}`;
            yield* makeIdle;
            const pauses = makeThreadVmPauseStore(f.sql);
            expect(yield* pauses.reserveIdle(f.hostId)).toBe(f.allocationId);
            const cancelled = (yield* asVm(getThreadVmPause(f.owner)))!;
            const cancel = { ...f.owner, operationId: cancelled.operationId };
            expect(yield* asVm(cancelThreadVmPause(cancel))).toMatchObject({
              phase: "cancelled",
              canActivate: true,
            });
            expect(yield* asVm(confirmThreadVmPauseActivation(cancel))).toMatchObject({
              phase: "cancelled",
              sourceReopened: true,
            });
            yield* makeIdle;
            expect(yield* pauses.reserveIdle(f.hostId)).toBe(f.allocationId);
            const pending = (yield* asVm(getThreadVmPause(f.owner)))!;
            const wrongPrincipal = {
              ...f.principal,
              threadVm: { ...f.principal.threadVm, allocationId: NodeCrypto.randomUUID() },
            };
            expect(yield* Effect.isFailure(asVm(getThreadVmPause(f.owner), wrongPrincipal))).toBe(
              true,
            );
            expect(
              yield* Effect.isFailure(asVm(getThreadVmPause({ ...f.owner, generation: 2 }))),
            ).toBe(true);
            expect(pending.workflowCheckpoint?.checkpointId).toBe(checkpoint.checkpointId);
            expect(yield* pauses.claim(f.hostId)).toBeNull();
            const bootId = NodeCrypto.randomUUID();
            expect(
              yield* asVm(
                freezeThreadVmPause({
                  ...f.owner,
                  operationId: pending.operationId,
                  bootId,
                  sealEpoch: 1,
                  workflowCheckpoint: pending.workflowCheckpoint!,
                  nativeCheckpointOperationId: null,
                  sourceSequence: 0,
                }),
              ),
            ).toMatchObject({ operationId: pending.operationId, bootId, sourceSequence: 0 });
            expect(yield* pauses.claim(f.hostId)).toBeNull();
            const backups = makeThreadVmBackupStore(f.sql);
            const saves = makeThreadVmFinalSaveStore(f.sql, objects);
            const allocation = (yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId))!;
            const missing = {
              allocationId: f.allocationId,
              computeRef: allocation.computeRef!,
              generation: 1,
              hostId: f.hostId,
              provisionOperationId: f.operationId,
              threadId: f.threadId,
            };
            const operationId = NodeCrypto.randomUUID();
            const restoreResponse = {
              userId: f.ownerUserId,
              responseId: operationId,
              response: {
                operation: "input",
                checkpointId: checkpoint.checkpointId,
                expectedRevision: 1,
                text: "debug",
              },
            };
            const connectCodex = Effect.gen(function* () {
              yield* f.sql`INSERT INTO relay_organizations VALUES(${f.organizationId},'Organization','2026','2026') ON CONFLICT DO NOTHING`;
              yield* f.sql`INSERT INTO relay_organization_members VALUES(${f.organizationId},${f.ownerUserId},'admin','2026','2026') ON CONFLICT DO NOTHING`;
              yield* f.sql`INSERT INTO relay_codex_vm_connections
                (organization_id,connection_id,issuer,subject,client_id,status,payload_sealed,expires_at,updated_at)
                SELECT organization_id,record#>>'{vmAdmission,codexConnectionId}','issuer',${f.ownerUserId},'client','connected','sealed','2099-01-01','2026'
                FROM relay_workflow_jobs WHERE job_id=${f.workflowJobId}
                ON CONFLICT (organization_id) DO UPDATE SET status='connected'`;
            });
            const advanceRecovery = Effect.gen(function* () {
              const workflows = yield* Workflows;
              const current = (yield* workflows.claim(f.workflowJobId))!;
              return yield* makeWorkflowVmRecovery(f.sql, objects)
                .advance(current, current.leaseUntil!)
                .pipe(
                  Effect.ensuring(
                    workflows.release(f.workflowJobId, current.leaseUntil!).pipe(Effect.orDie),
                  ),
                );
            });
            const snapshotId = `input-snapshot-${f.allocationId}`;
            const sourceBuildId = NodeCrypto.randomUUID();
            if (revokeResponse) {
              const { backupId } = (yield* f.sql<{
                backupId: string;
              }>`SELECT backup_operation_id AS "backupId"
                FROM relay_thread_vm_pauses WHERE operation_id=${pending.operationId}`)[0]!;
              const sandbox = {
                ...pausedSandbox(allocation.computeRef!, f.allocationId, f.operationId, f.threadId),
                state: "running" as const,
              };
              const native = { sourceTemplateID: snapshotId, sourceBuildID: sourceBuildId };
              let sourcePresent = true;
              let ready = false;
              let dispatches = 0;
              const backupWorker = makeThreadVmBackupWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed(sourcePresent ? sandbox : null),
                  snapshot: () =>
                    Effect.sync(() => dispatches++).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ThreadVmComputeError({
                            operation: "snapshot",
                            message: "Lost reply",
                          }),
                        ),
                      ),
                    ),
                  findSnapshot: () => Effect.succeed(ready ? { snapshotId, names: [] } : null),
                  restore: {
                    resolveNamedSnapshot: () => Effect.succeed(native),
                    resolveFailedNamedSnapshot: () => Effect.succeed({ snapshotId, ...native }),
                  },
                },
                f.hostId,
                false,
              );
              const retry = f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp() WHERE operation_id=${backupId}`;
              expect(yield* backupWorker.runOne()).toBe(true);
              for (const present of [true, false]) {
                sourcePresent = present;
                yield* retry;
                expect(yield* backupWorker.runOne()).toBe(true);
                expect(yield* backups.get(backupId)).toMatchObject({
                  phase: "creating",
                  snapshotId: null,
                  nativeCaptureReceipt: null,
                });
                expect(yield* asVm(getThreadVmPause(f.owner))).toMatchObject({
                  phase: "pending",
                  canActivate: false,
                });
                expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toMatchObject({
                  state: "recovery_error",
                  detail: expect.stringMatching(/snapshot/i),
                });
              }
              sourcePresent = true;
              ready = true;
              yield* retry;
              expect(yield* backupWorker.runOne()).toBe(true);
              expect((yield* backups.get(backupId))?.phase).toBe("verified");
              expect(dispatches).toBe(1);
            } else {
              const capture = (yield* backups.claim(f.hostId))!;
              expect(yield* backups.beginCapture(capture)).toBe(true);
              if (scenario === "loss-before-pause") {
                expect(yield* saves.reconcileMissingWorkflowSource(missing)).toBe(false);
                expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
              }
              expect(
                yield* backups.recordCapture(capture, {
                  snapshotId,
                  sourceTemplateId: snapshotId,
                  sourceBuildId,
                }),
              ).toBe(true);
            }
            if (scenario !== "loss-before-pause") {
              const pause = (yield* pauses.claim(f.hostId))!;
              expect(yield* pauses.markSealed(pause, bootId)).toBe(true);
              expect(yield* pauses.beginPause(pause)).toBe(true);
              yield* pauses.acknowledgePause(pause);
              expect(yield* pauses.finish(pause)).toBe(true);
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId)
                  ?.state,
              ).toBe("paused");
            }
            const startSave = (operationId: string) =>
              saves.beginWorkflow({
                operationId,
                threadId: f.threadId,
                allocationId: f.allocationId,
                generation: 1,
              });
            let saved: string;
            if (!sourceLoss) {
              const abandoned = NodeCrypto.randomUUID();
              expect(yield* startSave(abandoned)).toBe(true);
              expect(yield* makeThreadVmFinalSaveWorker(f.sql, objects, f.hostId).runOne()).toBe(
                true,
              );
              expect(yield* saves.abandonUnissuedWorkflowSave(abandoned)).toBe(true);
              expect(yield* makeThreadVmSavedDiskStore(f.sql).get(abandoned)).toBeNull();
              saved = NodeCrypto.randomUUID();
              expect(yield* startSave(saved)).toBe(true);
              expect(yield* makeThreadVmFinalSaveWorker(f.sql, objects, f.hostId).runOne()).toBe(
                true,
              );
            } else {
              yield* connectCodex;
              const cancelControl = { userId: f.ownerUserId, response: { operation: "cancel" } };
              const beginCancel = f.sql`UPDATE relay_workflow_jobs SET status='cancelling',
                record=record || '{"status":"cancelling"}'::jsonb,pending_control=${f.sql.json(cancelControl)}
                WHERE job_id=${f.workflowJobId}`;
              let pendingControl = scenario === "loss-cancel" ? cancelControl : restoreResponse;
              if (scenario === "loss-cancel") yield* beginCancel;
              yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json(pendingControl)} WHERE job_id=${f.workflowJobId}`;
              yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp() WHERE allocation_id=${f.allocationId}`;
              const stopped = () =>
                Effect.succeed(
                  pausedSandbox(missing.computeRef, f.allocationId, f.operationId, f.threadId),
                );
              if (scenario === "loss-while-parked" || scenario === "loss-after-reconnect") {
                const resumes = makeThreadVmResumeStore(f.sql);
                expect(
                  (yield* resumes.requestWorkflow(f.threadId, f.workflowJobId)).operationId,
                ).toBe(operationId);
                expect(
                  (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
                ).toBe(operationId);
                const current = (yield* resumes.claim(f.hostId))!;
                yield* resumes.beginConnect(current, true);
                expect(yield* saves.reconcileMissingWorkflowSource(missing)).toBe(false);
                expect(yield* resumes.settleConnect(current)).toBe(true);
                expect(yield* resumes.finishPower(current, "routing-fixture")).toBe(true);
                yield* resumes.defer(current);
                yield* f.sql`UPDATE relay_thread_vm_resumes SET retry_at=clock_timestamp() WHERE operation_id=${operationId}`;
                yield* f.sql`UPDATE relay_codex_vm_connections SET status='disconnected' WHERE organization_id=${f.organizationId}`;
                const park = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: stopped,
                    recoverIngress: () => Effect.die("A disconnected workflow may not connect"),
                  },
                  { reopenAfterResume: () => Effect.die("The source is paused") },
                  f.hostId,
                  true,
                );
                expect(yield* park.runOne()).toBe(true);
                expect((yield* f.capacity.get(operationId))?.state).toBe("waiting");
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toEqual({ state: "waiting_codex" });
              }
              if (scenario === "loss-mismatched-backup")
                yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{progress,checkpoint,checkpointId}','"a-later-checkpoint"')
                  WHERE job_id=${f.workflowJobId}`;
              if (scenario === "loss-before-pause") {
                let absent = false;
                const missingWithPause = makeThreadVmPauseWorker(
                  f.sql,
                  {
                    inspect: () =>
                      absent
                        ? Effect.succeed(null)
                        : Effect.fail(
                            new ThreadVmComputeError({
                              operation: "inspect",
                              message: "Temporary",
                            }),
                          ),
                    pause: () => Effect.die("Never pause an absent sandbox"),
                  },
                  {
                    seal: () => Effect.die("Never seal an absent sandbox"),
                    reopen: () => Effect.die("Never reopen an absent sandbox"),
                  },
                  f.hostId,
                  false,
                  saves.reconcileMissingWorkflowSource,
                );
                expect(yield* missingWithPause.runOne()).toBe(true);
                expect((yield* f.capacity.get(f.operationId))?.state).toBe("started");
                expect((yield* f.placements.getAny(f.threadId))?.operationId).toBeNull();
                yield* f.sql`UPDATE relay_thread_vm_pauses SET retry_at=clock_timestamp() WHERE operation_id=${pending.operationId}`;
                absent = true;
                expect(yield* missingWithPause.runOne()).toBe(true);
                expect(
                  yield* f.sql`SELECT phase,pause_acknowledged_at FROM relay_thread_vm_pauses WHERE operation_id=${pending.operationId}`,
                ).toEqual([{ phase: "cancelled", pause_acknowledged_at: null }]);
              } else if (scenario === "loss-after-reconnect") {
                yield* connectCodex;
                const missingDuringResume = makeThreadVmResumeWorker(
                  f.sql,
                  {
                    inspect: () => Effect.succeed(null),
                    recoverIngress: () => Effect.die("An absent source may not connect"),
                  },
                  { reopenAfterResume: () => Effect.die("The source is absent") },
                  f.hostId,
                  true,
                  undefined,
                  (claim) => saves.reconcileMissingWorkflowSource({ ...claim, resumeClaim: claim }),
                );
                expect(yield* missingDuringResume.runOne()).toBe(true);
              } else {
                const observing = makeThreadVmLeaseWorker(
                  f.sql,
                  () => Effect.die("Inspecting paused workflows must not renew them"),
                  f.hostId,
                  { inspect: () => Effect.succeed(null) },
                  saves.reconcileMissingWorkflowSource,
                );
                expect(yield* observing.runOne("paused")).toBe(true);
              }
              expect(yield* saves.reconcileMissingWorkflowSource(missing)).toBe(false);
              expect((yield* (yield* Workflows).getJob(f.workflowJobId))?.pendingControl).toEqual(
                pendingControl,
              );
              if (scenario === "loss-mismatched-backup") {
                expect(
                  (yield* makeThreadVmAllocationStore(f.sql).getAny(f.allocationId))?.state,
                ).toBe("deleted");
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toMatchObject({ state: "recovery_error" });
                expect(
                  yield* f.sql`SELECT operation_id FROM relay_thread_vm_saved_disks WHERE thread_id=${f.threadId}`,
                ).toEqual([]);
                yield* beginCancel;
                expect(yield* advanceRecovery).toMatchObject({ status: "cancelled" });
                expect(
                  yield* f.sql`SELECT operation_id FROM relay_thread_vm_restores WHERE thread_id=${f.threadId}`,
                ).toEqual([]);
                return;
              }
              saved = (yield* f.placements.getAny(f.threadId))!.operationId!;
              expect(yield* saves.get(saved)).toMatchObject({
                phase: "deleting",
                reason: "source_loss",
              });
              if (scenario === "loss-cancel-during-deletion") {
                yield* beginCancel;
                pendingControl = cancelControl;
              }
              expect(yield* advanceRecovery).toMatchObject({
                status: scenario.startsWith("loss-cancel") ? "cancelling" : "awaiting_input",
              });
              expect((yield* (yield* Workflows).getJob(f.workflowJobId))?.pendingControl).toEqual(
                pendingControl,
              );
              expect(
                yield* f.sql`SELECT operation_id FROM relay_thread_vm_restores WHERE thread_id=${f.threadId}`,
              ).toEqual([]);
            }
            let deleted = 0;
            const deletion = makeThreadVmFinalSaveDeletionWorker(
              f.sql,
              objects,
              {
                inspect: () => Effect.succeed(null),
                destroy: () =>
                  Effect.gen(function* () {
                    expect(yield* saves.abandonUnissuedWorkflowSave(saved)).toBe(false);
                    deleted++;
                  }).pipe(Effect.orDie),
              },
              f.hostId,
            );
            expect(yield* deletion.runOne()).toBe(true);
            expect(deleted).toBe(1);
            expect((yield* saves.get(saved))?.phase).toBe("completed");
            if (scenario.startsWith("loss-cancel")) {
              expect(yield* advanceRecovery).toMatchObject({ status: "cancelled" });
              expect(
                (yield* (yield* Workflows).getJob(f.workflowJobId))?.pendingControl,
              ).toBeNull();
              expect(
                yield* f.sql`SELECT operation_id FROM relay_thread_vm_restores WHERE thread_id=${f.threadId}`,
              ).toEqual([]);
              return;
            }
            expect(yield* f.capacity.get(operationId)).toBeNull();
            expect(
              (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId)
                ?.state,
            ).toBe("saved");
            if (scenario === "idle-restore") {
              const recoveryError = {
                state: "recovery_error",
                detail: "The saved checkpoint could not be restored.",
              };
              yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{vmRecovery}',${f.sql.json(recoveryError)})
                WHERE job_id=${f.workflowJobId}`;
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
              ).toEqual(recoveryError);
            }
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '365 days'
          WHERE operation_id=${saved}`;
            expect(yield* makeThreadVmSavedDiskStore(f.sql).claimExpired(f.hostId)).toBeNull();

            const restores = makeThreadVmRestoreStore(f.sql, objects);
            const intent = {
              operationId,
              allocationId: operationId,
              threadId: f.threadId,
              savedDiskOperationId: saved,
              expectedGeneration: 1,
              actorUserId: f.ownerUserId,
              workflowJobId: f.workflowJobId,
              serving: true,
            };
            yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{progress,checkpoint,checkpointId}','"another-checkpoint"')
          WHERE job_id=${f.workflowJobId}`;
            expect(yield* Effect.isFailure(restores.begin(intent))).toBe(true);
            expect(
              (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId)
                ?.state,
            ).toBe("recovery_error");
            expect(yield* makeThreadVmCapacityStore(f.sql).get(operationId)).toBeNull();
            yield* f.sql`UPDATE relay_workflow_jobs SET record=jsonb_set(record,'{progress,checkpoint,checkpointId}',to_jsonb(${checkpoint.checkpointId}::text))
          WHERE job_id=${f.workflowJobId}`;
            const recoverSaved = scenario === "idle-restore" || parkRestore;
            const throughRecovery = sourceLoss || recoverSaved;
            if (recoverSaved) {
              yield* connectCodex;
              yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json(restoreResponse)} WHERE job_id=${f.workflowJobId}`;
            }
            if (throughRecovery) {
              expect(yield* advanceRecovery).toMatchObject({ status: "awaiting_input" });
              const accepted = (yield* (yield* Workflows).getJob(f.workflowJobId))!;
              expect(accepted.record.vmRecovery).toBeUndefined();
              expect(accepted.pendingControl).toEqual(restoreResponse);
              expect(yield* advanceRecovery).toMatchObject({ status: "awaiting_input" });
              expect(
                yield* f.sql`SELECT operation_id FROM relay_thread_vm_restores WHERE thread_id=${f.threadId}`,
              ).toEqual([{ operation_id: operationId }]);
            }
            const restored = throughRecovery
              ? (yield* restores.get(operationId))!
              : yield* restores.begin(intent);
            expect(restored.workflowCheckpoint?.publicationId).toBe(publicationId);
            expect(restored.nativeCheckpointOperationId).toBeNull();
            expect(
              (yield* makeThreadVmAllocationStore(f.sql).getAny(operationId))?.resourceKind,
            ).toBe("organization_workflow");
            expect((yield* makeThreadVmCapacityStore(f.sql).get(operationId))?.state).toBe(
              "waiting",
            );
            yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json(restoreResponse)} WHERE job_id=${f.workflowJobId}`;
            if (scenario === "loss-while-parked")
              expect(yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true })).toBeNull();
            yield* connectCodex;
            if (parkRestore) yield* f.capacity.configure(f.hostId, 1);
            expect(
              (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
            ).toBe(operationId);
            const setCodexStatus = (status: "connected" | "disconnected") =>
              f.sql`UPDATE relay_codex_vm_connections SET status=${status} WHERE organization_id=${f.organizationId}`;
            let catalogCalls = 0;
            let catalogFails = false;
            let disconnectDuringCatalog = false;
            const restoreWorker = makeThreadVmRestoreWorker(
              f.sql,
              objects,
              {
                resolveSource: (sourceTemplateID, sourceBuildID) =>
                  Effect.gen(function* () {
                    catalogCalls++;
                    if (disconnectDuringCatalog)
                      yield* setCodexStatus("disconnected").pipe(Effect.orDie);
                    if (catalogFails)
                      return yield* new E2BRestoreError({
                        operation: "resolveSource",
                        reason: "transport",
                      });
                    return { sourceTemplateID, sourceBuildID };
                  }),
              },
              f.hostId,
            );
            if (parkRestore) {
              const readmit = f.capacity.admitNext(f.hostId, { workflowEnabled: true });
              const assertParked = Effect.gen(function* () {
                expect((yield* f.capacity.get(operationId))?.state).toBe("waiting");
                expect(yield* restores.get(operationId)).toMatchObject({
                  claimId: null,
                  errorCode: null,
                });
                expect((yield* (yield* Workflows).getJob(f.workflowJobId))?.pendingControl).toEqual(
                  restoreResponse,
                );
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toEqual({ state: "waiting_codex" });
                const competitor = yield* seed({ hostId: f.hostId, personal: true });
                yield* f.capacity.configure(f.hostId, 1);
                expect((yield* readmit)?.operationId).toBe(competitor.operationId);
                yield* f.capacity.cancelUnstarted(competitor.operationId);
                yield* setCodexStatus("connected");
                expect((yield* readmit)?.operationId).toBe(operationId);
              });

              yield* setCodexStatus("disconnected");
              expect(yield* restoreWorker.runOne()).toBe(true);
              expect(catalogCalls).toBe(0);
              expect((yield* restores.get(operationId))?.phase).toBe("pending");
              yield* assertParked;

              catalogFails = true;
              expect(yield* restoreWorker.runOne()).toBe(true);
              expect((yield* f.capacity.get(operationId))?.state).toBe("reserved");
              expect((yield* restores.get(operationId))?.errorCode).toBe("snapshot_unconfirmed");
              yield* f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp() WHERE operation_id=${operationId}`;
              disconnectDuringCatalog = true;
              expect(yield* restoreWorker.runOne()).toBe(true);
              expect(yield* restores.get(operationId)).toMatchObject({
                phase: "preparing",
                preparedReceipt: null,
              });
              yield* assertParked;

              catalogFails = false;
              expect(yield* restoreWorker.runOne()).toBe(true);
              expect(yield* restores.get(operationId)).toMatchObject({
                phase: "prepared",
                preparedReceipt: { sourceTemplateId: snapshotId, sourceBuildId },
              });
              yield* assertParked;
              expect(catalogCalls).toBe(3);
            } else {
              expect(yield* restoreWorker.runOne()).toBe(true);
            }
            expect((yield* restores.get(operationId))?.phase).toBe("prepared");
            if (parkRestore) {
              const store = yield* Workflows;
              const original = job.vmAdmission!.codexConnectionId;
              const replaceConnection = (status: "connected" | "disconnected", id = original) =>
                f.sql`UPDATE relay_codex_vm_connections SET status=${status},connection_id=${id}
                  WHERE organization_id=${f.organizationId}`;
              const admit = () => f.capacity.admitNext(f.hostId, { workflowEnabled: true });
              const work = () => store.getJob(f.workflowJobId);
              const due = f.sql`UPDATE relay_thread_vm_restores SET retry_at=clock_timestamp() WHERE operation_id=${operationId}`;
              const sandboxId = NodeCrypto.randomUUID();
              const sandbox = pausedSandbox(sandboxId, operationId, operationId, f.threadId, 2);
              const observed: SandboxInfo = {
                ...sandbox,
                templateId: snapshotId,
                state: "running",
                metadata: { ...sandbox.metadata, "launchpad.restore": "v1" },
              };
              const nativeInspections: Array<SandboxInfo | null | "unavailable"> = [];
              const deleteStarted = yield* Deferred.make<void>();
              let creates = 0;
              let lookups = 0;
              let deletes = 0;
              let deleteUnavailable = false;
              let holdDelete = false;
              let visible = false;
              const worker = makeThreadVmRestoreServingWorker(
                f.sql,
                objects,
                {
                  createFromSnapshot: (request) =>
                    Effect.gen(function* () {
                      creates++;
                      expect(request).toMatchObject({ operationId, generation: 2, bootAttempt: 0 });
                      return yield* new ThreadVmComputeError({
                        operation: "create",
                        message: "Lost reply",
                      });
                    }),
                  findOperation: (id) =>
                    Effect.sync(() => {
                      lookups++;
                      expect(id).toBe(operationId);
                      return visible ? [observed] : [];
                    }),
                  inspect: (id) =>
                    Effect.gen(function* () {
                      expect(id).toBe(sandboxId);
                      const next = nativeInspections.shift();
                      if (next !== undefined && next !== "unavailable") return next;
                      return yield* new ThreadVmComputeError({
                        operation: "inspect",
                        message: "Temporary",
                      });
                    }),
                  recoverIngress: () => Effect.die("No ingress before the boot is inspectable"),
                  destroy: (id) =>
                    Effect.gen(function* () {
                      expect(id).toBe(sandboxId);
                      deletes++;
                      if (holdDelete) {
                        yield* Deferred.succeed(deleteStarted, undefined);
                        return yield* Effect.never;
                      }
                      if (deleteUnavailable)
                        return yield* new ThreadVmComputeError({
                          operation: "destroy",
                          message: "Temporary",
                        });
                    }),
                },
                f.hostId,
                () => Effect.die("No bootstrap before the boot is inspectable"),
              );
              for (const phase of ["prepared", "committed"] as const) {
                const generation = phase === "prepared" ? 1 : 2;
                yield* replaceConnection("disconnected");
                expect(yield* worker.runOne()).toBe(true);
                expect(yield* restores.get(operationId)).toMatchObject({
                  phase,
                  targetGeneration: phase === "prepared" ? null : generation,
                  bootCreateStarted: false,
                  bootReceipt: null,
                });
                expect(yield* f.placements.getAny(f.threadId)).toMatchObject({
                  generation,
                  operationId,
                });
                expect(yield* f.capacity.get(operationId)).toMatchObject({
                  state: "waiting",
                  computeRef: null,
                });
                expect(yield* work()).toMatchObject({
                  status: "awaiting_input",
                  pendingControl: restoreResponse,
                  record: { progress: { revision: 1, checkpoint } },
                });
                expect(
                  yield* f.sql`SELECT claim_id,claim_until FROM relay_thread_vm_restores WHERE operation_id=${operationId}`,
                ).toEqual([{ claim_id: null, claim_until: null }]);
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toEqual({ state: "waiting_codex" });
                expect(creates).toBe(0);

                const competitor = yield* seed({ hostId: f.hostId, personal: true });
                yield* f.capacity.configure(f.hostId, 1);
                expect((yield* admit())?.operationId).toBe(competitor.operationId);
                yield* f.capacity.cancelUnstarted(competitor.operationId);
                yield* replaceConnection("connected", NodeCrypto.randomUUID());
                expect(yield* admit()).toBeNull();
                expect(yield* worker.runOne()).toBe(false);
                expect((yield* work())?.pendingControl).toEqual(restoreResponse);
                yield* replaceConnection("connected");
                expect((yield* admit())?.operationId).toBe(operationId);
                expect(yield* worker.runOne()).toBe(true);
                expect((yield* f.placements.getAny(f.threadId))?.generation).toBe(2);
              }

              // The create crossed the native boundary. A disconnect cannot give away its slot.
              expect(creates).toBe(1);
              expect(yield* restores.get(operationId)).toMatchObject({
                phase: "creating",
                bootCreateStarted: true,
                bootReceipt: null,
              });
              yield* replaceConnection("disconnected");
              yield* due;
              expect(yield* worker.runOne()).toBe(true);
              expect(lookups).toBe(1);
              expect(yield* f.capacity.get(operationId)).toMatchObject({
                state: "started",
                computeRef: null,
              });
              const waiting = yield* seed({ hostId: f.hostId, personal: true });
              yield* f.capacity.configure(f.hostId, 1);
              expect(yield* admit()).toBeNull();
              expect((yield* work())?.pendingControl).toEqual(restoreResponse);

              yield* replaceConnection("connected");
              visible = true;
              yield* due;
              expect(yield* worker.runOne()).toBe(true);
              expect(creates).toBe(1);
              expect(lookups).toBe(2);
              expect(yield* restores.get(operationId)).toMatchObject({
                bootReceipt: { sandboxId, generation: 2, bootAttempt: 0 },
              });
              expect(yield* f.capacity.get(operationId)).toMatchObject({
                state: "started",
                computeRef: sandboxId,
              });
              expect((yield* work())?.pendingControl).toEqual(restoreResponse);
              expect(deletes).toBe(0);

              // A lost boot prompts cleanup, but the native delete acknowledgement can precede disappearance.
              yield* replaceConnection("disconnected");
              for (const attempt of [
                {
                  inspections: [null, { ...observed, metadata: {} }],
                  deleteUnavailable: false,
                  attempts: 0,
                },
                { inspections: [observed, observed], deleteUnavailable: false, attempts: 1 },
                { inspections: [observed], deleteUnavailable: true, attempts: 2 },
                {
                  inspections: [observed, "unavailable" as const],
                  deleteUnavailable: false,
                  attempts: 3,
                },
              ]) {
                nativeInspections.push(...attempt.inspections);
                deleteUnavailable = attempt.deleteUnavailable;
                yield* due;
                expect(yield* worker.runOne()).toBe(true);
                expect(nativeInspections).toEqual([]);
                expect(deletes).toBe(attempt.attempts);
                expect(yield* restores.get(operationId)).toMatchObject({
                  bootRecoveryStarted: true,
                  bootReceipt: { sandboxId, generation: 2, bootAttempt: 0 },
                });
                expect(yield* f.capacity.get(operationId)).toMatchObject({
                  state: "started",
                  computeRef: sandboxId,
                });
                expect(yield* admit()).toBeNull();
                expect(
                  (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
                ).toMatchObject({
                  state: "recovery_error",
                  detail: expect.stringMatching(
                    /could not confirm deletion of the previous workflow VM/,
                  ),
                });
              }
              const attentionChecked = yield* f.sql
                .withTransaction(
                  Effect.gen(function* () {
                    const current = (yield* work())!;
                    yield* store.updateJob(
                      current,
                      { ...current.record, status: "cancelling" },
                      {
                        userId: f.ownerUserId,
                        response: { operation: "cancel" },
                      },
                    );
                    yield* f.sql`UPDATE relay_thread_vm_restores SET phase='aborting' WHERE operation_id=${operationId}`;
                    const attention = yield* store.pageJobs(f.repositoryId, { view: "attention" });
                    expect(attention.jobs).toMatchObject([
                      { jobId: f.workflowJobId, status: "cancelling", needsAttention: true },
                    ]);

                    yield* f.sql`UPDATE relay_thread_vm_restores SET error_code=NULL WHERE operation_id=${operationId}`;
                    expect(
                      (yield* store.pageJobs(f.repositoryId, { view: "attention" })).jobs,
                    ).toEqual([]);
                    expect(
                      (yield* store.pageJobs(f.repositoryId, { view: "active" })).jobs,
                    ).toMatchObject([
                      { jobId: f.workflowJobId, status: "cancelling", needsAttention: false },
                    ]);
                    return yield* Effect.fail("rollback-attention-check" as const);
                  }),
                )
                .pipe(Effect.flip);
              expect(attentionChecked).toBe("rollback-attention-check");

              // An interrupted delete must report uncertainty even without a prior warning.
              yield* f.sql`UPDATE relay_thread_vm_restores SET error_code=NULL,retry_at=clock_timestamp()
                WHERE operation_id=${operationId}`;
              nativeInspections.push(observed);
              holdDelete = true;
              const interrupted = yield* worker.runOne().pipe(Effect.forkChild);
              yield* Deferred.await(deleteStarted);
              yield* Fiber.interrupt(interrupted);
              holdDelete = false;
              expect(deletes).toBe(4);
              expect(yield* f.capacity.get(operationId)).toMatchObject({
                state: "started",
                computeRef: sandboxId,
              });
              expect(yield* restores.get(operationId)).toMatchObject({
                claimId: null,
                errorCode: "boot_deletion_unconfirmed",
                bootReceipt: { sandboxId, generation: 2, bootAttempt: 0 },
              });
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
              ).toMatchObject({
                state: "recovery_error",
                detail: expect.stringMatching(/could not confirm deletion/),
              });
              expect(yield* admit()).toBeNull();

              nativeInspections.push(observed, null);
              yield* due;
              expect(yield* worker.runOne()).toBe(true);
              expect(deletes).toBe(5);
              expect(nativeInspections).toEqual([]);
              expect(yield* restores.get(operationId)).toMatchObject({
                phase: "committed",
                targetGeneration: 2,
                bootAttempt: 1,
                bootCreateStarted: false,
                bootReceipt: null,
              });
              expect(yield* worker.runOne()).toBe(true);
              expect(yield* f.placements.getAny(f.threadId)).toMatchObject({
                generation: 2,
                operationId,
              });
              expect(yield* f.capacity.get(operationId)).toMatchObject({
                state: "waiting",
                computeRef: null,
              });
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
              ).toEqual({ state: "waiting_codex" });
              expect((yield* admit())?.operationId).toBe(waiting.operationId);
              expect((yield* work())?.pendingControl).toEqual(restoreResponse);
              expect(creates).toBe(1);
              return;
            }
            const serving = makeThreadVmRestoreServingStore(f.sql, objects);
            const commit = (yield* serving.claim(f.hostId))!;
            const destination = yield* serving.commit(commit);
            expect(destination?.targetGeneration).toBe(2);
            expect(destination?.allocationId).toBe(operationId);
            expect((yield* f.placements.getAny(f.threadId))?.operationId).toBe(operationId);
            if (abortCommitted) {
              yield* f.sql`UPDATE relay_codex_vm_connections SET status='disconnected' WHERE organization_id=${f.organizationId}`;
              expect(yield* serving.beginCreate((yield* serving.claim(f.hostId))!)).toBeNull();
              expect(yield* f.capacity.get(operationId)).toMatchObject({
                state: "waiting",
                computeRef: null,
              });
              const cancelling = scenario === "restore-cancelled-after-commit";
              if (cancelling) {
                yield* f.sql`UPDATE relay_workflow_jobs SET status='cancelling',record=jsonb_set(record,'{status}','"cancelling"'),
                  pending_control=${f.sql.json({ userId: f.ownerUserId, response: { operation: "cancel" } })} WHERE job_id=${f.workflowJobId}`;
              } else {
                yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id=${f.organizationId} AND user_id=${f.ownerUserId}`;
              }
              expect(yield* advanceRecovery).toMatchObject({
                status: cancelling ? "cancelling" : "awaiting_input",
              });
              const abort = (yield* serving.claim(f.hostId))!;
              expect(abort.phase).toBe("aborting");
              yield* serving.completeCommittedAbort(abort);
              expect((yield* f.capacity.get(operationId))?.state).toBe("released");
              expect(yield* f.placements.getAny(f.threadId)).toMatchObject({
                generation: 2,
                operationId: null,
              });
              expect(yield* makeThreadVmSavedDiskStore(f.sql).get(saved)).toMatchObject({
                generation: 1,
                phase: "available",
              });
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
              ).toEqual({ state: "saved" });
              if (cancelling) {
                expect(yield* advanceRecovery).toMatchObject({
                  status: "cancelled",
                  progress: { executionReleased: true },
                });
                return;
              }
              yield* connectCodex;
              const replacementResponseId = NodeCrypto.randomUUID();
              yield* f.sql`UPDATE relay_workflow_jobs SET pending_control=${f.sql.json({ ...restoreResponse, responseId: replacementResponseId })} WHERE job_id=${f.workflowJobId}`;
              expect(yield* advanceRecovery).toMatchObject({ status: "awaiting_input" });
              expect(yield* restores.get(replacementResponseId)).toMatchObject({
                generation: 2,
                sourceGeneration: 1,
                savedDiskOperationId: saved,
              });
              expect(
                (yield* f.capacity.admitNext(f.hostId, { workflowEnabled: true }))?.operationId,
              ).toBe(replacementResponseId);
              expect(yield* restoreWorker.runOne()).toBe(true);
              expect(yield* serving.commit((yield* serving.claim(f.hostId))!)).toMatchObject({
                targetGeneration: 3,
              });
              return;
            }
            const create = (yield* serving.claim(f.hostId))!;
            if (revokeResponse) {
              yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id=${f.organizationId} AND user_id=${f.ownerUserId}`;
              expect(yield* serving.beginCreate(create)).toBeNull();
              expect((yield* restores.get(operationId))?.bootCreateStarted).toBe(false);
              expect((yield* restores.get(operationId))?.phase).toBe("aborting");
              return;
            }
            expect(yield* credentials.authenticate(sourceToken)).toMatchObject({ _tag: "None" });
            expect(yield* Effect.isFailure(asVm(getThreadVmRestoreRecovery(f.owner)))).toBe(true);
            expect((yield* serving.beginCreate(create))?.phase).toBe("creating");
            yield* serving.recordObserved(create, NodeCrypto.randomUUID(), "sealed-routing");
            yield* serving.recordBootstrap(create, {
              version: 1,
              kind: "native-warm-restore-bootstrap-v1",
              boot: {
                version: 1,
                operationId,
                allocationId: operationId,
                threadId: f.threadId,
                generation: 2,
              },
              source: {
                allocationId: f.allocationId,
                operationId: f.operationId,
                threadId: f.threadId,
                generation: 1,
                bootId,
                captureOperationId: pending.operationId,
                sealEpoch: 1,
              },
              targetSealEpoch: 2,
              coordinatorStopped: true,
              sealRebound: true,
            });
            const environmentId = EnvironmentId.make(NodeCrypto.randomUUID());
            const credentialId = NodeCrypto.randomUUID();
            const targetToken = NodeCrypto.randomUUID();
            yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
            VALUES(${credentialId},${environmentId},'restored-key',${hash(targetToken)},'2026','2026')`;
            yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
            VALUES(${environmentId},${operationId},${f.threadId},${f.repositoryId},2,'restored-key',${credentialId})`;
            yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
            VALUES(${operationId},${operationId},${credentialId},${environmentId},'restored-key',${credentialId},'sealed-fixture',clock_timestamp(),clock_timestamp())`;
            yield* makeThreadVmRestoreEnrollmentStore(f.sql).assigned({
              enrolled: true,
              operationId,
              allocationId: operationId,
              environmentId,
              threadId: ThreadId.make(f.threadId),
              generation: 2,
            });
            yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at)
            VALUES(${`github.com/acme/recovery-${f.repositoryId}`},${f.repositoryId},${f.organizationId},'2026')`;
            yield* f.sql`INSERT INTO relay_thread_vm_codex_auth(allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id,acknowledged_connection_id)
            SELECT ${operationId},${environmentId},2,${f.threadId},organization_id,'organization',
              record#>>'{vmAdmission,codexConnectionId}',record#>>'{vmAdmission,codexConnectionId}'
            FROM relay_workflow_jobs WHERE job_id=${f.workflowJobId}`;
            const target = yield* credentials.authenticate(targetToken);
            if (target._tag !== "Some" || !target.value.threadVm)
              return yield* Effect.die("Missing restored credential");
            const owner = { threadId: f.threadId, environmentId, generation: 2 };
            const recovery = yield* asVm(getThreadVmRestoreRecovery(owner), target.value);
            expect(recovery).toMatchObject({
              operationId,
              native: null,
              workflow: { binding: { allocationId: operationId, environmentId, generation: 2 } },
            });
            const artifact = { ...owner, operationId, artifactId: state.artifactId };
            const body = yield* asVm(readThreadVmRestoreArtifact(artifact), target.value);
            expect(Buffer.concat(yield* Stream.runCollect(body))).toEqual(stateBytes);
            expect(yield* Effect.isFailure(asVm(readThreadVmRestoreArtifact(artifact)))).toBe(true);
            const receipt = {
              version: 1,
              operationId,
              environmentId,
              scope: target.value.threadVm,
              projectId: ProjectId.make(`vm:${f.threadId}`),
              workspaceRoot: "/workspace/project",
              checkoutPath: "/workspace/project",
              branch: "main",
              revision: "a".repeat(40),
              manifestSha256: "b".repeat(64),
              sourceEnvironmentId: EnvironmentId.make(f.owner.environmentId),
              sourceSequence: 0,
              nativeManifestArtifactId: null,
              attachmentManifestArtifactId: null,
              workflowPublicationId: publicationId,
              workflowStateSha256: state.sha256,
              sequence: 1,
              execution: "frozen",
            } as const;
            const imports = makeThreadVmRestoreImportStore(f.sql, objects);
            yield* imports.record((yield* imports.claim(f.hostId))!, receipt);
            const activate = asVm(confirmThreadVmRestoreActivation(owner, receipt), target.value);
            expect(yield* activate).toEqual({ ready: true });
            expect((yield* f.placements.getAny(f.threadId))?.operationId).toBeNull();
            expect(yield* activate).toEqual({ ready: true });
            if (scenario === "restored-native-cancel") {
              const replacement = (yield* makeThreadVmAllocationStore(f.sql).getAny(operationId))!;
              const reboundPublicationId = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_workflow_recovery_records
                (publication_id,job_id,thread_id,revision,manifest_artifact_id,manifest_sha256,manifest_size_bytes,manifest)
                VALUES(${reboundPublicationId},${f.workflowJobId},${f.threadId},2,${NodeCrypto.randomUUID()},${"1".repeat(64)},1,${f.sql.json(
                  {
                    ...manifest,
                    publicationId: reboundPublicationId,
                    revision: 2,
                    binding: {
                      ...manifest.binding,
                      environmentId,
                      operationId,
                      allocationId: operationId,
                      generation: 2,
                    },
                  },
                )})`;
              yield* f.sql`UPDATE relay_workflow_recovery_heads SET publication_id=${reboundPublicationId},revision=2 WHERE job_id=${f.workflowJobId}`;
              yield* f.sql`UPDATE relay_workflow_jobs SET status='cancelling',record=jsonb_set(record,'{status}','"cancelling"'),
                pending_control=${f.sql.json({ userId: f.ownerUserId, response: { operation: "cancel" } })} WHERE job_id=${f.workflowJobId}`;
              const paused = {
                ...pausedSandbox(replacement.computeRef!, operationId, operationId, f.threadId, 2),
                templateId: replacement.templateId.split(":")[0]!,
              };
              expect(
                yield* makeThreadVmLeaseWorker(
                  f.sql,
                  () =>
                    Effect.fail(
                      new ThreadVmComputeError({ operation: "lease", message: "Paused" }),
                    ),
                  f.hostId,
                  { inspect: () => Effect.succeed(paused) },
                ).runOne(),
              ).toBe(true);
              expect(yield* advanceRecovery).toMatchObject({
                status: "cancelled",
                progress: { executionReleased: true },
              });
              expect((yield* f.capacity.get(operationId))?.state).toBe("released");
              expect((yield* makeThreadVmAllocationStore(f.sql).getAny(operationId))?.state).toBe(
                "paused",
              );
              expect((yield* f.placements.getAny(f.threadId))?.generation).toBe(2);
            }
            yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${credentialId}`;
            expect(yield* credentials.authenticate(targetToken)).toMatchObject({ _tag: "None" });
            expect(yield* Effect.isFailure(activate)).toBe(true);
            if (scenario === "idle-restore") {
              // Project the next checkpoint after a later idle save without repeating the native workers.
              const nextCheckpoint = { ...checkpoint, checkpointId: "next-input", generation: 1 };
              const store = yield* Workflows;
              const continued = (yield* store.getJob(f.workflowJobId))!;
              yield* store.updateJob(
                continued,
                {
                  ...continued.record,
                  progress: {
                    ...continued.record.progress!,
                    revision: 2,
                    checkpoint: nextCheckpoint,
                  },
                },
                null,
              );
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp()
                WHERE allocation_id=${operationId}`;
              yield* f.sql`UPDATE relay_thread_vm_saved_disks SET generation=2,phase='available',restore_operation_id=NULL,restore_allocation_id=NULL
                WHERE operation_id=${saved}`;
              yield* f.sql`UPDATE relay_thread_vm_final_saves SET source_receipt=jsonb_set(source_receipt,'{workflowCheckpoint}',
                (source_receipt->'workflowCheckpoint') || ${f.sql.json({ checkpointId: nextCheckpoint.checkpointId, checkpointGeneration: nextCheckpoint.generation })})
                WHERE operation_id=${saved}`;
              expect(
                (yield* readWorkflowVmRecoveries(f.sql, [f.workflowJobId])).get(f.workflowJobId),
              ).toEqual({ state: "saved" });
            }
          }).pipe(Effect.provide(Layer.merge(workflows, NodeFileSystem.layer))),
      );
    }
  });
});
