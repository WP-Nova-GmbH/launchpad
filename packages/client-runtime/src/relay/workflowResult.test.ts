import { describe, expect, it } from "vite-plus/test";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { canRecoverPrivateThreadLocation, workflowResultOrigin } from "./workflowResult.ts";
const origin = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
  jobId: "job",
  threadId: "thread",
};
describe("workflow result return ownership", () => {
  it("preserves the job link when the same thread changes environment", () => {
    expect(
      workflowResultOrigin(
        { workflowOrigin: origin, environmentId: "new-vm" },
        "account",
        "thread",
      ),
    ).toEqual(origin);
  });
  it("does not attach a job return link to another thread or account", () => {
    expect(workflowResultOrigin({ workflowOrigin: origin }, "other", "thread")).toBeNull();
    expect(workflowResultOrigin({ workflowOrigin: origin }, "account", "other")).toBeNull();
    expect(
      workflowResultOrigin(
        { workflowOrigin: { ...origin, repositoryId: null } },
        "account",
        "thread",
      ),
    ).toBeNull();
  });
  it("keeps the VM reader hint for the matching result route", () => {
    const workflowOrigin = { ...origin, workflowVmResultReader: true };
    expect(workflowResultOrigin({ workflowOrigin }, "account", "thread")).toEqual(workflowOrigin);
    expect(workflowResultOrigin({ workflowOrigin }, "other", "thread")).toBeNull();
  });
});

describe("private thread location recovery", () => {
  it("does not query private placement for a cold VM result without navigation state", () => {
    expect(
      canRecoverPrivateThreadLocation({
        accountId: "account",
        threadId: "workflow:job",
        capabilities: undefined,
      }),
    ).toBe(false);
  });

  it("can recover a moved machine workflow whose original environment never returns", () => {
    for (const threadId of ["workflow:job:agent", "ordinary-thread"])
      expect(
        canRecoverPrivateThreadLocation({ accountId: "account", threadId, capabilities: null }),
      ).toBe(true);
  });

  it("uses the current capability before a result hint or the cold ID", () => {
    const workflowOrigin = { ...origin, workflowVmResultReader: true as const };
    expect(
      canRecoverPrivateThreadLocation({
        capabilities: { workflowVmResultReader: true },
        accountId: "account",
        threadId: "thread",
      }),
    ).toBe(false);
    for (const threadId of ["thread", "workflow:job"])
      expect(
        canRecoverPrivateThreadLocation({
          capabilities: { workflowVmResultReader: false },
          accountId: "account",
          threadId,
          origin: { ...workflowOrigin, threadId },
        }),
      ).toBe(true);
    expect(
      canRecoverPrivateThreadLocation({
        capabilities: {},
        accountId: "account",
        threadId: "workflow:job",
      }),
    ).toBe(true);
  });

  it("accepts only hints for the current account and conversation", () => {
    const input = {
      capabilities: undefined,
      origin: { ...origin, workflowVmResultReader: true as const },
      accountId: "account",
      threadId: "thread",
    };
    expect(canRecoverPrivateThreadLocation(input)).toBe(false);
    expect(canRecoverPrivateThreadLocation({ ...input, accountId: "other" })).toBe(true);
    expect(canRecoverPrivateThreadLocation({ ...input, threadId: "other" })).toBe(true);
    expect(canRecoverPrivateThreadLocation({ ...input, accountId: null })).toBe(true);
  });
});
