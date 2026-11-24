import {
  act,
  createElement,
  isValidElement,
  startTransition,
  useEffect,
  useLayoutEffect,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { it as effectTest } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import {
  WorkflowInvalidError,
  WorkflowSubmissionPendingError,
  type RepositoryWorkflow,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  clearWorkflowScope,
  setWorkflowSessionAccount,
  updateWorkflowDrafts,
  workflowDraftAtom,
  workflowSessionKey,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const { navigate, getToken, runPromiseExit } = vi.hoisted(() => ({
  navigate: vi.fn(),
  getToken: vi.fn<() => Promise<string | null>>(),
  runPromiseExit: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromiseExit } }));
vi.mock("../ui/alert-dialog", () => {
  const part = ({ children }: PropsWithChildren) => children;
  return {
    AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? createElement("section", { role: "alertdialog" }, children) : null,
    AlertDialogPopup: part,
    AlertDialogHeader: part,
    AlertDialogTitle: part,
    AlertDialogDescription: part,
    AlertDialogFooter: part,
  };
});
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
const messages = (role: string) =>
  renderer!.root.findAll((node) => typeof node.type === "string" && node.props.role === role);
const alertText = () => messages("alert").map(visibleText).join(" ");
const dialog = () => renderer!.root.findByProps({ role: "alertdialog" });
const button = (label: string, container = renderer!.root) =>
  container
    .findAllByType("button")
    .find((node) => visibleText(node).replace(/\s+/g, " ").trim() === label)!;
const press = (label: string, container = renderer!.root) =>
  act(async () => {
    button(label, container).props.onClick();
  });
const separateRunDraft = () =>
  renderer!.root
    .findAllByType("details")
    .find((node) =>
      node
        .findAllByType("summary")
        .some((summary) => visibleText(summary).trim() === "New run draft"),
    )!;
async function openSeparateRunConfirmation() {
  await press("Start an additional run", separateRunDraft());
  expect(visibleText(dialog())).toContain("Start a separate run?");
}
const confirmSeparateRun = () => press("Start an additional run", dialog());
async function startSeparateRun() {
  await openSeparateRunConfirmation();
  await confirmSeparateRun();
}

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
const authenticatedView = (props: Props) => (
  <AppAtomRegistryProvider>
    <AuthenticatedWorkflowRun {...props} />
  </AppAtomRegistryProvider>
);
async function mount(props = base, withAuth = false, options?: Parameters<typeof create>[1]) {
  await act(() => {
    renderer = create(withAuth ? authenticatedView(props) : view(props), options);
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
  it("lets the relay check VM publishing readiness and keeps instructions when blocked", async () => {
    const message = "Give the organization's GitHub App Contents write access.";
    read.mockRejectedValueOnce(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "runWorkflow",
        cause: new WorkflowInvalidError({ message }),
      }),
    );
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
    await submit();
    expect(read).toHaveBeenCalledTimes(1);
    expect(alertText()).toContain(message);
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
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

      await startSeparateRun();
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
        await press("Check runs");
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

  effectTest.effect.each(["vm", "machine"] as const)(
    "does not send an additional %s run after the saved target changes during authentication",
    (targetKind) =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<Effect.Effect<void>>();
        yield* Effect.forever(Queue.take(requests).pipe(Effect.flatMap((request) => request))).pipe(
          Effect.forkScoped,
        );
        yield* Effect.promise(async () => {
          const saved = targetKind === "vm" ? vmWorkflow : workflow;
          const initial = { ...base, workflow: saved, vmExecutionAvailable: true };
          const updated: RepositoryWorkflow = {
            ...saved,
            revision: saved.revision + 1,
            definition: {
              ...saved.definition,
              target:
                targetKind === "vm"
                  ? { kind: "vm", baseBranch: "release/2.x" }
                  : {
                      kind: "machine",
                      environmentId: EnvironmentId.make("new-environment"),
                      projectId: ProjectId.make("new-checkout"),
                    },
            },
          };
          vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "workflow-test");
          read.mockRejectedValueOnce(new Error("Reply lost"));
          await mount(initial);
          await submit();
          await edit("A different run");
          const original = draft().operation;
          await unmount();
          await mount(initial, true);

          type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
          const runWorkflow = vi.fn<Client["runWorkflow"]>(() => Effect.succeed(job));
          const client = { runWorkflow } as unknown as Client;
          const delivered = deferred<void>();
          runPromiseExit.mockImplementation(
            (
              effect: Effect.Effect<
                RepositoryWorkflowJob,
                ManagedRelay.ManagedRelayClientError,
                ManagedRelayTenancy.ManagedRelayTenancyClient
              >,
            ) =>
              new Promise((resolve) => {
                Queue.offerUnsafe(
                  requests,
                  effect.pipe(
                    Effect.provideService(ManagedRelayTenancy.ManagedRelayTenancyClient, client),
                    Effect.exit,
                    Effect.map((exit) => {
                      resolve(exit);
                      delivered.resolve();
                    }),
                  ),
                );
              }),
          );
          const auth = deferred<string>();
          getToken.mockReturnValueOnce(auth.promise);
          await startSeparateRun();
          expect(getToken).toHaveBeenCalledOnce();
          expect(draft().operation?.state).toBe("pending");

          const current = { ...initial, workflow: updated };
          if (targetKind === "machine") {
            await unmount();
            await mount(current, true);
          } else {
            await act(() => renderer!.update(authenticatedView(current)));
          }

          await act(async () => {
            auth.resolve("fixture-token");
            await delivered.promise;
          });

          expect(runWorkflow).not.toHaveBeenCalled();
          expect(navigate).not.toHaveBeenCalled();
          expect(draft().error).toBe(
            "The saved workflow changed before the run was sent. Review the execution target and try again.",
          );
          expect(draft()).toMatchObject({ operation: original, instruction: "A different run" });
          expect(alertText()).toContain("Could not start the additional run");
        });
      }),
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
    await startSeparateRun();
    const original = runWorkflow.mock.calls[0]![0].payload;
    const replacement = runWorkflow.mock.calls[1]![0].payload;
    expect(replacement.requestId).not.toBe(original.requestId);
    expect(alertText()).toContain("A different run");
    expect(alertText()).not.toContain("Run A");

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
      await press("Check runs");
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
      expect(visibleText(renderer!.root).replace(/\s+/g, " ")).toContain(
        "Target VM Base branch release/1.x",
      );
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
      expect(messages("alertdialog")).toHaveLength(0);
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

  it.each(["Machine target", "gate closed", "archived"] as const)(
    "checks the earlier VM receipt independently with %s",
    async (condition) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      const receipt = deferred<RepositoryWorkflowJob>();
      read
        .mockRejectedValueOnce(new Error("Original reply lost"))
        .mockRejectedValueOnce(new Error("Newer reply lost"))
        .mockRejectedValueOnce(new Error("No matching receipt yet"))
        .mockReturnValueOnce(receipt.promise);
      await mount(initial);
      await submit();
      const original = runWorkflow.mock.calls[0]![0].payload;
      await edit("Instructions for the additional run");
      const latest =
        condition === "Machine target"
          ? { ...initial, workflow }
          : condition === "archived"
            ? { ...initial, workflow: { ...vmWorkflow, archived: true } }
            : { ...initial, vmExecutionAvailable: false };
      if (condition === "Machine target") await update(latest);
      await startSeparateRun();
      const foreground = draft().operation;
      await edit("Instructions for the next draft");
      await update(latest);

      await press("Check submission");
      expect(runWorkflow.mock.calls[2]![0].payload).toEqual({ ...original, replayOnly: true });
      expect(visibleText(renderer!.root)).toContain("No matching receipt yet");
      expect(draft().operation).toBe(foreground);
      await press("Check submission");
      expect(runWorkflow.mock.calls[3]![0].payload).toEqual({ ...original, replayOnly: true });
      expect(draft().earlierUnconfirmedRuns?.[0]?.state).toBe("pending");

      await unmount();
      await mount(latest);
      expect(visibleText(renderer!.root)).toContain("Checking for a receipt");
      expect(button("Check submission").props["aria-disabled"]).toBe(true);
      await press("Check submission");
      expect(runWorkflow).toHaveBeenCalledTimes(4);

      await accept(receipt, job);
      expect(draft()).toMatchObject({
        instruction: "Instructions for the next draft",
        operation: foreground,
        error: "Newer reply lost",
        startedJobId: job.jobId,
      });
      expect(draft().earlierUnconfirmedRuns).toBeUndefined();
      expect(navigate).not.toHaveBeenCalled();
      expect(button("Check submission")).toBeUndefined();
      await press("View started run");
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/workflows/$repositoryId/jobs/$jobId",
        params: { repositoryId: scope.repositoryId, jobId: job.jobId },
      });
    },
  );

  it.each(["unconfirmed", "rejected"] as const)(
    "keeps each recovery action unique when an additional run is pending and then %s",
    async (outcome) => {
      const { call } = captureSubmissions();
      const reply = deferred<void>();
      const rejection =
        outcome === "unconfirmed"
          ? new Error("Third reply lost")
          : new ManagedRelay.ManagedRelayRequestFailedError({
              action: "runWorkflow",
              cause: new WorkflowInvalidError({ message: "Third run could not start." }),
            });
      read
        .mockRejectedValueOnce(new Error("Original reply lost"))
        .mockRejectedValueOnce(new Error("Second reply lost"))
        .mockReturnValueOnce(
          reply.promise.then(() => {
            throw rejection;
          }),
        );
      await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call });
      await submit();
      await edit("Second instructions");
      await startSeparateRun();
      await edit("Third instructions");

      const earlierRows = () => renderer!.root.findAllByType("li").map(visibleText);
      await startSeparateRun();
      expect(messages("status").map(visibleText)).toContain(
        "Waiting for confirmation of the additional run.",
      );
      expect(earlierRows()).toEqual([expect.stringContaining("Run A")]);
      const recovery = button("Retry previous submission");
      expect(recovery.props["aria-disabled"]).toBe(true);
      expect(visibleText(renderer!.root)).toContain("Second instructions");

      await accept(reply, undefined);

      if (outcome === "rejected") {
        expect(earlierRows()).toEqual([expect.stringContaining("Run A")]);
        expect(button("Retry previous submission")).toBe(recovery);
        expect(recovery.props["aria-disabled"]).toBeUndefined();
        expect(draft().operation?.instruction).toBe("Second instructions");
      } else {
        expect(earlierRows()).toEqual([
          expect.stringContaining("Run A"),
          expect.stringContaining("Second instructions"),
        ]);
        expect(draft().operation?.instruction).toBe("Third instructions");
      }
    },
  );

  it("focuses the confirmed earlier run when its focused check action disappears", async () => {
    const { call } = captureSubmissions();
    const receipt = deferred<RepositoryWorkflowJob>();
    read
      .mockRejectedValueOnce(new Error("Original reply lost"))
      .mockRejectedValueOnce(new Error("Newer reply lost"))
      .mockReturnValueOnce(receipt.promise);
    const body = {};
    const ownerDocument: { activeElement: object; body: object } = { activeElement: body, body };
    const focusedCheck = { ownerDocument };
    const startedRun = { focus: () => (ownerDocument.activeElement = startedRun) };
    const newerRecovery = { focus: () => (ownerDocument.activeElement = newerRecovery) };
    await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call }, false, {
      createNodeMock(element) {
        const { children } = element.props as PropsWithChildren;
        if (element.type === "li")
          return { ownerDocument, contains: (node: object) => node === focusedCheck };
        if (element.type === "button" && children === "View started run") {
          if (ownerDocument.activeElement === focusedCheck) ownerDocument.activeElement = body;
          return startedRun;
        }
        if (
          element.type === "button" &&
          Array.isArray(children) &&
          children.includes("Retry previous submission")
        )
          return newerRecovery;
        return null;
      },
    });
    await submit();
    await edit("A different run");
    await startSeparateRun();
    ownerDocument.activeElement = focusedCheck;
    await press("Check submission");
    await accept(receipt, job);

    expect(button("Retry previous submission")).toBeDefined();
    expect(ownerDocument.activeElement).toBe(startedRun);
    expect(navigate).not.toHaveBeenCalled();
  });

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
      await openSeparateRunConfirmation();
      await press("Keep editing", dialog());
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(draft()).toBe(retained);

      await startSeparateRun();
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
      expect(visibleText(renderer!.root)).toContain("Run A");
      expect(alertText()).toContain("Could not start the additional run");
      expect(alertText()).not.toContain("Previous submission not confirmed");
      expect(renderer!.root.findByType("textarea").props.value).toBe("A different run");

      await press(targetKind === "vm" ? "Retry previous submission" : "Check previous submission");
      expect(runWorkflow.mock.calls[2]![0].payload).toEqual({
        ...original,
        ...(targetKind === "machine" ? { replayOnly: true } : {}),
      });
      expect(draft()).toMatchObject({ instruction: "A different run", operation: null });
    },
  );

  it.each(["target kind", "base branch", "gate", "archive"] as const)(
    "does not start a separate run when the %s changes during confirmation",
    async (change) => {
      const { call, runWorkflow } = captureSubmissions();
      const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
      read.mockRejectedValueOnce(new Error("Reply lost"));
      await mount(initial);
      await submit();
      await openSeparateRunConfirmation();
      const confirm = button("Start an additional run", dialog()).props.onClick;
      const changedBranch: RepositoryWorkflow = {
        ...vmWorkflow,
        definition: {
          ...vmWorkflow.definition,
          target: { kind: "vm", baseBranch: "release/2.x" },
        },
      };
      const changed: Record<typeof change, Props> = {
        "target kind": { ...initial, workflow },
        "base branch": { ...initial, workflow: changedBranch },
        gate: { ...initial, vmExecutionAvailable: false },
        archive: { ...initial, workflow: { ...vmWorkflow, archived: true } },
      };
      await update(changed[change]);
      const retained = draft();
      await act(() => confirm());
      expect(messages("alertdialog")).toHaveLength(0);
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(draft()).toBe(retained);
    },
  );

  it.each(["Run A", "A different run"])(
    "keeps the recovery and new draft visible during a VM retry with instructions %s",
    async (instruction) => {
      const { call, runWorkflow } = captureSubmissions();
      const reply = deferred<RepositoryWorkflowJob>();
      read.mockRejectedValueOnce(new Error("Reply lost")).mockReturnValueOnce(reply.promise);
      await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call });
      await submit();
      await edit(instruction);
      const disclosure = separateRunDraft();
      const retry = button("Retry previous submission");
      await press("Retry previous submission");
      expect(draft().operation?.state).toBe("pending");
      expect(runWorkflow.mock.calls[1]![0].payload).toEqual(runWorkflow.mock.calls[0]![0].payload);
      const submissionStatus = messages("status");
      expect(submissionStatus).toHaveLength(1);
      expect(visibleText(submissionStatus[0]!)).toContain(
        "Waiting for confirmation of the previous submission.",
      );
      expect(visibleText(renderer!.root)).toContain("Previously submitted instructions");
      expect(renderer!.root.findByType("textarea").props.value).toBe(instruction);
      expect(separateRunDraft()).toBe(disclosure);
      expect(button("Retry previous submission")).toBe(retry);

      await accept(reply, job);
      if (instruction === "Run A") {
        expect(navigate).toHaveBeenCalledTimes(1);
      } else {
        expect(navigate).not.toHaveBeenCalled();
        expect(renderer!.root.findByType("textarea").props.value).toBe(instruction);
        expect(button("View started run")).toBeDefined();
      }
    },
  );

  it.each(["Previously submitted instructions", "New run draft", "outside recovery"])(
    "handles focus on %s when a retry resolves with a new draft retained",
    async (focusedLabel) => {
      const { call } = captureSubmissions();
      const reply = deferred<RepositoryWorkflowJob>();
      read.mockRejectedValueOnce(new Error("Reply lost")).mockReturnValueOnce(reply.promise);
      const body = {};
      const ownerDocument: { activeElement: object; body: object } = { activeElement: body, body };
      const focusedNode = { ownerDocument };
      const startedRun = {
        ownerDocument,
        focus() {
          ownerDocument.activeElement = startedRun;
        },
      };
      function containsFocusedSummary(node: ReactNode): boolean {
        if (Array.isArray(node)) return node.some(containsFocusedSummary);
        if (!isValidElement<PropsWithChildren>(node)) return false;
        return (
          (node.type === "summary" && node.props.children === focusedLabel) ||
          containsFocusedSummary(node.props.children)
        );
      }
      const insideRecovery = focusedLabel !== "outside recovery";
      await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call }, false, {
        createNodeMock(element) {
          const { children } = element.props as PropsWithChildren;
          if (element.type === "button" && children === "View started run") {
            // Removing a focused disclosure returns DOM focus to the body.
            if (insideRecovery && ownerDocument.activeElement === focusedNode)
              ownerDocument.activeElement = body;
            return startedRun;
          }
          if (element.type === "div" || element.type === "details") {
            return {
              ownerDocument,
              contains: (node: object) => node === focusedNode && containsFocusedSummary(children),
            };
          }
          return null;
        },
      });
      await submit();
      await edit("A different run");
      await press("Retry previous submission");
      ownerDocument.activeElement = focusedNode;

      await accept(reply, job);

      expect(navigate).not.toHaveBeenCalled();
      expect(ownerDocument.activeElement).toBe(insideRecovery ? startedRun : focusedNode);
    },
  );

  it("shows the same VM retry while its receipt is pending after reopening", async () => {
    const { call, runWorkflow } = captureSubmissions();
    const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockRejectedValueOnce(new Error("Reply lost")).mockReturnValueOnce(reply.promise);
    await mount(initial);
    await submit();
    await press("Retry previous submission");
    await unmount();
    await mount(initial);

    expect(messages("status").map(visibleText)).toContain(
      "Waiting for confirmation of the previous submission.",
    );
    expect(button("Retry previous submission").props["aria-disabled"]).toBe(true);
    expect(visibleText(renderer!.root)).toContain("Previously submitted instructions");
    expect(separateRunDraft().findByType("textarea").props.value).toBe("Run A");
    expect(runWorkflow).toHaveBeenCalledTimes(2);
    await accept(reply, job);
    expect(button("View started run")).toBeDefined();
  });

  it("keeps the additional-run rejection separate from the original request after reopening", async () => {
    const { call } = captureSubmissions();
    const initial = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, call };
    const reply = deferred<void>();
    const message = "The additional run needs a usable checkout.";
    read.mockRejectedValueOnce(new Error("Reply lost")).mockReturnValueOnce(
      reply.promise.then(() => {
        throw new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: new WorkflowInvalidError({ message }),
        });
      }),
    );
    await mount(initial);
    await submit();
    const original = draft().operation;
    await edit("A different run");
    await startSeparateRun();
    await unmount();
    await mount(initial);

    expect(messages("status").map(visibleText)).toContain(
      "Waiting for confirmation of the additional run.",
    );
    expect(visibleText(renderer!.root)).toContain("Run A");
    expect(separateRunDraft().findByType("textarea").props.value).toBe("A different run");

    await unmount();
    await accept(reply, undefined);
    await mount(initial);

    expect(draft()).toMatchObject({ operation: original, instruction: "A different run" });
    expect(alertText()).toContain("Could not start the additional run");
    expect(alertText()).toContain(message);
    expect(visibleText(renderer!.root)).toContain("Run A");
    expect(separateRunDraft().findByType("textarea").props.value).toBe("A different run");
  });

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

  it("recovers from an unavailable base branch without retaining its stale alert", async () => {
    const message = "Choose an existing GitHub base branch with at least one commit.";
    read.mockRejectedValueOnce(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "runWorkflow",
        cause: new WorkflowInvalidError({
          message,
          vmStartFailure: { kind: "base-branch-unavailable", branch: "release/1.x" },
          vmStartFailureRevision: vmWorkflow.revision,
        }),
      }),
    );
    const props = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true, canConfigure: true };
    await mount(props);
    await submit();

    await update({
      ...props,
      workflow: {
        ...vmWorkflow,
        revision: 2,
        definition: { ...vmWorkflow.definition, name: "Renamed workflow" },
      },
    });
    expect(alertText()).toContain("Base branch unavailable");
    await press("Edit workflow");
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/workflows/$repositoryId/$workflowId/edit",
      params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
      search: { settings: "execution" },
    });

    await update({
      ...props,
      workflow: {
        ...vmWorkflow,
        revision: 3,
        definition: { ...vmWorkflow.definition, target: { kind: "vm", baseBranch: "main" } },
      },
    });

    expect(alertText()).toBe("");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
    await submit();
    expect(draft().startedJobId).toBe(job.jobId);
  });

  it.each([2, undefined])(
    "shows the relay's branch failure when the catalog shows a different branch (rejected revision: %s)",
    async (revision) => {
      read.mockRejectedValueOnce(
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "runWorkflow",
          cause: new WorkflowInvalidError({
            message: "Choose an existing GitHub base branch with at least one commit.",
            vmStartFailure: { kind: "base-branch-unavailable", branch: "release/2.x" },
            ...(revision === undefined ? {} : { vmStartFailureRevision: revision }),
          }),
        }),
      );
      await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true });
      await submit();

      expect(alertText()).toContain("Base branch unavailable");
      expect(alertText()).toContain("release/2.x");
      if (revision !== undefined) expect(alertText()).toMatch(/workflow revision\s+2/);
      expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
    },
  );

  it("clears required publishing permissions when a newer revision drops publishing steps", async () => {
    read.mockRejectedValueOnce(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "runWorkflow",
        cause: new WorkflowInvalidError({
          message: "Grant the GitHub App Contents write access.",
          vmStartFailure: { kind: "github-access-missing", permission: "contents-write" },
          vmStartFailureRevision: vmWorkflow.revision,
        }),
      }),
    );
    const props = { ...base, workflow: vmWorkflow, vmExecutionAvailable: true };
    await mount({
      ...props,
      workflow: {
        ...vmWorkflow,
        definition: {
          ...vmWorkflow.definition,
          steps: [
            ...vmWorkflow.definition.steps,
            { id: "push", title: "Push branch", kind: "action", action: "push" },
          ],
        },
      },
    });
    await submit();

    expect(alertText()).toContain("Contents write access");
    await update({ ...props, workflow: { ...vmWorkflow, revision: 2 } });
    expect(alertText()).toBe("");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
  });

  it("keeps the same focusable Retry start button through a second verification failure", async () => {
    const failure = new ManagedRelay.ManagedRelayRequestFailedError({
      action: "runWorkflow",
      cause: new WorkflowInvalidError({
        message: "Could not verify the repository right now.",
        vmStartFailure: { kind: "github-verification-temporary" },
        vmStartFailureRevision: vmWorkflow.revision,
      }),
    });
    const reply = deferred<void>();
    read.mockRejectedValueOnce(failure).mockReturnValueOnce(
      reply.promise.then(() => {
        throw failure;
      }),
    );
    await mount({ ...base, workflow: vmWorkflow, vmExecutionAvailable: true });
    await submit();
    const retry = button("Retry start");

    await submit();
    expect(button("Retrying start…")).toBe(retry);
    expect(retry.props).toMatchObject({ disabled: false, "aria-disabled": true });
    expect(messages("status").map(visibleText).join(" ")).toContain("Checking GitHub");
    await submit();
    expect(read).toHaveBeenCalledTimes(2);

    await accept(reply, undefined);
    expect(button("Retry start")).toBe(retry);
    expect(retry.props["aria-disabled"]).toBeUndefined();
    expect(alertText()).toContain("GitHub verification failed");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Run A");
  });
});

