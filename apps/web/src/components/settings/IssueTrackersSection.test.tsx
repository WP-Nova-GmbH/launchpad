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
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children, ...props }: { children: ReactNode }) => (
    <div role="radiogroup" {...props}>
      {children}
    </div>
  ),
  RadioGroupItem: (props: object) => <input type="radio" {...props} />,
}));
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
  (renderer.root.findAllByProps({ role: "dialog" }).at(-1) ?? renderer.root)
    .findAllByType("button")
    .find((node) => textOf(node) === label)!;
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
    mocks.runPromise.mockResolvedValueOnce({
      authorizationUrl: "https://linear.app/oauth/authorize",
      authorizationId: "attempt",
      connection: {
        ...active,
        authorization: { id: "attempt", phase: "pending", expiresAt: "2026-10-01T12:00:00Z" },
      },
    });
    await click("Change workspace");
    expect(window.open).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize",
      "_blank",
      "noopener,noreferrer",
    );
    expect(button("Continue to Linear")).toBeUndefined();
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

it("connects Jira through OAuth and refreshes the pending dialog after returning", async () => {
  const jira = {
    ...active,
    service: "jira",
    status: "connecting",
    accountLabel: null,
    authorization: { id: "jira-attempt", phase: "pending", expiresAt: "2026-10-01T12:00:00Z" },
  };
  mocks.runPromise.mockResolvedValueOnce({
    authorizationUrl: "https://mcp.atlassian.com/v1/authorize?state=test",
    authorizationId: "jira-attempt",
    connection: jira,
  });
  await click("Connect");
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(textOf(renderer.root)).toContain("Waiting for Atlassian");
  expect(button("Continue to Atlassian")).toBeUndefined();
  expect(window.open).toHaveBeenCalledWith(
    "https://mcp.atlassian.com/v1/authorize?state=test",
    "_blank",
    "noopener,noreferrer",
  );
  expect(textOf(renderer.root)).toContain("Finish in Atlassian, then return here");
  mocks.runPromise.mockResolvedValueOnce({
    ...snapshot,
    connections: [
      active,
      { ...jira, status: "connected", accountLabel: "Team Jira", authorization: undefined },
    ],
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(textOf(renderer.root)).toContain("Team Jira");
});

it("shows opening progress immediately and retries failed sign-in without a confirmation step", async () => {
  let rejectStart!: (error: Error) => void;
  mocks.runPromise.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectStart = reject;
      }),
  );
  await click("Connect");
  expect(textOf(renderer.root)).toContain("Opening Atlassian…");
  expect(button("Continue to Atlassian")).toBeUndefined();
  expect(button("Try again")).toBeUndefined();
  mocks.runPromise.mockResolvedValueOnce(snapshot);
  await act(async () => rejectStart(new Error("Atlassian is unavailable")));
  expect(textOf(renderer.root)).toContain("Could not open Atlassian");
  expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Atlassian is unavailable");
  mocks.runPromise.mockResolvedValueOnce({
    authorizationUrl: "https://auth.atlassian.com/authorize",
    authorizationId: "retry-attempt",
    connection: {
      service: "jira",
      status: "connecting",
      accountLabel: null,
      updatedAt: "2026-10-02",
      authorization: { id: "retry-attempt", phase: "pending", expiresAt: "2026-10-02T12:00:00Z" },
    },
  });
  await click("Try again");
  expect(textOf(renderer.root)).toContain("Waiting for Atlassian");
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

const jiraSelection = {
  service: "jira",
  status: "connecting",
  accountLabel: null,
  updatedAt: "2026-10-01",
  authorization: { id: "jira-choice", phase: "selecting_site", expiresAt: "2026-10-01T12:00:00Z" },
  jiraSites: [
    { cloudId: "a", siteUrl: "https://a.atlassian.net", accountLabel: "Team A" },
    { cloudId: "b", siteUrl: "https://b.atlassian.net", accountLabel: "Team B" },
  ],
} as const;
const jiraPending: RelayIssueTrackerConnections = {
  ...snapshot,
  connections: [active, jiraSelection],
};
const refreshWith = async (value: RelayIssueTrackerConnections) => {
  mocks.runPromise.mockResolvedValueOnce(value);
  await act(async () => window.dispatchEvent(new Event("focus")));
};
const chooseSite = async (cloudId: string) => {
  await act(async () =>
    renderer.root.findByProps({ role: "radiogroup" }).props.onValueChange(cloudId),
  );
};

it("shows the site picker on return from OAuth and connects an explicit choice", async () => {
  mocks.runPromise.mockResolvedValueOnce({
    authorizationUrl: "https://mcp.atlassian.com/v1/authorize",
    authorizationId: jiraSelection.authorization.id,
    connection: {
      ...jiraSelection,
      jiraSites: undefined,
      authorization: { ...jiraSelection.authorization, phase: "pending" },
    },
  });
  await click("Connect");
  await refreshWith(jiraPending);
  expect(textOf(renderer.root)).toContain("Choose Jira site");
  expect(textOf(renderer.root)).toContain("a.atlassian.net");
  expect(textOf(renderer.root)).toContain("b.atlassian.net");
  expect(button("Connect").props.disabled).toBe(true);
  await chooseSite("b");
  expect(button("Connect").props.disabled).toBe(false);
  mocks.runPromise.mockResolvedValueOnce({
    ...snapshot,
    connections: [
      active,
      {
        ...jiraSelection,
        status: "connected",
        accountLabel: "Team B",
        authorization: undefined,
        jiraSites: undefined,
      },
    ],
  });
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(button("Choose site")).toBeUndefined();
  expect(textOf(renderer.root)).toContain("Team B");
});

it("resumes a persisted choice after remount and keeps it when the dialog is closed", async () => {
  await act(async () => renderer.unmount());
  mocks.runPromise.mockResolvedValueOnce(jiraPending);
  await act(async () => {
    renderer = create(<Settings />);
  });
  await click("Choose site");
  expect(button("Connect").props.disabled).toBe(true);
  await chooseSite("a");
  await click("Close");
  expect(button("Choose site")).toBeDefined();
  await click("Choose site");
  expect(button("Connect").props.disabled).toBe(true);
  expect(window.open).not.toHaveBeenCalled();
});

it("cancels only the unfinished setup and removes its picker", async () => {
  await refreshWith(jiraPending);
  await click("Choose site");
  mocks.runPromise.mockResolvedValueOnce(snapshot);
  await click("Cancel setup");
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(button("Choose site")).toBeUndefined();
  expect(button("Connect")).toBeDefined();
});

it("closes a superseded picker and requires a fresh choice for the new attempt", async () => {
  await refreshWith(jiraPending);
  await click("Choose site");
  await chooseSite("b");
  await refreshWith({
    ...snapshot,
    connections: [
      active,
      { ...jiraSelection, authorization: { ...jiraSelection.authorization, id: "new-choice" } },
    ],
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  await click("Choose site");
  expect(button("Connect").props.disabled).toBe(true);
});

it("keeps an expired site selection error visible after the picker closes and clears it on retry", async () => {
  await refreshWith(jiraPending);
  await click("Choose site");
  await chooseSite("a");
  const message = "This site selection expired. Connect Jira again.";
  mocks.runPromise.mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(snapshot);
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe(message);
  expect(button("Connect").props.disabled).toBe(false);

  mocks.runPromise.mockResolvedValueOnce({
    authorizationUrl: "https://mcp.atlassian.com/v1/authorize",
    authorizationId: "jira-retry",
    connection: {
      ...jiraSelection,
      jiraSites: undefined,
      authorization: { ...jiraSelection.authorization, id: "jira-retry", phase: "pending" },
    },
  });
  await click("Connect");
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  expect(textOf(renderer.root)).toContain("Finish in Atlassian, then return here");
});

it("disables selection after a lost response until metadata is verified", async () => {
  await refreshWith(jiraPending);
  await click("Choose site");
  await chooseSite("a");
  mocks.runPromise
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockRejectedValueOnce(new Error("Offline"));
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(button("Connect").props.disabled).toBe(true);
  expect(button("Cancel setup").props.disabled).toBe(true);
  await refreshWith(jiraPending);
  expect(button("Connect").props.disabled).toBe(false);
});

it("removes picker controls when admin access is lost", async () => {
  await refreshWith(jiraPending);
  await click("Choose site");
  await act(async () => renderer.update(<Settings isAdmin={false} />));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(button("Choose site")).toBeUndefined();
});
