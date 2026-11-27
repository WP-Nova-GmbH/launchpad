import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ActiveWorkflowRunPage } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer, type TestRendererOptions } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SidebarWorkflowRuns } from "./SidebarWorkflowRuns";

const read = vi.hoisted(() => vi.fn<() => Effect.Effect<ActiveWorkflowRunPage>>());
vi.mock("@t3tools/client-runtime/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/relay")>()),
  readActiveWorkflowRunsPage: read,
}));
vi.mock("@effect/atom-react", () => {
  const session = { accountId: "account" };
  return { useAtomValue: () => session };
});
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false }),
  useSidebarVisibility: () => true,
  SidebarGroup: ({ children }: PropsWithChildren) => <section>{children}</section>,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function sidebarFixture(options?: TestRendererOptions) {
  const values = new Map<string, string>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("self", {});
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      origin: "http://localhost",
      matchMedia: () => Object.assign(new EventTarget(), { matches: true }),
      setInterval,
      clearInterval,
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    }),
  );
  const documentEvents = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    getElementById: () => null,
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("history", {});
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("scrollTo", () => {});
  const root = createRootRoute({
    component: () => (
      <>
        <SidebarWorkflowRuns />
        <Outlet />
      </>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/workflows/$repositoryId/jobs/$jobId",
    component: () => <p>Run details</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({
    isServer: false,
    routeTree: root.addChildren([index, detail]),
    history,
  });
  const mount = async () => {
    await act(() => {
      renderer = create(<RouterProvider router={router} />, options);
    });
  };
  const links = () => renderer!.root.findAllByType("a");
  const heading = () => renderer!.root.findByType("button");
  const countLabel = () => heading().findAllByType("span")[0]!.children.join("");
  const text = () => JSON.stringify(renderer!.toJSON());
  await router.load();
  return { mount, links, heading, countLabel, text, history, documentEvents };
}

const issue = {
  jobId: "run-a",
  repositoryId: "repo-a",
  repositoryName: "Launchpad",
  title: "Fix sidebar",
  issueIdentifier: "WP-331",
  status: "running" as const,
  createdAt: "2026-01-01",
};

it("tracks active runs across repositories, opens the selected run, and remembers a collapsed shelf", async () => {
  const { mount, links, heading, countLabel, text, history, documentEvents } =
    await sidebarFixture();
  const manual = {
    ...issue,
    jobId: "run-b",
    repositoryId: "repo-b",
    repositoryName: "Website",
    title: "Release",
    issueIdentifier: null,
    status: "queued" as const,
  };
  const serve = (jobs: ActiveWorkflowRunPage["jobs"]) =>
    read.mockReturnValue(
      Effect.succeed({ organizationId: "org", total: jobs.length, jobs, nextCursor: null }),
    );
  serve([issue, manual]);
  await mount();
  expect(heading().props["aria-expanded"]).toBe(true);
  expect(countLabel()).toBe("Workflow Runs (2)");
  expect(links().map((link) => link.props.title)).toEqual(["WP-331 · Fix sidebar", "Release"]);
  expect(links()[1]?.props.href).toBe("/workflows/repo-b/jobs/run-b");
  await act(async () => {
    links()[1]!.props.onClick({
      button: 0,
      currentTarget: { getAttribute: () => null, hasAttribute: () => false },
      defaultPrevented: false,
      preventDefault() {},
    });
  });
  expect(history.location.pathname).toBe("/workflows/repo-b/jobs/run-b");
  expect(text()).toContain("Run details");

  serve([{ ...issue, status: "awaiting_review" }]);
  await act(() => {
    documentEvents.visibilityState = "hidden";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
  });
  const readsWhenHidden = read.mock.calls.length;
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(read).toHaveBeenCalledTimes(readsWhenHidden);
  await act(() => {
    documentEvents.visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
  });
  expect(text()).toContain("Needs review");
  expect(countLabel()).toBe("Workflow Runs (1)");
  expect(links()).toHaveLength(1);
  serve([{ ...issue, status: "awaiting_review", checkpointResponsePending: true }]);
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(text()).toContain("Waiting for confirmation");
  expect(text()).not.toContain("Needs review");
  expect(links()[0]?.props.href).toBe("/workflows/repo-a/jobs/run-a");
  await act(() => heading().props.onClick());
  expect(heading().props["aria-expanded"]).toBe(false);
  expect(links()).toHaveLength(0);
  await act(() => renderer!.unmount());
  await mount();
  expect(heading().props["aria-expanded"]).toBe(false);
  serve([]);
  await act(() => heading().props.onClick());
  expect(countLabel()).toBe("Workflow Runs (0)");
  expect(text()).toContain("No active runs");
});

it.each([true, false])(
  "hands off focus on the final page only if the user stayed on Show more (stayed=%s)",
  async (stay) => {
    const more = () =>
      renderer!.root
        .findAllByType("button")
        .find((node) => node.children.includes("Show more runs"));
    let focused: unknown;
    const ownerDocument = {
      body: {},
      get activeElement(): unknown {
        // Removing a focused button leaves focus on the document body.
        return focused === button && !more() ? this.body : focused;
      },
      getElementById(id: string) {
        const link = links().find((node) => node.props.id === id);
        return (
          link && {
            focus: () => {
              focused = link.props.title;
            },
          }
        );
      },
    };
    const button = { ownerDocument };
    const { mount, links } = await sidebarFixture({
      createNodeMock(element) {
        const props = element.props as Record<string, unknown>;
        if (element.type === "button" && props.children === "Show more runs") return button;
        return null;
      },
    });
    const jobs = Array.from({ length: 21 }, (_, i) => ({
      ...issue,
      issueIdentifier: null,
      jobId: String(i + 1),
      title: `Run ${i + 1}`,
    }));
    read.mockReturnValue(
      Effect.succeed({
        jobs: jobs.slice(0, 20),
        organizationId: "org",
        nextCursor: "next",
        total: 21,
      }),
    );
    await mount();
    expect(links()).toHaveLength(20);
    let finish!: (page: ActiveWorkflowRunPage) => void;
    const response = new Promise<ActiveWorkflowRunPage>((resolve) => {
      finish = resolve;
    });
    read.mockReturnValue(Effect.promise(() => response));
    focused = button;
    await act(() => more()!.props.onClick({ detail: 0, currentTarget: button }));
    expect(more()?.props["aria-disabled"]).toBe(true);
    if (!stay) focused = "Another control";
    // While loading, run 20 finished and an earlier run became visible.
    // Keyboard navigation should still advance past the original page.
    await act(async () => {
      const refreshed = [
        { ...jobs[0]!, jobId: "0", title: "Run 0" },
        ...jobs.filter((job) => job.jobId !== "20"),
      ];
      finish({ jobs: refreshed, organizationId: "org", nextCursor: null, total: 21 });
      await response;
    });
    expect(more()).toBeUndefined();
    expect(links().at(-1)?.props.title).toBe("Run 21");
    expect(ownerDocument.activeElement).toBe(stay ? "Run 21" : "Another control");
  },
);
