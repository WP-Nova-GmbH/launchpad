import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { makeWorkflowResultOutbox } from "../jobs/WorkflowResultOutbox.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initial } from "../jobs/WorkflowActions.test-fixture.ts";
import { WorkflowRun, make as makeStore } from "../jobs/WorkflowRunStore.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "./ThreadExecutionFence.ts";
import { requireWorkflowVmLifecycleCheckpoint } from "./WorkflowThreadOwnership.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowRun));
const enrollment = {
  threadId: "thread",
  projectId: "project",
  relayUrl: "https://relay.example",
  environmentId: "environment",
  generation: 1,
  operationId: "enroll",
};
const move = {
  threadId: "thread",
  generation: 1,
  operationId: "move",
  previousOperationId: "enroll",
};
const released = (): WorkflowRun => {
  const run = initial();
  return { ...run, executionReserved: false, progress: { ...run.progress, status: "done" } };
};
const blocked: ReadonlyArray<readonly [string, (run: WorkflowRun) => WorkflowRun]> = [
  ["running", (run) => ({ ...run, progress: { ...run.progress, status: "running" } })],
  [
    "awaiting review",
    (run) => ({ ...run, progress: { ...run.progress, status: "awaiting_review" } }),
  ],
  [
    "waiting capacity",
    (run) => ({ ...run, progress: { ...run.progress, status: "waiting_capacity" } }),
  ],
  ["manual pause", (run) => ({ ...run, manualPause: { state: "paused", promptId: null } })],
  ["terminal reservation", (run) => ({ ...run, executionReserved: true })],
  [
    "approval cleanup",
    (run) => ({
      ...run,
      approvalAttempt: {
        approvedBy: null,
        checkpointId: "checkpoint",
        preparedHead: "head",
        acceptedRevision: 1,
        commandId: "approval",
        createdAt: "now",
        setupCleanup: { attemptId: "setup", state: "pending", detail: null },
      },
    }),
  ],
  [
    "cancellation cleanup",
    (run) => ({
      ...run,
      cancellationAttempt: {
        commandId: "cancel",
        createdAt: "now",
        setupCleanup: { attemptId: "setup", state: "failed", detail: "unconfirmed" },
      },
    }),
  ],
  [
    "queue intent",
    (run) => ({
      ...run,
      pendingQueueDismissal: { commandId: "dismiss", expectedRevision: 1, createdAt: "now" },
    }),
  ],
  [
    "preparation intent",
    (run) => ({
      ...run,
      pendingPreparationRetry: {
        commandId: "retry",
        expectedRevision: 1,
        expectedControlRevision: 1,
        createdAt: "now",
      },
    }),
  ],
  [
    "publishing command",
    (run) => ({
      ...run,
      actions: run.actions?.map((action) => ({
        ...action,
        commands: [
          { id: "command", pid: 42, identity: "owner", boot: null, stopped: false, code: null },
        ],
      })),
    }),
  ],
];
for (const [name, hold] of blocked)
  it.effect(`does not enroll, drain, activate or freeze ${name} workflow ownership`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = makeThreadExecutionFence(sql);
      const run = hold(released());
      const put = sql`INSERT INTO repository_workflow_jobs VALUES (${run.jobId},${run.progress.threadId},${run.progress.status},${run.executionReserved ? 1 : 0},${encode(run)})`;
      const clear = sql`DELETE FROM repository_workflow_jobs`;
      yield* put;
      assert.include((yield* Effect.flip(fence.prepare(enrollment))).message, "workflow");
      assert.isNull(yield* fence.get("thread"));
      yield* clear;
      yield* fence.prepare(enrollment);
      yield* put;
      assert.include((yield* Effect.flip(fence.activate(enrollment))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "frozen");
      yield* clear;
      yield* fence.activate(enrollment);
      yield* put;
      assert.include((yield* Effect.flip(fence.beginDrain(move))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "active");
      yield* clear;
      yield* fence.beginDrain(move);
      yield* put;
      assert.include((yield* Effect.flip(fence.freeze(move))).message, "workflow");
      assert.equal((yield* fence.get("thread"))?.phase, "draining");
      const store = yield* makeStore;
      assert.isNotNull(yield* store.getByThread("thread"));
      assert.lengthOf(yield* store.owners(), 1);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
  );
for (const status of ["done", "cancelled", "failed"] as const)
  it.effect(`permits VM placement after ${status} workflow fully releases ownership`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const run = released();
      const ended = { ...run, progress: { ...run.progress, status } };
      yield* sql`INSERT INTO repository_workflow_jobs VALUES (${run.jobId},${run.progress.threadId},${status},0,${encode(ended)})`;
      const fence = makeThreadExecutionFence(sql);
      yield* fence.prepare(enrollment);
      yield* fence.activate(enrollment);
      yield* fence.beginDrain(move);
      assert.equal(yield* fence.freeze(move), 0);
      const store = yield* makeStore;
      assert.isNull(yield* store.getByThread("thread"));
      assert.deepEqual(yield* store.owners(), []);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
  );
it.effect("fails closed for a malformed terminal workflow record", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repository_workflow_jobs VALUES ('bad','thread','done',0,'{}')`;
    assert.include(
      (yield* Effect.flip(makeThreadExecutionFence(sql).prepare(enrollment))).message,
      "workflow",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("pauses and reopens the original placement at an acknowledged first Input", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fences = makeThreadExecutionFence(sql);
    yield* fences.prepare(enrollment);
    yield* fences.activate(enrollment);
    const initialRun = released();
    const binding = {
      jobId: initialRun.jobId,
      organizationId: initialRun.workflow.organizationId,
      repositoryId: initialRun.workflow.repositoryId,
      threadId: ThreadId.make(enrollment.threadId),
      projectId: ProjectId.make(enrollment.projectId),
      environmentId: EnvironmentId.make(enrollment.environmentId),
      generation: enrollment.generation,
      operationId: enrollment.operationId,
      allocationId: "allocation",
    };
    const checkpoint = {
      checkpointId: "first-input",
      kind: "input" as const,
      stepId: "input",
      generation: 0,
      role: "maintainer" as const,
      question: "What should the Agent do?",
    };
    const store = yield* makeStore;
    yield* store.save({
      ...initialRun,
      runtime: { kind: "vm", ...binding },
      providerContinuation: {
        driver: ProviderDriverKind.make("codex"),
        continuationKey: "codex:managed",
      },
      workflow: {
        ...initialRun.workflow,
        definition: {
          ...initialRun.workflow.definition,
          target: { kind: "vm", baseBranch: null },
          steps: [
            {
              id: "input",
              kind: "input",
              title: "Input",
              role: checkpoint.role,
              question: checkpoint.question,
            },
            ...initialRun.workflow.definition.steps,
          ],
        },
      },
      sequence: { ...initialRun.sequence!, cursor: 0, completed: [], started: false },
      progress: { ...initialRun.progress, checkpoint, status: "awaiting_input", stepId: "input" },
    });
    const intent = yield* makeWorkflowResultOutbox(sql).next(binding.threadId);
    assert.isNotNull(intent);
    const descriptor = {
      jobId: binding.jobId,
      checkpointId: checkpoint.checkpointId,
      checkpointGeneration: 0,
      publicationId: intent!.publicationId,
      publicationRevision: intent!.revision,
    };
    yield* Effect.flip(fences.beginDrain({ ...move, workflowCheckpoint: descriptor }));
    yield* sql`UPDATE workflow_result_outbox SET status='acknowledged' WHERE publication_id=${descriptor.publicationId}`;
    const proof = yield* requireWorkflowVmLifecycleCheckpoint(sql, {
      ...move,
      workflowCheckpoint: descriptor,
    });
    assert.isTrue(proof.beforeAgent);
    yield* Effect.flip(
      fences.beginDrain({
        ...move,
        workflowCheckpoint: { ...descriptor, checkpointGeneration: 1 },
      }),
    );
    yield* fences.beginDrain({ ...move, workflowCheckpoint: descriptor });
    assert.equal(yield* fences.freeze({ ...move, workflowCheckpoint: descriptor }), 0);
    yield* fences.activate({ ...move, workflowCheckpoint: descriptor });
    assert.isTrue(yield* store.isVmFenceActive(binding));
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);

it.effect.each(["finished", "unfinished"] as const)(
  "cold activation preserves the native ownership requirements for a %s workflow",
  (state) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fences = makeThreadExecutionFence(sql);
      const restore = { ...enrollment, generation: 2, operationId: "restore" };
      yield* fences.prepare(restore);
      const original = released();
      const binding = {
        ...restore,
        jobId: original.jobId,
        organizationId: original.workflow.organizationId,
        repositoryId: original.workflow.repositoryId,
        threadId: ThreadId.make(restore.threadId),
        projectId: ProjectId.make(restore.projectId),
        environmentId: EnvironmentId.make(restore.environmentId),
        allocationId: "restored-allocation",
      };
      const checkpoint = {
        ...original.sequence!.completed[0]!.checkpoint!,
        checkpointId: "review",
        kind: "review" as const,
        stepId: "review",
        generation: 0,
        role: "maintainer" as const,
      };
      const run: WorkflowRun = {
        ...original,
        runtime: { kind: "vm", ...binding },
        providerContinuation: {
          driver: ProviderDriverKind.make("codex"),
          continuationKey: "codex:managed",
        },
        workflow: {
          ...original.workflow,
          definition: {
            ...original.workflow.definition,
            target: { kind: "vm", baseBranch: null },
            steps: [
              original.workflow.definition.steps[0]!,
              { id: "review", kind: "review", title: "Review", role: "maintainer" },
            ],
          },
        },
        progress: {
          ...original.progress,
          status: state === "finished" ? "done" : "awaiting_review",
          stepId: "review",
          checkpoint,
        },
      };
      const store = yield* makeStore;
      yield* store.save(run);
      const intent = (yield* makeWorkflowResultOutbox(sql).next(binding.threadId))!;
      yield* sql`UPDATE workflow_result_outbox SET status='acknowledged'
        WHERE publication_id=${intent.publicationId}`;
      yield* sql`INSERT INTO projection_projects
        (project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${restore.projectId},'Restored','/workspace/project','[]',${run.createdAt},${run.createdAt})`;
      yield* sql`INSERT INTO projection_threads
        (thread_id,project_id,title,model_selection_json,created_at,updated_at,branch)
        VALUES (${restore.threadId},${restore.projectId},'Restored','{}',
          ${run.createdAt},${run.createdAt},'launchpad/job')`;
      yield* sql`INSERT INTO thread_checkout_claims
        (operation_id,thread_id,generation,project_id,repository_root,checkout_path,
          mode,branch,manifest_sha256,workspace_sha256,inspection_json,phase)
        VALUES (${restore.operationId},${restore.threadId},2,${restore.projectId},
          '/workspace/project','/workspace/project','main','launchpad/job',
          'manifest','workspace','{}','installed')`;
      yield* sql`INSERT INTO thread_transfer_baselines
        (operation_id,thread_id,generation,manifest_sha256,history_sha256,receipts_sha256,
          source_environment_id,source_sequence,destination_sequence)
        VALUES (${restore.operationId},${restore.threadId},2,'manifest','history','receipts','old-environment',7,8)`;
      // Finished human follow-up imports its stopped native cursor without a workflow episode.
      yield* sql`INSERT INTO provider_session_runtime
        (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,
          last_seen_at,resume_cursor_json,runtime_payload_json)
        VALUES (${restore.threadId},'codex','codex','codex','full-access','stopped',
          ${run.createdAt},'{"threadId":"retained-native","resumePolicy":"require-existing"}',
          '{"stoppedRuntimeEventsDrained":true}')`;
      const workflowCheckpoint = {
        jobId: run.jobId,
        checkpointId: state === "finished" ? intent.publicationId : checkpoint.checkpointId,
        checkpointGeneration: 0,
        publicationId: intent.publicationId,
        publicationRevision: intent.revision,
        ...(state === "finished" ? { finishedWorkspaceRevision: 1 } : {}),
      };
      if (state === "unfinished") {
        assert.include(
          (yield* Effect.flip(fences.activate({ ...restore, workflowCheckpoint }))).message,
          "restored workflow runtime is not ready",
        );
        assert.equal((yield* fences.get(restore.threadId))?.phase, "frozen");
        return;
      }
      yield* fences.activate({ ...restore, workflowCheckpoint });
      assert.isTrue(yield* store.isVmFenceActive(binding));
      assert.deepEqual(
        yield* sql`SELECT phase,release_reason FROM thread_checkout_claims
          WHERE operation_id=${restore.operationId}`,
        [{ phase: "released", release_reason: "activated" }],
      );
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);

it.effect(
  "keeps pending saved results during transfer without pretending execution is running",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = makeThreadExecutionFence(sql);
      yield* fence.prepare(enrollment);
      yield* fence.activate(enrollment);
      const run = released();
      yield* sql`INSERT INTO repository_workflow_jobs VALUES (${run.jobId},${run.progress.threadId},'done',0,${encode(run)})`;
      yield* makeWorkflowResultOutbox(sql).enqueue({
        binding: {
          jobId: run.jobId,
          organizationId: "org",
          repositoryId: "repo",
          allocationId: "allocation",
          threadId: ThreadId.make("thread"),
          projectId: ProjectId.make("project"),
          environmentId: EnvironmentId.make("environment"),
          generation: 1,
          operationId: "enroll",
        },
        recordJson: "{}",
      });
      const store = yield* makeStore;
      assert.isNull(yield* store.getByThread("thread"));
      assert.deepEqual(yield* store.owners(), []);
      assert.include((yield* Effect.flip(fence.beginDrain(move))).message, "pending result");
      assert.equal((yield* fence.get("thread"))?.phase, "active");
      yield* sql`UPDATE workflow_result_outbox SET status='acknowledged' WHERE job_id=${run.jobId}`;
      yield* fence.beginDrain(move);
      assert.equal(yield* fence.freeze(move), 0);
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
