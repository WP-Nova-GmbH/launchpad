import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { WorkflowJobPage } from "@t3tools/contracts/workflows";
import { act, cloneElement, createElement, type PropsWithChildren, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WorkflowJobs } from "./WorkflowJobs";
import { workflowRunsBackLocation } from "./workflowRunsNavigation";

const call = vi.hoisted(() => vi.fn<() => Promise<WorkflowJobPage>>());
vi.mock("./workflowState", () => ({ useWorkflowClient: () => call }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => children,
  TooltipTrigger: ({ render, children }: PropsWithChildren<{ render: ReactElement }>) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps the visible History list while the run route is loading and restores it when returning", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("self", {});
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { origin: "http://localhost", setInterval, clearInterval }),
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { getElementById: () => null }));
  vi.stubGlobal("history", {});
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("scrollTo", () => {});
  const scope = {
    accountId: "account",
    organizationId: "org",
    repositoryId: RelayRepositoryId.make("repo"),
  };
  const jobId = "older-run";
  call.mockResolvedValueOnce({ jobs: [], nextCursor: null }).mockResolvedValue({
    jobs: [
      {
        jobId,
        repositoryId: scope.repositoryId,
        workflowId: "workflow",
        runtime: null,
        instruction: "Earlier release",
        status: "done",
        detail: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    nextCursor: null,
  });

  const loading = deferred();
  const routeReady = deferred();
  const refreshWorkflows = async () => {};
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/workflows/$repositoryId",
    validateSearch: () => ({ tab: "runs" as const }),
    component: () => (
      <WorkflowJobs scope={scope} workflows={[]} refreshWorkflows={refreshWorkflows} />
    ),
  });
  const run = createRoute({
    getParentRoute: () => root,
    path: "/workflows/$repositoryId/jobs/$jobId",
    loader: () => {
      loading.resolve();
      return routeReady.promise;
    },
    component: () => <p>Run details</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/workflows/repo?tab=runs"] });
  const router = createRouter({
    isServer: false,
    routeTree: root.addChildren([list, run]),
    history,
  });
  const button = (label: string) =>
    renderer!.root
      .findAllByType("button")
      .find(({ props }) => props.children === label || props["aria-label"] === label)!;
  const content = () => JSON.stringify(renderer?.toJSON());

  await router.load();
  await act(() => {
    renderer = create(<RouterProvider router={router} />);
  });
  await act(() => button("History").props.onClick());
  expect(content()).toContain("Earlier release");
  expect(call).toHaveBeenCalledTimes(2);

  await act(async () => {
    button("View run for Workflow run: Earlier release").props.onClick();
    await loading.promise;
  });
  expect(button("History").props["aria-pressed"]).toBe(true);
  expect(content()).toContain("Earlier release");
  expect(call).toHaveBeenCalledTimes(2);

  await act(() => routeReady.resolve());
  expect(content()).toContain("Run details");
  await act(async () => {
    await router.navigate(
      workflowRunsBackLocation(scope, jobId, history.location.state.workflowRunsReturn),
    );
  });
  expect(button("History").props["aria-pressed"]).toBe(true);
  expect(content()).toContain("Earlier release");
  expect(call).toHaveBeenCalledTimes(3);
});
