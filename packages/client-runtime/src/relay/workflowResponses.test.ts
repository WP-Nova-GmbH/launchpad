import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkflowJobProgress, RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { describe, expect, it } from "vite-plus/test";
import {
  clearAcknowledgedWorkflowDraft,
  workflowActionState,
  workflowManualControlState,
  workflowManualSubmission,
  type WorkflowDraftSubmission,
} from "./workflowResponses.ts";

const submitted: WorkflowDraftSubmission = {
  checkpointId: "checkpoint-a",
  operation: "input",
  userId: "user",
  text: "answer-a",
};
const acknowledgement = (submission = submitted): WorkflowJobProgress => ({
  revision: 1,
  status: "running",
  threadId: ThreadId.make("thread"),
  detail: null,
  checkpoint: null,
  responses: [
    {
      checkpointId: submission.checkpointId!,
      stepId: "input",
      generation: 0,
      operation: submission.operation === "request_changes" ? "request_changes" : "input",
      userId: submission.userId!,
      text: submission.text,
      createdAt: "2026-10-12T00:00:00.000Z",
    },
  ],
});

describe("workflow response draft acknowledgement", () => {
  it.each(["input", "request_changes"] as const)(
    "preserves edits during a pending %s and clears only an unchanged exact response",
    async (operation) => {
      const submission = { ...submitted, operation };
      let resolve!: (progress: WorkflowJobProgress) => void;
      const pending = new Promise<WorkflowJobProgress>((ack) => {
        resolve = ack;
      });
      let drafts: Record<string, string> = {
        "checkpoint-a": "answer-a",
        "checkpoint-b": "another checkpoint",
      };
      const apply = pending.then((progress) => {
        drafts = clearAcknowledgedWorkflowDraft(drafts, submission, progress);
      });
      drafts = { ...drafts, "checkpoint-a": "newer answer-b" };
      resolve(acknowledgement(submission));
      await apply;
      expect(drafts).toEqual({
        "checkpoint-a": "newer answer-b",
        "checkpoint-b": "another checkpoint",
      });
      const unchanged = clearAcknowledgedWorkflowDraft(
        { "checkpoint-a": "answer-a", "checkpoint-b": "another checkpoint" },
        submission,
        acknowledgement(submission),
      );
      expect(unchanged).toEqual({ "checkpoint-b": "another checkpoint" });
    },
  );
  it.each([499, 500, 501])(
    "handles an acknowledged response of length %s conservatively",
    (length) => {
      const submission = { ...submitted, text: "x".repeat(length) };
      const progress = acknowledgement(submission);
      const wire = {
        ...progress,
        responses: progress.responses!.map((response) => ({
          ...response,
          text: response.text!.slice(0, 500),
        })),
      };
      const drafts = { "checkpoint-a": submission.text };
      expect(clearAcknowledgedWorkflowDraft(drafts, submission, wire)).toEqual(
        length < 500 ? {} : drafts,
      );
    },
  );
  it("does not mistake a competing longer response's identical prefix for an exact acknowledgement", () => {
    const submission = { ...submitted, text: "x".repeat(500) };
    const progress = acknowledgement({ ...submission, text: submission.text + "different suffix" });
    const wire = {
      ...progress,
      responses: progress.responses!.map((response) => ({
        ...response,
        text: response.text!.slice(0, 500),
      })),
    };
    const drafts = { "checkpoint-a": submission.text };
    expect(clearAcknowledgedWorkflowDraft(drafts, submission, wire)).toBe(drafts);
  });
  it("retains pending, failed, competing and stale acknowledgements and approval-only feedback", () => {
    const drafts = { "checkpoint-a": "answer-a" };
    const other = [
      { ...submitted, checkpointId: "old-checkpoint" },
      { ...submitted, userId: "teammate" },
      { ...submitted, operation: "request_changes" as const },
      { ...submitted, text: "competing" },
    ];
    for (const response of other)
      expect(clearAcknowledgedWorkflowDraft(drafts, submitted, acknowledgement(response))).toBe(
        drafts,
      );
    expect(clearAcknowledgedWorkflowDraft(drafts, submitted, null)).toBe(drafts);
    expect(
      clearAcknowledgedWorkflowDraft(drafts, submitted, { ...acknowledgement(), responses: [] }),
    ).toBe(drafts);
    expect(
      clearAcknowledgedWorkflowDraft(
        drafts,
        { ...submitted, operation: "approve", text: null },
        acknowledgement(),
      ),
    ).toBe(drafts);
  });
});

const manualJob = (): RepositoryWorkflowJob => ({
  jobId: "job",
  repositoryId: "repo",
  workflowId: "flow",
  environmentId: EnvironmentId.make("env"),
  instruction: "work",
  status: "running",
  detail: null,
  workflow: null,
  progress: { ...acknowledgement(), manualPauseSupported: true },
  createdAt: "now",
  updatedAt: "now",
});
describe("pending workflow responses", () => {
  it("blocks conflicting controls until a refreshed acknowledgement, including legacy compatibility", () => {
    const job = manualJob();
    const pending = { ...job, responsePending: true };
    expect(workflowManualControlState(pending)).toMatchObject({
      canPause: false,
      canResume: false,
      checkpointBlocked: true,
      responsePending: true,
      message: "Response pending; waiting for the environment.",
    });
    const held = {
      ...pending,
      progress: { ...pending.progress!, manualPause: { state: "paused" as const } },
    };
    expect(workflowManualControlState(held).canResume).toBe(false);
    expect(workflowManualControlState({ ...job, responsePending: false }).canPause).toBe(true);
    expect(workflowManualControlState(job).canPause).toBe(true);
    expect(workflowManualControlState({ ...pending, status: "done" }).message).toBeNull();
  });
});

