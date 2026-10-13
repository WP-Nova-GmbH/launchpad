import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import {
  WorkflowDefinition,
  RespondToWorkflowJob,
  workflowZones,
  type WorkflowStep,
} from "./workflows.ts";
const isDefinition = Schema.is(WorkflowDefinition);
const isResponse = Schema.is(RespondToWorkflowJob);
const agent: WorkflowStep = {
  id: "implement",
  kind: "agent",
  title: "Implement",
  instruction: "Implement",
  modelSelection: null,
};
const review: WorkflowStep = { id: "review", kind: "review", title: "Review", role: "maintainer" };
const input: WorkflowStep = {
  id: "input",
  kind: "input",
  title: "Input",
  question: "What next?",
  role: "member",
};
const definition = (steps: ReadonlyArray<WorkflowStep>) => ({
  name: "Workflow",
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  steps,
});
describe("workflow boundaries", () => {
  it("accepts repeated kinds with stable IDs, Input first, and an explicit earlier rework target", () => {
    expect(
      isDefinition(
        definition([
          input,
          agent,
          { ...agent, id: "verify" },
          { ...review, reworkStepId: agent.id },
        ]),
      ),
    ).toBe(true);
    expect(isDefinition(definition([agent]))).toBe(true);
  });
  it("rejects duplicate IDs, a Review without a result, and invalid rework targets", () => {
    for (const steps of [
      [agent, agent],
      [review, agent],
      [input],
      [agent, { ...review, reworkStepId: input.id }],
      [agent, { ...review, reworkStepId: "later" }, { ...agent, id: "later" }],
    ])
      expect(isDefinition(definition(steps))).toBe(false);
  });
  it("requires revision-bound nonempty human input and rejects full-access Agents", () => {
    expect(
      isResponse({
        operation: "input",
        checkpointId: "cp",
        expectedRevision: 1,
        text: "",
      }),
    ).toBe(false);
    expect(
      isResponse({
        operation: "request_changes",
        checkpointId: "cp",
        text: "fix",
      }),
    ).toBe(false);
    expect(
      isDefinition({ ...definition([agent]), steps: [{ ...agent, runtimeMode: "full-access" }] }),
    ).toBe(false);
  });
  it("groups adjacent Agents and preserves every human boundary through reordering", () => {
    const second = { ...agent, id: "verify" };
    expect(
      workflowZones([agent, second, input, review, { ...agent, id: "finish" }]).map((zone) =>
        zone.map((step) => step.id),
      ),
    ).toEqual([["implement", "verify"], ["input"], ["review"], ["finish"]]);
    expect(
      workflowZones([agent, input, second, review]).map((zone) => zone.map((step) => step.id)),
    ).toEqual([["implement"], ["input"], ["verify"], ["review"]]);
  });
});

it("requires stable identity and a nonnegative revision for manual workflow controls", () => {
  for (const operation of ["pause", "resume"] as const) {
    expect(isResponse({ operation, controlId: "intent", expectedRevision: 3 })).toBe(true);
    expect(isResponse({ operation, expectedRevision: 3 })).toBe(false);
    expect(isResponse({ operation, controlId: "", expectedRevision: 3 })).toBe(false);
    expect(isResponse({ operation, controlId: "intent", expectedRevision: -1 })).toBe(false);
  }
});
