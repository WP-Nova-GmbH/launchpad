import type { RelayIssueTrackerConnections } from "@t3tools/contracts/relay";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(async () => "token"), runPromise: vi.fn() }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: mocks.getToken }) }));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: mocks.runPromise } }));
vi.mock("../../cloud/linkEnvironment", () => ({
  decodedRelayClientError: () => (error: unknown) => error,
}));
vi.mock("../../cloud/publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    headerAction,
    children,
  }: {
    headerAction: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {headerAction}
      {children}
    </div>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) =>
      open ? (
        <section role="dialog">
          <button onClick={() => onOpenChange(false)}>Dismiss dialog</button>
          {children}
        </section>
      ) : null,
    DialogPopup: Part,
    DialogPanel: Part,
    DialogHeader: Part,
    DialogFooter: Part,
    DialogTitle: Part,
    DialogDescription: Part,
  };
});

import { useIssueTrackers } from "../../cloud/issueTrackers";
import { IssueTrackersSection } from "./IssueTrackersSection";

const active = {
  service: "linear",
  status: "connected",
  accountLabel: "Company A",
  updatedAt: "2026-10-01",
} as const;
const snapshot: RelayIssueTrackerConnections = { linearAvailable: true, connections: [active] };
const pending: RelayIssueTrackerConnections = {
  ...snapshot,
  connections: [
    {
      ...active,
      replacement: {
        id: "proposal",
        currentWorkspaceId: "a",
        workspaceId: "b",
        currentAccountLabel: "Company A",
        accountLabel: "Company B",
        expiresAt: "2026-10-01T12:00:00Z",
      },
    },
  ],
};
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
let renderer: ReactTestRenderer;
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => textOf(node) === label)!;
const click = async (label: string) => {
  await act(async () => {
    button(label).props.onClick();
  });
};
function Settings({ isAdmin = true }: { isAdmin?: boolean }) {
  return (
    <IssueTrackersSection
      isAdmin={isAdmin}
      organizationName="Our organization"
      {...useIssueTrackers()}
    />
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const window = Object.assign(new EventTarget(), { open: vi.fn() });
  vi.stubGlobal("window", window);
  mocks.runPromise.mockReset().mockResolvedValueOnce(snapshot);
  await act(async () => {
    renderer = create(<Settings />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("Linear workspace settings interactions", () => {
  it("keeps the renewal dialog open while A is connected, then exposes the returned proposal", async () => {
    await click("Change workspace");
    mocks.runPromise.mockResolvedValueOnce({
      authorizationUrl: "https://linear.app/oauth/authorize",
      authorizationId: "attempt",
      connection: {
        ...active,
        authorization: { id: "attempt", phase: "pending", expiresAt: "2026-10-01T12:00:00Z" },
      },
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(textOf(renderer.root)).toContain("Finish in Linear, then return here");
    mocks.runPromise.mockResolvedValueOnce(pending);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await click("Review change");
    expect(textOf(renderer.root)).toContain("Company B");
    expect(textOf(renderer.root)).toContain("Company A");
    expect(textOf(renderer.root)).toContain("Our organization");
    await click("Dismiss dialog");
    expect(button("Review change")).toBeDefined();
  });

  it.each(["Replace", "Cancel change"])(
    "%s updates the real hook and removes the pending review",
    async (action) => {
      mocks.runPromise.mockResolvedValueOnce(pending);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await click("Review change");
      mocks.runPromise.mockResolvedValueOnce({
        ...snapshot,
        connections: [
          { ...active, accountLabel: action === "Replace" ? "Company B" : "Company A" },
        ],
      });
      await click(action);
      expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(button("Review change")).toBeUndefined();
      expect(textOf(renderer.root)).toContain(action === "Replace" ? "Company B" : "Company A");
    },
  );

  it("shows uncertain state, disables mutations, and recovers through Refresh", async () => {
    mocks.runPromise.mockResolvedValueOnce(pending);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await click("Review change");
    mocks.runPromise
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new Error("Offline"));
    await click("Replace");
    expect(textOf(renderer.root)).toContain("Could not verify the current connection");
    expect(button("Replace").props.disabled).toBe(true);
    await click("Dismiss dialog");
    expect(button("Change workspace").props.disabled).toBe(true);
    const refresh = renderer.root.findByProps({ "aria-label": "Refresh issue trackers" });
    expect(refresh.props.disabled).toBe(false);
    mocks.runPromise.mockResolvedValueOnce(snapshot);
    await act(async () => {
      refresh.props.onClick();
    });
    expect(button("Change workspace").props.disabled).toBe(false);
  });

  it("does not offer mutation controls to organization members", async () => {
    await act(async () => renderer.update(<Settings isAdmin={false} />));
    expect(button("Change workspace")).toBeUndefined();
    expect(button("Disconnect")).toBeUndefined();
  });
});
