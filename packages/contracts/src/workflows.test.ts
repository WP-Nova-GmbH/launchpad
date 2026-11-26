import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import {
  WorkflowDefinition,
  WorkflowCatalog,
  WorkflowControl,
  WorkflowInvalidError,
  WorkflowJobPageQuery,
  WorkflowRuntime,
  RespondToWorkflowJob,
  resolveWorkflowCommitSubject,
  workflowZones,
  type WorkflowStep,
} from "./workflows.ts";
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const isDefinition = Schema.is(WorkflowDefinition);
const isResponse = Schema.is(RespondToWorkflowJob);
const isRuntime = Schema.is(WorkflowRuntime);
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
  target: {
    kind: "machine" as const,
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
  },
  steps,
});
describe("workflow boundaries", () => {
  it("validates Push commit subjects and expands frozen run metadata", () => {
    const push = { id: "push", kind: "action", title: "Push branch", action: "push" } as const;
    const template = "fix({{issueKey}}): update {{workflowName}}";
    const vmDefinition = (commitSubject: string) => ({
      ...definition([agent, { ...push, commitSubject }]),
      target: { kind: "vm" as const, baseBranch: null },
    });
    expect(isDefinition(vmDefinition(template))).toBe(true);
    expect(isDefinition(vmDefinition("🧪".repeat(100)))).toBe(true);
    expect(isDefinition(definition([agent, { ...push, commitSubject: template }]))).toBe(false);
    for (const invalid of ["fix({{issue}}): update", "first line\nsecond line", "a".repeat(101)])
      expect(isDefinition(vmDefinition(invalid))).toBe(false);
    expect(resolveWorkflowCommitSubject(undefined, "Ship", undefined)).toBe("chore: update Ship");
    expect(resolveWorkflowCommitSubject(template, "Ship", "WP-331")).toBe(
      "fix(WP-331): update Ship",
    );
    expect(resolveWorkflowCommitSubject(template, "Ship", undefined)).toBeNull();
    expect(
      resolveWorkflowCommitSubject("{{workflowName}} {{issueKey}}", "a".repeat(100), "WP-331"),
    ).toBe(`${"a".repeat(100)} WP-331`);
    const decodeControl = Schema.decodeUnknownSync(WorkflowControl);
    expect(
      decodeControl({
        organizationId: "org",
        repositoryId: "repo",
        projectId: "project",
        operation: "start",
        workflow: {
          workflowId: "ship",
          organizationId: "org",
          repositoryId: "repo",
          revision: 1,
          definition: vmDefinition(template),
          archived: false,
          createdAt: "now",
          updatedAt: "now",
        },
        runtime: { kind: "vm", threadId: "thread" },
        issueKey: "WP-331",
      }),
    ).toMatchObject({ issueKey: "WP-331", workflow: { definition: vmDefinition(template) } });
  });

  it("round-trips VM start failures and accepts errors from older relays", () => {
    const decode = Schema.decodeUnknownSync(WorkflowInvalidError);
    const encode = Schema.encodeSync(WorkflowInvalidError);
    const legacy = { _tag: "WorkflowInvalidError", message: "Could not start workflow." };
    for (const error of [
      legacy,
      { ...legacy, vmStartFailure: { kind: "github-access-missing" } },
      {
        ...legacy,
        vmStartFailure: {
          kind: "github-access-missing",
          permission: "contents-read",
          repository: "acme/project",
        },
      },
      {
        ...legacy,
        vmStartFailure: { kind: "base-branch-unavailable", branch: null },
        vmStartFailureRevision: 3,
      },
      { ...legacy, vmStartFailure: { kind: "github-verification-temporary" } },
    ]) {
      expect(encode(decode(error))).toEqual(error);
    }
  });

  it("separates a VM's saved branch intent from a machine execution binding", () => {
    expect(isDefinition({ ...definition([agent]), target: { kind: "vm", baseBranch: null } })).toBe(
      true,
    );
    expect(
      isDefinition({ ...definition([agent]), target: { kind: "vm", baseBranch: "release" } }),
    ).toBe(true);
    expect(
      isDefinition({
        name: "Legacy wire shape",
        environmentId: "env",
        projectId: "project",
        steps: [agent],
      }),
    ).toBe(false);
    expect(isRuntime({ kind: "machine", environmentId: "env" })).toBe(false);
    expect(isRuntime({ kind: "vm", environmentId: "env", projectId: "project" })).toBe(false);
    expect(isRuntime({ kind: "vm", threadId: "thread" })).toBe(true);
  });
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

it("validates publishing order and groups actions into automatic zones", () => {
  const push: WorkflowStep = { id: "push", title: "Push branch", kind: "action", action: "push" };
  const pr: WorkflowStep = {
    id: "pr",
    title: "Open PR",
    kind: "action",
    action: "open_pull_request",
  };
  for (const steps of [
    [agent, push, pr],
    [agent, review, push, input, pr],
    [agent, push, pr, { ...review, reworkStepId: agent.id }],
  ])
    expect(isDefinition(definition(steps))).toBe(true);
  for (const steps of [
    [push, agent],
    [agent, pr],
    [agent, push, { ...agent, id: "next" }, pr],
  ])
    expect(isDefinition(definition(steps))).toBe(false);
  expect(
    workflowZones([agent, push, pr, input, review, agent]).map((zone) =>
      zone.map((step) => step.id),
    ),
  ).toEqual([["implement", "push", "pr"], ["input"], ["review"], ["implement"]]);
  expect(isResponse({ operation: "retry_action", actionId: "action", expectedRevision: 7 })).toBe(
    true,
  );
  expect(isResponse({ operation: "retry_action", actionId: "", expectedRevision: 7 })).toBe(false);
  expect(isResponse({ operation: "retry_action", actionId: "action", expectedRevision: -1 })).toBe(
    false,
  );
});

it("validates bounded page sizes and supported list views at the wire boundary", () => {
  const decode = Schema.decodeUnknownSync(WorkflowJobPageQuery);
  expect(decode({ view: "active", limit: "100" }).limit).toBe(100);
  for (const value of [
    { view: "all" },
    { view: "active", limit: "101" },
    { view: "active", limit: "0" },
    { view: "history", limit: "1.5" },
    { view: "active", cursor: "x".repeat(2049) },
  ]) {
    expect(() => decode(value)).toThrow();
  }
});

it("decodes older workflow catalog responses without inventing automation capability", () => {
  const old = decodeCatalog({ workflows: [] });
  expect(old.automationSupported).toBeUndefined();
  expect(old.automationSummaries).toBeUndefined();
  expect(
    decodeCatalog({
      workflows: [],
      automationSupported: true,
      automationSummaries: [],
    }).automationSupported,
  ).toBe(true);
});
