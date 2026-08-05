import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitManager } from "../../git/GitManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { JobRunner } from "../Services/JobRunner.ts";
import { GATE_FAIL_MARKER, GATE_PASS_MARKER, m0Workflow, type JobWorkflow } from "../workflow.ts";
import { JobRunnerLive, jobBranchName } from "./JobRunner.ts";

const PROJECT_ID = ProjectId.make("project-job");
const WORKSPACE_ROOT = "/tmp/job-workspace";
const WORKTREE_PATH = "/tmp/job-worktree";
const NOW = "2026-05-01T00:00:00.000Z";

const MODEL_SELECTION = { instanceId: "codex", model: "gpt-5.3-codex" } as const;

function projectShell(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Job Project",
    workspaceRoot: WORKSPACE_ROOT,
    defaultModelSelection: MODEL_SELECTION,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationProjectShell;
}

function sessionSetEvent(input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId: string | null;
  readonly sequence: number;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`evt-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: {
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: input.status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: input.activeTurnId === null ? null : TurnId.make(input.activeTurnId),
        lastError: null,
        updatedAt: NOW,
      },
    },
  };
}

interface HarnessOptions {
  /** How the agent's turn ends, per thread title. Defaults to completing. */
  readonly turnEnds?: (threadId: ThreadId) => "completed" | "failed";
  /** What the reviewing agent said. */
  readonly gateText?: string;
  readonly stackedActionResults?: Partial<
    Record<GitRunStackedActionInput["action"], GitRunStackedActionResult>
  >;
  readonly stackedActionFails?: ReadonlyArray<GitRunStackedActionInput["action"]>;
}

function stackedActionResult(
  action: GitRunStackedActionInput["action"],
  overrides: {
    readonly commit?: GitRunStackedActionResult["commit"];
    readonly push?: GitRunStackedActionResult["push"];
    readonly pr?: GitRunStackedActionResult["pr"];
  } = {},
): GitRunStackedActionResult {
  return {
    action,
    branch: { status: "skipped_not_requested" },
    commit: overrides.commit ?? { status: "created", commitSha: "abc123" },
    push: overrides.push ?? { status: "pushed" },
    pr:
      overrides.pr ??
      (action === "create_pr"
        ? { status: "created", url: "https://example.test/pr/1", number: 1 }
        : { status: "skipped_not_requested" }),
    toast: { title: "done", cta: { kind: "none" } },
  } as unknown as GitRunStackedActionResult;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const pubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const stackedActions = yield* Ref.make<ReadonlyArray<GitRunStackedActionInput>>([]);
    const sequence = yield* Ref.make(0);

    const engineLayer = Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
      get streamDomainEvents() {
        return Stream.fromPubSub(pubSub);
      },
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          yield* Ref.update(dispatched, (all) => [...all, command]);
          if (command.type !== "thread.turn.start") {
            return { sequence: 0 };
          }
          // Stand in for the provider: acknowledge the turn, then settle it.
          const threadId = command.threadId;
          const ends = options.turnEnds?.(threadId) ?? "completed";
          const next = () => Ref.updateAndGet(sequence, (value) => value + 1);
          yield* PubSub.publish(
            pubSub,
            sessionSetEvent({
              threadId,
              status: "running",
              activeTurnId: "turn-1",
              sequence: yield* next(),
            }),
          );
          yield* PubSub.publish(
            pubSub,
            sessionSetEvent({
              threadId,
              status: ends === "completed" ? "ready" : "error",
              activeTurnId: null,
              sequence: yield* next(),
            }),
          );
          return { sequence: 0 };
        }),
    });

    const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeed(Option.some(projectShell())),
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.succeed(
          Option.some({
            id: threadId,
            messages: [
              {
                id: "m1",
                role: "assistant",
                text: options.gateText ?? GATE_PASS_MARKER,
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          } as unknown as OrchestrationThread),
        ),
    });

    const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
      fetchRemote: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "deadbeef", remoteRefName: "refs/remotes/origin/main" }),
      createWorktree: () =>
        Effect.succeed({ worktree: { path: WORKTREE_PATH, refName: jobBranchName("job-1") } }),
    });

    const gitManagerLayer = Layer.mock(GitManager)({
      runStackedAction: (input: GitRunStackedActionInput) =>
        Effect.gen(function* () {
          yield* Ref.update(stackedActions, (all) => [...all, input]);
          if (options.stackedActionFails?.includes(input.action)) {
            return yield* Effect.fail(new Error(`${input.action} failed`) as never);
          }
          return options.stackedActionResults?.[input.action] ?? stackedActionResult(input.action);
        }),
    });

    // The supervisor is exercised in supervisor.test.ts; here it only needs to
    // exist so the runner can attach it.
    const textGenerationLayer = Layer.mock(TextGeneration)({
      generateApprovalVerdict: () =>
        Effect.succeed({ verdict: "approve" as const, reasoning: "stub" }),
    });

    const layer = JobRunnerLive.pipe(
      Layer.provide(engineLayer),
      Layer.provide(textGenerationLayer),
      Layer.provide(snapshotLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(gitManagerLayer),
      Layer.provide(NodeServices.layer),
    );

    return { layer, dispatched, stackedActions };
  });

function runJob(options: HarnessOptions = {}, workflow?: JobWorkflow) {
  return Effect.gen(function* () {
    const harness = yield* makeHarness(options);
    const outcome = yield* Effect.gen(function* () {
      const runner = yield* JobRunner;
      return yield* runner.run({
        jobId: "job-1",
        projectId: PROJECT_ID,
        instruction: "Add a health endpoint",
        baseBranch: "main",
        workflow: workflow ?? m0Workflow({ instruction: "Add a health endpoint" }),
      });
    }).pipe(Effect.provide(harness.layer));
    return {
      outcome,
      dispatched: yield* Ref.get(harness.dispatched),
      stackedActions: yield* Ref.get(harness.stackedActions),
    };
  });
}

it.effect("runs the walking skeleton end to end and reports the pull request", () =>
  Effect.gen(function* () {
    const { outcome, stackedActions } = yield* runJob({
      stackedActionResults: {
        create_pr: stackedActionResult("create_pr", {
          pr: { status: "created", url: "https://example.test/pr/1", number: 1 },
        }),
      },
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.failedStepId, null);
    assert.equal(outcome.pullRequestUrl, "https://example.test/pr/1");
    assert.equal(outcome.branch, "t3-job/job-1");
    assert.deepEqual(
      stackedActions.map((action) => action.action),
      ["commit_push", "create_pr"],
    );
  }),
);

it.effect("evaluates the gate in a different thread from the one it gates", () =>
  Effect.gen(function* () {
    // ADR-0009 / invariant 15: an agent assessing its own work is not a review.
    const { outcome } = yield* runJob();

    const implement = outcome.steps.find((step) => step.stepId === "implement");
    const review = outcome.steps.find((step) => step.stepId === "review");
    assert.ok(implement && "threadId" in implement);
    assert.ok(review && "threadId" in review);
    assert.notEqual(implement.threadId, review.threadId);
  }),
);

it.effect("creates every agent thread with the step's runtime mode", () =>
  Effect.gen(function* () {
    const { dispatched } = yield* runJob();

    const creates = dispatched.filter((command) => command.type === "thread.create");
    assert.equal(creates.length, 2);
    for (const create of creates) {
      assert.equal(create.runtimeMode, "approval-required");
    }
  }),
);

it.effect("stops before pushing when the review fails", () =>
  Effect.gen(function* () {
    const { outcome, stackedActions } = yield* runJob({
      gateText: `The tests do not run.\n${GATE_FAIL_MARKER}`,
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failedStepId, "review");
    assert.deepEqual(stackedActions, []);
    assert.equal(outcome.pullRequestUrl, null);
  }),
);

it.effect("never opens a pull request when the push failed", () =>
  Effect.gen(function* () {
    const { outcome, stackedActions } = yield* runJob({ stackedActionFails: ["commit_push"] });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failedStepId, "push");
    assert.deepEqual(
      stackedActions.map((action) => action.action),
      ["commit_push"],
    );
  }),
);

it.effect("stops with a plain reason when the agent changed nothing", () =>
  Effect.gen(function* () {
    const { outcome, stackedActions } = yield* runJob({
      stackedActionResults: {
        commit_push: stackedActionResult("commit_push", {
          commit: { status: "skipped_no_changes" },
          push: { status: "skipped_up_to_date" },
        }),
      },
    });

    assert.equal(outcome.failedStepId, "push");
    const push = outcome.steps.find((step) => step.stepId === "push");
    assert.match(push?.detail ?? "", /no changes/);
    assert.deepEqual(
      stackedActions.map((action) => action.action),
      ["commit_push"],
    );
  }),
);

it.effect("treats a pull request created without a URL as opened, not failed", () =>
  Effect.gen(function* () {
    // `gh pr create` discards its stdout and the follow-up lookup can miss, so
    // a missing URL says nothing about whether the pull request exists.
    const { outcome } = yield* runJob({
      stackedActionResults: {
        create_pr: stackedActionResult("create_pr", { pr: { status: "created" } }),
      },
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.pullRequestUrl, null);
    const pr = outcome.steps.find((step) => step.stepId === "open-pull-request");
    assert.equal(pr?.status, "completed");
    assert.match(pr?.detail ?? "", /URL could not be resolved/);
  }),
);

it.effect("stops at the implementation step when its turn fails", () =>
  Effect.gen(function* () {
    const { outcome, stackedActions } = yield* runJob({ turnEnds: () => "failed" });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failedStepId, "implement");
    assert.deepEqual(stackedActions, []);
  }),
);

it.effect("passes the gate when the review says so", () =>
  Effect.gen(function* () {
    const { outcome } = yield* runJob({ gateText: `Looks right.\n${GATE_PASS_MARKER}` });

    const review = outcome.steps.find((step) => step.stepId === "review");
    assert.equal(review?.status, "passed");
    assert.equal(outcome.status, "completed");
  }),
);
