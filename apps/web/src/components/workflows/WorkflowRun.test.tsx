import { act, createElement, startTransition, useEffect, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow, RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import {
  clearWorkflowScope,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowSessionKey,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const { navigate, confirmation } = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirmation: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirmation }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => createElement("textarea", props),
}));

import { WorkflowRun } from "./WorkflowRun";

type Props = Parameters<typeof WorkflowRun>[0];
const scope: WorkflowScope = {
  accountId: "account",
  organizationId: "organization",
  repositoryId: RelayRepositoryId.make("repository"),
};
const workflow: RepositoryWorkflow = {
  workflowId: "A",
  repositoryId: scope.repositoryId,
  organizationId: scope.organizationId,
  archived: false,
  revision: 1,
  definition: {
    name: "Workflow A",
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    steps: [
      { id: "agent", kind: "agent", title: "Agent", instruction: "Work", modelSelection: null },
    ],
  },
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const otherWorkflow: RepositoryWorkflow = {
  ...workflow,
  workflowId: "B",
  definition: { ...workflow.definition, name: "Workflow B" },
};
const job: RepositoryWorkflowJob = {
  jobId: "job-A",
  repositoryId: scope.repositoryId,
  workflowId: workflow.workflowId,
  environmentId: workflow.definition.environmentId,
  instruction: "Run A",
  status: "queued",
  detail: null,
  workflow: null,
  progress: null,
  createdAt: "2026-10-13",
  updatedAt: "2026-10-13",
};
const read = vi.fn<() => Promise<RepositoryWorkflowJob>>();
const call: Props["call"] = async <A,>() => (await read()) as A;
const base: Props = { scope, workflow, projects: [], call };
const key = workflowSessionKey(scope, workflow.workflowId);
const otherKey = workflowSessionKey(scope, otherWorkflow.workflowId);
const draft = () => appAtomRegistry.get(workflowDraftAtom).runs[key]!;
let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const view = (props: Props) => (
  <AppAtomRegistryProvider>
    <WorkflowRun {...props} />
  </AppAtomRegistryProvider>
);
async function mount(props = base) {
  await act(() => {
    renderer = create(view(props));
  });
}
async function update(props: Props) {
  await act(() => renderer!.update(view(props)));
}
async function unmount() {
  await act(() => renderer?.unmount());
  renderer = undefined;
}
async function submit() {
  await act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
}
async function accept<A>(receipt: ReturnType<typeof deferred<A>>, value: A) {
  await act(async () => {
    receipt.resolve(value);
    await receipt.promise;
  });
}
async function edit(instruction: string) {
  await act(() =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: instruction } }),
  );
}
function uncertain() {
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    runs: {
      ...state.runs,
      [key]: {
        ...state.runs[key]!,
        operation: { requestId: "previous", state: "uncertain", instruction: "Run A" },
      },
    },
  }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigate.mockReset();
  confirmation.mockReset().mockResolvedValue(true);
  read.mockReset().mockResolvedValue(job);
  setWorkflowSessionAccount(appAtomRegistry, null);
  setWorkflowSessionAccount(appAtomRegistry, scope.accountId);
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    runs: {
      [key]: { instruction: "Run A", operation: null, startedJobId: null, error: null },
      [otherKey]: { instruction: "Run B", operation: null, startedJobId: null, error: null },
    },
  }));
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

describe("Run receipt and navigation ownership", () => {
  it("navigates once from the same current form and retains its receipt", async () => {
    await mount();
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft()).toMatchObject({ instruction: "", operation: null, startedJobId: job.jobId });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: { repositoryId: scope.repositoryId, jobId: job.jobId },
      }),
    );
  });
  it("keeps ownership through an ordinary metadata refresh", async () => {
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await mount();
    await submit();
    await update({ ...base, workflow: { ...workflow, revision: 2 } });
    await accept(reply, job);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(draft().startedJobId).toBe(job.jobId);
  });
  it.each(["B", "return-to-A"])(
    "retains A's receipt without redirecting %s",
    async (destination) => {
      const reply = deferred<RepositoryWorkflowJob>();
      read.mockReturnValue(reply.promise);
      await mount();
      await submit();
      await update({ ...base, workflow: otherWorkflow });
      if (destination === "return-to-A") await update(base);
      await accept(reply, job);
      expect(navigate).not.toHaveBeenCalled();
      expect(draft().startedJobId).toBe(job.jobId);
      expect(appAtomRegistry.get(workflowDraftAtom).runs[otherKey]?.instruction).toBe("Run B");
    },
  );
  it("retains the pending lock and job link across unmount and return", async () => {
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await mount();
    await submit();
    await unmount();
    await mount();
    await edit("Cannot replace pending instructions");
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().instruction).toBe("Run A");
    await accept(reply, job);
    expect(navigate).not.toHaveBeenCalled();
    expect(draft().startedJobId).toBe(job.jobId);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.props.children === "View started run"),
    ).toBe(true);
  });
});

