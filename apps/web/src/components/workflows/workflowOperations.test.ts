import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow, RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  setWorkflowSessionAccount,
  workflowDraftAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { saveWorkflowDraft, runWorkflowDraft } from "./workflowOperations";

vi.mock("../../lib/utils", () => {
  let requestId = 0;
  return { randomUUID: () => `request-${++requestId}` };
});
const scope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const saved: RepositoryWorkflow = {
  workflowId: "workflow",
  repositoryId: scope.repositoryId,
  organizationId: scope.organizationId,
  revision: 1,
  archived: false,
  definition: {
    name: "Workflow",
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    steps: [
      { id: "agent", kind: "agent", title: "Agent", instruction: "Work", modelSelection: null },
    ],
  },
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const job: RepositoryWorkflowJob = {
  jobId: "job",
  repositoryId: scope.repositoryId,
  workflowId: saved.workflowId,
  environmentId: saved.definition.environmentId,
  instruction: "Task",
  status: "queued",
  detail: null,
  workflow: null,
  progress: null,
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const editor = (): WorkflowEditorDraft => ({
  workflowId: saved.workflowId,
  definition: saved.definition,
  baseline: null,
  selectedStepId: "agent",
  targetConfirmed: true,
  operation: null,
  error: null,
});
const key = workflowSessionKey(scope, saved.workflowId);
const seed = () =>
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: { [key]: editor() },
    runs: { [key]: { instruction: "Task", operation: null, startedJobId: null, error: null } },
  }));
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  seed();
});

describe("workflow writes surviving navigation", () => {
  it("keeps Save pending outside its component and prevents a duplicate request", async () => {
    const result = deferred<RepositoryWorkflow>();
    const save = vi.fn(() => result.promise);
    const pending = saveWorkflowDraft(scope, saved.workflowId, save);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("pending");
    expect(await saveWorkflowDraft(scope, saved.workflowId, save)).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    result.resolve(saved);
    expect(await pending).toEqual(saved);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.baseline).toEqual(saved);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation).toBeNull();
  });
  it("retains an uncertain Create ID and retries optimistic concurrency with that same ID", async () => {
    const save = vi.fn(async () => {
      throw new Error("Reply lost");
    });
    await saveWorkflowDraft(scope, saved.workflowId, save);
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.operation?.state).toBe("uncertain");
    const retry = vi.fn(async () => saved);
    await saveWorkflowDraft(scope, saved.workflowId, retry);
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: saved.workflowId, expectedRevision: 0 }),
    );
  });
  it("does not overwrite a replacement editor with a late acknowledgement", async () => {
    const result = deferred<RepositoryWorkflow>();
    const pending = saveWorkflowDraft(scope, saved.workflowId, () => result.promise);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: { [key]: { ...editor(), definition: { ...saved.definition, name: "Replacement" } } },
    }));
    result.resolve(saved);
    expect(await pending).toBeNull();
    expect(appAtomRegistry.get(workflowDraftAtom).editors[key]?.definition.name).toBe(
      "Replacement",
    );
  });
  it("keeps one Run request in flight and retains its acknowledged job link after unmount", async () => {
    const result = deferred<RepositoryWorkflowJob>();
    const start = vi.fn(() => result.promise);
    const pending = runWorkflowDraft(scope, saved.workflowId, start);
    expect(await runWorkflowDraft(scope, saved.workflowId, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    result.resolve(job);
    expect(await pending).toEqual(job);
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]).toMatchObject({
      instruction: "",
      startedJobId: "job",
      operation: null,
    });
    // A failed catalog read cannot change a completed write; there is no read chained to it.
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]?.startedJobId).toBe("job");
  });
  it("keeps instructions and reports an uncertain Run without silently retrying", async () => {
    const start = vi.fn(async () => {
      throw new Error("Disconnected");
    });
    expect(await runWorkflowDraft(scope, saved.workflowId, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(workflowDraftAtom).runs[key]).toMatchObject({
      instruction: "Task",
      startedJobId: null,
      operation: { state: "uncertain" },
    });
  });
  it("discards a previous account's late Run result", async () => {
    const result = deferred<RepositoryWorkflowJob>();
    const pending = runWorkflowDraft(scope, saved.workflowId, () => result.promise);
    setWorkflowSessionAccount(appAtomRegistry, "different-account");
    result.resolve(job);
    expect(await pending).toBeNull();
    expect(appAtomRegistry.get(workflowDraftAtom).runs).toEqual({});
  });
});
