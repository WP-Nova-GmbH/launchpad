import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  CommandId,
  MessageId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type ThreadPromptQueue,
  type ProviderAuthState,
} from "@t3tools/contracts";
import type {
  RelayThreadVmProviderAuth,
  RelayThreadVmProviderAuthBinding,
} from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  createThreadVmControlAtoms,
  withPortableThreadDeletion,
  threadVmProviderAuthPresentation,
} from "./threadVmControls.ts";
import {
  portableThreadClientRouteAtom,
  createPortableThreadLibraryAtoms,
  verifyPortableThreadClientRoute,
} from "./portableThreadLibrary.ts";
import { createThreadVmActionJournal } from "./threadVmActionSubmission.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";

const environmentId = EnvironmentId.make("retired-environment"),
  threadId = ThreadId.make("vm-thread"),
  relayUrl = "https://relay.example.test",
  at = "2026-10-07T00:00:00Z";
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: at,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "VM",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      relayRouting: { relayUrl, generation: 1, phase: "retired" },
    },
  ],
};
const status = {
  threadId,
  generation: 1,
  allocation: null,
  setupPhase: null,
  capacityState: null,
  activity: "unknown",
  pausePhase: null,
  resumePhase: null,
  backupPhase: null,
  lastVerifiedBackupAt: null,
  savedDisk: {
    operationId: "saved",
    phase: "available",
    savedAt: at,
    expiresAt: "2026-11-07T00:00:00Z",
  },
};
const authBinding: RelayThreadVmProviderAuthBinding = {
  operationId: "move-auth",
  allocationId: "fresh-vm",
  environmentId: EnvironmentId.make("next-vm"),
  generation: 2,
  instanceId: "codex",
};
const idleAuth: ProviderAuthState = {
  instanceId: ProviderInstanceId.make("codex"),
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  interaction: null,
};
const waitingAuth: RelayThreadVmProviderAuth = {
  ...authBinding,
  requirement: "sign_in_required",
  auth: {
    ...idleAuth,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://chatgpt.com/activate",
    interaction: {
      type: "deviceCode",
      id: "interaction-1",
      url: "https://chatgpt.com/activate",
      userCode: "TEST-1234",
    },
  },
};
const pendingVmStatus = {
  ...status,
  allocation: null,
  savedDisk: null,
  pendingProviderAuth: authBinding,
};

describe("pending VM Codex sign-in presentation", () => {
  it("shows a device code only for the active official sign-in flow", () => {
    expect(threadVmProviderAuthPresentation(waitingAuth)).toMatchObject({
      url: "https://chatgpt.com/activate",
      userCode: "TEST-1234",
      canCancel: true,
      canStart: false,
    });
    const unsafe = {
      ...waitingAuth,
      auth: {
        ...waitingAuth.auth,
        interaction: {
          ...waitingAuth.auth.interaction!,
          type: "deviceCode" as const,
          id: "unsafe",
          userCode: "TEST-1234",
          url: "https://chatgpt.com.evil.test/activate",
        },
      },
    };
    expect(threadVmProviderAuthPresentation(unsafe)).toMatchObject({ url: null, userCode: null });
  });
  it("clears old codes after completion or cancellation and offers a new sign-in after cancellation", () => {
    expect(
      threadVmProviderAuthPresentation({ ...waitingAuth, requirement: "authenticated" }),
    ).toMatchObject({
      title: "Codex signed in",
      url: null,
      userCode: null,
      canStart: false,
      canCancel: false,
    });
    expect(
      threadVmProviderAuthPresentation({
        ...waitingAuth,
        auth: { ...waitingAuth.auth, phase: "cancelled" },
      }),
    ).toMatchObject({
      url: null,
      userCode: null,
      canStart: true,
      canCancel: false,
      startLabel: "Retry Codex sign-in",
    });
  });
  it("shows an unsupported runner reason without offering an ineffective sign-in", () => {
    expect(
      threadVmProviderAuthPresentation({
        ...waitingAuth,
        requirement: "provider_unavailable",
        auth: {
          ...idleAuth,
          phase: "failed",
          message: "Update the runner to the supported Codex version.",
        },
      }),
    ).toMatchObject({
      title: "Codex needs attention",
      message: "Update the runner to the supported Codex version.",
      canStart: false,
    });
  });
});
const harness = Effect.fnUntraced(function* (
  fetchFn: typeof fetch,
  source = snapshot,
  archived: Atom.Atom<AsyncResult.AsyncResult<OrchestrationShellSnapshot, never>> | null = null,
  detail: Atom.Atom<Pick<OrchestrationThread, "promptQueue"> | null> | null = null,
) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(managedRelaySessionAtom, {
    accountId: "owner",
    readClerkToken: () => Effect.succeed("owner-token"),
  });
  const controls = createThreadVmControlAtoms(
    Atom.runtime(tenancyLayer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn)))),
    () => Atom.make(source),
    undefined,
    archived ? () => archived : undefined,
    detail ? () => detail : undefined,
  );
  const query = controls.queryAtom(environmentId, threadId);
  return { registry, controls, query };
});

describe("VM host availability", () => {
  it.effect(
    "uses the relay capability without signing in and treats older relays as unconfigured",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const configured of [true, false, undefined]) {
            let requests = 0;
            const h = yield* harness(async (url, init) => {
              const request = new Request(url, init);
              expect(request.url).toBe(`${relayUrl}/health`);
              expect(request.method).toBe("GET");
              expect(request.headers.get("authorization")).toBeNull();
              requests++;
              return Response.json({ ok: true, service: "relay", threadVmConfigured: configured });
            });
            h.registry.set(managedRelaySessionAtom, null);
            const query = h.controls.hostConfigurationQueryAtom,
              view = h.controls.hostConfigurationAtom;
            yield* AtomRegistry.mount(h.registry, view);
            expect(
              yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }),
            ).toBe(configured === true);
            const expected = configured === true ? null : "VM host not configured";
            expect(h.registry.get(view).unavailableReason).toBe(expected);
            expect(h.registry.get(view).unavailableReason).toBe(expected);
            expect(requests).toBe(1);
          }
        }),
      ),
  );

  it.effect("disables new VM moves during refresh and reflects changed relay configuration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = Promise.withResolvers<Response>();
        let requests = 0;
        const h = yield* harness(async () => {
          requests++;
          return requests === 1
            ? Response.json({ ok: true, service: "relay", threadVmConfigured: true })
            : response.promise;
        });
        const query = h.controls.hostConfigurationQueryAtom,
          view = h.controls.hostConfigurationAtom;
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view).unavailableReason).toBeNull();
        h.registry.refresh(query);
        expect(h.registry.get(view).unavailableReason).toBe("Checking VM host…");
        response.resolve(Response.json({ ok: true, service: "relay", threadVmConfigured: false }));
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view).unavailableReason).toBe("VM host not configured");
        expect(requests).toBe(2);
      }),
    ),
  );

  it.effect("distinguishes a failed capability check from an unconfigured host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const reply of [
          () => Response.json({ error: "unavailable" }, { status: 503 }),
          () => Response.json({ ok: true, service: "relay", threadVmConfigured: "true" }),
        ]) {
          const h = yield* harness(async () => reply());
          const query = h.controls.hostConfigurationQueryAtom,
            view = h.controls.hostConfigurationAtom;
          yield* AtomRegistry.mount(h.registry, view);
          const result = yield* Effect.result(
            AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }),
          );
          expect(result._tag).toBe("Failure");
          expect(h.registry.get(view).unavailableReason).toBe(
            "Could not check VM host. Reopen Run on to retry.",
          );
        }
      }),
    ),
  );
});

const guestSnapshot: OrchestrationShellSnapshot = {
  ...snapshot,
  threads: snapshot.threads.map((thread) => ({
    ...thread,
    relayRouting: {
      relayUrl: "https://guest-relay.example.test",
      generation: 1,
      phase: "active",
    },
  })),
};
const currentPlacement = {
  threadId,
  organizationId: "org",
  repositoryId: "repo",
  ownerUserId: "owner",
  environmentId,
  projectId: "project",
  generation: 1,
  operationId: null,
};

