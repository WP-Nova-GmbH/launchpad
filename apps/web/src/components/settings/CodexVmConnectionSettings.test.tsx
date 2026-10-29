import type { RelayCodexVmConnection, RelayCodexVmSignInAttempt } from "@t3tools/contracts/relay";
import { CodexVmSignInError, type CodexVmSignInCallback } from "@t3tools/contracts";
import { act, cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CodexVmSignIn } from "@t3tools/client-runtime/relay";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";

type Controller = ReturnType<typeof CodexVmSignIn.makeCodexVmSignInController>;
const hook = vi.hoisted(() => ({
  controller: null as Controller | null,
  command: null as Promise<void> | null,
  enqueue: (_work: Effect.Effect<void>) => {},
}));
vi.mock("../../cloud/codexVmConnection", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useCodexVmConnection: () => {
      const controller = hook.controller!;
      const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const run = (work: Effect.Effect<void>) => {
        const promise = runUi(work);
        hook.command = promise;
        return promise;
      };
      return {
        ...snapshot,
        refresh: () => run(controller.refresh),
        connect: () => run(controller.connect),
        reconnect: () => run(controller.reconnect),
        replace: () => run(controller.replace),
        retry: () => run(controller.retry),
        cancel: () => run(controller.cancel),
        disconnect: () => run(controller.disconnect),
        dismissPlanConfirmation: controller.dismissPlanConfirmation,
      };
    },
  };
});
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ id: "organization-codex-vms" }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
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
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    render,
    ...props
  }: ComponentProps<"button"> & { render?: ReactElement<Record<string, unknown>> }) =>
    render ? cloneElement(render, props, children) : <button {...props}>{children}</button>,
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span data-slot="badge">{children}</span>,
}));
vi.mock("../ui/menu", () => ({
  Menu: () => null,
  MenuTrigger: () => null,
  MenuPopup: () => null,
  MenuItem: () => null,
  MenuSeparator: () => null,
}));
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <section role="dialog">{children}</section> : null,
    DialogPopup: Part,
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogFooter: Part,
  };
});

import { CodexVmConnectionSettings } from "./CodexVmConnectionSettings";

const disconnected: RelayCodexVmConnection = {
  connectionId: null,
  label: null,
  status: "disconnected",
  epoch: 0,
  tokenRevision: 0,
  errorCode: null,
  refreshing: false,
};
const connected: RelayCodexVmConnection = {
  ...disconnected,
  connectionId: "organization-account",
  label: "test@example.test",
  status: "connected",
  epoch: 1,
  tokenRevision: 1,
};
const attempt: RelayCodexVmSignInAttempt = {
  attemptId: "original-attempt",
  phase: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function fixture(initial = connected) {
  let connection = initial;
  let readFails = false;
  let completeFails = false;
  let recovered = false;
  let holdDisconnect = false;
  const calls = { reads: 0, starts: 0, exchanges: 0, attemptIds: [] as string[] };
  const waiting = Deferred.makeUnsafe<void>();
  const callback = Deferred.makeUnsafe<CodexVmSignInCallback, CodexVmSignInError>();
  const disconnectStarted = Deferred.makeUnsafe<void>();
  const disconnectReply = Deferred.makeUnsafe<RelayCodexVmConnection>();
  const unavailable = () => new CodexVmSignIn.CodexVmSignInClientError({ reason: "unavailable" });
  const deps: CodexVmSignIn.CodexVmSignInDependencies = {
    capability: Effect.succeed(true),
    startBridge: Effect.succeed({
      bridgeId: "bridge",
      state: "bridge-state".repeat(10),
      redirectUri: "http://127.0.0.1:45001/auth/callback",
      expiresAt: attempt.expiresAt,
    }),
    waitBridge: () =>
      Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(callback))),
    cancelBridge: () =>
      Deferred.fail(callback, new CodexVmSignInError({ reason: "cancelled" })).pipe(Effect.asVoid),
    readConnection: Effect.suspend(() => {
      calls.reads++;
      return readFails ? Effect.fail(unavailable()) : Effect.succeed(connection);
    }),
    startAttempt: () =>
      Effect.sync(() => {
        calls.starts++;
        return {
          attempt,
          authorizationUrl:
            "https://auth.openai.com/oauth/authorize?client_id=dynamic_agent_client",
        };
      }),
    completeAttempt: () =>
      Effect.suspend(() => {
        calls.exchanges++;
        if (completeFails) return Effect.fail(unavailable());
        connection = connected;
        return Effect.succeed(connection);
      }),
    readAttempt: (id) =>
      Effect.sync(() => {
        calls.attemptIds.push(id);
        return { ...attempt, phase: recovered ? "completed" : "exchanging" };
      }),
    cancelAttempt: () => Effect.sync(() => connection),
    disconnect: Deferred.succeed(disconnectStarted, undefined).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          holdDisconnect ? Deferred.await(disconnectReply) : Effect.succeed(disconnected),
        ),
      ),
    ),
    openAuthorization: () => Effect.void,
  };
  const controller = CodexVmSignIn.makeCodexVmSignInController(deps);
  return {
    controller,
    calls,
    waiting,
    disconnectStarted,
    failReads: (value: boolean) => {
      readFails = value;
    },
    failCompletion: () => {
      completeFails = true;
    },
    recover: () => {
      recovered = true;
      connection = connected;
    },
    pauseDisconnect: () => {
      holdDisconnect = true;
    },
    finishDisconnect: () => {
      connection = disconnected;
      return Deferred.succeed(disconnectReply, disconnected);
    },
    callback: Deferred.succeed(callback, {
      state: "bridge-state".repeat(10),
      code: "one-use-test-code",
      clientId: "issued-client-id",
    }),
  };
}

