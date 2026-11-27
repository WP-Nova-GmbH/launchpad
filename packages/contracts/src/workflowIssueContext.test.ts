import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RepositoryWorkflowJob, WorkflowIssueSnapshot, workflowIssueUrl } from "./workflows.ts";

const snapshot = {
  workspaceId: "workspace",
  issueId: "issue",
  identifier: "ENG-1",
  title: "Implement",
  url: "https://linear.app/test/issue/ENG-1",
  description: "Requirements",
  team: { id: "team", name: "Team" },
  status: { id: "ready", name: "Ready" },
  labels: [],
  issueUpdatedAt: "2026-10-19",
  retrievedAt: "2026-10-19",
  authorizationEpoch: 1,
  credentialVersion: 1,
};
const decodeJob = Schema.decodeUnknownSync(RepositoryWorkflowJob);
const decodeSnapshot = Schema.decodeUnknownSync(WorkflowIssueSnapshot);
describe("workflow issue context contracts", () => {
  it("retains old manual records without requiring a snapshot or queue reason", () => {
    const job = decodeJob({
      jobId: "job",
      repositoryId: "repo",
      workflowId: "flow",
      environmentId: "environment",
      instruction: "Work",
      status: "queued",
      detail: null,
      workflow: null,
      progress: null,
      createdAt: "now",
      updatedAt: "now",
    });
    expect(job.issueSnapshot).toBeUndefined();
    expect(job.queueReason).toBeUndefined();
    expect(job.responsePending).toBeUndefined();
  });
  it("bounds stored context and retains empty descriptions", () => {
    const decode = decodeSnapshot;
    expect(decode({ ...snapshot, description: "" }).description).toBe("");
    expect(() => decode({ ...snapshot, description: "x".repeat(32_001) })).toThrow();
    expect(() => decode({ ...snapshot, description: undefined })).toThrow();
  });
  it.each([
    "javascript:alert(1)",
    "https://linear.app.evil.test/team/issue/ENG-1",
    "https://user:secret@linear.app/test/issue/ENG-1",
    "https://linear.app/test/issue/ENG-1?token=secret",
    "https://images.linear.app/asset.png",
  ])("does not make unsafe or unrelated URLs clickable: %s", (url) => {
    expect(workflowIssueUrl(url)).toBeNull();
  });
  it("permits normal Linear issue URLs with a descriptive slug", () => {
    expect(workflowIssueUrl("https://linear.app/test/issue/ENG-1/fix-navigation")).toBe(
      "https://linear.app/test/issue/ENG-1/fix-navigation",
    );
  });
});