describe("cold VM relay transport bootstrap", () => {
  it.effect(
    "opens a deep link with one exact placement read and no library dialog or VM wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init),
              path = new URL(request.url).pathname;
            expect(new URL(request.url).origin).toBe(relayUrl);
            expect(request.method).toBe("GET");
            expect(request.headers.get("authorization")).toBe("Bearer owner-token");
            calls.push(path);
            return Response.json(path.endsWith("/placement") ? currentPlacement : status);
          }, guestSnapshot);
          yield* AtomRegistry.mount(h.registry, h.query);
          expect(
            (yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }))
              ?.status,
          ).toEqual(status);
          expect(h.registry.get(h.controls.routeAtom(environmentId, threadId))).toEqual({
            relayUrl,
            generation: 1,
            phase: "active",
          });
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(45_000));
          expect(calls.filter((path) => path.endsWith("/placement"))).toHaveLength(1);
          expect(calls.filter((path) => path.endsWith("/vm-status")).length).toBeGreaterThan(1);
        }),
      ),
  );

  it.effect(
    "denies an owner, generation or thread mismatch without retrying on status refresh",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const placement of [
            { ...currentPlacement, environmentId: "another-owner" },
            { ...currentPlacement, generation: 2 },
            { ...currentPlacement, threadId: "another-thread" },
          ]) {
            let reads = 0;
            const h = yield* harness(async (url) => {
              expect(new URL(String(url)).pathname.endsWith("/placement")).toBe(true);
              reads++;
              return Response.json(placement);
            }, guestSnapshot);
            for (let retry = 0; retry < 2; retry++) {
              h.registry.refresh(h.query);
              expect(
                (yield* Effect.result(
                  AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }),
                ))._tag,
              ).toBe("Failure");
            }
            expect(reads).toBe(1);
            expect(
              h.registry.get(portableThreadClientRouteAtom(environmentId, threadId)),
            ).toBeNull();
          }
        }),
      ),
  );
  it.effect(
    "retries a transient placement failure only after the selected thread's explicit Retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          let placements = 0;
          const h = yield* harness(async (url) => {
            if (String(url).endsWith("/placement")) {
              placements++;
              return placements === 1
                ? Response.json({ error: "Temporarily unavailable" }, { status: 503 })
                : Response.json(currentPlacement);
            }
            return Response.json(status);
          }, guestSnapshot);
          yield* AtomRegistry.mount(h.registry, h.query);
          expect(
            (yield* Effect.result(
              AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }),
            ))._tag,
          ).toBe("Failure");
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(45_000));
          expect(placements).toBe(1);
          h.controls.refresh(h.registry, environmentId, threadId);
          expect(
            (yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }))
              ?.status,
          ).toEqual(status);
          expect(placements).toBe(2);
        }),
      ),
  );

  it.effect(
    "verifies a new configured relay after a successful proof from the previous relay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          registry.set(managedRelaySessionAtom, {
            accountId: "owner",
            readClerkToken: () => Effect.succeed("owner-token"),
          });
          const configured = Atom.make(relayUrl),
            calls: string[] = [];
          const fetchFn: typeof fetch = async (url, init) => {
            const request = new Request(url, init),
              path = new URL(request.url).pathname;
            expect(request.method).toBe("GET");
            calls.push(new URL(request.url).origin + path);
            if (path.endsWith("/portable"))
              return Response.json({
                entries: [
                  {
                    title: "VM",
                    modelSelection: snapshot.threads[0]!.modelSelection,
                    createdAt: at,
                    updatedAt: at,
                    placement: currentPlacement,
                  },
                ],
                next: null,
              });
            return Response.json(path.endsWith("/placement") ? currentPlacement : status);
          };
          const runtime = Atom.runtime((get) =>
              tenancyLayer({ relayUrl: get(configured) }).pipe(
                Layer.provide(remoteHttpClientLayer(fetchFn)),
              ),
            ),
            library = createPortableThreadLibraryAtoms(runtime),
            controls = createThreadVmControlAtoms(runtime, () => Atom.make(guestSnapshot)),
            query = controls.queryAtom(environmentId, threadId);
          expect((yield* Effect.promise(() => library.loadIndex.run(registry, {})))._tag).toBe(
            "Success",
          );
          yield* AtomRegistry.mount(registry, query);
          yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
          registry.set(configured, "https://other-relay.example.test");
          expect(
            (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }))?.status,
          ).toEqual(status);
          expect(registry.get(controls.routeAtom(environmentId, threadId))?.relayUrl).toBe(
            "https://other-relay.example.test",
          );
          expect(calls.filter((call) => call.endsWith("/placement"))).toEqual([
            "https://other-relay.example.test/v1/threads/vm-thread/placement",
          ]);
        }),
      ),
  );

  it.effect("keeps a newer placement proof when an older generation's read completes later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const session = { accountId: "owner", readClerkToken: () => Effect.succeed("owner-token") };
        registry.set(managedRelaySessionAtom, session);
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let reads = 0;
        const relay = tenancyLayer({ relayUrl }).pipe(
          Layer.provide(
            remoteHttpClientLayer(async () => {
              if (++reads === 1) {
                requested.resolve();
                await release.promise;
                return Response.json(currentPlacement);
              }
              return Response.json({ ...currentPlacement, generation: 2 });
            }),
          ),
        );
        const older = yield* verifyPortableThreadClientRoute(registry, {
          environmentId,
          threadId,
          generation: 1,
          session,
        }).pipe(Effect.provide(relay), Effect.forkChild);
        yield* Effect.promise(() => requested.promise);
        yield* verifyPortableThreadClientRoute(registry, {
          environmentId,
          threadId,
          generation: 2,
          session,
        }).pipe(Effect.provide(relay));
        release.resolve();
        yield* Fiber.join(older);
        expect(
          registry.get(portableThreadClientRouteAtom(environmentId, threadId))?.generation,
        ).toBe(2);
      }),
    ),
  );

  it.effect("discards an in-flight proof after the session or configured relay changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const change of ["session", "relay"] as const) {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const session = {
            accountId: "owner",
            readClerkToken: () => Effect.succeed("owner-token"),
          };
          registry.set(managedRelaySessionAtom, session);
          const configured = Atom.make(relayUrl),
            requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>(),
            calls: string[] = [];
          const fetchFn: typeof fetch = async (url, init) => {
            const request = new Request(url, init);
            expect(request.method).toBe("GET");
            expect(new URL(request.url).pathname.endsWith("/placement")).toBe(true);
            calls.push(new URL(request.url).origin);
            if (calls.length > 1)
              return Response.json({ error: "No matching placement" }, { status: 403 });
            requested.resolve();
            await release.promise;
            return Response.json(currentPlacement);
          };
          const controls = createThreadVmControlAtoms(
              Atom.runtime((get) =>
                tenancyLayer({ relayUrl: get(configured) }).pipe(
                  Layer.provide(remoteHttpClientLayer(fetchFn)),
                ),
              ),
              () => Atom.make(guestSnapshot),
            ),
            query = controls.queryAtom(environmentId, threadId);
          const pending = yield* AtomRegistry.getResult(registry, query, {
            suspendOnWaiting: true,
          }).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => requested.promise);
          if (change === "session") registry.set(managedRelaySessionAtom, { ...session });
          else registry.set(configured, "https://other-relay.example.test");
          release.resolve();
          expect((yield* Fiber.join(pending))._tag).toBe("Failure");
          expect(registry.get(portableThreadClientRouteAtom(environmentId, threadId))).toBeNull();
          expect(calls).toEqual([
            relayUrl,
            change === "relay" ? "https://other-relay.example.test" : relayUrl,
          ]);
        }
      }),
    ),
  );
});

