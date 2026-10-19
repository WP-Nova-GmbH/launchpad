import * as Schema from "effect/Schema";
import type { WorkflowAutomation } from "@t3tools/contracts/workflows";
import { WorkflowTriggerInspector } from "../workflows/WorkflowTriggerInspector";
import { act, useState, createElement, type PropsWithChildren, type ComponentType } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { it } from "@effect/vitest";
import type { HttpClient } from "effect/unstable/http";
import type { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
  type WorkflowRepositorySources,
  type WorkflowSource,
  type WorkflowSourceOwner,
  type BeginWorkflowSource,
} from "@t3tools/contracts/relay";
const decodeAutomation = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fixture = vi.hoisted(() => ({
  account: "owner",
  getToken: vi.fn(async () => "fixture-token"),
  fetch: vi.fn<typeof fetch>(),
  deliveries: [] as Array<Promise<void>>,
  enqueue: (_effect: Effect.Effect<void>) => {},
  repo: null as unknown as WorkflowRepositorySources,
  failRead: false,
  failSelection: false,
  delivery: "unverified" as WorkflowSource["delivery"],
  denyRead: false,
  dropAllow: false,
  allowCount: 0,
  readCount: 0,
  owner: null as unknown as WorkflowSourceOwner,
  begins: [] as Array<typeof BeginWorkflowSource.Type>,
  beginReply: null as
    | null
    | ((body: typeof BeginWorkflowSource.Type) => Response | Promise<Response>),
  dropWithdraw: false,
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: fixture.account, isLoaded: true, getToken: fixture.getToken }),
}));
vi.mock("../../cloud/publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(true) }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("../ui/select", () => {
  const part = ({ children }: PropsWithChildren) => createElement("div", null, children);
  return {
    Select: (props: Record<string, unknown>) =>
      createElement("div", { ...props, "data-picker": true }),
    SelectTrigger: part,
    SelectValue: part,
    SelectPopup: part,
    SelectItem: part,
  };
});
vi.mock("../ui/sheet", () => {
  const part = ({ children }: PropsWithChildren) => children;
  return {
    Sheet: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? children : null),
    SheetPopup: part,
    SheetHeader: part,
    SheetTitle: part,
    SheetDescription: part,
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    headerAction,
  }: PropsWithChildren<{ headerAction?: React.ReactNode }>) =>
    createElement("section", null, headerAction, children),
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: "Workflow sources" }),
}));
vi.mock("../../lib/runtime", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { ManagedRelayTenancy } = await import("@t3tools/client-runtime/relay");
  const { remoteHttpClientLayer } = await import("@t3tools/client-runtime/rpc");
  const http = remoteHttpClientLayer((input, init) => fixture.fetch(input, init));
  const layer = ManagedRelayTenancy.layer({ relayUrl: "https://relay.test" }).pipe(
    Layer.provideMerge(http),
  );
  return {
    runtime: {
      runPromiseExit: <A, E>(
        program: Effect.Effect<
          A,
          E,
          HttpClient.HttpClient | ManagedRelayTenancy.ManagedRelayTenancyClient
        >,
        _options?: { signal?: AbortSignal },
      ) => {
        let complete!: () => void;
        const receipt = {
          promise: new Promise<void>((resolve) => {
            complete = resolve;
          }),
          resolve: () => complete(),
        };
        fixture.deliveries.push(receipt.promise);
        return new Promise((resolve) => {
          fixture.enqueue(
            program.pipe(
              Effect.provide(layer),
              Effect.exit,
              Effect.tap((exit) =>
                Effect.sync(() => {
                  resolve(exit);
                  receipt.resolve();
                }),
              ),
              Effect.asVoid,
            ),
          );
        });
      },
    },
  };
});

