import {
  CommandId,
  MessageId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type OrchestrationThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitManager } from "../../git/GitManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { JobRunnerError } from "../Errors.ts";
import {
  JobRunner,
  type JobOutcome,
  type JobRequest,
  type JobRunnerShape,
  type JobStepOutcome,
} from "../Services/JobRunner.ts";
import { attachTurnSettleWatch } from "../settle.ts";
import { attachApprovalSupervisor } from "../supervisor.ts";
import {
  parseGateVerdict,
  type JobActionStep,
  type JobAgentStep,
  type JobGateStep,
} from "../workflow.ts";

/**
 * Deterministic and deliberately not a `t3code/<hex>` temporary branch:
 * `ProviderCommandReactor` renames those to a model-generated name on the
 * first turn, in a forked fiber that races the turn. A job wants the branch it
 * chose, and wants it stable for the push and the pull request.
 */
export function jobBranchName(jobId: string): string {
  const sanitized = jobId.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `t3-job/${sanitized.length > 0 ? sanitized : "job"}`;
}

function lastAssistantText(thread: OrchestrationThread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "assistant" && message.text.trim().length > 0) {
      return message.text;
    }
  }
  return null;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const gitManager = yield* GitManager;
  const textGeneration = yield* TextGeneration;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:job-${tag}:${uuid}`)));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const fail =
    (input: {
      readonly jobId: string;
      readonly operation: JobRunnerError["operation"];
      readonly detail: string;
    }) =>
    (cause: Cause.Cause<unknown>) =>
      Effect.fail(new JobRunnerError({ ...input, cause: new Error(Cause.pretty(cause)) }));

  /**
   * Create a thread bound to the job's worktree and run one instruction in it.
   *
   * Runtime mode is written to the thread rather than passed on the turn: the
   * decider reads `targetThread.runtimeMode` and ignores the command's own
   * field, so setting it on the turn alone would silently leave the thread at
   * whatever mode it was created with.
   */
  const runInstructionInNewThread = Effect.fn("JobRunner.runInstructionInNewThread")(
    function* (input: {
      readonly jobId: string;
      readonly request: JobRequest;
      readonly stepId: string;
      readonly title: string;
      readonly instruction: string;
      readonly runtimeMode: RuntimeMode;
      readonly branch: string;
      readonly worktreePath: string;
      readonly modelSelection: ModelSelection;
    }) {
      // Keyed on the step id, not its title: ids are unique within a workflow
      // by construction, titles are free text and two steps sharing one would
      // silently run in the same thread.
      const threadId = ThreadId.make(`${input.jobId}-${input.stepId}`);
      const createdAt = yield* nowIso;

      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* commandId("thread-create"),
        threadId,
        projectId: input.request.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt,
      });

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const watch = yield* attachTurnSettleWatch({ engine, threadId });
          // Scoped to this step, so the supervisor can only ever answer
          // requests from the thread the runner just created — never one a
          // human is driving.
          yield* attachApprovalSupervisor({
            engine,
            textGeneration,
            crypto,
            threadId,
            stepInstruction: input.instruction,
            cwd: input.worktreePath,
            modelSelection: input.modelSelection,
          });
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: yield* commandId("turn-start"),
            threadId,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              role: "user",
              text: input.instruction,
              attachments: [],
            },
            runtimeMode: input.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: yield* nowIso,
          });
          return yield* watch.await;
        }),
      );

      return { threadId, outcome };
    },
  );

  const runAgentStep = Effect.fn("JobRunner.runAgentStep")(function* (input: {
    readonly jobId: string;
    readonly request: JobRequest;
    readonly step: JobAgentStep;
    readonly branch: string;
    readonly worktreePath: string;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<JobStepOutcome, JobRunnerError> {
    const { threadId, outcome } = yield* runInstructionInNewThread({
      jobId: input.jobId,
      request: input.request,
      stepId: input.step.id,
      title: input.step.title,
      instruction: input.step.instruction,
      runtimeMode: input.step.runtimeMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.catchCause(
        fail({ jobId: input.jobId, operation: "run-step", detail: `step '${input.step.id}'` }),
      ),
    );

    return {
      stepId: input.step.id,
      kind: "agent",
      status: outcome.kind === "completed" ? "completed" : outcome.kind,
      threadId,
      detail: outcome.kind === "completed" ? null : outcome.detail,
    };
  });

  /**
   * A gate runs in a thread of its own over the same worktree. That is the
   * whole point: the reviewing agent has none of the implementing agent's
   * conversation, so it is assessing the work rather than defending it.
   */
  const runGateStep = Effect.fn("JobRunner.runGateStep")(function* (input: {
    readonly jobId: string;
    readonly request: JobRequest;
    readonly step: JobGateStep;
    readonly branch: string;
    readonly worktreePath: string;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<JobStepOutcome, JobRunnerError> {
    const { threadId, outcome } = yield* runInstructionInNewThread({
      jobId: input.jobId,
      request: input.request,
      stepId: input.step.id,
      title: input.step.title,
      instruction: input.step.instruction,
      runtimeMode: input.step.runtimeMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.catchCause(
        fail({ jobId: input.jobId, operation: "run-step", detail: `step '${input.step.id}'` }),
      ),
    );

    if (outcome.kind !== "completed") {
      return {
        stepId: input.step.id,
        kind: "gate",
        status: "failed",
        threadId,
        detail: outcome.detail ?? "The review did not finish.",
      };
    }

    const detail = yield* snapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((thread) =>
        Option.match(thread, { onNone: () => null, onSome: lastAssistantText }),
      ),
      Effect.catchCause(
        fail({
          jobId: input.jobId,
          operation: "run-step",
          detail: `gate '${input.step.id}' output`,
        }),
      ),
    );
    const verdict = parseGateVerdict(detail);

    return {
      stepId: input.step.id,
      kind: "gate",
      status: verdict.passed ? "passed" : "failed",
      threadId,
      detail: verdict.reason,
    };
  });

  /**
   * Actions are the runner's own work, never an agent's (ADR-0009). `push`
   * commits and pushes; `open_pull_request` opens one against the pushed
   * branch. They are separate steps rather than one `commit_push_pr` so each
   * is separately observable and separately retryable.
   */
  const runActionStep = Effect.fn("JobRunner.runActionStep")(function* (input: {
    readonly jobId: string;
    readonly step: JobActionStep;
    readonly worktreePath: string;
  }): Effect.fn.Return<JobStepOutcome, never> {
    const result = yield* gitManager
      .runStackedAction({
        actionId: `job:${input.jobId}:${input.step.id}`,
        cwd: input.worktreePath,
        action: input.step.action === "push" ? "commit_push" : "create_pr",
      })
      .pipe(Effect.option);

    if (Option.isNone(result)) {
      return {
        stepId: input.step.id,
        kind: "action",
        action: input.step.action,
        status: "failed",
        detail: `The ${input.step.action} action failed.`,
        pullRequestUrl: null,
      };
    }

    if (input.step.action === "push") {
      // A hard git failure arrives as an Effect error, so the statuses here
      // only distinguish "did something" from "had nothing to do". Nothing to
      // do means the agent changed nothing, and there is then no pull request
      // to open — better to stop with that said plainly than to fail at the
      // next step for a reason that reads as a git problem.
      const { commit, push } = result.value;
      const producedWork = push.status === "pushed" || commit.status === "created";
      return {
        stepId: input.step.id,
        kind: "action",
        action: "push",
        status: producedWork ? "completed" : "failed",
        detail: producedWork
          ? null
          : `Nothing to push: the agent made no changes (commit '${commit.status}', push '${push.status}').`,
        pullRequestUrl: null,
      };
    }

    const pr = result.value.pr;
    const opened = pr.status === "created" || pr.status === "opened_existing";
    return {
      stepId: input.step.id,
      kind: "action",
      action: "open_pull_request",
      status: opened ? "completed" : "failed",
      // A pull request can be created without a URL coming back: `gh pr create`
      // discards its stdout and the follow-up lookup can miss. Created-but-
      // unlinked is a real outcome, not a failure.
      detail: opened && pr.url === undefined ? "Opened, but its URL could not be resolved." : null,
      pullRequestUrl: pr.url ?? null,
    };
  });

  const run: JobRunnerShape["run"] = Effect.fn("JobRunner.run")(function* (request: JobRequest) {
    const project = yield* snapshotQuery
      .getProjectShellById(request.projectId)
      .pipe(
        Effect.catchCause(
          fail({ jobId: request.jobId, operation: "resolve-project", detail: "projection read" }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* Effect.fail(
        new JobRunnerError({
          jobId: request.jobId,
          operation: "resolve-project",
          detail: `No active project '${request.projectId}'.`,
        }),
      );
    }
    const workspaceRoot = project.value.workspaceRoot;
    const modelSelection = project.value.defaultModelSelection;
    if (modelSelection === null) {
      return yield* Effect.fail(
        new JobRunnerError({
          jobId: request.jobId,
          operation: "resolve-project",
          detail: `Project '${request.projectId}' has no default model selection.`,
        }),
      );
    }

    // Jobs always build on what is actually on the remote: an executor's
    // checkout is long-lived and its local base branch may be arbitrarily
    // stale.
    const branch = jobBranchName(request.jobId);
    const worktreePath = yield* Effect.gen(function* () {
      yield* gitWorkflow.fetchRemote({ cwd: workspaceRoot, remoteName: "origin" });
      const remoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd: workspaceRoot,
        refName: request.baseBranch,
        fallbackRemoteName: "origin",
      });
      const created = yield* gitWorkflow.createWorktree({
        cwd: workspaceRoot,
        refName: remoteBase.commitSha,
        newRefName: branch,
        baseRefName: request.baseBranch,
        path: null,
      });
      return created.worktree.path;
    }).pipe(
      Effect.catchCause(
        fail({
          jobId: request.jobId,
          operation: "prepare-worktree",
          detail: `base branch '${request.baseBranch}'`,
        }),
      ),
    );

    const steps: Array<JobStepOutcome> = [];
    let implementationThreadId: ThreadId | null = null;
    let pullRequestUrl: string | null = null;
    let failedStepId: string | null = null;

    for (const step of request.workflow.steps) {
      const outcome =
        step.kind === "agent"
          ? yield* runAgentStep({
              jobId: request.jobId,
              request,
              step,
              branch,
              worktreePath,
              modelSelection,
            })
          : step.kind === "gate"
            ? yield* runGateStep({
                jobId: request.jobId,
                request,
                step,
                branch,
                worktreePath,
                modelSelection,
              })
            : yield* runActionStep({ jobId: request.jobId, step, worktreePath });

      steps.push(outcome);
      if (outcome.kind === "agent" && implementationThreadId === null) {
        implementationThreadId = outcome.threadId;
      }
      if (outcome.kind === "action" && outcome.pullRequestUrl !== null) {
        pullRequestUrl = outcome.pullRequestUrl;
      }

      const stepFailed =
        outcome.status === "failed" ||
        outcome.status === "interrupted" ||
        (outcome.kind === "gate" && outcome.status !== "passed");
      if (stepFailed) {
        failedStepId = outcome.stepId;
        yield* Effect.logWarning("job step failed; stopping", {
          jobId: request.jobId,
          stepId: outcome.stepId,
          detail: outcome.detail,
        });
        break;
      }
    }

    return {
      jobId: request.jobId,
      status: failedStepId === null ? "completed" : "failed",
      threadId: implementationThreadId,
      branch,
      worktreePath,
      pullRequestUrl,
      steps,
      failedStepId,
    } satisfies JobOutcome;
  });

  return JobRunner.of({ run });
});

export const JobRunnerLive = Layer.effect(JobRunner, make);
