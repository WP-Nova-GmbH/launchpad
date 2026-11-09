import { act, createElement, startTransition, useEffect, useLayoutEffect } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import {
  WorkflowInvalidError,
  WorkflowSubmissionPendingError,
  type RepositoryWorkflow,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { ManagedRelay, type ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  clearWorkflowScope,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowSessionKey,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const { navigate, confirmation, getToken, runPromiseExit } = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirmation: vi.fn<() => Promise<boolean>>(),
  getToken: vi.fn<() => Promise<string | null>>(),
  runPromiseExit: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromiseExit } }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirmation }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => createElement("textarea", props),
}));

import { WorkflowRun } from "./WorkflowRun";
import { useWorkflowClient } from "./workflowState";

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
    target: {
      kind: "machine" as const,
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("project"),
    },
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
  runtime: workflow.definition.target.kind === "machine" ? workflow.definition.target : null,
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
const visibleText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : visibleText(child))).join(" ");
const alertText = () =>
  renderer!.root
    .findAll((node) => typeof node.type === "string" && node.props.role === "alert")
    .map(visibleText)
    .join(" ");

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
function AuthenticatedWorkflowRun(props: Props) {
  const call = useWorkflowClient(props.scope);
  return <WorkflowRun {...props} call={call} />;
}
async function mount(props = base, withAuth = false) {
  await act(() => {
    renderer = create(
      withAuth ? (
        <AppAtomRegistryProvider>
          <AuthenticatedWorkflowRun {...props} />
        </AppAtomRegistryProvider>
      ) : (
        view(props)
      ),
    );
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
  getToken.mockReset().mockResolvedValue("fixture-token");
  runPromiseExit.mockReset();
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
  vi.unstubAllEnvs();
});

describe("Run receipt and navigation ownership", () => {
  it("blocks a saved VM publishing workflow before submission and retains its instructions", async () => {
    await mount({
      ...base,
      vmExecutionAvailable: true,
      workflow: {
        ...workflow,
        definition: {
          ...workflow.definition,
          target: { kind: "vm", baseBranch: null },
          steps: [
            ...workflow.definition.steps,
            { id: "push", title: "Push branch", kind: "action", action: "push" },
          ],
        },
      },
    });
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Publishing requires a Machine target");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
    expect(read).not.toHaveBeenCalled();
    expect(draft().instruction).toBe("Run A");
  });
  it("keeps instructions copyable after a rejected Run and a refresh to the VM target", async () => {
    const message = "The workflow execution target changed. Review the saved target and try again.";
    type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
    const runWorkflow = vi.fn<Client["runWorkflow"]>();
    const client = { runWorkflow } as unknown as Client;
    await mount({
      ...base,
      call: async (operation) => {
        void operation(client, "fixture-token");
        throw new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: new WorkflowInvalidError({ message }),
        });
      },
    });
    await submit();
    expect(runWorkflow).toHaveBeenCalledExactlyOnceWith({
      clerkToken: "fixture-token",
      repositoryId: scope.repositoryId,
      payload: {
        workflowId: workflow.workflowId,
        instruction: "Run A",
        expectedTargetKind: "machine",
      },
    });
    expect(alertText()).toContain(message);
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
    expect(draft()).toMatchObject({ operation: null, startedJobId: null });
    expect(navigate).not.toHaveBeenCalled();

    await update({
      ...base,
      workflow: {
        ...workflow,
        revision: 2,
        definition: { ...workflow.definition, target: { kind: "vm", baseBranch: null } },
      },
    });
    expect(renderer!.root.findByType("textarea").props).toMatchObject({
      readOnly: true,
      value: "Run A",
    });
    expect(renderer!.root.findByType("textarea").props.disabled).toBeFalsy();
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
  });

  it("does not present a submission form on the direct VM Run route", async () => {
    await mount({
      ...base,
      workflow: {
        ...workflow,
        workflowId: "vm-without-draft",
        definition: { ...workflow.definition, target: { kind: "vm", baseBranch: null } },
      },
    });
    expect(renderer!.root.findAllByType("form")).toHaveLength(0);
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Running VM workflows is not available yet.",
    );
    expect(read).not.toHaveBeenCalled();
  });
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