vi.mock(
  "../../../../mobile/node_modules/react/index.js",
  async () => await vi.importActual("react"),
);
vi.mock("../../../../mobile/node_modules/react-native/index.js", () => ({
  Text: (props: PropsWithChildren) => createElement("text", props),
  Platform: { OS: "ios" },
}));
vi.mock("../../../../mobile/node_modules/@clerk/expo/dist/index.js", () => ({
  useAuth: () => ({ userId: fixture.account, getToken: fixture.getToken }),
}));
vi.mock("../../../../mobile/src/lib/runtime", async () => await import("../../lib/runtime"));
vi.mock("../../../../mobile/src/features/cloud/publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: PropsWithChildren) => createElement("section", null, children),
}));
vi.mock("../../../../mobile/src/features/settings/components/SettingsActionRow", () => ({
  SettingsActionRow: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { onClick: onPress }, label),
}));
const { WorkflowSourceHealth } = await vi.importActual<{
  WorkflowSourceHealth: ComponentType<{ repositoryId: RelayRepositoryId; focused: boolean }>;
}>("../../../../mobile/src/features/settings/WorkflowSourceHealth");
import { WorkflowSourcesSettings } from "./WorkflowSources";
import { RepositorySources } from "../workflows/WorkflowSources";
const source: WorkflowSource = {
  connectionId: "connection",
  ownerUserId: "owner",
  applicationId: "app",
  workspaceId: "workspace",
  workspaceName: "Engineering workspace",
  viewerName: "Linear Owner",
  authorizationEpoch: 1,
  status: "connected",
  health: { code: "healthy", retryAt: null },
  delivery: "unverified",
};
let renderer: ReactTestRenderer;
const words = () => JSON.stringify(renderer.toJSON());
const button = (text: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.join("") === text)!;
const drain = async () => {
  do {
    await act(async () => {
      while (fixture.deliveries.length) await Promise.all(fixture.deliveries.splice(0));
    });
  } while (fixture.deliveries.length);
};
const mount = async () => {
  await act(async () => {
    renderer = create(
      <RepositorySources accountId="owner" repositoryId={RelayRepositoryId.make("repo")} />,
    );
  });
  await drain();
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.account = "owner";
  fixture.deliveries = [];
  fixture.begins = [];
  fixture.beginReply = null;
  fixture.dropWithdraw = false;
  fixture.owner = {
    configured: true,
    applicationId: "app",
    version: 0,
    attempt: null,
    connections: [],
    repositories: [],
    grants: [],
    withdrawableGrants: [],
  };
  fixture.failRead = false;
  fixture.failSelection = false;
  fixture.delivery = "unverified";
  fixture.denyRead = false;
  fixture.dropAllow = false;
  fixture.allowCount = 0;
  fixture.readCount = 0;
  fixture.repo = {
    configured: true,
    canManage: true,
    sources: [],
    eligible: [{ source, previousGrantId: null }],
  };
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    confirm: () => true,
    open: vi.fn(),
  });
  fixture.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    if (request.method === "GET") {
      fixture.readCount++;
      if (fixture.denyRead)
        return Response.json(
          { _tag: "WorkflowSourceError", code: "forbidden", message: "Repository access removed." },
          { status: 400 },
        );
      if (fixture.failRead) return new Response("temporarily unavailable", { status: 503 });
      if (request.url.endsWith("/health"))
        return Response.json({
          sources: [
            {
              connectionId: "connection",
              workspaceName: source.workspaceName,
              ownerUserId: "owner",
              status: source.status,
              health: source.health,
              delivery: fixture.delivery,
            },
          ],
        });
      return Response.json(
        request.url.endsWith("/v1/workflow-sources") ? fixture.owner : fixture.repo,
      );
    }
    if (request.url.endsWith("/metadata"))
      return Response.json({
        items: [{ id: "new-team", name: "Another page item" }],
        nextCursor: null,
      });
    if (request.url.endsWith("/selection")) {
      if (fixture.failSelection) return new Response("Unavailable", { status: 503 });
      const body = (await request.json()) as {
        teamId: string;
        stateId?: string;
        labelIds: string[];
      };
      return Response.json({
        authorizationEpoch: 1,
        team: { id: body.teamId, name: "Saved team" },
        state: body.stateId ? { id: body.stateId, name: "Saved status" } : null,
        labels: body.labelIds.map((id) => ({
          id,
          name: id === "global" ? "Global label" : "Team label",
          teamId: id === "global" ? null : body.teamId,
        })),
        issues: [],
        deliveryReady: true,
      });
    }
    if (request.url.endsWith("/linear/begin")) {
      const body = (await request.json()) as typeof BeginWorkflowSource.Type;
      fixture.begins.push(body);
      fixture.owner = {
        ...fixture.owner,
        version: fixture.owner.version + 1,
        attempt: {
          attemptId: body.attemptId,
          connectionId: body.connectionId,
          expiresAt: 600000,
          status: "pending",
          error: null,
        },
      };
      if (fixture.beginReply) return fixture.beginReply(body);
      return Response.json({
        authorization: {
          applicationId: "app",
          attemptId: body.attemptId,
          url: "https://linear.app/oauth/authorize?state=" + body.attemptId,
        },
        owner: fixture.owner,
      });
    }
    if (request.url.endsWith("/v1/workflow-sources/withdraw")) {
      const { grantId } = (await request.json()) as { grantId: string };
      fixture.owner = {
        ...fixture.owner,
        withdrawableGrants: fixture.owner.withdrawableGrants.filter((g) => g.grantId !== grantId),
      };
      if (fixture.dropWithdraw) throw new Error("withdraw reply lost after commit");
      return Response.json(fixture.owner);
    }
    if (request.url.endsWith("/linear/cancel")) {
      fixture.owner = {
        ...fixture.owner,
        version: fixture.owner.version + 1,
        attempt: fixture.owner.attempt ? { ...fixture.owner.attempt, status: "cancelled" } : null,
      };
      return Response.json(fixture.owner);
    }
    if (request.url.endsWith("/allow")) {
      fixture.allowCount++;
      const body = (await request.json()) as { grantId: string };
      fixture.repo = {
        ...fixture.repo,
        eligible: [],
        sources: [
          {
            source,
            grant: {
              grantId: body.grantId,
              connectionId: source.connectionId,
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: "owner",
              generation: 1,
              revoked: false,
            },
          },
        ],
      };
      if (fixture.dropAllow) throw new Error("response lost after commit");
      return Response.json(fixture.repo);
    }
    return Response.json(fixture.repo);
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const serveRequests = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void>>();
  fixture.enqueue = (effect) => {
    Queue.offerUnsafe(queue, effect);
  };
  yield* Effect.forever(
    Queue.take(queue).pipe(Effect.flatMap((read) => read.pipe(Effect.forkScoped))),
  ).pipe(Effect.forkScoped);
});
it.effect("retries a failed source read and recovers its repository state", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      fixture.failRead = true;
      await mount();
      expect(words()).toContain("Could not workflow sources");
      fixture.failRead = false;
      await act(async () => button("Refresh sources").props.onClick());
      await drain();
      expect(words()).toContain("Engineering workspace");
      expect(button("Allow repository")).toBeDefined();
    });
  }),
);
it.effect("reconciles a lost Allow reply without repeating consent", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      await mount();
      fixture.dropAllow = true;
      await act(async () => button("Allow repository").props.onClick());
      await drain();
      expect(fixture.allowCount).toBe(1);
      expect(fixture.readCount).toBe(2);
      expect(words()).toContain("Engineering workspace");
      expect(button("Withdraw access")).toBeDefined();
      expect(button("Allow repository")).toBeUndefined();
    });
  }),
);
it.effect("retains explicitly stale rows during an outage and clears them on lost access", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      await mount();
      fixture.failRead = true;
      await act(async () => button("Refresh sources").props.onClick());
      await drain();
      expect(words()).toContain("Engineering workspace");
      expect(words()).toContain("Showing last available status");
      fixture.failRead = false;
      fixture.denyRead = true;
      await act(async () => button("Refresh sources").props.onClick());
      await drain();
      expect(words()).not.toContain("Engineering workspace");
      expect(words()).toContain("Repository access removed");
    });
  }),
);
it.effect("shows the connection owner and service recovery independently of consent", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      fixture.repo = {
        ...fixture.repo,
        eligible: [],
        sources: [
          {
            source: {
              ...source,
              ownerUserId: "other",
              ownerLabel: "Riley",
              health: { code: "service_configuration", retryAt: null },
            },
            grant: {
              grantId: "grant",
              connectionId: "connection",
              repositoryId: "repo",
              organizationId: "org",
              ownerUserId: "other",
              generation: 1,
              revoked: false,
            },
          },
        ],
      };
      await mount();
      expect(words()).toContain("Riley");
      expect(words()).toContain("Service configuration needs attention");
      expect(button("Retry connection")).toBeDefined();
      expect(button("Allow repository")).toBeUndefined();
    });
  }),
);