describe("completed thread location handoff", () => {
  const placement = {
    threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "owner",
    environmentId,
    projectId: "project",
    generation: 1,
    operationId: "moving",
  };
  const activeSnapshot: OrchestrationShellSnapshot = {
    ...snapshot,
    threads: [
      { ...snapshot.threads[0]!, relayRouting: { relayUrl, generation: 1, phase: "active" } },
    ],
  };
  const checkInput = { environmentId, threadId, accountId: "owner", relayUrl };

  it.effect("shows a pending move failure and keeps polling until it clears and completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const detail = "Codex could not resume the transferred conversation: incompatible history.";
        let reads = 0;
        const h = yield* harness(async () => {
          reads++;
          return Response.json(
            reads < 3
              ? { ...placement, moveFailureDetail: reads === 1 ? detail : null }
              : {
                  ...placement,
                  environmentId: "mac",
                  generation: 2,
                  operationId: null,
                  moveFailureDetail: "An old failure must not follow a completed move.",
                },
          );
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view)).toMatchObject({
          movePending: true,
          error: null,
          moveFailureDetail: detail,
          placement: { operationId: placement.operationId },
        });
        expect(
          h.registry.get(h.controls.confirmedLocationAtom(environmentId, threadId)),
        ).toMatchObject({ operationId: placement.operationId });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(reads).toBe(2);
        expect(h.registry.get(view)).toMatchObject({
          movePending: true,
          error: null,
          moveFailureDetail: null,
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(reads).toBe(3);
        expect(h.registry.get(view)).toMatchObject({
          movePending: false,
          moveFailureDetail: null,
          destination: { environmentId: "mac", generation: 2 },
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
        expect(reads).toBe(3);
      }),
    ),
  );

  it.effect("hides a failure belonging to another claimed move", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue: ThreadPromptQueue = {
          enabled: true,
          revision: 1,
          pauseReason: null,
          handoff: null,
          awaitingTurnId: null,
          admissions: [],
          finalizedTurnId: null,
          entries: [
            {
              kind: "move",
              state: "moving",
              operationId: CommandId.make("new-move"),
              messageId: MessageId.make("new-move-entry"),
              destination: { kind: "vm" },
              revision: 1,
              acceptedSequence: 1,
              createdAt: at,
            },
          ],
        };
        const h = yield* harness(
          async () => Response.json({ ...placement, moveFailureDetail: "Old move failed." }),
          activeSnapshot,
          null,
          Atom.make<Pick<OrchestrationThread, "promptQueue"> | null>({ promptQueue: queue }),
        );
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(
          h.registry,
          h.controls.locationQueryAtom(environmentId, threadId),
          {
            suspendOnWaiting: true,
          },
        );
        expect(h.registry.get(view)).toMatchObject({ movePending: true, moveFailureDetail: null });
      }),
    ),
  );

  it.effect("hides a cached move failure as soon as the signed-in account changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = Promise.withResolvers<void>();
        let reads = 0;
        const h = yield* harness(async () => {
          if (++reads > 1) await release.promise;
          return Response.json({ ...placement, moveFailureDetail: "Private move failure." });
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.moveFailureDetail).toBe("Private move failure.");
        h.registry.set(managedRelaySessionAtom, {
          accountId: "other",
          readClerkToken: () => Effect.succeed("other-token"),
        });
        expect(h.registry.get(view)?.moveFailureDetail ?? null).toBeNull();
        release.resolve();
      }),
    ),
  );

  it.effect(
    "confirms cancellation after the claimed queue move disappears, then stops tracking",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          const queue: ThreadPromptQueue = {
            enabled: true,
            revision: 1,
            pauseReason: null,
            handoff: null,
            awaitingTurnId: null,
            admissions: [],
            finalizedTurnId: null,
            entries: [
              {
                kind: "move",
                state: "cancelling",
                operationId: CommandId.make(placement.operationId),
                messageId: MessageId.make("cancelled-move"),
                destination: { kind: "vm" },
                revision: 1,
                acceptedSequence: 1,
                createdAt: at,
              },
            ],
          };
          for (const outcome of ["stable", "pending", "denied"] as const) {
            let cancelled = false,
              reads = 0;
            const detail = Atom.make<Pick<OrchestrationThread, "promptQueue"> | null>({
              promptQueue: queue,
            });
            const h = yield* harness(
              async () => {
                reads++;
                if (cancelled && reads === 3 && outcome === "denied")
                  return Response.json({ error: "Access removed" }, { status: 403 });
                const pending = !cancelled || (reads === 3 && outcome === "pending");
                return Response.json({
                  ...placement,
                  operationId: pending ? placement.operationId : null,
                });
              },
              activeSnapshot,
              null,
              detail,
            );
            const view = h.controls.locationViewAtom(environmentId, threadId),
              query = h.controls.locationQueryAtom(environmentId, threadId);
            yield* AtomRegistry.mount(h.registry, view);
            yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
            yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
            expect(h.registry.get(view)?.movePending).toBe(true);
            cancelled = true;
            h.registry.set(detail, { promptQueue: { ...queue, revision: 2, entries: [] } });
            yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }).pipe(
              Effect.result,
            );
            expect(reads).toBe(3);
            if (outcome === "pending") {
              expect(h.registry.get(view)?.movePending).toBe(true);
              yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
              expect(reads).toBe(4);
            } else if (outcome === "denied") {
              expect(h.registry.get(view)?.error).toBeTruthy();
              expect(h.registry.get(view)?.movePending).toBe(false);
              yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
              expect(reads).toBe(3);
              yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
              expect(reads).toBe(4);
            }
            expect(h.registry.get(view)).toBeNull();
            expect(
              h.registry.get(h.controls.confirmedLocationAtom(environmentId, threadId))
                ?.operationId,
            ).toBeNull();
            const finalReads = reads;
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
            expect(reads).toBe(finalReads);
          }
        }),
      ),
  );

  it.effect("keeps tracking a move when an explicit check supersedes the automatic lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let reads = 0;
        const destination = {
          ...placement,
          environmentId: "mac",
          generation: 2,
          operationId: null,
        };
        const h = yield* harness(async () => {
          const request = ++reads;
          if (request === 1) {
            requested.resolve();
            await release.promise;
          }
          return Response.json(
            request === 1
              ? placement
              : request === 2
                ? { ...destination, operationId: "activating" }
                : destination,
          );
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* Effect.promise(() => requested.promise);
        expect(
          (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))._tag,
        ).toBe("Success");
        release.resolve();
        expect(
          (yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(h.registry.get(view)).toMatchObject({ movePending: true, error: null });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(reads).toBe(3);
        expect(h.registry.get(view)?.destination).toEqual({
          environmentId: "mac",
          threadId,
          generation: 2,
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(4_000));
        expect(reads).toBe(3);
      }),
    ),
  );

  it.effect("publishes explicit recovery after the cached active source misses cutover", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const destination = {
          ...placement,
          environmentId: "mac",
          generation: 2,
          operationId: null,
        };
        const h = yield* harness(async () => {
          reads++;
          return Response.json(destination);
        }, activeSnapshot);
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        expect(h.registry.get(view)).toBeNull();
        expect(
          (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))._tag,
        ).toBe("Success");
        expect(h.registry.get(view)).toMatchObject({
          recoveryRequested: true,
          destination: { environmentId: "mac", threadId, generation: 2 },
          placement: destination,
        });
        expect(
          h.registry.get(h.controls.confirmedLocationAtom(EnvironmentId.make("mac"), threadId)),
        ).toEqual(destination);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
        expect(reads).toBe(1);
      }),
    ),
  );

  it.effect(
    "rechecks pending recovery and accepts ready and new operations at the same generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let reads = 0;
          const h = yield* harness(
            async () =>
              Response.json({
                ...placement,
                environmentId: "mac",
                generation: 2,
                operationId: ++reads === 2 ? null : `move-${reads}`,
              }),
            activeSnapshot,
          );
          const view = h.controls.locationViewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          for (const pending of [true, false, true]) {
            expect(
              (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))
                ._tag,
            ).toBe("Success");
            expect(h.registry.get(view)).toMatchObject({
              recoveryRequested: true,
              movePending: pending,
            });
            expect(h.registry.get(view)?.destination?.generation ?? null).toBe(pending ? null : 2);
          }
          expect(reads).toBe(3);
        }),
      ),
  );

  it.effect("does not let an older pending response replace a newer ready response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let reads = 0;
        const h = yield* harness(async () => {
          if (++reads === 1) {
            requested.resolve();
            await release.promise;
            return Response.json({ ...placement, environmentId: "mac", generation: 2 });
          }
          return Response.json({
            ...placement,
            environmentId: "mac",
            generation: 2,
            operationId: null,
          });
        }, activeSnapshot);
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        const older = h.controls.checkLocation.run(h.registry, checkInput);
        yield* Effect.promise(() => requested.promise);
        expect(
          (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))._tag,
        ).toBe("Success");
        release.resolve();
        expect((yield* Effect.promise(() => older))._tag).toBe("Failure");
        expect(h.registry.get(view)).toMatchObject({
          movePending: false,
          destination: { generation: 2 },
        });
      }),
    ),
  );

  it.effect("ignores a later lower generation without replacing the confirmed destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const h = yield* harness(
          async () =>
            Response.json({
              ...placement,
              environmentId: "mac",
              generation: ++reads === 1 ? 3 : 2,
              operationId: null,
            }),
          activeSnapshot,
        );
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
        expect(
          (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))._tag,
        ).toBe("Failure");
        expect(h.registry.get(view)?.destination?.generation).toBe(3);
      }),
    ),
  );

  it.effect(
    "clears successful recovery after access is removed and permits an explicit retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          let reads = 0;
          const h = yield* harness(
            async () =>
              ++reads === 2
                ? Response.json({ error: "Access removed" }, { status: 403 })
                : Response.json({
                    ...placement,
                    environmentId: "mac",
                    generation: reads + 1,
                    operationId: null,
                  }),
            activeSnapshot,
          );
          const view = h.controls.locationViewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
          expect(h.registry.get(view)?.destination?.generation).toBe(2);
          expect(
            (yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput)))
              ._tag,
          ).toBe("Failure");
          expect(h.registry.get(view)?.error).toBeTruthy();
          expect(h.registry.get(view)?.destination).toBeNull();
          expect(
            h.registry.get(h.controls.confirmedLocationAtom(environmentId, threadId)),
          ).toBeNull();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
          expect(reads).toBe(2);
          yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
          expect(h.registry.get(view)?.destination?.generation).toBe(4);
        }),
      ),
  );

  it.effect("hides successful recovery once the current active location is confirmed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(
          async () => Response.json({ ...placement, operationId: null }),
          activeSnapshot,
        );
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
        expect(h.registry.get(view)).toBeNull();
        expect(
          h.registry.get(h.controls.confirmedLocationAtom(environmentId, threadId))?.environmentId,
        ).toBe(environmentId);
      }),
    ),
  );

  it.effect("discards explicit recovery when the signed-in session changes while loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const h = yield* harness(async () => {
          requested.resolve();
          await release.promise;
          return Response.json({
            ...placement,
            environmentId: "mac",
            generation: 2,
            operationId: null,
          });
        }, activeSnapshot);
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        const pending = h.controls.checkLocation.run(h.registry, checkInput);
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, {
          accountId: "other",
          readClerkToken: () => Effect.succeed("other-token"),
        });
        release.resolve();
        expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
        expect(h.registry.get(view)).toBeNull();
        expect(
          h.registry.get(h.controls.confirmedLocationAtom(environmentId, threadId)),
        ).toBeNull();
      }),
    ),
  );

  it.effect("keeps an explicit result when an older automatic lookup completes later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let reads = 0;
        const h = yield* harness(async () => {
          if (++reads === 1) {
            requested.resolve();
            await release.promise;
            return Response.json(placement);
          }
          return Response.json({
            ...placement,
            environmentId: "mac",
            generation: 3,
            operationId: null,
          });
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        const automatic = yield* AtomRegistry.getResult(h.registry, query, {
          suspendOnWaiting: true,
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        yield* Effect.promise(() => h.controls.checkLocation.run(h.registry, checkInput));
        release.resolve();
        yield* Fiber.join(automatic);
        expect(h.registry.get(view)).toMatchObject({ error: null, destination: { generation: 3 } });
      }),
    ),
  );

  it.effect(
    "invalidates a successful location and late checks when the configured relay changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          registry.set(managedRelaySessionAtom, {
            accountId: "owner",
            readClerkToken: () => Effect.succeed("owner-token"),
          });
          const configured = Atom.make(relayUrl),
            source = Atom.make(activeSnapshot),
            requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          let reads = 0;
          const controls = createThreadVmControlAtoms(
            Atom.runtime((get) =>
              tenancyLayer({ relayUrl: get(configured) }).pipe(
                Layer.provide(
                  remoteHttpClientLayer(async () => {
                    if (++reads === 2) {
                      requested.resolve();
                      await release.promise;
                    }
                    return Response.json({
                      ...placement,
                      environmentId: "mac",
                      generation: 2,
                      operationId: null,
                    });
                  }),
                ),
              ),
            ),
            () => source,
          );
          const view = controls.locationViewAtom(environmentId, threadId),
            confirmed = controls.confirmedLocationAtom(environmentId, threadId);
          yield* AtomRegistry.mount(registry, view);
          yield* Effect.promise(() => controls.checkLocation.run(registry, checkInput));
          expect(registry.get(confirmed)?.generation).toBe(2);
          const pending = controls.checkLocation.run(registry, checkInput);
          yield* Effect.promise(() => requested.promise);
          registry.set(configured, "https://another-relay.example.test");
          release.resolve();
          expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
          expect(registry.get(confirmed)).toBeNull();
          expect(registry.get(view)).toBeNull();
        }),
      ),
  );

  it.effect(
    "rejects a late recovery after the source route generation changes without leaving it loading",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          registry.set(managedRelaySessionAtom, {
            accountId: "owner",
            readClerkToken: () => Effect.succeed("owner-token"),
          });
          const source = Atom.make(activeSnapshot),
            requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const controls = createThreadVmControlAtoms(
            Atom.runtime(
              tenancyLayer({ relayUrl }).pipe(
                Layer.provide(
                  remoteHttpClientLayer(async () => {
                    requested.resolve();
                    await release.promise;
                    return Response.json({
                      ...placement,
                      environmentId: "mac",
                      generation: 2,
                      operationId: null,
                    });
                  }),
                ),
              ),
            ),
            () => source,
          );
          const view = controls.locationViewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(registry, view);
          const pending = controls.checkLocation.run(registry, checkInput);
          yield* Effect.promise(() => requested.promise);
          registry.set(source, {
            ...activeSnapshot,
            threads: [
              {
                ...activeSnapshot.threads[0]!,
                relayRouting: { relayUrl, generation: 3, phase: "active" },
              },
            ],
          });
          release.resolve();
          expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
          expect(registry.get(view)?.destination).toBeNull();
          expect(registry.get(view)?.isPending).toBe(false);
          expect(registry.get(view)?.error).toBeTruthy();
        }),
      ),
  );

  it.effect("explicit recovery reads fresh placement and rejects another account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const h = yield* harness(async () => {
          reads++;
          return Response.json({ ...placement, generation: reads, operationId: null });
        });
        const input = { environmentId, threadId, accountId: "owner", relayUrl };
        for (const generation of [1, 2]) {
          const result = yield* Effect.promise(() =>
            h.controls.checkLocation.run(h.registry, input),
          );
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") expect(result.value.generation).toBe(generation);
        }
        const denied = yield* Effect.promise(() =>
          h.controls.checkLocation.run(h.registry, { ...input, accountId: "other" }),
        );
        expect(denied._tag).toBe("Failure");
        const changedRelay = yield* Effect.promise(() =>
          h.controls.checkLocation.run(h.registry, {
            ...input,
            relayUrl: "https://another-relay.example.test",
          }),
        );
        expect(changedRelay._tag).toBe("Failure");
        expect(reads).toBe(2);
      }),
    ),
  );
  it.effect("recovers a cold stale route with no source snapshot using one relay read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const h = yield* harness(
          async (url, init) => {
            const request = new Request(url, init);
            expect(request.url).toBe(relayUrl + "/v1/threads/vm-thread/placement");
            expect(request.headers.get("authorization")).toBe("Bearer owner-token");
            reads++;
            return Response.json({
              ...placement,
              environmentId: "mac",
              generation: 3,
              operationId: null,
            });
          },
          { ...snapshot, threads: [] },
        );
        const view = h.controls.locationViewAtom(environmentId, threadId, true),
          query = h.controls.locationQueryAtom(environmentId, threadId, true);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.destination).toEqual({
          environmentId: "mac",
          threadId,
          generation: 3,
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
        expect(reads).toBe(1);
      }),
    ),
  );
  it.effect("a cold pending move or denied lookup waits for explicit retry without polling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        for (const denied of [false, true]) {
          let reads = 0;
          const h = yield* harness(
            async () => {
              reads++;
              return denied
                ? Response.json({ error: "Access removed" }, { status: 403 })
                : Response.json(placement);
            },
            { ...snapshot, threads: [] },
          );
          const view = h.controls.locationViewAtom(environmentId, threadId, true),
            query = h.controls.locationQueryAtom(environmentId, threadId, true);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }).pipe(
            Effect.result,
          );
          expect(h.registry.get(view)?.destination).toBeNull();
          if (denied) expect(h.registry.get(view)?.error).toBeTruthy();
          else expect(h.registry.get(view)?.movePending).toBe(true);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
          expect(reads).toBe(1);
          h.registry.refresh(query);
          yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }).pipe(
            Effect.result,
          );
          expect(reads).toBe(2);
        }
      }),
    ),
  );
  it.effect("ignores a cold route reply when the account changes while it is loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let reads = 0;
        const h = yield* harness(
          async () => {
            reads++;
            requested.resolve();
            await release.promise;
            return Response.json({
              ...placement,
              environmentId: "mac",
              generation: 3,
              operationId: null,
            });
          },
          { ...snapshot, threads: [] },
        );
        h.registry.set(managedRelaySessionAtom, null);
        const view = h.controls.locationViewAtom(environmentId, threadId, true),
          query = h.controls.locationQueryAtom(environmentId, threadId, true);
        yield* AtomRegistry.mount(h.registry, view);
        expect(h.registry.get(view)).toBeNull();
        expect(reads).toBe(0);
        h.registry.set(managedRelaySessionAtom, {
          accountId: "owner",
          readClerkToken: () => Effect.succeed("owner-token"),
        });
        const pending = yield* AtomRegistry.getResult(h.registry, query, {
          suspendOnWaiting: true,
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, null);
        release.resolve();
        yield* Fiber.join(pending);
        expect(h.registry.get(view)).toBeNull();
      }),
    ),
  );
  it.effect(
    "keeps polling a claimed move when its first placement read predates relay admission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          const active = {
            ...snapshot,
            threads: [
              {
                ...snapshot.threads[0]!,
                relayRouting: { relayUrl, generation: 1, phase: "active" as const },
              },
            ],
          };
          for (const state of ["moving", "blocked", "cancelling"] as const) {
            const detail = Atom.make<Pick<OrchestrationThread, "promptQueue"> | null>(null);
            let reads = 0;
            const h = yield* harness(
              async (url) => {
                expect(String(url)).toBe(relayUrl + "/v1/threads/vm-thread/placement");
                reads++;
                return Response.json(
                  reads === 1
                    ? { ...placement, operationId: null }
                    : { ...placement, environmentId: "mac", generation: 2, operationId: null },
                );
              },
              active,
              null,
              detail,
            );
            const view = h.controls.locationViewAtom(environmentId, threadId),
              query = h.controls.locationQueryAtom(environmentId, threadId);
            yield* AtomRegistry.mount(h.registry, view);
            expect(h.registry.get(view)).toBeNull();
            expect(reads).toBe(0);
            const promptQueue: ThreadPromptQueue = {
              enabled: true,
              revision: 1,
              pauseReason: null,
              handoff: null,
              awaitingTurnId: null,
              admissions: [],
              finalizedTurnId: null,
              entries: [
                {
                  kind: "move",
                  state,
                  operationId: CommandId.make("move-operation"),
                  messageId: MessageId.make("move-entry"),
                  destination: { kind: "vm" },
                  revision: 1,
                  acceptedSequence: 1,
                  createdAt: at,
                },
              ],
            };
            h.registry.set(detail, { promptQueue });
            yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
            expect(h.registry.get(view)?.destination).toBeNull();
            expect(reads).toBe(1);
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
            expect(h.registry.get(view)?.destination).toEqual({
              environmentId: "mac",
              threadId,
              generation: 2,
            });
            expect(reads).toBe(2);
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
            expect(reads).toBe(2);
          }
        }),
      ),
  );
  it.effect(
    "follows a completed VM-to-local cutover without querying the disconnected source and stops reading",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          let reads = 0;
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            expect(request.method).toBe("GET");
            expect(request.url).toBe(relayUrl + "/v1/threads/vm-thread/placement");
            reads++;
            return Response.json(
              reads === 1
                ? placement
                : { ...placement, environmentId: "mac", generation: 2, operationId: null },
            );
          });
          const view = h.controls.locationViewAtom(environmentId, threadId),
            query = h.controls.locationQueryAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
          expect(h.registry.get(view)?.destination).toBeNull();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
          expect(h.registry.get(view)?.destination).toEqual({
            environmentId: "mac",
            threadId,
            generation: 2,
          });
          expect(reads).toBe(2);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
          expect(reads).toBe(2);
        }),
      ),
  );
  it.effect("does not poll ordinary active chats", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const active = {
          ...snapshot,
          threads: [
            {
              ...snapshot.threads[0]!,
              relayRouting: { relayUrl, generation: 1, phase: "active" as const },
            },
          ],
        };
        const h = yield* harness(async () => {
          reads++;
          return Response.json(placement);
        }, active);
        const view = h.controls.locationViewAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
        expect(h.registry.get(view)).toBeNull();
        expect(reads).toBe(0);
      }),
    ),
  );
  it.effect("does not keep polling a paused thread with no move operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const h = yield* harness(async () => {
          reads++;
          return Response.json({ ...placement, operationId: null });
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.destination).toBeNull();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
        expect(reads).toBe(1);
      }),
    ),
  );
  it.effect("stops automatic lookups after an access failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const h = yield* harness(async () => {
          reads++;
          return Response.json({ error: "Access removed" }, { status: 403 });
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }).pipe(
          Effect.result,
        );
        expect(h.registry.get(view)?.error).toBeTruthy();
        expect(h.registry.get(view)?.destination).toBeNull();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
        expect(reads).toBe(1);
      }),
    ),
  );
  it.effect("discards a late cutover reply after signing out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const h = yield* harness(async () => {
          requested.resolve();
          await release.promise;
          return Response.json({
            ...placement,
            environmentId: "mac",
            generation: 2,
            operationId: null,
          });
        });
        const view = h.controls.locationViewAtom(environmentId, threadId),
          query = h.controls.locationQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        const pending = yield* AtomRegistry.getResult(h.registry, query, {
          suspendOnWaiting: true,
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, null);
        release.resolve();
        yield* Fiber.join(pending);
        expect(h.registry.get(view)).toBeNull();
      }),
    ),
  );
});

