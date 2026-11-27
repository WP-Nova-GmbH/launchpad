import { ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";
import {
  canUseLiveProjectWorkspace,
  canUseWorkflowVmFollowUp,
  workflowResultGitAccess,
} from "./workflowResultGitAccess";

const threadId = "workflow:result";
const origin = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
  jobId: "result",
  threadId,
  workflowVmResultReader: true,
} as const;

describe("workflow result Git access", () => {
  it("blocks checkout Git before the read-only result's server config arrives", () => {
    expect(workflowResultGitAccess({ threadId, capabilities: undefined }).canReadCheckoutGit).toBe(
      false,
    );
    expect(workflowResultGitAccess({ threadId, capabilities: undefined, origin })).toEqual({
      workflowVmResultReader: true,
      canReadCheckoutGit: false,
    });
  });

  it("distinguishes direct result routes from Machine workflow threads using the environment", () => {
    expect(
      workflowResultGitAccess({ threadId, capabilities: { workflowVmResultReader: true } }),
    ).toEqual({
      workflowVmResultReader: true,
      canReadCheckoutGit: false,
    });
    expect(
      workflowResultGitAccess({
        threadId,
        capabilities: { workflowVmResultReader: false },
        origin,
      }),
    ).toEqual({
      workflowVmResultReader: false,
      canReadCheckoutGit: true,
    });
    expect(workflowResultGitAccess({ threadId, capabilities: {} }).canReadCheckoutGit).toBe(true);
    expect(
      workflowResultGitAccess({ threadId: "personal", capabilities: undefined, origin })
        .canReadCheckoutGit,
    ).toBe(true);
  });
});

it("limits follow-up controls to the exact authorized thread and generation", () => {
  const capabilities = {
    workflowVmResultReader: true,
    workflowVmFollowUp: { threadId: ThreadId.make(threadId), generation: 2 },
  } as Parameters<typeof canUseWorkflowVmFollowUp>[0]["capabilities"];
  const followUpOrigin = { ...origin, workflowVmFollowUpGeneration: 2 };
  const access = {
    threadId,
    capabilities,
    origin: followUpOrigin,
    scopedTarget: { threadId: ThreadId.make(threadId), generation: 2 },
  };
  expect(canUseWorkflowVmFollowUp(access)).toBe(true);
  expect(canUseWorkflowVmFollowUp({ ...access, scopedTarget: undefined })).toBe(false);
  expect(canUseWorkflowVmFollowUp({ ...access, capabilities: undefined })).toBe(false);
  expect(canUseWorkflowVmFollowUp({ ...access, origin })).toBe(false);
  expect(canUseWorkflowVmFollowUp({ ...access, threadId: "different" })).toBe(false);
  expect(
    workflowResultGitAccess({ threadId, capabilities, origin: followUpOrigin }).canReadCheckoutGit,
  ).toBe(false);
});

describe("workflow VM project access", () => {
  it("preserves writable group members while result descriptors load", () => {
    const members = [
      { projectId: "vm:workflow:result", capabilities: undefined },
      { projectId: "writable-checkout", capabilities: undefined },
      { projectId: "another-result", capabilities: { workflowVmResultReader: true } },
      { projectId: "vm:personal", capabilities: { workflowVmResultReader: false } },
    ];

    expect(members.filter(canUseLiveProjectWorkspace).map(({ projectId }) => projectId)).toEqual([
      "writable-checkout",
      "vm:personal",
    ]);
  });
});
