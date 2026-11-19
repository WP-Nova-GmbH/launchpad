import { describe, expect, it } from "@effect/vitest";
import { normalizeStoredWorkflow, normalizeStoredWorkflowJob } from "./workflowStorage.ts";

const definition = {
  name: "Implement",
  environmentId: "environment",
  projectId: "project",
  steps: [
    { id: "agent", kind: "agent", title: "Agent", instruction: "Implement", modelSelection: null },
  ],
};
const workflow = {
  workflowId: "workflow",
  organizationId: "org",
  repositoryId: "repo",
  revision: 17,
  definition,
  archived: false,
  createdAt: "before",
  updatedAt: "before",
};
const job = {
  jobId: "job",
  repositoryId: "repo",
  workflowId: "workflow",
  environmentId: "stale-hint",
  instruction: "Fix",
  status: "dispatching",
  detail: null,
  workflow,
  progress: null,
  requiredProtocol: 8,
  createdAt: "before",
  updatedAt: "before",
};

describe("workflow storage normalization", () => {
  it("preserves accepted intent and ambiguous delivery without adopting the root hint", () => {
    const next = normalizeStoredWorkflowJob(job);
    expect(next.runtime).toEqual({
      kind: "machine",
      environmentId: "environment",
      projectId: "project",
    });
    expect(next.workflow?.revision).toBe(17);
    expect(next.workflow?.definition.steps).toEqual(definition.steps);
    expect(next.startAttempted).toBeUndefined();
    expect(next.requiredProtocol).toBe(8);
    expect(next).not.toHaveProperty("environmentId");
    expect(normalizeStoredWorkflowJob(next)).toEqual(next);
  });
  it("leaves an unfrozen queued job unassigned", () => {
    expect(
      normalizeStoredWorkflowJob({ ...job, workflow: null, status: "queued" }).runtime,
    ).toBeNull();
  });
  it("normalizes saved machine intent without changing its revision", () => {
    expect(normalizeStoredWorkflow(workflow)).toEqual({
      ...workflow,
      definition: {
        name: definition.name,
        steps: definition.steps,
        target: { kind: "machine", environmentId: "environment", projectId: "project" },
      },
    });
  });
});