describe("manual workflow controls", () => {
  it("distinguishes saved requests, step-boundary waits and acknowledged holds", () => {
    const job = manualJob();
    expect(workflowManualControlState(job).canPause).toBe(true);
    const request = workflowManualSubmission(null, job, "pause", () => "pause-id");
    const queued = { ...job, pendingManualControl: request.control };
    expect(workflowManualControlState(queued)).toMatchObject({
      canPause: false,
      canResume: false,
      checkpointBlocked: true,
    });
    const requested = {
      ...job,
      progress: { ...job.progress!, manualPause: { state: "requested" as const } },
    };
    expect(workflowManualControlState(requested)).toMatchObject({
      canPause: false,
      canResume: true,
      checkpointBlocked: true,
    });
    const paused = {
      ...requested,
      status: "paused" as const,
      progress: {
        ...requested.progress,
        status: "paused" as const,
        underlyingStatus: "awaiting_input" as const,
        manualPause: { state: "paused" as const },
      },
    };
    expect(workflowManualControlState(paused)).toMatchObject({
      canResume: true,
      status: "awaiting_input",
    });
    expect(
      workflowManualControlState({
        ...paused,
        pendingManualControl: { ...request.control, operation: "resume" },
      }).canResume,
    ).toBe(false);
  });
  it("retries a lost reply with the same identity and requires a new click after acknowledged/stale state", () => {
    const job = manualJob();
    let ids = 0;
    const uuid = () => `control-${++ids}`;
    const original = workflowManualSubmission(null, job, "pause", uuid);
    expect(workflowManualSubmission(original, job, "pause", uuid)).toBe(original);
    const saved = {
      ...job,
      pendingManualControl: original.control,
      progress: { ...job.progress!, revision: 9 },
    };
    expect(workflowManualSubmission(original, saved, "pause", uuid)).toBe(original);
    const acknowledged = {
      ...job,
      progress: { ...job.progress!, lastManualControl: original.control },
    };
    expect(
      workflowManualSubmission(original, acknowledged, "pause", uuid).control.controlId,
    ).not.toBe(original.control.controlId);
    const refreshed = { ...job, progress: { ...job.progress!, revision: 9 } };
    expect(
      workflowManualSubmission(original, refreshed, "pause", uuid).control.expectedRevision,
    ).toBe(9);
    expect(workflowManualSubmission(original, job, "resume", uuid).control.operation).toBe(
      "resume",
    );
  });
  it("hides controls for legacy, queued, finishing and cancelled jobs without erasing failure state or drafts", () => {
    const job = manualJob();
    for (const status of ["finishing", "cancelling", "done", "cancelled", "failed"] as const)
      expect(
        workflowManualControlState({ ...job, status, progress: { ...job.progress!, status } })
          .canPause,
      ).toBe(false);
    expect(workflowManualControlState({ ...job, progress: null, status: "queued" }).canPause).toBe(
      false,
    );
    expect(
      workflowManualControlState({
        ...job,
        progress: { ...job.progress!, manualPauseSupported: undefined },
      }).canPause,
    ).toBe(false);
    const failed = {
      ...job,
      status: "paused" as const,
      progress: {
        ...job.progress!,
        status: "paused" as const,
        underlyingStatus: "paused" as const,
        manualPause: { state: "requested" as const },
        retryablePreparation: true,
      },
    };
    expect(workflowManualControlState(failed)).toMatchObject({
      canResume: true,
      checkpointBlocked: true,
      status: "paused",
    });
    const drafts = { "checkpoint-a": "answer-a" };
    expect(
      clearAcknowledgedWorkflowDraft(drafts, { ...submitted, operation: "pause" }, failed.progress),
    ).toBe(drafts);
  });
});

it("offers publishing recovery only for the current uncertain action outside a manual hold", () => {
  const job = manualJob();
  const action = {
    actionId: "publish",
    stepId: "push",
    generation: 2,
    operation: "push" as const,
    state: "uncertain" as const,
    retryable: true,
    detail: "Lost reply",
    commitSha: "sha",
    pullRequestUrl: null,
  };
  const paused = {
    ...job,
    status: "paused" as const,
    progress: {
      ...job.progress!,
      status: "paused" as const,
      stepId: "push",
      generation: 2,
      actions: [action],
    },
  };
  expect(workflowActionState(paused).canRetry).toBe(true);
  expect(
    workflowActionState({ ...paused, progress: { ...paused.progress, generation: 3 } }).canRetry,
  ).toBe(false);
  expect(
    workflowActionState({
      ...paused,
      progress: { ...paused.progress, manualPause: { state: "paused" } },
    }).canRetry,
  ).toBe(false);
  expect(
    workflowActionState({
      ...paused,
      progress: {
        ...paused.progress,
        actions: [{ ...action, state: "completed", retryable: false }],
      },
    }).canRetry,
  ).toBe(false);
});