it.effect("mobile reads safe source health, refreshes stale status and clears revoked access", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      await act(async () => {
        renderer = create(
          <WorkflowSourceHealth repositoryId={RelayRepositoryId.make("repo")} focused />,
        );
      });
      await drain();
      expect(words()).toContain("Engineering workspace");
      expect(words()).toContain("Configure workflow sources in the web or desktop app");
      expect(button("Allow repository")).toBeUndefined();
      expect(words()).toContain("Event delivery is not verified.");
      fixture.delivery = "verified";
      await act(async () => button("Refresh workflow sources").props.onClick());
      await drain();
      expect(words()).toContain("Event delivery verified for observed teams.");
      fixture.failRead = true;
      await act(async () => button("Refresh workflow sources").props.onClick());
      await drain();
      expect(words()).toContain("Showing last available status");
      expect(words()).toContain("Engineering workspace");
      fixture.failRead = false;
      fixture.denyRead = true;
      await act(async () => button("Refresh workflow sources").props.onClick());
      await drain();
      expect(words()).not.toContain("Engineering workspace");
      expect(words()).toContain("Repository access removed");
    });
  }),
);

const mountOwner = async () => {
  await act(async () => {
    renderer = create(<WorkflowSourcesSettings />);
  });
  await drain();
};
const refreshOwner = async () => {
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((b) => b.props["aria-label"] === "Refresh workflow sources")!
      .props.onClick();
  });
  await drain();
};
const click = async (label: string) => {
  await act(async () => {
    button(label).props.onClick();
  });
  await drain();
};
const pendingB = () => {
  fixture.owner = {
    ...fixture.owner,
    version: fixture.owner.version + 1,
    attempt: {
      attemptId: "other-device-B",
      connectionId: null,
      expiresAt: 600000,
      status: "pending",
      error: null,
    },
  };
};
const links = () => renderer.root.findAllByType("a");