describe("Uncertain Run confirmation ownership", () => {
  it.each(["unmount", "workflow", "repository", "organization", "account", "archive"])(
    "does not start after changing %s during confirmation",
    async (change) => {
      uncertain();
      const answer = deferred<boolean>();
      confirmation.mockReturnValue(answer.promise);
      await mount();
      await submit();
      if (change === "unmount") await unmount();
      else if (change === "workflow") await update({ ...base, workflow: otherWorkflow });
      else if (change === "archive")
        await update({ ...base, workflow: { ...workflow, archived: true } });
      else if (change === "account") {
        await act(() => setWorkflowSessionAccount(appAtomRegistry, "another-account"));
        await update({ ...base, scope: { ...scope, accountId: "another-account" } });
      } else
        await update({
          ...base,
          scope:
            change === "repository"
              ? { ...scope, repositoryId: RelayRepositoryId.make("another-repository") }
              : { ...scope, organizationId: "another-organization" },
        });
      const retained = appAtomRegistry.get(workflowDraftAtom);
      await accept(answer, true);
      expect(read).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(workflowDraftAtom)).toBe(retained);
    },
  );
  it("keeps edited instructions instead of running them under an older confirmation", async () => {
    uncertain();
    const answer = deferred<boolean>();
    confirmation.mockReturnValueOnce(answer.promise);
    await mount();
    await submit();
    await edit("Replacement instructions");
    await accept(answer, true);
    expect(read).not.toHaveBeenCalled();
    expect(draft().instruction).toBe("Replacement instructions");
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().operation?.instruction).toBe("Replacement instructions");
    await accept(reply, { ...job, instruction: "Replacement instructions" });
  });
  it.each(["replace", "clear scope"])("ignores confirmation after %s", async (change) => {
    uncertain();
    const answer = deferred<boolean>();
    confirmation.mockReturnValue(answer.promise);
    await mount();
    await submit();
    await act(() => {
      if (change === "clear scope") clearWorkflowScope(appAtomRegistry, scope);
      else
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          runs: { ...state.runs, [key]: { ...state.runs[key]!, error: "Replacement record" } },
        }));
    });
    const retained = appAtomRegistry.get(workflowDraftAtom);
    await accept(answer, true);
    expect(read).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom)).toBe(retained);
  });
  it("uses the current registry record even before its render catches up", async () => {
    const answer = deferred<boolean>();
    confirmation.mockReturnValue(answer.promise);
    await mount();
    await act(() => {
      uncertain();
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await accept(answer, true);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("deduplicates submissions through confirmation and request delivery", async () => {
    uncertain();
    const answer = deferred<boolean>();
    const reply = deferred<RepositoryWorkflowJob>();
    confirmation.mockReturnValue(answer.promise);
    read.mockReturnValue(reply.promise);
    await mount();
    await submit();
    await submit();
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await accept(answer, true);
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().operation?.instruction).toBe("Run A");
    await accept(reply, job);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps the uncertain draft on cancellation and allows a later explicit submit", async () => {
    uncertain();
    confirmation.mockResolvedValueOnce(false);
    await mount();
    const retained = draft();
    await submit();
    expect(read).not.toHaveBeenCalled();
    expect(draft()).toBe(retained);
    await submit();
    expect(confirmation).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

function CommitReceipt({
  id,
  release,
  onPassive,
}: {
  id: string;
  release: () => void;
  onPassive: () => void;
}) {
  useLayoutEffect(() => {
    if (id === "B") release();
  }, [id, release]);
  useEffect(() => {
    if (id === "B") onPassive();
  }, [id, onPassive]);
  return null;
}
describe("Ownership invalidation before passive cleanup", () => {
  it.each(["run receipt", "confirmation"])("rejects old %s after B commits", async (kind) => {
    const reply = deferred<RepositoryWorkflowJob>();
    const answer = deferred<boolean>();
    const passive = deferred<void>();
    if (kind === "confirmation") {
      uncertain();
      confirmation.mockReturnValue(answer.promise);
    } else read.mockReturnValue(reply.promise);
    const release = () => (kind === "confirmation" ? answer.resolve(true) : reply.resolve(job));
    const onPassive = () => passive.resolve();
    const frame = (definition: RepositoryWorkflow) => (
      <>
        {view({ ...base, workflow: definition })}
        <CommitReceipt id={definition.workflowId} release={release} onPassive={onPassive} />
      </>
    );
    await act(() => {
      renderer = create(frame(workflow));
    });
    await submit();
    // act flushes passive cleanup before queued continuations. Keep the transition's
    // real commit interval and wait on B's passive receipt instead of a timer.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    startTransition(() => renderer!.update(frame(otherWorkflow)));
    await passive.promise;
    expect(navigate).not.toHaveBeenCalled();
    if (kind === "confirmation") expect(read).not.toHaveBeenCalled();
    else expect(draft().startedJobId).toBe(job.jobId);
  });
});
