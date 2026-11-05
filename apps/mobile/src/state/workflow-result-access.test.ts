import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkflowResultAccess, threadWorkspaceRouteTarget } from "./workflow-result-access";

const machineResult = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
  jobId: "job",
  threadId: "thread",
};
const vmResult = { ...machineResult, workflowVmResultReader: true as const };

describe("thread workspace routes", () => {
  it.each([
    "ThreadFiles",
    "ThreadFile",
    "ThreadTerminal",
    "ThreadDevicePreview",
    "GitOverview",
    "GitCommit",
    "GitBranches",
    "GitConfirm",
  ])("checks %s against the linked environment before opening its workspace", (name) => {
    const capabilitiesByEnvironment = new Map([
      ["ordinary", { workflowVmResultReader: false }],
      ["result", { workflowVmResultReader: true }],
    ]);
    const target = threadWorkspaceRouteTarget({
      name,
      params: { environmentId: "result", threadId: "workflow:job" },
    });
    expect(target).toEqual({ environmentId: "result", threadId: "workflow:job" });
    const capabilities = capabilitiesByEnvironment.get(target?.environmentId ?? "") ?? null;
    expect(resolveWorkflowResultAccess(null, undefined, target!.threadId).workspaceEnabled).toBe(
      false,
    );
    expect(
      resolveWorkflowResultAccess(capabilities, undefined, target!.threadId).workspaceEnabled,
    ).toBe(false);
  });

  it("rejects ambiguous environment IDs in workspace deep links", () => {
    expect(
      threadWorkspaceRouteTarget({
        name: "ThreadFile",
        params: { environmentId: ["ordinary", "result"], threadId: "workflow:job" },
      }),
    ).toEqual({ environmentId: null, threadId: "workflow:job" });
  });

  it("leaves the result conversation, saved diff, attachments and draft files accessible", () => {
    const params = { environmentId: "result", threadId: "workflow:job" };
    for (const name of ["Thread", "ThreadReview", "ThreadAttachment", "NewTaskFile"]) {
      expect(threadWorkspaceRouteTarget({ name, params })).toBeNull();
    }
  });
});

describe("workflow result access", () => {
  it("blocks workspace requests before a workflow VM result connects", () => {
    expect(resolveWorkflowResultAccess(null, vmResult, "thread")).toEqual({
      readOnly: true,
      workspaceEnabled: false,
    });
  });

  it("keeps a direct workflow VM link read-only without navigation state", () => {
    expect(resolveWorkflowResultAccess(null, undefined, "thread").workspaceEnabled).toBe(false);
    expect(
      resolveWorkflowResultAccess({ workflowVmResultReader: true }, undefined, "thread"),
    ).toEqual({
      readOnly: true,
      workspaceEnabled: false,
    });
  });

  it("preserves workspace controls for Machine results and old ordinary servers", () => {
    for (const capabilities of [{}, { workflowVmResultReader: false }]) {
      expect(resolveWorkflowResultAccess(capabilities, machineResult, "thread")).toEqual({
        readOnly: false,
        workspaceEnabled: true,
      });
    }
  });

  it("prefers the server capability and ignores hints from another conversation", () => {
    expect(
      resolveWorkflowResultAccess({ workflowVmResultReader: false }, vmResult, "thread")
        .workspaceEnabled,
    ).toBe(true);
    expect(resolveWorkflowResultAccess({}, vmResult, "another-thread").workspaceEnabled).toBe(true);
    expect(resolveWorkflowResultAccess({}, vmResult, "thread").workspaceEnabled).toBe(false);
  });
});
