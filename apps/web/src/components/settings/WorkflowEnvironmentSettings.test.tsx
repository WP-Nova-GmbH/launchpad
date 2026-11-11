import {
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayRepositoryWorkflowConfiguration,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import { it } from "@effect/vitest";
import type { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { WorkflowEnvironmentButton } from "./WorkflowEnvironmentSettings";

const fixture = vi.hoisted(() => ({
  accountId: "user-a",
  tokenAccountId: null as string | null,
  fetch: vi.fn<(request: Request) => Promise<Response>>(),
  pending: [] as Promise<unknown>[],
  enqueue: (_effect: Effect.Effect<void>) => {},
}));
vi.mock("@clerk/react", () => {
  const getToken = async () => fixture.tokenAccountId ?? fixture.accountId;
  return { useAuth: () => ({ userId: fixture.accountId, getToken }) };
});
vi.mock("../../cloud/publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "fixture" }),
}));
vi.mock("../../lib/runtime", async () => {
  const { ManagedRelayTenancy } = await import("@t3tools/client-runtime/relay");
  const { remoteHttpClientLayer } = await import("@t3tools/client-runtime/rpc");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Cause = await import("effect/Cause");
  const Exit = await import("effect/Exit");
  const client = ManagedRelayTenancy.layer({ relayUrl: "https://relay.example.test" }).pipe(
    Layer.provide(remoteHttpClientLayer((input, init) => fixture.fetch(new Request(input, init)))),
  );
  return {
    runtime: {
      runPromise: (
        effect: Effect.Effect<unknown, Error, ManagedRelayTenancy.ManagedRelayTenancyClient>,
      ) => {
        const pending = new Promise((resolve, reject) =>
          fixture.enqueue(
            effect.pipe(
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
        fixture.pending.push(pending);
        return pending;
      },
    },
  };
});
vi.mock("../ui/sheet", () => ({
  Sheet: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (value: boolean) => void;
  }) =>
    open ? (
      <section>
        {children}
        <button onClick={() => onOpenChange(false)}>Close</button>
      </section>
    ) : null,
  SheetPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: ({
    nativeInput: _nativeInput,
    ...props
  }: ComponentProps<"input"> & { nativeInput?: boolean }) => <input {...props} />,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

const organizationId = RelayOrganizationId.make("org");
const repositoryId = RelayRepositoryId.make("repo");
const repositoryName = "Example";
const variableValue = "test\n  second line  \n";
const initial: RelayRepositoryWorkflowConfiguration = {
  organizationId,
  repositoryId,
  revision: 1,
  entries: [
    { kind: "variable", name: "APP_MODE", value: variableValue },
    { kind: "secret", name: "PACKAGE_TOKEN" },
  ],
};
const changedRevisionResponse = () =>
  Response.json(
    {
      _tag: "RelayTenancyConflictError",
      code: "tenancy_conflict",
      reason: "workflow_configuration_changed",
      traceId: "trace",
    },
    { status: 409 },
  );

let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.accountId = "user-a";
  fixture.tokenAccountId = null;
  fixture.fetch.mockReset();
  fixture.pending = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function mockRelay(
  onRead: () => RelayRepositoryWorkflowConfiguration,
  onWrite: (
    update: RelayUpdateRepositoryWorkflowConfiguration,
    request: Request,
  ) => Promise<Response>,
) {
  fixture.fetch.mockImplementation(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/organization")
      return Response.json({
        organization: { organizationId, name: "Org", createdAt: "2026" },
        userId: request.headers.get("authorization")?.replace("Bearer ", ""),
        role: "admin",
        joinedAt: "2026",
      });
    if (path !== "/v1/repositories/repo/workflow-environment")
      throw new Error("Unexpected relay request");
    if (request.method === "GET") return Response.json(onRead());
    if (request.method !== "PATCH") throw new Error("Unexpected workflow environment method");
    return onWrite(await request.json(), request);
  });
}

const editor = (accountId = "user-a") => (
  <WorkflowEnvironmentButton
    accountId={accountId}
    organizationId={organizationId}
    repositoryId={repositoryId}
    repositoryName={repositoryName}
  />
);
const button = (name: string) =>
  renderer.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === name || item.props.children === name)!;
const field = (name: string, type: "input" | "textarea" = "input") => {
  const label = renderer.root.findAllByType("label").find((item) => item.props.children === name)!;
  return renderer.root.findAllByType(type).find((item) => item.props.id === label.props.htmlFor)!;
};
const visibleText = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : visibleText(child)))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
const open = async (options?: Parameters<typeof create>[1]) => {
  await act(() => {
    renderer = create(editor(), options);
  });
  await click("Workflow environment");
};
const click = async (name: string) => {
  await act(async () => {
    const target = button(name);
    target.props.onClick({ currentTarget: target.instance });
  });
  await act(async () => {
    await Promise.allSettled(fixture.pending.splice(0));
  });
};
const changeSecret = (value: string) =>
  act(() => {
    field("Secret value").props.onChange({ currentTarget: { value } });
  });

