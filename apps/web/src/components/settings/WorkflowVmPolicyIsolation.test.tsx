import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import { ThreadVmPolicySettings } from "./ThreadVmPolicySettings";

const requests = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  workflowReads: 0,
  enqueue: (_work: Effect.Effect<void>) => {},
}));
vi.mock("@clerk/react", () => {
  const getToken = async () => "token";
  return { useAuth: () => ({ userId: "user", getToken }) };
});
vi.mock("../../lib/runtime", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Cause = await import("effect/Cause");
  const Exit = await import("effect/Exit");
  const { ManagedRelayTenancy } = await import("@t3tools/client-runtime/relay");
  const { remoteHttpClientLayer } = await import("@t3tools/client-runtime/rpc");
  const { DEFAULT_THREAD_VM_POLICY } = await import("@t3tools/contracts/relay");
  const client = ManagedRelayTenancy.layer({ relayUrl: "https://relay.example.test" }).pipe(
    Layer.provide(
      remoteHttpClientLayer(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/health")
          return Response.json({
            ok: true,
            service: "relay",
            workflowVmCapabilities: { configuration: true, execution: false },
          });
        if (path === "/v1/organization")
          return Response.json({
            organization: { organizationId: "org", name: "Org", createdAt: "2026" },
            userId: "user",
            role: "admin",
            joinedAt: "2026",
          });
        if (path === "/v1/organization/thread-vm-policy")
          return Response.json({
            organizationId: "org",
            revision: 1,
            policy: DEFAULT_THREAD_VM_POLICY,
          });
        if (path === "/v1/organization/workflow-vm-policy") {
          requests.workflowReads++;
          if (requests.workflowReads === 1) throw new Error("Fixture transport failure");
          return Response.json(
            {
              _tag: "RelayInternalError",
              code: "internal_error",
              reason: "internal_error",
              traceId: "test",
            },
            { status: 500 },
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    ),
  );
  return {
    runtime: {
      runPromise: (
        work: Effect.Effect<unknown, Error, ManagedRelayTenancy.ManagedRelayTenancyClient>,
      ) => {
        const promise = new Promise((resolve, reject) =>
          requests.enqueue(
            work.pipe(
              Effect.provide(client),
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) resolve(exit.value);
                  else reject(Cause.squash(exit.cause));
                }),
              ),
            ),
          ),
        );
        requests.pending.push(promise);
        return promise;
      },
    },
  };
});
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ id: "organization-thread-vms" }),
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
    render: _render,
    ...props
  }: ComponentProps<"button"> & { render?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));

const visibleText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : visibleText(child))).join(" ");

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.pending = [];
  requests.workflowReads = 0;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.effect("keeps personal policy edits intact when the workflow policy read and retry fail", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Effect.Effect<void>>();
    requests.enqueue = (work) => {
      Queue.offerUnsafe(queue, work);
    };
    yield* Effect.forever(Queue.take(queue).pipe(Effect.flatMap(Effect.forkScoped))).pipe(
      Effect.forkScoped,
    );
    yield* Effect.promise(async () => {
      await act(async () => {
        renderer = create(<ThreadVmPolicySettings isAdmin organizationId="org" />);
      });
      await act(async () => {
        await Promise.allSettled(requests.pending);
      });
      const view = renderer!;
      const initialAlert = visibleText(view.root.findByProps({ role: "alert" }));
      expect(initialAlert).toContain("Check your connection and try again.");
      expect(initialAlert).not.toContain("Could not read the workflow VM limit");
      const personal = () => view.root.findByProps({ "aria-label": "VMs per user" });
      expect(personal().props.value).toBe("3");
      await act(() => personal().props.onChange({ target: { value: "7" } }));
      const retry = view.root
        .findAllByType("button")
        .find((entry) => visibleText(entry).trim() === "Retry")!;
      await act(async () => {
        retry.props.onClick();
      });
      await act(async () => {
        await Promise.allSettled(requests.pending);
      });
      expect(requests.workflowReads).toBe(2);
      expect(personal().props.value).toBe("7");
      expect(personal().props.disabled).toBe(false);
      expect(
        view.root.findAllByType("button").find((entry) => entry.props.children === "Save policy")!
          .props.disabled,
      ).toBe(false);
      const retryAlert = visibleText(view.root.findByProps({ role: "alert" }));
      expect(retryAlert).toContain("Couldn’t load the VM limit");
      expect(retryAlert).toContain("Relay encountered an internal error");
      expect(retryAlert).not.toContain("Check your connection and try again.");
    });
  }),
);
