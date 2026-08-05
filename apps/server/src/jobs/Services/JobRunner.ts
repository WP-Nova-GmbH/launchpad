/**
 * JobRunner - executor-side execution of one job.
 *
 * The relay triggers; the runner orchestrates (ADR-0005). It materializes a
 * worktree, drives each step, evaluates gates, and performs the deterministic
 * tail itself. Everything inside a thread stays the environment's business —
 * the runner never reports turn-level detail upward.
 *
 * @module jobs/Services/JobRunner
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { JobRunnerError } from "../Errors.ts";
import type { JobActionKind, JobWorkflow } from "../workflow.ts";

export interface JobRequest {
  /** Caller-supplied so a dispatch is idempotent from the trigger's side. */
  readonly jobId: string;
  readonly projectId: ProjectId;
  /** What the work item asks for; snapshotted by the caller, not re-read here. */
  readonly instruction: string;
  /** The branch the work builds on. Resolved against `origin` before use. */
  readonly baseBranch: string;
  readonly workflow: JobWorkflow;
}

export type JobStepOutcome =
  | {
      readonly stepId: string;
      readonly kind: "agent";
      readonly status: "completed" | "interrupted" | "failed";
      readonly threadId: ThreadId;
      readonly detail: string | null;
    }
  | {
      readonly stepId: string;
      readonly kind: "gate";
      readonly status: "passed" | "failed";
      readonly threadId: ThreadId;
      readonly detail: string | null;
    }
  | {
      readonly stepId: string;
      readonly kind: "action";
      readonly action: JobActionKind;
      readonly status: "completed" | "failed";
      readonly detail: string | null;
      readonly pullRequestUrl: string | null;
    };

export interface JobOutcome {
  readonly jobId: string;
  readonly status: "completed" | "failed";
  /** The thread the implementation ran in; a follow-up continues this one. */
  readonly threadId: ThreadId | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequestUrl: string | null;
  readonly steps: ReadonlyArray<JobStepOutcome>;
  /** Set when the job stopped early; names the step that ended it. */
  readonly failedStepId: string | null;
}

export interface JobRunnerShape {
  /**
   * Run a job to completion. Steps stop at the first failure — a gate that
   * fails is the point of a gate — and the outcome says which step ended it.
   */
  readonly run: (request: JobRequest) => Effect.Effect<JobOutcome, JobRunnerError>;
}

export class JobRunner extends Context.Service<JobRunner, JobRunnerShape>()(
  "t3/jobs/Services/JobRunner",
) {}