function withUi(test: () => Promise<void>) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Effect.Effect<void>>();
    fixture.enqueue = (work) => {
      Queue.offerUnsafe(queue, work);
    };
    yield* Effect.forever(Queue.take(queue).pipe(Effect.flatMap(Effect.forkScoped))).pipe(
      Effect.forkScoped,
    );
    yield* Effect.promise(test);
  });
}

describe("workflow environment settings", () => {
  it.effect("imports reviewed entries together, preserving the type of explicit replacements", () =>
    withUi(async () => {
      const write = vi.fn(async (update: RelayUpdateRepositoryWorkflowConfiguration) =>
        Response.json({ ...initial, revision: update.expectedRevision + 1 }),
      );
      mockRelay(() => initial, write);
      await open();
      await click("Import .env");
      await act(() =>
        field("Paste .env contents", "textarea").props.onChange({
          currentTarget: {
            value:
              "APP_MODE=prod\nPACKAGE_TOKEN=new-token\nAPP_URL=http://localhost\nDEPLOY_TOKEN=deploy-value",
          },
        }),
      );
      await click("Preview import");
      const select = (label: string) =>
        renderer.root.findAllByType("select").find((node) => node.props["aria-label"] === label)!;
      expect(select("Action for APP_MODE").props.value).toBe("skip");
      expect(select("Action for PACKAGE_TOKEN").props.value).toBe("skip");
      expect(select("Type for APP_URL").props.value).toBe("variable");
      expect(select("Type for DEPLOY_TOKEN").props.value).toBe("secret");
      expect(JSON.stringify(renderer.toJSON())).not.toContain("deploy-value");
      expect(write).not.toHaveBeenCalled();
      await act(() => {
        select("Action for PACKAGE_TOKEN").props.onChange({ currentTarget: { value: "replace" } });
        select("Type for APP_URL").props.onChange({ currentTarget: { value: "secret" } });
      });
      await click("Edit pasted text");
      const pastedText = field("Paste .env contents", "textarea");
      await act(() =>
        pastedText.props.onChange({
          currentTarget: {
            value: pastedText.props.value.replace(
              "DEPLOY_TOKEN=deploy-value",
              "DEPLOY_TOKEN=updated-deploy-value",
            ),
          },
        }),
      );
      await click("Preview import");
      expect(select("Type for APP_URL").props.value).toBe("secret");
      expect(select("Action for PACKAGE_TOKEN").props.value).toBe("skip");
      expect(write).not.toHaveBeenCalled();
      await act(() =>
        select("Action for PACKAGE_TOKEN").props.onChange({ currentTarget: { value: "replace" } }),
      );
      await click("Import 3 entries");
      expect(write).toHaveBeenCalledExactlyOnceWith(
        {
          expectedRevision: 1,
          mutation: {
            kind: "import",
            entries: [
              { name: "PACKAGE_TOKEN", value: "new-token", kind: "secret", replace: true },
              { name: "APP_URL", value: "http://localhost", kind: "secret", replace: false },
              {
                name: "DEPLOY_TOKEN",
                value: "updated-deploy-value",
                kind: "secret",
                replace: false,
              },
            ],
          },
        },
        expect.any(Request),
      );
      expect(visibleText(renderer.root)).toContain("Imported 3 entries.");
    }),
  );

  it.effect("asks for a fresh preview after a conflicting import", () =>
    withUi(async () => {
      let record = initial;
      const write = vi.fn(async () => {
        record = {
          ...initial,
          revision: 2,
          entries: [
            ...initial.entries,
            { name: "APP_URL", kind: "variable", value: "another-value" },
          ],
        };
        return changedRevisionResponse();
      });
      mockRelay(() => record, write);
      await open();
      await click("Import .env");
      await act(() =>
        field("Paste .env contents", "textarea").props.onChange({
          currentTarget: { value: "APP_URL=http://localhost\nCONNECTION_URL=opaque-credential" },
        }),
      );
      await click("Preview import");
      const choice = (label: string) => renderer.root.findByProps({ "aria-label": label });
      await act(() =>
        choice("Type for CONNECTION_URL").props.onChange({ currentTarget: { value: "secret" } }),
      );
      await click("Import 2 entries");
      expect(button("Import 2 entries").props.disabled).toBe(true);
      await click("Reload settings");
      expect(button("Review again").props.disabled).toBe(false);
      await click("Review again");
      expect(choice("Action for APP_URL").props.value).toBe("skip");
      expect(choice("Type for CONNECTION_URL").props.value).toBe("secret");
      expect(button("Import 1 entry").props.disabled).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("focuses each draft when opened and leaves focus alone while editing", () =>
    withUi(async () => {
      mockRelay(
        () => initial,
        async () => Response.error(),
      );
      const focus = vi.fn();
      await act(() => {
        renderer = create(editor(), {
          createNodeMock: (element) => {
            const props = element.props as { role?: unknown };
            return props.role === "group" ? { focus } : null;
          },
        });
      });
      await click("Workflow environment");

      await click("Edit APP_MODE");
      expect(focus).toHaveBeenCalledTimes(1);
      await click("Cancel");
      await click("Secrets");
      await click("Replace PACKAGE_TOKEN");
      expect(focus).toHaveBeenCalledTimes(2);
      await changeSecret("draft value");
      expect(focus).toHaveBeenCalledTimes(2);
      await click("Delete PACKAGE_TOKEN");
      expect(focus).toHaveBeenCalledTimes(3);
      expect(button("Confirm delete")).toBeDefined();
      await click("Cancel deletion");
      expect(field("Secret value").props.value).toBe("draft value");
      expect(focus).toHaveBeenCalledTimes(4);
    }),
  );

  it.effect(
    "keeps the full multiline variable value for editing and can replace or delete a secret",
    () =>
      withUi(async () => {
        const write = vi.fn(async (update: RelayUpdateRepositoryWorkflowConfiguration) =>
          Response.json({
            ...initial,
            revision: update.expectedRevision + 1,
            entries: update.mutation.kind === "delete" ? [initial.entries[0]] : initial.entries,
          }),
        );
        mockRelay(() => initial, write);
        await open();
        expect(button("Replace PACKAGE_TOKEN")).toBeUndefined();
        expect(JSON.stringify(renderer.toJSON())).toContain("test");
        await click("Edit APP_MODE");
        expect(field("Variable value", "textarea").props.value).toBe(variableValue);
        expect(button("Secrets").props.disabled).toBe(true);
        await click("Cancel");
        await click("Secrets");
        expect(button("Edit APP_MODE")).toBeUndefined();
        await click("Replace PACKAGE_TOKEN");
        expect(field("Secret value").props.type).toBe("password");
        expect(field("Secret value").props.value).toBe("");
        expect(button("Replace secret").props.disabled).toBe(true);

        const secret = "test-only secret\nsecond line";
        await act(() => {
          field("Secret value").props.onPaste({
            clipboardData: { getData: () => secret },
            preventDefault: () => {},
          });
        });
        expect(field("Secret value").props.value).not.toContain(secret);
        await click("Replace secret");
        expect(write.mock.calls[0]?.[0]).toEqual({
          expectedRevision: 1,
          mutation: { kind: "setSecret", name: "PACKAGE_TOKEN", value: secret },
        });
        expect(JSON.stringify(renderer.toJSON())).not.toContain("test-only secret");
        await click("Replace PACKAGE_TOKEN");
        await click("Delete PACKAGE_TOKEN");
        await click("Confirm delete");
        expect(write.mock.calls[1]?.[0]).toEqual({
          expectedRevision: 2,
          mutation: { kind: "delete", name: "PACKAGE_TOKEN" },
        });
        expect(button("Replace PACKAGE_TOKEN")).toBeUndefined();
      }),
  );

  it.effect("explains invalid names and saves after the name is corrected", () =>
    withUi(async () => {
      const write = vi.fn(async (update: RelayUpdateRepositoryWorkflowConfiguration) =>
        Response.json({
          ...initial,
          revision: update.expectedRevision + 1,
          entries: [...initial.entries, { kind: "variable", name: "API_KEY", value: "" }],
        }),
      );
      mockRelay(() => initial, write);
      await open();
      expect(button("Add variable").props.disabled).toBe(false);
      expect(button("Add secret")).toBeUndefined();
      await click("Add variable");
      expect(button("Add variable").props.disabled).toBe(true);
      expect(button("Secrets").props.disabled).toBe(true);

      const changeName = (value: string) =>
        act(() => field("Name").props.onChange({ currentTarget: { value } }));
      await changeName("API-KEY");
      const name = field("Name");
      expect(name.props["aria-invalid"]).toBe(true);
      const hint = renderer.root.findByProps({ id: name.props["aria-describedby"] });
      expect(visibleText(hint)).toBe(
        "Start with a letter or underscore. Use only letters, numbers, and underscores.",
      );
      expect(button("Save variable").props.disabled).toBe(true);

      await changeName("PACKAGE_TOKEN");
      expect(visibleText(renderer.root.findByProps({ role: "alert" }))).toContain(
        "A secret already uses this name.",
      );
      expect(button("Save variable").props.disabled).toBe(true);
      expect(write).not.toHaveBeenCalled();

      await changeName("API_KEY");
      expect(field("Name").props["aria-invalid"]).not.toBe(true);
      expect(button("Save variable").props.disabled).toBe(false);
      await click("Save variable");
      expect(write.mock.calls[0]?.[0]).toEqual({
        expectedRevision: 1,
        mutation: { kind: "setVariable", name: "API_KEY", value: "" },
      });
      expect(button("Edit API_KEY")).toBeDefined();
    }),
  );

  for (const mode of ["conflict", "unconfirmed", "removed"] as const)
    it.effect(
      `keeps the secret draft after a ${mode} save and waits for reload and an explicit retry`,
      () =>
        withUi(async () => {
          let record = initial;
          const write = vi.fn(async (update: RelayUpdateRepositoryWorkflowConfiguration) => {
            if (update.expectedRevision === 1) {
              record = {
                ...initial,
                revision: 2,
                entries: mode === "removed" ? initial.entries.slice(0, 1) : initial.entries,
              };
              return mode === "unconfirmed"
                ? new Response("test-only secret", { status: 500 })
                : changedRevisionResponse();
            }
            return Response.json({ ...record, revision: 3 });
          });
          mockRelay(() => record, write);
          await open();
          await click("Secrets");
          await click("Replace PACKAGE_TOKEN");
          await changeSecret("test-only secret");
          await click("Replace secret");
          expect(field("Secret value").props.value).toBe("test-only secret");
          const alert = renderer.root.findByProps({ role: "alert" });
          const draft = renderer.root.findByProps({ role: "group", tabIndex: -1 });
          let recovery = alert;
          while (recovery.parent && recovery.parent !== draft.parent) recovery = recovery.parent;
          expect(visibleText(alert)).not.toContain("test-only secret");
          if (mode === "conflict") {
            expect(visibleText(alert)).toContain(
              "Reload the latest settings before trying again. Your draft will stay.",
            );
          }
          expect(recovery.findByType("button")).toBe(button("Reload settings"));
          expect(recovery.parent).toBe(draft.parent);
          expect(recovery.parent!.children.indexOf(recovery)).toBe(
            recovery.parent!.children.indexOf(draft) + 1,
          );
          expect(button("Replace secret").props.disabled).toBe(true);
          expect(button("Add secret").props.disabled).toBe(true);
          await click("Reload settings");
          expect(write).toHaveBeenCalledTimes(1);
          expect(field("Secret value").props.value).toBe("test-only secret");
          if (mode === "removed") {
            expect(
              visibleText(renderer.root.findByProps({ role: "group", tabIndex: -1 })),
            ).toContain("Replace PACKAGE_TOKEN");
          }
          await click(mode === "removed" ? "Save secret" : "Replace secret");
          expect(write.mock.calls[1]?.[0]).toEqual({
            expectedRevision: 2,
            mutation: { kind: "setSecret", name: "PACKAGE_TOKEN", value: "test-only secret" },
          });
        }),
    );

  for (const target of ["absent", "recreated"] as const)
    it.effect(`clears a pending delete when reload shows the entry is ${target}`, () =>
      withUi(async () => {
        let record = initial;
        const remaining = initial.entries.filter((entry) => entry.name !== "PACKAGE_TOKEN");
        const write = vi.fn(async (update: RelayUpdateRepositoryWorkflowConfiguration) => {
          if (update.expectedRevision === 1 && target === "recreated") {
            // Another maintainer deleted and recreated a secret with the same name.
            record = { ...initial, revision: 3 };
            return changedRevisionResponse();
          }
          record = { ...record, revision: update.expectedRevision + 1, entries: remaining };
          // The initial delete succeeded, but the client could not confirm it.
          return update.expectedRevision === 1
            ? new Response(null, { status: 500 })
            : Response.json(record);
        });
        mockRelay(() => record, write);
        await open();
        await click("Secrets");
        await click("Replace PACKAGE_TOKEN");
        await click("Delete PACKAGE_TOKEN");
        await click("Confirm delete");
        expect(button("Confirm delete").props.disabled).toBe(true);

        if (target === "recreated") {
          expect(visibleText(renderer.root.findByProps({ role: "alert" }))).toContain(
            "Reload the latest settings before confirming the deletion again.",
          );
        }
        await click("Reload settings");
        expect(write).toHaveBeenCalledTimes(1);
        expect(button("Confirm delete")).toBeUndefined();
        if (target === "absent") {
          expect(button("Replace PACKAGE_TOKEN")).toBeUndefined();
        } else {
          await click("Replace PACKAGE_TOKEN");
          await click("Delete PACKAGE_TOKEN");
          expect(write).toHaveBeenCalledTimes(1);
          await click("Confirm delete");
          expect(write.mock.calls[1]?.[0]).toEqual({
            expectedRevision: 3,
            mutation: { kind: "delete", name: "PACKAGE_TOKEN" },
          });
        }
      }),
    );

  it.effect("keeps recovery available when the user cancels a conflicted draft", () =>
    withUi(async () => {
      let record = initial;
      const write = vi.fn(async () => {
        record = { ...initial, revision: 2 };
        return changedRevisionResponse();
      });
      mockRelay(() => record, write);
      const focusReload = vi.fn();
      const focusReplace = vi.fn();
      await open({
        createNodeMock: (element) => {
          if (element.type !== "button") return null;
          const props = element.props as ComponentProps<"button">;
          if (props.children === "Reload settings") return { focus: focusReload };
          if (props["aria-label"] === "Replace PACKAGE_TOKEN") {
            return { focus: focusReplace, isConnected: true };
          }
          return null;
        },
      });
      await click("Secrets");
      await click("Replace PACKAGE_TOKEN");
      await changeSecret("discard this draft");
      await click("Replace secret");
      await click("Cancel");
      expect(renderer.root.findAllByType("input")).toHaveLength(0);
      const alert = visibleText(renderer.root.findByProps({ role: "alert" }));
      expect(alert).toContain("Reload the latest settings before trying again.");
      expect(alert).not.toContain("Your draft will stay.");
      expect(button("Reload settings").props.disabled).toBe(false);
      expect(focusReload).toHaveBeenCalledTimes(1);
      expect(focusReplace).not.toHaveBeenCalled();
      expect(button("Replace PACKAGE_TOKEN").props.disabled).toBe(true);
      expect(button("Add secret").props.disabled).toBe(true);
      await click("Reload settings");
      expect(focusReplace).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(button("Add secret").props.disabled).toBe(false);
      await click("Replace PACKAGE_TOKEN");
      expect(field("Secret value").props.value).toBe("");
    }),
  );

  it.effect(
    "clears a secret draft on close and ignores a save reply from the previous account",
    () =>
      withUi(async () => {
        let finishSave!: (response: Response) => void;
        let observeWrite!: (request: Request) => void;
        const reply = new Promise<Response>((resolve) => {
          finishSave = resolve;
        });
        const started = new Promise<Request>((resolve) => {
          observeWrite = resolve;
        });
        mockRelay(
          () => initial,
          async (_update, request) => {
            observeWrite(request);
            return reply;
          },
        );
        await open();
        await click("Secrets");
        await click("Replace PACKAGE_TOKEN");
        await changeSecret("discard on close");
        await click("Close");
        await click("Workflow environment");
        await click("Secrets");
        await click("Replace PACKAGE_TOKEN");
        expect(field("Secret value").props.value).toBe("");
        await changeSecret("first account only");
        await act(async () => {
          button("Replace secret").props.onClick();
          await started;
        });
        expect(button("Add secret").props.disabled).toBe(true);
        const oldRequest = fixture.pending.splice(0);
        fixture.accountId = "user-b";
        await act(() => renderer.update(editor("user-a")));
        expect(button("Workflow environment")).toBeUndefined();
        await act(() => renderer.update(editor("user-b")));
        await click("Workflow environment");
        await act(async () => {
          finishSave(Response.json({ ...initial, revision: 2, entries: [] }));
          await Promise.allSettled(oldRequest);
        });
        await click("Secrets");
        await click("Replace PACKAGE_TOKEN");
        expect(field("Secret value").props.value).toBe("");
        expect(JSON.stringify(renderer.toJSON())).not.toContain("first account only");
      }),
  );

  it.effect("clears the editor when repository access is lost", () =>
    withUi(async () => {
      mockRelay(
        () => initial,
        async () =>
          Response.json(
            {
              _tag: "RelayTenancyForbiddenError",
              code: "tenancy_forbidden",
              reason: "not_a_maintainer",
              traceId: "trace",
            },
            { status: 403 },
          ),
      );
      await open();
      await click("Secrets");
      await click("Replace PACKAGE_TOKEN");
      await changeSecret("discard after permission loss");
      await click("Replace secret");
      expect(renderer.root.findAllByType("input")).toHaveLength(0);
      expect(visibleText(renderer.root.findByProps({ role: "alert" }))).toContain(
        "no longer have access",
      );
    }),
  );

  it.effect("never sends a draft using a token from a different account", () =>
    withUi(async () => {
      const write = vi.fn(async () => Response.json({ ...initial, revision: 2 }));
      mockRelay(() => initial, write);
      await open();
      await click("Secrets");
      await click("Replace PACKAGE_TOKEN");
      await changeSecret("first account only");
      fixture.tokenAccountId = "user-b";
      await click("Replace secret");
      expect(write).not.toHaveBeenCalled();
      expect(renderer.root.findAllByType("input")).toHaveLength(0);
    }),
  );
});
