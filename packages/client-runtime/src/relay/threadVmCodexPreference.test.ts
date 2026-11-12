import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type ThreadRelayRouting } from "@t3tools/contracts";
import type { RelayThreadVmCodexPreference } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { layer } from "./managedRelayTenancy.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import { createThreadVmCodexPreferenceAtoms } from "./threadVmCodexPreference.ts";

const environmentId = EnvironmentId.make("local"),
  threadId = ThreadId.make("thread"),
  relayUrl = "https://relay.example.test";
const organization = { mode: "organization", connectionId: "organization-account" } as const;
const connection = {
  connectionId: organization.connectionId,
  label: "Team",
  status: "connected",
  epoch: 1,
  tokenRevision: 1,
  errorCode: null,
  refreshing: false,
};
const initial: RelayThreadVmCodexPreference = {
  generation: 3,
  revision: 0,
  selection: { mode: "personal" },
  editable: true,
};
const saved = { ...initial, revision: 1, selection: organization };
const args = {
  environmentId,
  threadId,
  accountId: "owner",
  selection: organization,
  expectedRevision: 0,
  expectedGeneration: 3,
};
const scopeArgs = { environmentId, threadId };
const harness = Effect.fnUntraced(function* (
  fetchFn: typeof fetch,
  route: ThreadRelayRouting | null = { relayUrl, generation: 3, phase: "active" },
) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(managedRelaySessionAtom, {
    accountId: "owner",
    readClerkToken: () => Effect.succeed("token"),
  });
  const runtime = Atom.runtime(
      layer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn))),
    ),
    routeAtom = Atom.make<ThreadRelayRouting | null>(route),
    controls = createThreadVmCodexPreferenceAtoms(runtime, () => routeAtom),
    view = controls.codexPreferenceViewAtom(environmentId, threadId),
    query = controls.codexPreferenceQueryAtom(environmentId, threadId);
  // Await the shared runtime before mounting the lazy query, without starting any request.
  yield* AtomRegistry.getResult(registry, runtime.atom(Effect.void), { suspendOnWaiting: true });
  return { registry, routeAtom, controls, view, query };
});
const read = Effect.fnUntraced(function* (
  h: Pick<Effect.Success<ReturnType<typeof harness>>, "registry" | "query">,
) {
  yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
});