it.effect("lets owners withdraw a hidden repository's consent and reconciles a lost reply", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      fixture.owner = {
        ...fixture.owner,
        connections: [source],
        withdrawableGrants: [
          { grantId: "hidden", connectionId: source.connectionId, repositoryName: null },
          {
            grantId: "visible",
            connectionId: source.connectionId,
            repositoryName: "Visible repository",
          },
        ],
      };
      await mountOwner();
      expect(words()).toContain("Repository no longer visible");
      expect(words()).toContain("You can still withdraw");
      fixture.dropWithdraw = true;
      await click("Withdraw access");
      expect(words()).not.toContain("Repository no longer visible");
      expect(words()).toContain("Visible repository");
      expect(fixture.owner.withdrawableGrants.map((g) => g.grantId)).toEqual(["visible"]);
    });
  }),
);
it.effect("suppresses a superseded link and explicitly resumes the same current attempt", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      await mountOwner();
      await click("Connect Linear workspace");
      const oldUrl = links()[0]!.props.href;
      expect(window.open).toHaveBeenCalledExactlyOnceWith(oldUrl, "_blank", "noopener,noreferrer");
      pendingB();
      await refreshOwner();
      expect(links()).toHaveLength(0);
      expect(button("Continue authorization")).toBeDefined();
      expect(window.open).toHaveBeenCalledTimes(1);
      await click("Continue authorization");
      expect(fixture.begins[1]?.attemptId).toBe("other-device-B");
      expect(links()[0]!.props.href).toContain("state=other-device-B");
      expect(window.open).toHaveBeenCalledTimes(2);
      await refreshOwner();
      expect(window.open).toHaveBeenCalledTimes(2);
      await click("Cancel authorization");
      expect(links()).toHaveLength(0);
    });
  }),
);
for (const responseOwner of ["A", "B"] as const) {
  it.effect(
    `rejects link A when response owner is ${responseOwner} and verification observes B`,
    () =>
      Effect.gen(function* () {
        yield* serveRequests;
        yield* Effect.promise(async () => {
          fixture.beginReply = (body) => {
            const oldOwner = fixture.owner;
            pendingB();
            return Response.json({
              authorization: {
                applicationId: "app",
                attemptId: body.attemptId,
                url: "https://linear.app/oauth/authorize?state=A",
              },
              owner: responseOwner === "A" ? oldOwner : fixture.owner,
            });
          };
          await mountOwner();
          await click("Connect Linear workspace");
          expect(links()).toHaveLength(0);
          expect(window.open).not.toHaveBeenCalled();
          expect(button("Continue authorization")).toBeDefined();
        });
      }),
  );
}
it.effect(
  "recovers a lost Begin reply without offering the retained old link or starting new consent",
  () =>
    Effect.gen(function* () {
      yield* serveRequests;
      yield* Effect.promise(async () => {
        await mountOwner();
        await click("Connect Linear workspace");
        fixture.beginReply = () => {
          throw new Error("Begin reply lost after commit");
        };
        await click("Connect Linear workspace");
        const committed = fixture.owner.attempt!.attemptId;
        expect(links()).toHaveLength(0);
        expect(window.open).toHaveBeenCalledTimes(1);
        fixture.beginReply = null;
        await click("Continue authorization");
        expect(fixture.begins[2]?.attemptId).toBe(committed);
        expect(links()[0]!.props.href).toContain(committed);
      });
    }),
);
it.effect(
  "blocks writes and consent links until a successful Refresh after failed mutation verification",
  () =>
    Effect.gen(function* () {
      yield* serveRequests;
      yield* Effect.promise(async () => {
        await mountOwner();
        fixture.beginReply = (body) => {
          fixture.failRead = true;
          return Response.json({
            authorization: {
              applicationId: "app",
              attemptId: body.attemptId,
              url: "https://linear.app/oauth/authorize?state=unverified",
            },
            owner: fixture.owner,
          });
        };
        await click("Connect Linear workspace");
        expect(window.open).not.toHaveBeenCalled();
        expect(links()).toHaveLength(0);
        expect(button("Connect Linear workspace").props.disabled).toBe(true);
        // Invoke the handler as well: the shared hook must reject a second write.
        await click("Connect Linear workspace");
        expect(fixture.begins).toHaveLength(1);
        fixture.failRead = false;
        fixture.beginReply = null;
        await refreshOwner();
        expect(button("Continue authorization").props.disabled).toBe(false);
        await click("Continue authorization");
        expect(fixture.begins[1]?.attemptId).toBe(fixture.begins[0]?.attemptId);
        expect(window.open).toHaveBeenCalledTimes(1);
      });
    }),
);
for (const status of ["exchanging", "connected", "failed", "cancelled"] as const) {
  it.effect(`removes the local authorization link when the attempt becomes ${status}`, () =>
    Effect.gen(function* () {
      yield* serveRequests;
      yield* Effect.promise(async () => {
        await mountOwner();
        await click("Connect Linear workspace");
        fixture.owner = { ...fixture.owner, attempt: { ...fixture.owner.attempt!, status } };
        await refreshOwner();
        expect(links()).toHaveLength(0);
        expect(button("Continue authorization")).toBeUndefined();
        expect(window.open).toHaveBeenCalledTimes(1);
      });
    }),
  );
}
it.effect("drops a delayed Begin result after the authenticated account changes", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.beginReply = async (body) => {
        const owner = fixture.owner;
        enter();
        await gate;
        return Response.json({
          authorization: {
            applicationId: "app",
            attemptId: body.attemptId,
            url: "https://linear.app/oauth/authorize?state=old-account",
          },
          owner,
        });
      };
      await mountOwner();
      await act(async () => {
        button("Connect Linear workspace").props.onClick();
        await entered;
      });
      fixture.account = "another-account";
      fixture.owner = { ...fixture.owner, attempt: null, version: 0 };
      await act(async () => {
        renderer.update(<WorkflowSourcesSettings />);
        release();
      });
      await drain();
      expect(window.open).not.toHaveBeenCalled();
      expect(links()).toHaveLength(0);
      expect(button("Continue authorization")).toBeUndefined();
    });
  }),
);