describe("owner-bound pending VM authentication", () => {
  it.effect("keeps a delayed sign-in read running through unchanged VM status refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const requests: Request[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (new URL(request.url).pathname.endsWith("vm-status"))
            return Response.json(pendingVmStatus);
          requests.push(request);
          requested.resolve();
          await release.promise;
          return Response.json({ ...waitingAuth, auth: idleAuth });
        });
        const view = h.controls.viewAtom(environmentId, threadId),
          authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* Effect.promise(() => requested.promise);
        for (let refresh = 0; refresh < 3; refresh++) {
          h.registry.refresh(h.query);
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        }
        expect(requests).toHaveLength(1);
        expect(requests[0]!.signal.aborted).toBe(false);
        release.resolve();
        yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.providerAuth?.auth.phase).toBe("idle");
      }),
    ),
  );
  it.effect("lets a slow active sign-in poll finish before scheduling the next poll", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const requests: Request[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (new URL(request.url).pathname.endsWith("vm-status"))
            return Response.json(pendingVmStatus);
          requests.push(request);
          if (requests.length === 2) {
            requested.resolve();
            await release.promise;
          }
          return Response.json(waitingAuth);
        });
        const view = h.controls.viewAtom(environmentId, threadId),
          authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        yield* Effect.promise(() => requested.promise);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
        expect(requests).toHaveLength(2);
        expect(requests[1]!.signal.aborted).toBe(false);
        release.resolve();
        yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.providerAuth?.auth.interaction).toMatchObject({
          userCode: "TEST-1234",
        });
      }),
    ),
  );
  it.effect("hides the previous VM's code while its replacement sign-in read is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let binding = authBinding;
        const next = { ...authBinding, allocationId: "replacement-vm", operationId: "next-move" };
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (new URL(request.url).pathname.endsWith("vm-status"))
            return Response.json({ ...pendingVmStatus, pendingProviderAuth: binding });
          if (binding === next) {
            requested.resolve();
            await release.promise;
          }
          return Response.json({ ...waitingAuth, ...binding });
        });
        const view = h.controls.viewAtom(environmentId, threadId),
          authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, view);
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.providerAuth?.allocationId).toBe(authBinding.allocationId);
        binding = next;
        h.registry.refresh(h.query);
        yield* Effect.promise(() => requested.promise);
        expect(h.registry.get(view)?.providerAuth).toBeNull();
        release.resolve();
        yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
        expect(h.registry.get(view)?.providerAuth?.allocationId).toBe(next.allocationId);
      }),
    ),
  );
  it.effect(
    "uses relay-only start and cancel for the next-generation VM while the source remains current",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [],
            bodies: unknown[] = [];
          let providerAuth: RelayThreadVmProviderAuth = { ...waitingAuth, auth: idleAuth };
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init),
              pathname = new URL(request.url).pathname;
            expect(new URL(request.url).hostname).toBe("relay.example.test");
            expect(request.headers.get("authorization")).toBe("Bearer owner-token");
            calls.push(request.method + " " + pathname);
            if (pathname.endsWith("vm-status")) return Response.json(pendingVmStatus);
            if (request.method === "POST") {
              bodies.push(await request.json());
              providerAuth = pathname.endsWith("/cancel")
                ? { ...waitingAuth, auth: { ...waitingAuth.auth, phase: "cancelled" } }
                : waitingAuth;
            }
            return Response.json(providerAuth);
          });
          const view = h.controls.viewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          const authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          expect(h.registry.get(view)?.providerAuth?.auth.phase).toBe("idle");
          const input = { environmentId, threadId, accountId: "owner", binding: authBinding };
          expect(
            (yield* Effect.promise(() =>
              h.controls.providerAuthAction.run(h.registry, {
                ...input,
                action: { type: "start" },
              }),
            ))._tag,
          ).toBe("Success");
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          expect(h.registry.get(view)?.providerAuth).toMatchObject(waitingAuth);
          expect(
            (yield* Effect.promise(() =>
              h.controls.providerAuthAction.run(h.registry, {
                ...input,
                action: { type: "cancel", flowId: "flow-1" },
              }),
            ))._tag,
          ).toBe("Success");
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          expect(h.registry.get(view)?.providerAuth?.auth.phase).toBe("cancelled");
          expect(bodies).toEqual([
            {
              operationId: authBinding.operationId,
              allocationId: authBinding.allocationId,
              generation: 2,
            },
            {
              operationId: authBinding.operationId,
              allocationId: authBinding.allocationId,
              generation: 2,
              flowId: "flow-1",
            },
          ]);
          expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
            "POST /v1/threads/vm-thread/provider-auth/start",
            "POST /v1/threads/vm-thread/provider-auth/cancel",
          ]);
        }),
      ),
  );
  it.effect(
    "never contacts a guest auth endpoint for an ordinary running or saved-only thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(new URL(request.url).pathname);
            return Response.json(status);
          });
          yield* AtomRegistry.mount(h.registry, h.controls.viewAtom(environmentId, threadId));
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          expect(calls).toEqual(["/v1/threads/vm-thread/vm-status"]);
        }),
      ),
  );
  it.effect("rejects a stale VM binding and another account before starting sign-in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          calls.push(request.method + " " + new URL(request.url).pathname);
          return Response.json(pendingVmStatus);
        });
        yield* AtomRegistry.mount(h.registry, h.query);
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        const input = {
          environmentId,
          threadId,
          accountId: "owner",
          binding: { ...authBinding, allocationId: "stale-vm" },
          action: { type: "start" as const },
        };
        expect(
          (yield* Effect.promise(() => h.controls.providerAuthAction.run(h.registry, input)))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.promise(() =>
            h.controls.providerAuthAction.run(h.registry, {
              ...input,
              binding: authBinding,
              accountId: "other",
            }),
          ))._tag,
        ).toBe("Failure");
        expect(calls).toEqual(["GET /v1/threads/vm-thread/vm-status"]);
      }),
    ),
  );
  it.effect("polls an active sign-in and stops when the relay no longer has pending auth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers();
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let reads = 0;
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (new URL(request.url).pathname.endsWith("vm-status"))
            return Response.json(pendingVmStatus);
          reads++;
          return Response.json(reads === 1 ? waitingAuth : null);
        });
        yield* AtomRegistry.mount(h.registry, h.controls.viewAtom(environmentId, threadId));
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(
          h.registry,
          h.controls.providerAuthQueryAtom(environmentId, threadId),
          { suspendOnWaiting: true },
        );
        expect(reads).toBe(1);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(reads).toBe(2);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(4_000));
        expect(reads).toBe(2);
      }),
    ),
  );
  it.effect(
    "hides the cached device code immediately while another account's status is loading",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (new URL(request.url).pathname.endsWith("vm-status")) {
              if (request.headers.get("authorization") === "Bearer other-token") {
                requested.resolve();
                await release.promise;
                return Response.json(status);
              }
              return Response.json(pendingVmStatus);
            }
            return Response.json(waitingAuth);
          });
          const view = h.controls.viewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          yield* AtomRegistry.getResult(
            h.registry,
            h.controls.providerAuthQueryAtom(environmentId, threadId),
            { suspendOnWaiting: true },
          );
          expect(h.registry.get(view)?.providerAuth?.auth.interaction?.type).toBe("deviceCode");
          h.registry.set(managedRelaySessionAtom, {
            accountId: "other",
            readClerkToken: () => Effect.succeed("other-token"),
          });
          yield* Effect.promise(() => requested.promise);
          expect(h.registry.get(view)?.providerAuth).toBeNull();
          release.resolve();
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        }),
      ),
  );
  it.effect(
    "discards a previous account's device code when its read arrives after an account switch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (new URL(request.url).pathname.endsWith("vm-status"))
              return Response.json(
                request.headers.get("authorization") === "Bearer other-token"
                  ? status
                  : pendingVmStatus,
              );
            requested.resolve();
            await release.promise;
            return Response.json(waitingAuth);
          });
          const view = h.controls.viewAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* Effect.promise(() => requested.promise);
          h.registry.set(managedRelaySessionAtom, {
            accountId: "other",
            readClerkToken: () => Effect.succeed("other-token"),
          });
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          release.resolve();
          expect(
            yield* AtomRegistry.getResult(
              h.registry,
              h.controls.providerAuthQueryAtom(environmentId, threadId),
              { suspendOnWaiting: true },
            ),
          ).toBeNull();
          expect(h.registry.get(view)?.accountId).toBe("other");
          expect(h.registry.get(view)?.providerAuth).toBeNull();
        }),
      ),
  );
  it.effect("does not accept a sign-in reply after the account signs out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          if (new URL(request.url).pathname.endsWith("vm-status"))
            return Response.json(pendingVmStatus);
          if (request.method === "POST") {
            requested.resolve();
            await release.promise;
            return Response.json(waitingAuth);
          }
          return Response.json({ ...waitingAuth, auth: idleAuth });
        });
        yield* AtomRegistry.mount(h.registry, h.query);
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        const pending = yield* Effect.promise(() =>
          h.controls.providerAuthAction.run(h.registry, {
            environmentId,
            threadId,
            accountId: "owner",
            binding: authBinding,
            action: { type: "start" },
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        h.registry.set(managedRelaySessionAtom, null);
        release.resolve();
        expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        expect(h.registry.get(h.controls.viewAtom(environmentId, threadId))).toBeNull();
      }),
    ),
  );
  it.effect(
    "reads back an active flow after a lost start reply instead of offering a duplicate start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let providerAuth: RelayThreadVmProviderAuth = { ...waitingAuth, auth: idleAuth };
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (new URL(request.url).pathname.endsWith("vm-status"))
              return Response.json(pendingVmStatus);
            if (request.method === "POST") {
              providerAuth = waitingAuth;
              throw new Error("Lost response");
            }
            return Response.json(providerAuth);
          });
          const view = h.controls.viewAtom(environmentId, threadId),
            authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          expect(
            (yield* Effect.promise(() =>
              h.controls.providerAuthAction.run(h.registry, {
                environmentId,
                threadId,
                accountId: "owner",
                binding: authBinding,
                action: { type: "start" },
              }),
            ))._tag,
          ).toBe("Failure");
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          expect(h.registry.get(view)?.providerAuth?.auth.phase).toBe("waiting");
          expect(
            threadVmProviderAuthPresentation(h.registry.get(view)!.providerAuth!).canStart,
          ).toBe(false);
        }),
      ),
  );
  it.effect(
    "allows cancellation during a delayed status poll and discards its older device code",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
          const requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>(),
            returned = Promise.withResolvers<void>();
          let reads = 0,
            cancelled = false;
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            if (new URL(request.url).pathname.endsWith("vm-status"))
              return Response.json(pendingVmStatus);
            if (request.method === "POST") {
              cancelled = true;
              return Response.json({
                ...waitingAuth,
                auth: { ...waitingAuth.auth, phase: "cancelled" },
              });
            }
            reads++;
            if (reads === 2) {
              requested.resolve();
              await release.promise;
              returned.resolve();
              return Response.json(waitingAuth);
            }
            return Response.json(
              cancelled
                ? { ...waitingAuth, auth: { ...waitingAuth.auth, phase: "cancelled" } }
                : waitingAuth,
            );
          });
          const view = h.controls.viewAtom(environmentId, threadId),
            authQuery = h.controls.providerAuthQueryAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, view);
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
          yield* Effect.promise(() => requested.promise);
          expect(h.registry.get(view)?.providerAuthPending).toBe(true);
          expect(
            threadVmProviderAuthPresentation(h.registry.get(view)!.providerAuth!).canCancel,
          ).toBe(true);
          expect(
            (yield* Effect.promise(() =>
              h.controls.providerAuthAction.run(h.registry, {
                environmentId,
                threadId,
                accountId: "owner",
                binding: authBinding,
                action: { type: "cancel", flowId: "flow-1" },
              }),
            ))._tag,
          ).toBe("Success");
          yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true });
          release.resolve();
          yield* Effect.promise(() => returned.promise);
          expect(
            (yield* AtomRegistry.getResult(h.registry, authQuery, { suspendOnWaiting: true }))?.auth
              .phase,
          ).toBe("cancelled");
          expect(
            threadVmProviderAuthPresentation(h.registry.get(view)!.providerAuth!).userCode,
          ).toBeNull();
        }),
      ),
  );
});

