import { ThreadId } from "@t3tools/contracts";
import type { WorkflowJobProgress } from "@t3tools/contracts/workflows";
import { describe, expect, it } from "vite-plus/test";
import {
  clearAcknowledgedWorkflowDraft,
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