describe("VM Run submission recovery", () => {
  const vmWorkflow: RepositoryWorkflow = {
    ...workflow,
    definition: { ...workflow.definition, target: { kind: "vm", baseBranch: "release/1.x" } },
  };
  const captureSubmissions = () => {
    type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
    const runWorkflow = vi.fn<Client["runWorkflow"]>();
    const client = { runWorkflow } as unknown as Client;
    const call: Props["call"] = async <A,>(operation: Parameters<Props["call"]>[0]) => {
      void operation(client, "fixture-token");
      return (await read()) as A;
    };
    return { runWorkflow, call };
  };
  const press = (label: string) =>
    act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((node) => node.props.children === label)!
        .props.onClick();
    });

  it.each([
    ["VM", "missing"],
    ["VM", "rejected"],
    ["Machine", "missing"],
  ] as const)(
    "keeps the original %s submission after the replacement's Clerk token is %s",
    async (kind, failure) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = {
        ...base,
        workflow: kind === "VM" ? vmWorkflow : workflow,
        vmExecutionAvailable: true,
        call,
      };
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "workflow-test");
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await mount(initial);
      await submit();
      const original = runWorkflow.mock.calls[0]![0].payload;
      await edit("A different run");
      await unmount();
      await mount(initial, true);
      if (failure === "missing") getToken.mockResolvedValueOnce(null);
      else getToken.mockRejectedValueOnce(new Error("Could not load the token"));

      await submit();
      expect(confirmation).toHaveBeenCalledOnce();
      expect(getToken).toHaveBeenCalledOnce();
      expect(runPromiseExit).not.toHaveBeenCalled();
      expect(runWorkflow).toHaveBeenCalledOnce();
      expect(alertText()).toContain("Launchpad Connect");

      await unmount();
      await mount(initial);
      if (kind === "VM") {
        await press("Retry previous submission");
        expect(runWorkflow.mock.calls[1]![0].payload).toEqual(original);
      } else {
        await press("Check recent runs");
        expect(runWorkflow).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/workflows/$repositoryId",
          params: { repositoryId: scope.repositoryId },
          search: { tab: "runs" },
        });
      }
      expect(renderer!.root.findByType("textarea").props.value).toBe("A different run");
    },
  );

  it("retries the replacement ID when the replacement's reply is lost after sending", async () => {
    const { call, runWorkflow } = captureSubmissions();
    const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
    read.mockRejectedValueOnce(new Error("Original reply lost")).mockRejectedValueOnce(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "runWorkflow",
        transportFailed: true,
        cause: new Error("Replacement reply lost"),
      }),
    );
    await mount(initial);
    await submit();
    await edit("A different run");
    await submit();
    const original = runWorkflow.mock.calls[0]![0].payload;
    const replacement = runWorkflow.mock.calls[1]![0].payload;
    expect(replacement.requestId).not.toBe(original.requestId);

    await press("Retry previous submission");
    expect(runWorkflow.mock.calls[2]![0].payload).toEqual(replacement);
  });

  it("keeps the recovered run shortcut after the next submission is rejected", async () => {
    const { call } = captureSubmissions();
    const message = "This run could not start.";
    read
      .mockRejectedValueOnce(new Error("Reply lost"))
      .mockResolvedValueOnce(job)
      .mockRejectedValueOnce(
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: new WorkflowInvalidError({ message }),
        }),
      );
    await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call });
    await submit();
    await edit("A different run");
    await press("Retry previous submission");
    await submit();

    expect(alertText()).toContain(message);
    expect(renderer!.root.findByType("textarea").props.value).toBe("A different run");
    await press("View started run");
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workflows/$repositoryId/jobs/$jobId",
      params: { repositoryId: scope.repositoryId, jobId: job.jobId },
    });
  });

  it.each(["archived", "gated"] as const)(
    "keeps the Machine history shortcut after the form becomes %s",
    async (condition) => {
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await mount();
      await submit();
      await edit("");
      await update({
        ...base,
        workflow: condition === "archived" ? { ...workflow, archived: true } : vmWorkflow,
      });

      expect(renderer!.root.findAllByType("form")).toHaveLength(0);
      expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
      await press("Check recent runs");
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "runs" },
      });
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it.each(["enabled", "gate closed", "Machine target", "archived"] as const)(
    "recovers the captured VM request after reopening with %s and keeps newer instructions",
    async (condition) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await mount(initial);
      expect(JSON.stringify(renderer!.toJSON())).toContain("VM · release/1.x");
      await submit();
      const captured = runWorkflow.mock.calls[0]![0].payload;
      expect(captured).toEqual({
        workflowId: workflow.workflowId,
        instruction: "Run A",
        expectedTargetKind: "vm",
        requestId: expect.any(String),
      });
      await edit("Instructions for a separate run");
      await unmount();
      await mount({
        ...initial,
        ...(condition === "gate closed" ? { vmExecutionAvailable: false } : {}),
        ...(condition === "Machine target" ? { workflow } : {}),
        ...(condition === "archived" ? { workflow: { ...vmWorkflow, archived: true } } : {}),
      });
      if (condition === "gate closed" || condition === "archived") {
        expect(renderer!.root.findAllByType("form")).toHaveLength(0);
        expect(renderer!.root.findByType("textarea").props.readOnly).toBe(true);
      }
      await press(
        condition === "enabled" ? "Retry previous submission" : "Check previous submission",
      );
      expect(runWorkflow.mock.calls[1]![0].payload).toEqual({
        ...captured,
        ...(condition === "enabled" ? {} : { replayOnly: true }),
      });
      expect(draft()).toMatchObject({
        instruction: "Instructions for a separate run",
        operation: null,
        startedJobId: job.jobId,
      });
      expect(confirmation).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(renderer!.root.findByType("textarea").props.value).toBe(
        "Instructions for a separate run",
      );
      await press("View started run");
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/workflows/$repositoryId/jobs/$jobId",
        params: { repositoryId: scope.repositoryId, jobId: job.jobId },
      });
    },
  );

  it.each(["vm", "machine"] as const)(
    "confirms a separate %s Run and preserves original VM recovery if it is rejected",
    async (targetKind) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      const message = "This run could not start.";
      read.mockRejectedValueOnce(new Error("Reply lost")).mockRejectedValueOnce(
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: new WorkflowInvalidError({ message }),
        }),
      );
      await mount(initial);
      await submit();
      const original = runWorkflow.mock.calls[0]![0].payload;
      await edit("A different run");
      if (targetKind === "machine") await update({ ...initial, workflow });
      const retained = draft();
      confirmation.mockResolvedValueOnce(false);
      await submit();
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(draft()).toBe(retained);

      await submit();
      expect(confirmation).toHaveBeenCalledTimes(2);
      const replacement = runWorkflow.mock.calls[1]![0].payload;
      expect(replacement).toEqual({
        workflowId: workflow.workflowId,
        instruction: "A different run",
        expectedTargetKind: targetKind,
        ...(targetKind === "vm" ? { requestId: expect.any(String) } : {}),
      });
      expect(replacement.requestId).not.toBe(original.requestId);
      expect(draft()).toMatchObject({
        instruction: "A different run",
        operation: retained.operation,
        error: message,
      });

      await press(targetKind === "vm" ? "Retry previous submission" : "Check previous submission");
      expect(runWorkflow.mock.calls[2]![0].payload).toEqual({
        ...original,
        ...(targetKind === "machine" ? { replayOnly: true } : {}),
      });
      expect(draft()).toMatchObject({ instruction: "A different run", operation: null });
    },
  );

  it.each(["target", "gate", "archive"] as const)(
    "does not start a separate run when the %s changes during confirmation",
    async (change) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await mount(initial);
      await submit();
      const answer = deferred<boolean>();
      confirmation.mockReturnValueOnce(answer.promise);
      await submit();
      expect(confirmation).toHaveBeenCalledOnce();
      await update(
        change === "target"
          ? { ...initial, workflow }
          : change === "gate"
            ? { ...initial, vmExecutionAvailable: false }
            : { ...initial, workflow: { ...vmWorkflow, archived: true } },
      );
      const retained = draft();
      await accept(answer, true);
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(draft()).toBe(retained);
    },
  );

  it.each([false, true])(
    "keeps an unresolved VM request after a retry error (gate closed: %s)",
    async (gateClosed) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      const message = gateClosed
        ? "This submission has no receipt yet. Check again shortly."
        : "Connect organization Codex before running.";
      const retry = gateClosed ? "Check previous submission" : "Retry previous submission";
      read.mockRejectedValueOnce(new Error("Reply lost")).mockRejectedValueOnce(
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: gateClosed
            ? new WorkflowSubmissionPendingError({ message })
            : new WorkflowInvalidError({ message }),
        }),
      );
      await mount(initial);
      await submit();
      if (gateClosed) await update({ ...initial, vmExecutionAvailable: false });
      await press(retry);
      expect(alertText()).toContain(message);
      expect(draft().operation).toMatchObject({ state: "uncertain", targetKind: "vm" });
      expect(navigate).not.toHaveBeenCalled();
      await press(retry);
      expect(runWorkflow.mock.calls[2]![0].payload).toEqual(runWorkflow.mock.calls[1]![0].payload);
      expect(draft().startedJobId).toBe(job.jobId);
    },
  );

  it("lets a first VM preflight rejection keep the instructions for a fresh submission", async () => {
    const { call, runWorkflow } = captureSubmissions();
    const message = "Connect organization Codex before running.";
    read.mockRejectedValueOnce(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "runWorkflow",
        cause: new WorkflowInvalidError({ message }),
      }),
    );
    await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call });
    await submit();
    expect(draft()).toMatchObject({ operation: null, instruction: "Run A" });
    expect(alertText()).toContain(message);
    await submit();
    expect(runWorkflow.mock.calls[0]![0].payload.requestId).not.toBe(
      runWorkflow.mock.calls[1]![0].payload.requestId,
    );
    expect(draft().startedJobId).toBe(job.jobId);
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