function deletionJournal() {
  const values = new Map<string, string>();
  const storage: ThreadMoveSubmissionStorage = {
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    withLock: async (_key, action) => action(),
  };
  return createThreadVmActionJournal(storage);
}

describe("deletion from ordinary thread entry points", () => {
  const operationId = "00000000-0000-4000-8000-000000000001";
  const input = { environmentId, input: { threadId } };
  const scope = { accountId: "owner", relayUrl };

  it.effect(
    "uses the enrolled route from a cached archived thread without contacting its environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(
            async (url, init) => {
              const request = new Request(url, init);
              expect(request.method).toBe("POST");
              expect(new URL(request.url).pathname).toBe("/v1/threads/vm-thread/deletion");
              return Response.json({
                threadId,
                operationId,
                generation: 1,
                phase: "completed",
                errorCode: null,
              });
            },
            { ...snapshot, threads: [] },
            Atom.make(AsyncResult.success(snapshot)),
          );
          const command = withPortableThreadDeletion(
            {
              label: "delete",
              run: async () => {
                throw new Error("Archived portable thread reached local deletion");
              },
            },
            h.controls.action,
            deletionJournal(),
            h.controls.routeAtom,
            () => operationId,
          );
          expect((yield* Effect.promise(() => command.run(h.registry, input)))._tag).toBe(
            "Success",
          );
        }),
      ),
  );

  it.effect(
    "routes deletion through the relay after an initially pending archive query completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const loaded = yield* Deferred.make<OrchestrationShellSnapshot>();
          const archive = Atom.runtime(Layer.empty).atom(Deferred.await(loaded));
          const calls: string[] = [];
          const h = yield* harness(
            async (url, init) => {
              const request = new Request(url, init);
              calls.push(request.method + " " + new URL(request.url).pathname);
              return Response.json({
                threadId,
                operationId,
                generation: 1,
                phase: "completed",
                errorCode: null,
              });
            },
            { ...snapshot, threads: [] },
            archive,
          );
          const route = h.controls.routeAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, route);
          expect(h.registry.get(route)).toBeNull();
          yield* Deferred.succeed(loaded, snapshot);
          yield* AtomRegistry.getResult(h.registry, archive, { suspendOnWaiting: true });
          expect(h.registry.get(route)).toEqual(snapshot.threads[0]!.relayRouting);
          const command = withPortableThreadDeletion(
            {
              label: "delete",
              run: async () => {
                throw new Error("Late archived route reached local deletion");
              },
            },
            h.controls.action,
            deletionJournal(),
            h.controls.routeAtom,
            () => operationId,
          );
          expect((yield* Effect.promise(() => command.run(h.registry, input)))._tag).toBe(
            "Success",
          );
          expect(calls).toEqual(["POST /v1/threads/vm-thread/deletion"]);
        }),
      ),
  );

  it.effect(
    "leaves an unenrolled local thread on its environment without contacting the relay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(
            async () => {
              throw new Error("Unexpected relay call");
            },
            {
              ...snapshot,
              threads: [],
            },
          );
          let localCalls = 0;
          const command = withPortableThreadDeletion(
            {
              label: "delete",
              run: async () => {
                localCalls++;
                return AsyncResult.success({ sequence: 8 });
              },
            },
            h.controls.action,
            deletionJournal(),
            h.controls.routeAtom,
            () => operationId,
          );
          expect(yield* Effect.promise(() => command.run(h.registry, input))).toMatchObject({
            _tag: "Success",
            value: { sequence: 8 },
          });
          expect(localCalls).toBe(1);
        }),
      ),
  );

  it.effect(
    "retains a lost deletion reply and reuses its original request until physical cleanup completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const journal = deletionJournal(),
            bodies: unknown[] = [];
          let calls = 0;
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            expect(new URL(request.url).pathname).toBe("/v1/threads/vm-thread/deletion");
            expect(request.method).toBe("POST");
            expect(request.headers.get("authorization")).toBe("Bearer owner-token");
            expect(await journal.list(scope)).toHaveLength(1);
            bodies.push(await request.json());
            calls++;
            if (calls === 1) throw new Error("Lost response");
            return Response.json({
              threadId,
              operationId,
              generation: 1,
              phase: calls === 2 ? "stopping" : "completed",
              errorCode: null,
            });
          });
          const makeCommand = (id: string) =>
            withPortableThreadDeletion(
              {
                label: "delete",
                run: async () => {
                  throw new Error("Portable deletion reached environment");
                },
              },
              h.controls.action,
              journal,
              h.controls.routeAtom,
              () => id,
            );
          expect(
            (yield* Effect.promise(() => makeCommand(operationId).run(h.registry, input)))._tag,
          ).toBe("Failure");
          expect(yield* Effect.promise(() => journal.list(scope))).toHaveLength(1);
          expect(
            (yield* Effect.promise(() =>
              makeCommand("00000000-0000-4000-8000-000000000002").run(h.registry, input),
            ))._tag,
          ).toBe("Success");
          expect(yield* Effect.promise(() => journal.list(scope))).toHaveLength(1);
          expect(
            (yield* Effect.promise(() =>
              makeCommand("00000000-0000-4000-8000-000000000003").run(h.registry, input),
            ))._tag,
          ).toBe("Success");
          expect(yield* Effect.promise(() => journal.list(scope))).toEqual([]);
          expect(bodies).toEqual(
            Array.from({ length: 3 }, () => ({
              operationId,
              expectedGeneration: 1,
              confirmWorkspaceLoss: true,
            })),
          );
        }),
      ),
  );

  it.effect("does not send an enrolled deletion while signed out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async () => {
          throw new Error("Unexpected request");
        });
        h.registry.set(managedRelaySessionAtom, null);
        const journal = deletionJournal();
        const command = withPortableThreadDeletion(
          {
            label: "delete",
            run: async () => {
              throw new Error("Unexpected local deletion");
            },
          },
          h.controls.action,
          journal,
          h.controls.routeAtom,
          () => operationId,
        );
        expect((yield* Effect.promise(() => command.run(h.registry, input)))._tag).toBe("Failure");
        expect(yield* Effect.promise(() => journal.list(scope))).toEqual([]);
      }),
    ),
  );

  it.effect(
    "leaves a saved reset intact and refuses deletion until that operation is resolved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(async () => {
            throw new Error("Unexpected deletion request");
          });
          const journal = deletionJournal();
          const reset = {
            environmentId,
            threadId,
            action: {
              type: "reset" as const,
              payload: {
                operationId,
                allocationId: "00000000-0000-4000-8000-000000000002",
                expectedGeneration: 1,
                canonicalKey: "github.com/team/repo",
                branch: "main",
                revision: "a".repeat(40),
              },
            },
          };
          yield* Effect.promise(() => journal.prepare(scope, reset));
          const command = withPortableThreadDeletion(
            {
              label: "delete",
              run: async () => {
                throw new Error("Unexpected local deletion");
              },
            },
            h.controls.action,
            journal,
            h.controls.routeAtom,
            () => operationId,
          );
          expect((yield* Effect.promise(() => command.run(h.registry, input)))._tag).toBe(
            "Failure",
          );
          expect(yield* Effect.promise(() => journal.list(scope))).toEqual([reset]);
        }),
      ),
  );
});

