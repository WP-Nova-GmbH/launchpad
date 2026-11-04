import { describe, expect, it } from "vite-plus/test";
import { workflowResultOrigin } from "./workflowResult.ts";
const origin = {
  accountId: "account",
  organizationId: "org",
  repositoryId: "repo",
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
