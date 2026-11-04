import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkflowResultAccess } from "./workflow-result-access";

const machineResult = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
  jobId: "job",
  threadId: "thread",
};
const vmResult = { ...machineResult, workflowVmResultReader: true as const };

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