let renderer: ReactTestRenderer | undefined;
function runUi<A>(work: Effect.Effect<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    hook.enqueue(
      work.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) resolve(exit.value);
            else reject(Cause.squash(exit.cause));
          }),
        ),
      ),
    );
  });
}
const serveRequests = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void>>();
  hook.enqueue = (work) => {
    Queue.offerUnsafe(queue, work);
  };
  yield* Effect.forever(
    Queue.take(queue).pipe(Effect.flatMap((work) => work.pipe(Effect.forkScoped))),
  ).pipe(Effect.forkScoped);
});
const uiTest = (body: () => Promise<void>) =>
  Effect.gen(function* () {
    yield* serveRequests;
    yield* Effect.promise(body);
  }).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        if (hook.controller)
          await act(async () => {
            await runUi(hook.controller!.dispose);
          });
      }),
    ),
  );
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => textOf(node) === label || node.props["aria-label"] === label);
const badgeLabels = () => renderer!.root.findAllByProps({ "data-slot": "badge" }).map(textOf);

async function mount(controller: Controller) {
  hook.controller = controller;
  await runUi(controller.refresh);
  await act(async () => {
    renderer = create(<CodexVmConnectionSettings organizationId="organization" isAdmin />);
  });
}

async function click(label: string) {
  const target = button(label);
  expect(target, `${label} should be available`).toBeDefined();
  expect(target!.props.disabled).not.toBe(true);
  await act(async () => {
    hook.command = null;
    target!.props.onClick();
    await hook.command;
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  hook.controller = null;
  hook.command = null;
  vi.unstubAllGlobals();
});

describe("compact organization Codex account recovery", () => {
  it.effect(
    "retains the account after a failed lookup, then repairs status without another sign-in",
    () =>
      uiTest(async () => {
        const f = fixture();
        await mount(f.controller);
        expect(badgeLabels()).toContain("Connected");

        f.failReads(true);
        await act(async () => {
          await runUi(f.controller.refresh);
        });
        expect(textOf(renderer!.root)).toContain(connected.label);
        expect(textOf(renderer!.root)).toContain("Can’t check account status");
        expect(textOf(renderer!.root)).toContain("Last known status: Connected.");
        expect(badgeLabels()).not.toContain("Connected");

        f.failReads(false);
        await click("Retry");
        expect(badgeLabels()).toContain("Connected");
        expect(textOf(renderer!.root)).not.toContain("Can’t check account status");
        expect(f.calls).toMatchObject({ reads: 3, starts: 0, exchanges: 0 });
      }),
  );

  it.effect(
    "checks an unresolved exchange on the original attempt without exchanging the code again",
    () =>
      uiTest(async () => {
        const f = fixture(disconnected);
        f.failCompletion();
        await mount(f.controller);
        await act(async () => {
          const signingIn = runUi(f.controller.connect);
          await runUi(Deferred.await(f.waiting));
          await runUi(f.callback);
          await signingIn;
        });
        expect(f.controller.getSnapshot()).toMatchObject({
          busy: false,
          attempt: { phase: "exchanging" },
        });
        expect(button("Check sign-in status")).toBeDefined();
        expect(button("Cancel sign-in")).toBeDefined();
        expect(textOf(renderer!.root)).not.toContain("Can’t check account status");

        await click("Check sign-in status");
        expect(f.controller.getSnapshot().error).toBeNull();
        expect(button("Check sign-in status")).toBeDefined();
        expect(button("Cancel sign-in")).toBeDefined();

        f.recover();
        await click("Check sign-in status");
        expect(badgeLabels()).toContain("Connected");
        expect(button("Check sign-in status")).toBeUndefined();
        expect(textOf(renderer!.root)).not.toContain("Account action needs attention");
        expect(f.calls.starts).toBe(1);
        expect(f.calls.exchanges).toBe(1);
        expect(f.calls.attemptIds).toEqual([
          attempt.attemptId,
          attempt.attemptId,
          attempt.attemptId,
        ]);
      }),
  );

  it.effect(
    "uses neutral progress for disconnect and exposes Cancel only for an actual sign-in attempt",
    () =>
      uiTest(async () => {
        const f = fixture();
        await mount(f.controller);
        f.pauseDisconnect();
        let disconnecting!: Promise<void>;
        await act(async () => {
          disconnecting = runUi(f.controller.disconnect);
          await runUi(Deferred.await(f.disconnectStarted));
        });
        expect(badgeLabels()).toContain("Working…");
        expect(button("Cancel sign-in")).toBeUndefined();
        expect(textOf(renderer!.root)).not.toContain("Finish sign-in in your browser");
        await act(async () => {
          await runUi(f.finishDisconnect());
          await disconnecting;
        });

        let signingIn!: Promise<void>;
        await act(async () => {
          signingIn = runUi(f.controller.connect);
          await runUi(Deferred.await(f.waiting));
        });
        expect(button("Cancel sign-in")).toBeDefined();
        expect(renderer!.root.findAllByType("a").map(textOf)).toContain("Open ChatGPT sign-in");
        expect(textOf(renderer!.root)).toContain("Finish sign-in in your browser");
        await click("Cancel sign-in");
        await act(async () => {
          await signingIn;
        });
        expect(button("Cancel sign-in")).toBeUndefined();
        expect(f.controller.getSnapshot().attempt).toBeNull();
      }),
  );
});