describe("Uncertain Run confirmation ownership", () => {
  it.each(["unmount", "workflow", "repository", "organization", "account", "archive", "checkout"])(
    "does not start after changing %s during confirmation",
    async (change) => {
      uncertain();
      await mount();
      await openSeparateRunConfirmation();
      const confirm = button("Start an additional run", dialog()).props.onClick;
      if (change === "unmount") await unmount();
      else if (change === "workflow") await update({ ...base, workflow: otherWorkflow });
      else if (change === "archive")
        await update({ ...base, workflow: { ...workflow, archived: true } });
      else if (change === "checkout")
        await update({
          ...base,
          workflow: {
            ...workflow,
            definition: {
              ...workflow.definition,
              target: {
                kind: "machine",
                environmentId: EnvironmentId.make("different-environment"),
                projectId: ProjectId.make("different-project"),
              },
            },
          },
        });
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
      await act(() => confirm());
      expect(read).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(appAtomRegistry.get(workflowDraftAtom)).toBe(retained);
      if (renderer) expect(messages("alertdialog")).toHaveLength(0);
    },
  );
  it("keeps edited instructions instead of running them under an older confirmation", async () => {
    uncertain();
    await mount();
    await openSeparateRunConfirmation();
    const confirm = button("Start an additional run", dialog()).props.onClick;
    await edit("Replacement instructions");
    await act(() => confirm());
    expect(read).not.toHaveBeenCalled();
    expect(draft().instruction).toBe("Replacement instructions");
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await startSeparateRun();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().operation?.instruction).toBe("Replacement instructions");
    await accept(reply, { ...job, instruction: "Replacement instructions" });
  });
  it.each(["replace", "clear scope"])("ignores confirmation after %s", async (change) => {
    uncertain();
    await mount();
    await openSeparateRunConfirmation();
    const confirm = button("Start an additional run", dialog()).props.onClick;
    await act(() => {
      if (change === "clear scope") clearWorkflowScope(appAtomRegistry, scope);
      else
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          runs: { ...state.runs, [key]: { ...state.runs[key]!, error: "Replacement record" } },
        }));
    });
    const retained = appAtomRegistry.get(workflowDraftAtom);
    await act(() => confirm());
    expect(read).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(workflowDraftAtom)).toBe(retained);
  });
  it("requires a separate confirmation when the usual Run form is stale", async () => {
    await mount();
    await act(() => {
      uncertain();
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(read).not.toHaveBeenCalled();
    expect(messages("alertdialog")).toHaveLength(0);
    expect(separateRunDraft().props.open).toBeFalsy();
    await openSeparateRunConfirmation();
    expect(read).not.toHaveBeenCalled();
    await confirmSeparateRun();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("can reopen confirmation after the draft changes in the same update", async () => {
    uncertain();
    await mount();
    const open = button("Start an additional run", separateRunDraft()).props.onClick;
    const editInstructions = renderer!.root.findByType("textarea").props.onChange;

    await act(() => {
      open();
      editInstructions({ target: { value: "Replacement instructions" } });
    });

    expect(messages("alertdialog")).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(draft().instruction).toBe("Replacement instructions");
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await startSeparateRun();
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().operation?.instruction).toBe("Replacement instructions");
    await accept(reply, { ...job, instruction: "Replacement instructions" });
  });
  it("deduplicates submissions through confirmation and request delivery", async () => {
    uncertain();
    const reply = deferred<RepositoryWorkflowJob>();
    read.mockReturnValue(reply.promise);
    await mount();
    await openSeparateRunConfirmation();
    await press("Start an additional run", separateRunDraft());
    expect(messages("alertdialog")).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    const confirm = button("Start an additional run", dialog()).props.onClick;
    await act(() => {
      confirm();
      confirm();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft().operation?.instruction).toBe("Run A");
    await accept(reply, job);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps the uncertain draft on cancellation and allows a later explicit submit", async () => {
    uncertain();
    await mount();
    const retained = draft();
    await openSeparateRunConfirmation();
    await press("Keep editing", dialog());
    expect(messages("alertdialog")).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(draft()).toBe(retained);
    await startSeparateRun();
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
    const passive = deferred<void>();
    let confirm: (() => void) | undefined;
    if (kind === "confirmation") uncertain();
    else read.mockReturnValue(reply.promise);
    const release = () => {
      if (confirm) confirm();
      else reply.resolve(job);
    };
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
    if (kind === "confirmation") {
      await openSeparateRunConfirmation();
      confirm = button("Start an additional run", dialog()).props.onClick;
    } else await submit();
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

describe("saved workflow run context", () => {
  it("keeps the run draft while opening unsaved definition changes for review", async () => {
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: {
        [key]: {
          workflowId: workflow.workflowId,
          definition: { ...workflow.definition, name: "Unsaved name" },
          baseline: workflow,
          selectedStepId: "agent",
          targetConfirmed: true,
          operation: null,
          error: null,
        },
      },
    }));
    await mount({ ...base, canConfigure: true });
    expect(alertText()).toContain("Your draft changes are not included");
    expect(visibleText(renderer!.root).replace(/\s+/g, " ")).toContain("Run Workflow A");
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((button) => visibleText(button) === "Review draft")!
        .props.onClick(),
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/workflows/$repositoryId/$workflowId/edit" }),
    );
    expect(draft().instruction).toBe("Run A");
  });
  it("shows one recovery alert with the captured submission separate from newer instructions", async () => {
    read.mockRejectedValueOnce(new Error("Reply lost"));
    await mount();
    await submit();
    await edit("Newer draft");
    const alerts = renderer!.root.findAll(
      (node) => typeof node.type === "string" && node.props.role === "alert",
    );
    expect(alerts).toHaveLength(1);
    expect(separateRunDraft().props.open).toBeFalsy();
    expect(separateRunDraft().findByType("textarea").props.required).toBeFalsy();
    expect(visibleText(alerts[0]!)).toContain("Previously submitted instructions");
    expect(visibleText(alerts[0]!)).toContain("Run A");
    expect(renderer!.root.findByType("textarea").props.value).toBe("Newer draft");
    expect(draft().operation?.instruction).toBe("Run A");
    await press("Check runs");
    expect(read).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: "runs" },
    });
    expect(draft().instruction).toBe("Newer draft");
  });
});
