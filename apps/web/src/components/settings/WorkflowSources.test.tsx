import { act, createElement, type PropsWithChildren, type ComponentType } from "react";
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
} from "@t3tools/contracts/relay";
const fixture = vi.hoisted(() => ({
  account: "owner",
  getToken: vi.fn(async () => "fixture-token"),
  fetch: vi.fn<typeof fetch>(),
  deliveries: [] as Array<Promise<void>>,
  enqueue: (_effect: Effect.Effect<void>) => {},
  repo: null as unknown as WorkflowRepositorySources,
  failRead: false,
  denyRead: false,
  dropAllow: false,
  allowCount: 0,
  readCount: 0,
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: fixture.account, isLoaded: true, getToken: fixture.getToken }),
}));
vi.mock("../../cloud/publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: () => Promise.resolve(true) }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: PropsWithChildren) => createElement("section", null, children),
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
  await act(async () => {
    while (fixture.deliveries.length) await Promise.all(fixture.deliveries.splice(0));
  });
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
  fixture.deliveries = [];
  fixture.failRead = false;
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
              delivery: "unverified",
            },
          ],
        });
      return Response.json(fixture.repo);
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
