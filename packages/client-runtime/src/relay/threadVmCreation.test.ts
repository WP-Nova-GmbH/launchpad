import { describe, expect, it } from "@effect/vitest";
import { RelayThreadVmCreateRequest } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createThreadVmCreationAtoms, createThreadVmCreationJournal } from "./threadVmCreation.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";

const request = Schema.decodeUnknownSync(RelayThreadVmCreateRequest)({
  allocationId: "allocation-original",
  threadId: "thread-original",
  organizationId: "org",
  repositoryId: "repo",
  canonicalKey: "github.com/team/repo",
  branch: "main",
  revision: "a".repeat(40),
  initialState: {
    title: "Private work",
    modelSelection: { instanceId: "codex", model: "test" },
    createdAt: "2026-10-08T00:00:00Z",
  },
});
const scope = { accountId: "owner", relayUrl: "https://relay.example.test" };
const accepted = {
  status: "accepted" as const,
  setup: {
    ...request,
    ownerUserId: "owner",
    phase: "pending" as const,
    environmentId: null,
    errorCode: null,
    receiptSha256: null,
  },
};
const quota = {
  status: "quota_reached" as const,
  maxVms: 3,
  reservedVms: 3,
  suggestedReplacement: null,
  replacement: {
    requestId: request.allocationId,
    threadId: request.threadId,
    phase: "awaiting_choice" as const,
    victimAllocationId: null,
    errorCode: null,
  },
};
function storage() {
  const data = new Map<string, string>(),
    locks = new Map<string, Promise<unknown>>();
  const store: ThreadMoveSubmissionStorage = {
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
    withLock: (key, run) => {
      const result = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
      locks.set(key, result);
      return result;
    },
  };
  return store;
}
const harness = Effect.fnUntraced(function* (fetchFn: typeof fetch, relayUrl = scope.relayUrl) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const session = { accountId: "owner", readClerkToken: () => Effect.succeed("test-token") };
  registry.set(managedRelaySessionAtom, session);
  const creation = createThreadVmCreationAtoms(
    Atom.runtime(tenancyLayer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn)))),
  );
  return { registry, session, creation };
});
describe("durable new VM thread creation", () => {
  it("retains the original request after restart and concurrent forms", async () => {
    const disk = storage(),
      one = createThreadVmCreationJournal(disk),
      two = createThreadVmCreationJournal(disk);
    const replies = await Promise.all([
      one.prepare(scope, request),
      two.prepare(scope, { ...request, allocationId: "another", branch: "other" }),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    expect((await createThreadVmCreationJournal(disk).read(scope))?.request).toEqual(request);
    await expect(one.finish(scope, request.allocationId)).rejects.toThrow("uncertain");
    expect(await one.read({ ...scope, accountId: "someone-else" })).toBeNull();
    expect(await one.read({ ...scope, relayUrl: "https://another.example.test" })).toBeNull();
  });
  it("hands an acknowledged creation to the relay before allowing another draft", async () => {
    const journal = createThreadVmCreationJournal(storage());
    await journal.prepare(scope, request);
    await journal.acknowledge(scope, request, accepted);
    await journal.finish(scope, request.allocationId);
    expect(await journal.read(scope)).toBeNull();
  });
  it("retains a quota request until cancellation is confirmed", async () => {
    const journal = createThreadVmCreationJournal(storage());
    await journal.prepare(scope, request);
    await journal.acknowledge(scope, request, quota);
    await expect(journal.finish(scope, request.allocationId)).rejects.toThrow("uncertain");
    await expect(journal.finish(scope, request.allocationId, "wrong-request")).rejects.toThrow(
      "uncertain",
    );
    expect((await journal.read(scope))?.response).toEqual(quota);
    await journal.finish(scope, request.allocationId, request.allocationId);
    expect(await journal.read(scope)).toBeNull();
  });
  it("rejects mismatched acknowledgements and malformed saved data", async () => {
    const disk = storage(),
      journal = createThreadVmCreationJournal(disk);
    await journal.prepare(scope, request);
    await expect(
      journal.acknowledge(scope, request, {
        ...accepted,
        setup: { ...accepted.setup, allocationId: "wrong" },
      }),
    ).rejects.toThrow("different");
    await expect(
      journal.acknowledge(scope, request, {
        ...quota,
        replacement: {
          ...quota.replacement,
          threadId: (accepted.setup.threadId + "-other") as typeof request.threadId,
        },
      }),
    ).rejects.toThrow("retain");
    const corrupt = createThreadVmCreationJournal({ ...disk, read: async () => "{broken" });
    await expect(corrupt.prepare(scope, request)).rejects.toThrow();
    expect((await journal.read(scope))?.response).toBeNull();
  });
  it.effect("creates via the authenticated relay without an environment connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const received = new Request(url, init);
          calls.push(received.method + " " + new URL(received.url).pathname);
          expect(received.headers.get("authorization")).toBe("Bearer test-token");
          expect(await received.json()).toEqual(request);
          return Response.json(accepted);
        });
        const reply = yield* Effect.promise(() =>
          h.creation.create.run(h.registry, { accountId: "owner", request }),
        );
        expect(reply._tag).toBe("Success");
        expect(calls).toEqual(["POST /v1/thread-vms"]);
      }),
    ),
  );
  it.effect("does not send another account's saved creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let tokens = 0;
        const h = yield* harness(async () => {
          throw new Error("No network allowed");
        });
        h.registry.set(managedRelaySessionAtom, {
          accountId: "different",
          readClerkToken: () => {
            tokens++;
            return Effect.succeed("secret");
          },
        });
        const reply = yield* Effect.promise(() =>
          h.creation.create.run(h.registry, { accountId: "owner", request }),
        );
        expect(reply._tag).toBe("Failure");
        expect(tokens).toBe(0);
      }),
    ),
  );
  it.effect("discards an account-changed response while retaining a retryable journal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const journal = createThreadVmCreationJournal(storage());
        yield* Effect.promise(() => journal.prepare(scope, request));
        const h = yield* harness(async () => {
          entered.resolve();
          await release.promise;
          return Response.json(accepted);
        });
        const running = yield* Effect.forkChild(
          Effect.promise(() => h.creation.create.run(h.registry, { accountId: "owner", request })),
        );
        yield* Effect.promise(() => entered.promise);
        h.registry.set(managedRelaySessionAtom, null);
        release.resolve();
        expect((yield* Fiber.join(running))._tag).toBe("Failure");
        expect((yield* Effect.promise(() => journal.read(scope)))?.request).toEqual(request);
      }),
    ),
  );
  it.effect("returns quota choices without selecting or deleting a VM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const received = new Request(url, init),
            path = new URL(received.url).pathname;
          calls.push(received.method + " " + path);
          return Response.json(
            path.endsWith("/candidates")
              ? [
                  {
                    allocationId: "victim",
                    threadId: "other-thread",
                    state: "paused",
                    title: "Other work",
                  },
                ]
              : quota.replacement,
          );
        });
        const reply = yield* Effect.promise(() =>
          h.creation.replacement.run(h.registry, {
            accountId: "owner",
            requestId: request.allocationId,
            action: "read",
          }),
        );
        expect(reply._tag).toBe("Success");
        expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
      }),
    ),
  );
});
