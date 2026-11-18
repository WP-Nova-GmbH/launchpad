import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { WorkflowVmPublishingRestore } from "@t3tools/contracts/workflows";
import { expect, it } from "@effect/vitest";
import { baseCommit, commitAt, initial } from "../jobs/WorkflowActions.test-fixture.ts";
import type { WorkflowRunRecovery } from "../jobs/WorkflowRunStore.ts";
import { restoreWorkflowPublishingAction } from "./ThreadVmWorkflowRestore.ts";

function recoveryFixture() {
  const run = initial();
  const agent = run.workflow.definition.steps[0]!;
  const push = run.workflow.definition.steps[1]!;
  const review = { id: "review", kind: "review", title: "Review", role: "maintainer" } as const;
  const pr = { id: "pr", kind: "action", action: "open_pull_request", title: "Open PR" } as const;
  const checkpoint = {
    ...run.sequence!.completed[0]!.checkpoint!,
    checkpointId: "workflow:job:checkpoint:review:0",
    stepId: review.id,
    kind: "review",
    generation: 0,
    role: "maintainer",
  } as const;
  const capsule: WorkflowRunRecovery = {
    format: "workflow-run-recovery-v1",
    frozenConfiguration: { jobId: "job", repositoryId: "repo" },
    workflowIgnoreRulesBase64: null,
    checkpointPins: [
      {
        turnId: checkpoint.turnId,
        turnCount: 1,
        checkpointRef: checkpoint.checkpointRef,
        commitId: commitAt(1),
        treeId: commitAt(2),
        baselineCommitId: baseCommit,
      },
    ],
    run: {
      ...run,
      executionReserved: false,
      actions: [],
      runtime: {
        kind: "vm",
        jobId: "job",
        organizationId: "org",
        repositoryId: "repo",
        allocationId: "allocation",
        operationId: "operation",
        generation: 1,
        environmentId: EnvironmentId.make("env"),
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("thread"),
      },
      workflow: {
        ...run.workflow,
        definition: {
          ...run.workflow.definition,
          steps: [agent, review, push, pr],
        },
      },
      progress: { ...run.progress, status: "awaiting_review", stepId: review.id, checkpoint },
    },
  };
  const published = {
    actionId: "workflow:job:action:push:0",
    stepId: "push",
    stepGeneration: 0,
    operation: "push",
    resultTurnId: checkpoint.turnId,
    checkpointRef: checkpoint.checkpointRef,
    tree: commitAt(2),
    parent: baseCommit,
    commitSha: commitAt(3),
    oldRemoteSha: null,
    pullRequestUrl: null,
    outcome: { commitSha: commitAt(3), pullRequestUrl: null },
  } as const;
  const publishing: WorkflowVmPublishingRestore = {
    action: {
      ...published,
      actionId: "workflow:job:action:pr:0",
      stepId: "pr",
      operation: "open_pull_request",
      parent: published.commitSha,
      oldRemoteSha: published.commitSha,
    },
    outcome: null,
    completedActions: [published],
    previousPush: published,
    expectedRevision: 12,
    latestPublicationRevision: 8,
    responses: [
      {
        checkpointId: checkpoint.checkpointId,
        stepId: review.id,
        generation: 0,
        operation: "approve",
        userId: "reviewer",
        text: null,
        createdAt: "now",
      },
    ],
  };
  return { capsule, publishing, published, pr };
}

it("restores a confirmed Push and accepted Review from before either occurred", () => {
  const { capsule, publishing, published, pr } = recoveryFixture();
  const restored = restoreWorkflowPublishingAction(capsule, publishing)?.run;
  expect(restored?.preparedHead).toBe(published.commitSha);
  expect(restored?.publication?.publishedHead).toBe(published.commitSha);
  expect(restored?.sequence?.responses).toEqual(publishing.responses);
  expect(restored?.sequence?.completed.map((step) => step.stepId)).toEqual([
    "agent",
    "review",
    "push",
  ]);
  expect(restored?.sequence?.cursor).toBe(3);
  expect(restored?.progress).toMatchObject({
    status: "paused",
    stepId: pr.id,
    revision: 12,
    checkpoint: null,
  });
  expect(restored?.actions?.map((action) => action.state)).toEqual(["completed", "uncertain"]);
  expect(restoreWorkflowPublishingAction(capsule, { ...publishing, responses: [] })).toBeNull();
  expect(
    restoreWorkflowPublishingAction(capsule, {
      ...publishing,
      action: { ...publishing.action, tree: commitAt(4) },
    }),
  ).toBeNull();
});

it("restores an Open PR intent lost before it bound the commit or sent a POST", () => {
  const { capsule, publishing, published } = recoveryFixture();
  const restored = restoreWorkflowPublishingAction(capsule, {
    ...publishing,
    action: { ...publishing.action, commitSha: null },
  })?.run;
  expect(restored?.publication?.publishedHead).toBe(published.outcome.commitSha);
  expect(restored?.actions?.at(-1)).toMatchObject({
    operation: "open_pull_request",
    state: "uncertain",
    commitSha: published.outcome.commitSha,
    commands: [],
  });
});

it("rejects an Open PR intent bound to a different commit than the confirmed Push", () => {
  const { capsule, publishing } = recoveryFixture();
  expect(
    restoreWorkflowPublishingAction(capsule, {
      ...publishing,
      action: { ...publishing.action, commitSha: commitAt(4) },
    }),
  ).toBeNull();
  expect(
    restoreWorkflowPublishingAction(capsule, {
      ...publishing,
      action: { ...publishing.action, commitSha: null },
      previousPush: { ...publishing.previousPush!, commitSha: commitAt(4) },
    }),
  ).toBeNull();
});