describe("saved VM Codex account", () => {
  it.effect("keeps the move guard pure and retains it after the editor closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>(),
          reply = Promise.withResolvers<Response>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => reply.resolve(new Response(null, { status: 503 }))),
        );
        const methods: string[] = [];
        let writes = 0;
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          methods.push(request.method);
          if (!request.url.endsWith("preference")) return Response.json(connection);
          if (request.method === "PUT") {
            writes++;
            if (writes === 1) {
              started.resolve();
              return reply.promise;
            }
            return Response.json(saved);
          }
          return Response.json(writes > 1 ? saved : initial);
        });
        const pending = h.controls.codexPreferencePendingAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, pending);
        expect(h.registry.get(pending)).toBe(false);
        expect(methods).toEqual([]);
        const close = h.registry.mount(h.view);
        yield* read(h);
        const command = h.controls.setCodexPreference.run(h.registry, args);
        yield* Effect.promise(() => started.promise);
        expect(h.registry.get(pending)).toBe(true);
        close();
        reply.resolve(new Response(null, { status: 503 }));
        yield* Effect.promise(() => command);
        const count = methods.length;
        expect(h.registry.get(pending)).toBe(true);
        expect(methods).toHaveLength(count);
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        expect(h.registry.get(pending)).toBe(true);
        yield* Effect.promise(() =>
          h.controls.retryCodexPreference.run(h.registry, { ...scopeArgs, accountId: "owner" }),
        );
        expect(h.registry.get(pending)).toBe(false);
        expect(writes).toBe(2);
      }),
    ),
  );

  it.effect("only reads metadata when an enrolled current thread opens the editor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          calls.push(`${request.method} ${new URL(request.url).pathname}`);
          expect(request.headers.get("authorization")).toBe("Bearer token");
          return Response.json(request.url.endsWith("preference") ? initial : connection);
        }, null);
        expect(calls).toEqual([]);
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        expect(calls).toEqual([]);
        h.registry.set(h.routeAtom, { relayUrl, generation: 3, phase: "active" });
        yield* read(h);
        expect(h.registry.get(h.view).data).toEqual(initial);
        expect(calls).toEqual([
          "GET /v1/threads/thread/provider-auth/preference",
          "GET /v1/organization/codex-vm-connection",
        ]);
      }),
    ),
  );

  it.effect("acknowledges and coalesces a save before an older held read can replace it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldReadStarted = Promise.withResolvers<void>(),
          oldRead = Promise.withResolvers<Response>(),
          putStarted = Promise.withResolvers<void>(),
          put = Promise.withResolvers<Response>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            oldRead.resolve(Response.json(initial));
            put.resolve(Response.json(saved));
          }),
        );
        let held = false,
          selected = false,
          writes = 0;
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (!request.url.endsWith("preference")) return Response.json(connection);
          if (request.method === "PUT") {
            writes++;
            putStarted.resolve();
            expect(await request.json()).toEqual({
              expectedGeneration: 3,
              expectedRevision: 0,
              selection: organization,
            });
            const response = await put.promise;
            selected = true;
            return response;
          }
          if (held) {
            held = false;
            oldReadStarted.resolve();
            return oldRead.promise;
          }
          return Response.json(selected ? saved : initial);
        });
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        held = true;
        const refresh = h.controls.refreshCodexPreference.run(h.registry, scopeArgs);
        yield* Effect.promise(() => oldReadStarted.promise);
        const first = h.controls.setCodexPreference.run(h.registry, args),
          second = h.controls.setCodexPreference.run(h.registry, args);
        yield* Effect.promise(() => putStarted.promise);
        expect(h.registry.get(h.view)).toMatchObject({
          phase: "saving",
          requested: organization,
          hasRequested: true,
        });
        put.resolve(Response.json(saved));
        expect((yield* Effect.promise(() => first))._tag).toBe("Success");
        expect((yield* Effect.promise(() => second))._tag).toBe("Success");
        expect(h.registry.get(h.view).data).toEqual(saved);
        oldRead.resolve(Response.json(initial));
        yield* Effect.promise(() => refresh);
        yield* read(h);
        expect(h.registry.get(h.view).data).toEqual(saved);
        expect(writes).toBe(1);
      }),
    ),
  );

  for (const committed of [false, true])
    it.effect(
      `resolves a lost save ${committed ? "by reading its committed revision" : "through an explicit same-choice retry"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let preference = initial,
              writes = 0;
            const payloads: unknown[] = [];
            const h = yield* harness(async (url, init) => {
              const request = new Request(url, init);
              if (!request.url.endsWith("preference")) return Response.json(connection);
              if (request.method === "PUT") {
                writes++;
                payloads.push(await request.json());
                if (writes === 1) {
                  if (committed) preference = saved;
                  throw new TypeError("Synthetic lost response");
                }
                preference = saved;
              }
              return Response.json(preference);
            });
            const unmount = h.registry.mount(h.view);
            yield* read(h);
            expect(
              (yield* Effect.promise(() => h.controls.setCodexPreference.run(h.registry, args)))
                ._tag,
            ).toBe("Failure");
            yield* read(h);
            expect(writes).toBe(1);
            if (committed) {
              expect(h.registry.get(h.view)).toMatchObject({
                phase: "idle",
                data: saved,
                hasRequested: false,
              });
              unmount();
              return;
            }
            expect(h.registry.get(h.view)).toMatchObject({
              phase: "unknown",
              data: initial,
              requested: organization,
            });
            unmount();
            yield* AtomRegistry.mount(h.registry, h.view);
            yield* read(h);
            expect(h.registry.get(h.view).phase).toBe("unknown");
            expect(writes).toBe(1);
            yield* Effect.promise(() =>
              h.controls.refreshCodexPreference.run(h.registry, scopeArgs),
            );
            expect(h.registry.get(h.view).phase).toBe("unknown");
            yield* Effect.promise(() =>
              h.controls.retryCodexPreference.run(h.registry, { ...scopeArgs, accountId: "owner" }),
            );
            expect(h.registry.get(h.view)).toMatchObject({
              phase: "idle",
              data: saved,
              hasRequested: false,
            });
            expect(payloads).toEqual([
              { expectedGeneration: 3, expectedRevision: 0, selection: organization },
              { expectedGeneration: 3, expectedRevision: 0, selection: organization },
            ]);
          }),
        ),
    );

  for (const winner of ["original", "new choice"] as const)
    it.effect(`can replace an uncertain choice through CAS when ${winner} wins`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          let preference = initial,
            writes = 0;
          const payloads: unknown[] = [];
          const personal = { ...saved, selection: { mode: "personal" as const } };
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (!request.url.endsWith("preference"))
              return Response.json({ ...connection, status: "disconnected", connectionId: null });
            if (request.method === "PUT") {
              writes++;
              payloads.push(await request.json());
              if (writes === 1) throw new TypeError("Synthetic lost response");
              if (winner === "original") {
                preference = saved;
                return Response.json(
                  {
                    _tag: "RelayTenancyConflictError",
                    code: "tenancy_conflict",
                    reason: "vm_policy_changed",
                    traceId: "test",
                  },
                  { status: 409 },
                );
              }
              preference = personal;
            }
            return Response.json(preference);
          });
          yield* AtomRegistry.mount(h.registry, h.view);
          yield* read(h);
          yield* Effect.promise(() => h.controls.setCodexPreference.run(h.registry, args));
          yield* read(h);
          expect(h.registry.get(h.view).phase).toBe("unknown");
          const result = yield* Effect.promise(() =>
            h.controls.setCodexPreference.run(h.registry, {
              ...args,
              selection: { mode: "personal" },
            }),
          );
          yield* read(h);
          expect(result._tag).toBe(winner === "original" ? "Failure" : "Success");
          expect(h.registry.get(h.view)).toMatchObject({
            phase: winner === "original" ? "rejected" : "idle",
            data: winner === "original" ? saved : personal,
            hasRequested: false,
          });
          expect(payloads).toEqual([
            { expectedGeneration: 3, expectedRevision: 0, selection: organization },
            { expectedGeneration: 3, expectedRevision: 0, selection: { mode: "personal" } },
          ]);
        }),
      ),
    );

  it.effect("shows a concurrent choice after a revision conflict without replaying the write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let writes = 0,
          preference = initial;
        const newer = { ...initial, revision: 2, selection: null };
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (!request.url.endsWith("preference")) return Response.json(connection);
          if (request.method === "PUT") {
            writes++;
            preference = newer;
            return Response.json(
              {
                _tag: "RelayTenancyConflictError",
                code: "tenancy_conflict",
                reason: "vm_policy_changed",
                traceId: "test",
              },
              { status: 409 },
            );
          }
          return Response.json(preference);
        });
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        expect(
          (yield* Effect.promise(() => h.controls.setCodexPreference.run(h.registry, args)))._tag,
        ).toBe("Failure");
        yield* read(h);
        expect(h.registry.get(h.view)).toMatchObject({
          phase: "rejected",
          data: newer,
          hasRequested: false,
        });
        expect(h.registry.get(h.view).error).toBeTruthy();
        expect(writes).toBe(1);
      }),
    ),
  );

  it.effect("persists an explicit clear using the exact current revision", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleared = { ...saved, revision: 2, selection: null };
        let selected = false;
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (!request.url.endsWith("preference")) return Response.json(connection);
          if (request.method === "PUT") {
            expect(await request.json()).toEqual({
              expectedGeneration: 3,
              expectedRevision: 1,
              selection: null,
            });
            selected = true;
          }
          return Response.json(selected ? cleared : saved);
        });
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        yield* Effect.promise(() =>
          h.controls.setCodexPreference.run(h.registry, {
            ...args,
            expectedRevision: 1,
            selection: null,
          }),
        );
        expect(h.registry.get(h.view)).toMatchObject({
          phase: "idle",
          data: cleared,
          hasRequested: false,
        });
      }),
    ),
  );

  for (const changed of ["session", "generation"] as const)
    it.effect(`ignores a save reply after the ${changed} changes`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = Promise.withResolvers<void>(),
            reply = Promise.withResolvers<Response>();
          yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve(Response.json(saved))));
          let generation = 3;
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (!request.url.endsWith("preference")) return Response.json(connection);
            if (request.method === "PUT") {
              started.resolve();
              return reply.promise;
            }
            return Response.json({ ...initial, generation });
          });
          yield* AtomRegistry.mount(h.registry, h.view);
          yield* read(h);
          const command = h.controls.setCodexPreference.run(h.registry, args);
          yield* Effect.promise(() => started.promise);
          if (changed === "session")
            h.registry.set(managedRelaySessionAtom, {
              accountId: "owner",
              readClerkToken: () => Effect.succeed("new-token"),
            });
          else {
            generation = 4;
            h.registry.set(h.routeAtom, { relayUrl, generation, phase: "active" });
          }
          yield* read(h);
          expect(h.registry.get(h.view).phase).toBe("idle");
          reply.resolve(Response.json(saved));
          yield* Effect.promise(() => command);
          expect(h.registry.get(h.view).data?.selection).toEqual(initial.selection);
          expect(h.registry.get(h.view).data?.generation).toBe(generation);
        }),
      ),
    );

  it.effect("does not edit a read-only placement or trust unavailable connection metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const methods: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          methods.push(request.method);
          return request.url.endsWith("preference")
            ? Response.json({ ...saved, editable: false })
            : new Response(null, { status: 503 });
        });
        yield* AtomRegistry.mount(h.registry, h.view);
        yield* read(h);
        expect(h.registry.get(h.view)).toMatchObject({
          data: { ...saved, editable: false },
          connection: null,
        });
        expect(h.registry.get(h.view).error).toBeTruthy();
        expect(
          (yield* Effect.promise(() =>
            h.controls.setCodexPreference.run(h.registry, { ...args, expectedRevision: 1 }),
          ))._tag,
        ).toBe("Failure");
        expect(methods.every((method) => method === "GET")).toBe(true);
        expect(h.registry.get(h.view).phase).toBe("rejected");
        expect(h.registry.get(h.view).error).toContain("Refresh before saving");
      }),
    ),
  );
});