it.effect(
  "resolves saved selections beyond the current page and clears only incompatible team criteria",
  () =>
    Effect.gen(function* () {
      yield* serveRequests;
      yield* Effect.promise(async () => {
        fixture.repo = {
          ...fixture.repo,
          eligible: [],
          sources: [
            {
              source,
              grant: {
                grantId: "grant",
                connectionId: "connection",
                organizationId: "org",
                repositoryId: "repo",
                ownerUserId: "owner",
                generation: 1,
                revoked: false,
              },
            },
          ],
        };
        const initial: WorkflowAutomation = {
          enabled: false,
          trigger: {
            provider: "linear",
            connectionId: "connection",
            grantId: "grant",
            teamId: "saved-team",
            event: "entered_status",
            stateId: "saved-status",
            labelIds: ["global", "team-label"],
          },
        };
        function Editor() {
          const [automation, setAutomation] = useState(initial);
          return (
            <>
              <WorkflowTriggerInspector
                scope={{
                  accountId: "owner",
                  organizationId: "org",
                  repositoryId: RelayRepositoryId.make("repo"),
                }}
                automation={automation}
                supported
                disabled={false}
                onChange={setAutomation}
                onClose={() => {}}
              />
              <output>{JSON.stringify(automation)}</output>
            </>
          );
        }
        await act(() => {
          renderer = create(<Editor />);
        });
        await drain();
        expect(words()).toContain("Saved team");
        expect(words()).toContain("Saved status");
        expect(words()).toContain("Global label");
        expect(words()).toContain("Team label");
        const team = renderer.root
          .findAllByProps({ "data-picker": true })
          .find((node) => node.props.value === "saved-team")!;
        await act(() => team.props.onValueChange("new-team"));
        await drain();
        const state = renderer.root.findByType("output").children.join("");
        expect(decodeAutomation(state)).toMatchObject({
          trigger: { teamId: "new-team", stateId: "", labelIds: ["global"] },
        });
        expect(words()).not.toContain("Team label");
      });
    }),
);
it.effect("keeps selected IDs and shows an error when selection metadata is unavailable", () =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(async () => {
      fixture.failSelection = true;
      fixture.repo = {
        ...fixture.repo,
        eligible: [],
        sources: [
          {
            source,
            grant: {
              grantId: "grant",
              connectionId: "connection",
              organizationId: "org",
              repositoryId: "repo",
              ownerUserId: "owner",
              generation: 1,
              revoked: false,
            },
          },
        ],
      };
      const automation: WorkflowAutomation = {
        enabled: false,
        trigger: {
          provider: "linear",
          connectionId: "connection",
          grantId: "grant",
          teamId: "saved-team",
          event: "entered_status",
          stateId: "saved-status",
          labelIds: ["global"],
        },
      };
      const change = vi.fn();
      await act(() => {
        renderer = create(
          <WorkflowTriggerInspector
            scope={{
              accountId: "owner",
              organizationId: "org",
              repositoryId: RelayRepositoryId.make("repo"),
            }}
            automation={automation}
            supported
            disabled={false}
            onChange={change}
            onClose={() => {}}
          />,
        );
      });
      await drain();
      expect(words()).toContain("Saved selections are retained");
      expect(words()).toContain("saved-team");
      expect(words()).toContain("saved-status");
      expect(change).not.toHaveBeenCalled();
    });
  }),
);