describe("shared VM controls", () => {
  it.effect(
    "checks a recovery candidate only on request and rejects stale or late account results",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const candidate = {
            threadId,
            generation: 1,
            sourceAllocationId: "source-allocation",
            backupOperationId: "00000000-0000-4000-8000-000000000001",
            capturedAt: "2026-10-15T12:00:00.000Z",
            nativeCheckpointOperationId: "00000000-0000-4000-8000-000000000002",
            available: true,
            blockedReason: null,
          };
          const calls: Request[] = [];
          const input = {
            environmentId,
            threadId,
            accountId: "owner",
            expectedGeneration: 1,
            sourceAllocationId: candidate.sourceAllocationId,
          };
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(request);
            return Response.json(candidate);
          });
          expect(calls).toHaveLength(0);
          expect(
            yield* Effect.promise(() => h.controls.checkBackupRecovery.run(h.registry, input)),
          ).toMatchObject({ _tag: "Success", value: candidate });
          expect(calls[0]?.method).toBe("GET");
          expect(calls[0]?.url).toBe(relayUrl + "/v1/threads/vm-thread/vm-backup-recovery");
          expect(calls[0]?.headers.get("authorization")).toBe("Bearer owner-token");
          expect(
            yield* Effect.promise(() =>
              h.controls.checkBackupRecovery.run(h.registry, {
                ...input,
                expectedGeneration: 2,
              }),
            ),
          ).toMatchObject({ _tag: "Failure" });
          const arrived = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const late = yield* harness(async () => {
            arrived.resolve();
            await release.promise;
            return Response.json(candidate);
          });
          const pending = yield* Effect.promise(() =>
            late.controls.checkBackupRecovery.run(late.registry, input),
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(() => arrived.promise);
          late.registry.set(managedRelaySessionAtom, null);
          release.resolve();
          expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure" });
        }),
      ),
  );
  it.effect("reads a saved-only VM from the relay without attempting connection or resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          expect(request.headers.get("authorization")).toBe("Bearer owner-token");
          calls.push(request.method + " " + new URL(request.url).pathname);
          return Response.json(status);
        });
        yield* AtomRegistry.mount(h.registry, h.query);
        expect(
          (yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }))?.status,
        ).toEqual(status);
        expect(calls).toEqual(["GET /v1/threads/vm-thread/vm-status"]);
        expect(
          h.registry.get(h.controls.viewAtom(environmentId, threadId))?.data?.status?.savedDisk
            ?.phase,
        ).toBe("available");
      }),
    ),
  );
  it.effect(
    "opens an explicit port through the authenticated relay and discards a late account reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Request[] = [];
          const release = Promise.withResolvers<void>();
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(request);
            expect(request.headers.get("authorization")).toBe("Bearer owner-token");
            expect(await request.json()).toEqual({ port: 4080 });
            return Response.json({
              url: "https://preview.example.test/__launchpad_preview/#one-use",
            });
          });
          const opened = yield* Effect.promise(() =>
            h.controls.openPreview.run(h.registry, { environmentId, threadId, port: 4080 }),
          );
          expect(opened._tag).toBe("Success");
          expect(calls[0]?.url).toBe(relayUrl + "/v1/threads/vm-thread/vm-previews");
          const invalid = yield* Effect.promise(() =>
            h.controls.openPreview.run(h.registry, { environmentId, threadId, port: 3773 }),
          );
          expect(invalid._tag).toBe("Failure");
          expect(calls).toHaveLength(1);
          const lateArrived = Promise.withResolvers<void>();
          const late = yield* harness(async () => {
            lateArrived.resolve();
            await release.promise;
            return Response.json({ url: "https://preview.example.test/__launchpad_preview/#late" });
          });
          const pending = yield* Effect.promise(() =>
            late.controls.openPreview.run(late.registry, { environmentId, threadId, port: 4080 }),
          ).pipe(Effect.forkScoped);
          // Token loading and fetch start are awaited through a receipt, not a sleep.
          yield* Effect.promise(() => lateArrived.promise);
          late.registry.set(managedRelaySessionAtom, null);
          release.resolve();
          expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        }),
      ),
  );
  it.effect("does not query ordinary local threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { relayRouting: _, ...thread } = snapshot.threads[0]!;
        const h = yield* harness(
          async () => {
            throw new Error("Ordinary local threads cannot use VM endpoints");
          },
          { ...snapshot, threads: [thread] },
        );
        yield* AtomRegistry.mount(h.registry, h.query);
        expect(
          yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }),
        ).toBeNull();
        expect(h.registry.get(h.controls.viewAtom(environmentId, threadId))).toBeNull();
      }),
    ),
  );
  it.effect("rejects an environment-selected relay before reading the account token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let tokens = 0;
        const h = yield* harness(
          async () => {
            throw new Error("No token may reach another relay");
          },
          {
            ...snapshot,
            threads: [
              {
                ...snapshot.threads[0]!,
                relayRouting: {
                  relayUrl: "https://foreign.example.test",
                  generation: 1,
                  phase: "active",
                },
              },
            ],
          },
        );
        h.registry.set(managedRelaySessionAtom, {
          accountId: "owner",
          readClerkToken: () =>
            Effect.sync(() => {
              tokens++;
              return "secret";
            }),
        });
        const result = yield* Effect.promise(() =>
          h.controls.action.run(h.registry, {
            environmentId,
            threadId,
            action: { type: "resume" },
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(tokens).toBe(0);
      }),
    ),
  );
  it.effect("sign-out while the token is loading prevents a queued lifecycle mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          ready = yield* Deferred.make<string>();
        const h = yield* harness(async () => {
          throw new Error("Signed-out actions cannot be sent");
        });
        h.registry.set(managedRelaySessionAtom, {
          accountId: "owner",
          readClerkToken: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
        });
        const action = yield* Effect.promise(() =>
          h.controls.action.run(h.registry, {
            environmentId,
            threadId,
            action: { type: "resume" },
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        h.registry.set(managedRelaySessionAtom, null);
        yield* Deferred.succeed(ready, "old-token");
        expect((yield* Fiber.join(action))._tag).toBe("Failure");
      }),
    ),
  );
  it.effect(
    "keeps a lost restore retry's original IDs and displays the retained quota choice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const operationId = "00000000-0000-4000-8000-000000000001",
            allocationId = "00000000-0000-4000-8000-000000000002";
          const payload = {
            operationId,
            allocationId,
            savedDiskOperationId: "00000000-0000-4000-8000-000000000003",
            expectedGeneration: 1,
          };
          const replacement = {
            requestId: operationId,
            threadId,
            phase: "awaiting_choice",
            victimAllocationId: null,
            errorCode: null,
          };
          const bodies: unknown[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init),
              path = new URL(request.url).pathname;
            if (request.method === "POST") {
              bodies.push(await request.json());
              if (bodies.length === 1) throw new Error("Lost admission response");
              return Response.json({
                status: "quota_reached",
                maxVms: 1,
                reservedVms: 1,
                replacement,
                suggestedReplacement: null,
              });
            }
            if (path.endsWith("/candidates"))
              return Response.json([
                { allocationId: "victim", threadId: "other", state: "paused", title: "Other work" },
              ]);
            return Response.json({ ...status, replacement });
          });
          const input = { environmentId, threadId, action: { type: "restore" as const, payload } };
          expect((yield* Effect.promise(() => h.controls.action.run(h.registry, input)))._tag).toBe(
            "Failure",
          );
          expect((yield* Effect.promise(() => h.controls.action.run(h.registry, input)))._tag).toBe(
            "Success",
          );
          yield* AtomRegistry.mount(h.registry, h.query);
          const data = yield* AtomRegistry.getResult(h.registry, h.query, {
            suspendOnWaiting: true,
          });
          expect(bodies).toEqual([payload, payload]);
          expect(data?.status?.replacement).toEqual(replacement);
          expect(data?.candidates).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "after deletion, reads only its cleanup receipt instead of trying to reach the retired VM",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const receipt = {
              threadId,
              operationId: "00000000-0000-4000-8000-000000000004",
              generation: 1,
              phase: "cleaning",
              errorCode: null,
            },
            calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            calls.push(request.method + " " + new URL(request.url).pathname);
            return Response.json(receipt);
          });
          expect(
            (yield* Effect.promise(() =>
              h.controls.action.run(h.registry, {
                environmentId,
                threadId,
                action: {
                  type: "delete",
                  payload: {
                    operationId: receipt.operationId,
                    expectedGeneration: 1,
                    confirmWorkspaceLoss: true,
                  },
                },
              }),
            ))._tag,
          ).toBe("Success");
          yield* AtomRegistry.mount(h.registry, h.query);
          expect(
            (yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true }))
              ?.deletion,
          ).toEqual(receipt);
          expect(calls).toEqual([
            "POST /v1/threads/vm-thread/deletion",
            "GET /v1/threads/vm-thread/deletion",
          ]);
        }),
      ),
  );
  it.effect(
    "recovers an original deletion from the configured relay after discovery and its thread have disappeared",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const payload = {
            operationId: "00000000-0000-4000-8000-000000000044",
            expectedGeneration: 1,
            confirmWorkspaceLoss: true as const,
          };
          const calls: Request[] = [];
          const h = yield* harness(
            async (url, init) => {
              const request = new Request(url, init);
              calls.push(request);
              expect(await request.json()).toEqual(payload);
              return Response.json({
                threadId,
                operationId: payload.operationId,
                generation: 1,
                phase: "completed",
                errorCode: null,
              });
            },
            { ...snapshot, threads: [] },
          );
          const input = {
            environmentId,
            threadId,
            accountId: "owner",
            relayUrl,
            action: { type: "delete" as const, payload },
          };
          expect((yield* Effect.promise(() => h.controls.action.run(h.registry, input)))._tag).toBe(
            "Success",
          );
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe(relayUrl + "/v1/threads/vm-thread/deletion");
          let tokens = 0;
          h.registry.set(managedRelaySessionAtom, {
            accountId: "other",
            readClerkToken: () =>
              Effect.sync(() => {
                tokens++;
                return "other-token";
              }),
          });
          expect((yield* Effect.promise(() => h.controls.action.run(h.registry, input)))._tag).toBe(
            "Failure",
          );
          expect(tokens).toBe(0);
          expect(calls).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "does not acknowledge an old account's lifecycle request when its HTTP reply arrives late",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requested = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          const h = yield* harness(async () => {
            requested.resolve();
            await release.promise;
            return Response.json({ ...status, resumePhase: "waiting" });
          });
          const pending = yield* Effect.promise(() =>
            h.controls.action.run(h.registry, {
              environmentId,
              threadId,
              accountId: "owner",
              relayUrl,
              action: { type: "resume" },
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(() => requested.promise);
          h.registry.set(managedRelaySessionAtom, null);
          release.resolve();
          expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        }),
      ),
  );
});

describe("VM lifecycle reads current state before mutation", () => {
  it.effect("rejects resume when the VM generation changed after the card loaded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let generation = 1;
        const methods: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          methods.push(request.method);
          expect(request.method).toBe("GET");
          return Response.json({
            ...status,
            generation,
            allocation: { allocationId: "vm", ownerUserId: "owner", state: "paused" },
            savedDisk: null,
            setupPhase: "ready",
          });
        });
        yield* AtomRegistry.mount(h.registry, h.query);
        yield* AtomRegistry.getResult(h.registry, h.query, { suspendOnWaiting: true });
        generation = 2;
        const result = yield* Effect.promise(() =>
          h.controls.action.run(h.registry, {
            environmentId,
            threadId,
            action: { type: "resume" },
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(methods).toEqual(["GET", "GET"]);
      }),
    ),
  );
});
