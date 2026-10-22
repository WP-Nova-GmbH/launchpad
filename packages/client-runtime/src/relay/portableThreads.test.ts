import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  getThreadCommandReceipt,
  enqueueThreadMove,
  threadCommandAcceptance,
  pauseThreadQueue,
  cancelThreadMove,
  startThreadTurn,
} from "../operations/commands.ts";
import { ThreadCommandRouting } from "../operations/commandRouting.ts";
import { createPortableThreadLibraryAtoms } from "./portableThreadLibrary.ts";
import { createThreadVmControlAtoms } from "./threadVmControls.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import { layer as tenancyLayer } from "./managedRelayTenancy.ts";
import {
  createPortableThreadCommandAtoms,
  portableCommandStatesAtom,
  portableThreadCommandLayer,
  refreshPortableCommandReceipt,
} from "./portableThreads.ts";

const environmentId = EnvironmentId.make("old-environment");
const threadId = ThreadId.make("portable");
const commandId = CommandId.make("stable-command");
const relayUrl = "https://relay.example.test";
const createdAt = "2026-10-07T00:00:00Z";
const pending = { commandId, position: 3, receipt: null };
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: createdAt,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Portable",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      relayRouting: { relayUrl, generation: 1, phase: "active" },
    },
  ],
};
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
const placementSummary = (env: string = environmentId, generation = 1) => ({
  title: "Portable",
  modelSelection: snapshot.threads[0]!.modelSelection,
  createdAt,
  updatedAt: createdAt,
  placement: {
    threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: "account",
    environmentId: env,
    projectId: "project",
    generation,
    operationId: null,
  },
});
const vmStatus = {
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
};
const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const harness = Effect.fn("PortableThreadCommandsTest.harness")(function* (fetchFn: typeof fetch) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(managedRelaySessionAtom, {
    accountId: "account",
    readClerkToken: () => Effect.succeed("token"),
  });
  const relay = tenancyLayer({ relayUrl }).pipe(Layer.provide(remoteHttpClientLayer(fetchFn)));
  const routingLayer = portableThreadCommandLayer(registry).pipe(Layer.provideMerge(relay));
  const direct: unknown[] = [];
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: environmentId },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: unknown) =>
            Effect.sync(() => {
              direct.push(command);
              return { sequence: 10 };
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"]);
  return {
    registry,
    direct,
    relay,
    supervisor,
    layer: Layer.mergeAll(
      routingLayer,
      cryptoLayer,
      Layer.succeed(EnvironmentSupervisor, supervisor),
    ),
  };
});

describe("portable command routing", () => {
  it.effect("leaves ordinary local commands independent of the relay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async () => {
          throw new Error("Relay must not be called");
        });
        h.registry.set(managedRelaySessionAtom, null);
        yield* Effect.gen(function* () {
          expect(yield* pauseThreadQueue({ threadId, commandId, createdAt })).toEqual({
            sequence: 10,
          });
          expect(h.direct).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("does not enroll an unrelated environment's thread with the same ID", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async () => {
          throw new Error("Unrelated local thread must not use relay");
        });
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, EnvironmentId.make("another-environment"));
          expect(yield* pauseThreadQueue({ threadId, commandId, createdAt })).toEqual({
            sequence: 10,
          });
          expect(h.direct).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect(
    "stages a prompt while its environment is disconnected and retains a pending receipt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bodies: unknown[] = [];
          const h = yield* harness(async (input, init) => {
            const request = new Request(input, init);
            expect(request.headers.get("authorization")).toBe("Bearer token");
            bodies.push(await request.json());
            return Response.json(pending);
          });
          yield* SubscriptionRef.set(h.supervisor.session, Option.none());
          yield* Effect.gen(function* () {
            const routing = yield* ThreadCommandRouting;
            routing!.remember(snapshot, environmentId);
            const input = {
              threadId,
              commandId,
              createdAt,
              message: {
                messageId: MessageId.make("message"),
                role: "user" as const,
                text: "Work",
                attachments: [],
              },
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
            };
            expect(yield* startThreadTurn(input)).toEqual({ relay: pending });
            expect(bodies).toEqual([
              {
                command: {
                  ...input,
                  message: { messageId: input.message.messageId, text: "Work", attachments: [] },
                  type: "thread.prompt.enqueue",
                },
              },
            ]);
            expect(h.direct).toEqual([]);
            expect(h.registry.get(portableCommandStatesAtom)[0]?.receipt).toEqual(pending);
          }).pipe(Effect.provide(h.layer));
        }),
      ),
  );

  it.effect(
    "keeps retired ownership pinned after an empty snapshot and rejects signed-out writes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(async () => {
            throw new Error("Must not send signed-out writes");
          });
          yield* Effect.gen(function* () {
            const routing = yield* ThreadCommandRouting;
            routing!.remember(
              {
                ...snapshot,
                threads: snapshot.threads.map((thread) => ({
                  ...thread,
                  relayRouting: { relayUrl, generation: 2, phase: "retired" },
                })),
              },
              environmentId,
            );
            routing!.remember({ ...snapshot, threads: [] }, environmentId);
            h.registry.set(managedRelaySessionAtom, null);
            const error = yield* Effect.flip(pauseThreadQueue({ threadId, commandId, createdAt }));
            expect(error.message).toContain("Sign in");
            expect(h.direct).toEqual([]);
          }).pipe(Effect.provide(h.layer));
        }),
      ),
  );

  it.effect("never forwards a token to a relay named by the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          expect(new URL(request.url).origin).toBe(relayUrl);
          calls.push(request.method + " " + new URL(request.url).pathname);
          return Response.json(placementSummary("unrelated-environment").placement);
        });
        let tokenReads = 0;
        h.registry.set(managedRelaySessionAtom, {
          accountId: "account",
          readClerkToken: () =>
            Effect.sync(() => {
              tokenReads++;
              return "token";
            }),
        });
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(
            {
              ...snapshot,
              threads: snapshot.threads.map((thread) => ({
                ...thread,
                relayRouting: {
                  relayUrl: "https://other.example.test",
                  generation: 1,
                  phase: "active",
                },
              })),
            },
            environmentId,
          );
          expect(
            (yield* Effect.flip(pauseThreadQueue({ threadId, commandId, createdAt }))).message,
          ).toContain("location changed");
          expect(tokenReads).toBe(1);
          expect(calls).toEqual(["GET /v1/threads/portable/placement"]);
          expect(h.direct).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  for (const first of ["cancel", "receipt"] as const) {
    it.effect(`verifies a frozen source's relay alias before its first ${first}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            expect(new URL(request.url).origin).toBe(relayUrl);
            expect(request.headers.get("authorization")).toBe("Bearer token");
            const path = new URL(request.url).pathname;
            calls.push(request.method + " " + path);
            if (path.endsWith("/placement")) return Response.json(placementSummary().placement);
            if (request.method === "POST") {
              const payload = await request.json();
              expect(payload.command.type).toBe("thread.move.cancel");
              expect(payload.command.expectedRevision).toBe(2);
            }
            return Response.json(pending);
          });
          const frozen: OrchestrationShellSnapshot = {
            ...snapshot,
            threads: snapshot.threads.map((thread) => ({
              ...thread,
              relayRouting: {
                relayUrl: "http://127.0.0.1:8610",
                generation: 1,
                phase: "frozen",
              },
            })),
          };
          yield* Effect.gen(function* () {
            const routing = yield* ThreadCommandRouting;
            routing!.remember(frozen, environmentId);
            const cancel = cancelThreadMove({
              threadId,
              commandId,
              createdAt,
              messageId: MessageId.make("moving-entry"),
              expectedRevision: 2,
            });
            const receipt = routing!.receipt(threadId, commandId, environmentId);
            if (first === "cancel") {
              expect(yield* cancel).toEqual({ relay: pending });
              expect(yield* receipt).toEqual(pending);
            } else {
              expect(yield* receipt).toEqual(pending);
              expect(yield* cancel).toEqual({ relay: pending });
            }
          }).pipe(Effect.provide(h.layer));
          const controls = createThreadVmControlAtoms(Atom.runtime(h.relay), () =>
            Atom.make(frozen),
          );
          expect(h.registry.get(controls.routeAtom(environmentId, threadId))).toEqual({
            relayUrl,
            generation: 1,
            phase: "frozen",
          });
          expect(calls[0]).toBe("GET /v1/threads/portable/placement");
          expect(calls.filter((call) => call.endsWith("/placement"))).toHaveLength(1);
          expect(calls).toContain("POST /v1/threads/portable/commands");
          expect(h.direct).toEqual([]);
        }),
      ),
    );
  }

  for (const mismatch of ["account", "session", "generation", "environment"] as const) {
    it.effect(`refuses alias cancellation when the verified ${mismatch} changes`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          let registry: AtomRegistry.AtomRegistry;
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            expect(new URL(request.url).origin).toBe(relayUrl);
            calls.push(request.method + " " + new URL(request.url).pathname);
            if (mismatch === "account" || mismatch === "session")
              registry.set(managedRelaySessionAtom, {
                accountId: mismatch === "session" ? "account" : "another-account",
                readClerkToken: () => Effect.succeed("another-token"),
              });
            return Response.json(
              placementSummary(
                mismatch === "environment" ? "another-environment" : environmentId,
                mismatch === "generation" ? 2 : 1,
              ).placement,
            );
          });
          registry = h.registry;
          yield* Effect.gen(function* () {
            const routing = yield* ThreadCommandRouting;
            routing!.remember(guestSnapshot, environmentId);
            const result = yield* Effect.result(
              cancelThreadMove({
                threadId,
                commandId,
                createdAt,
                messageId: MessageId.make("moving-entry"),
                expectedRevision: 2,
              }),
            );
            expect(result._tag).toBe("Failure");
          }).pipe(Effect.provide(h.layer));
          expect(calls).toEqual(["GET /v1/threads/portable/placement"]);
          expect(h.direct).toEqual([]);
        }),
      ),
    );
  }

  it.effect(
    "uses an authenticated placement's client transport for controls, commands and reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (url, init) => {
            const request = new Request(url, init);
            expect(new URL(request.url).origin).toBe(relayUrl);
            expect(request.headers.get("authorization")).toBe("Bearer token");
            const path = new URL(request.url).pathname;
            calls.push(request.method + " " + path);
            if (path.endsWith("/portable"))
              return Response.json({ entries: [placementSummary()], next: null });
            if (path.endsWith("/vm-status")) return Response.json(vmStatus);
            if (path.endsWith("/commands") && request.method === "GET")
              return Response.json({ entries: [pending], hasMore: false });
            return Response.json(pending);
          });
          const runtime = Atom.runtime(h.relay),
            source = Atom.make(guestSnapshot),
            library = createPortableThreadLibraryAtoms(runtime),
            controls = createThreadVmControlAtoms(runtime, () => source),
            commands = createPortableThreadCommandAtoms(runtime, () => source);
          expect((yield* Effect.promise(() => library.loadIndex.run(h.registry, {})))._tag).toBe(
            "Success",
          );
          expect(h.registry.get(controls.routeAtom(environmentId, threadId))).toEqual({
            relayUrl,
            generation: 1,
            phase: "active",
          });
          yield* AtomRegistry.getResult(h.registry, controls.queryAtom(environmentId, threadId), {
            suspendOnWaiting: true,
          });
          yield* Effect.gen(function* () {
            const routing = yield* ThreadCommandRouting;
            routing!.remember(guestSnapshot, environmentId);
            expect(yield* pauseThreadQueue({ threadId, commandId, createdAt })).toEqual({
              relay: pending,
            });
            expect(yield* routing!.receipt(threadId, commandId, environmentId)).toEqual(pending);
          }).pipe(Effect.provide(h.layer));
          yield* AtomRegistry.getResult(h.registry, commands.pendingAtom(environmentId, threadId), {
            suspendOnWaiting: true,
          });
          expect(
            h.registry.get(commands.viewAtom(environmentId, threadId))?.waitingForEnvironment,
          ).toBe(1);
          expect(calls).toEqual(
            expect.arrayContaining([
              "GET /v1/threads/portable",
              "GET /v1/threads/portable/vm-status",
              "POST /v1/threads/portable/commands",
              "GET /v1/threads/portable/commands/stable-command",
              "GET /v1/threads/portable/commands",
            ]),
          );
          expect(h.direct).toEqual([]);
        }),
      ),
  );

  it.effect(
    "does not reuse a transport proof for another session, generation, environment or relay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const mismatch of ["session", "generation", "environment", "relay"] as const) {
            let tokenReads = 0,
              proofRead = false;
            const verificationCalls: string[] = [];
            const h = yield* harness(async (url, init) => {
              if (proofRead) {
                const request = new Request(url, init);
                expect(new URL(request.url).origin).toBe(relayUrl);
                verificationCalls.push(request.method + " " + new URL(request.url).pathname);
                return Response.json({}, { status: 404 });
              }
              return Response.json({
                entries: [
                  placementSummary(
                    mismatch === "environment" ? "unrelated-environment" : environmentId,
                    mismatch === "generation" ? 2 : 1,
                  ),
                ],
                next: null,
              });
            });
            const session = {
              accountId: "account",
              readClerkToken: () =>
                Effect.sync(() => {
                  tokenReads++;
                  return "token";
                }),
            };
            h.registry.set(managedRelaySessionAtom, session);
            const proofRelay =
              mismatch === "relay"
                ? tenancyLayer({ relayUrl: "https://other.example.test" }).pipe(
                    Layer.provide(
                      remoteHttpClientLayer(async () =>
                        Response.json({ entries: [placementSummary()], next: null }),
                      ),
                    ),
                  )
                : h.relay;
            const library = createPortableThreadLibraryAtoms(Atom.runtime(proofRelay));
            expect((yield* Effect.promise(() => library.loadIndex.run(h.registry, {})))._tag).toBe(
              "Success",
            );
            proofRead = true;
            tokenReads = 0;
            if (mismatch === "session") h.registry.set(managedRelaySessionAtom, { ...session });
            const runtime = Atom.runtime(h.relay),
              source = Atom.make(guestSnapshot),
              controls = createThreadVmControlAtoms(runtime, () => source),
              commands = createPortableThreadCommandAtoms(runtime, () => source);
            yield* Effect.gen(function* () {
              const routing = yield* ThreadCommandRouting;
              routing!.remember(guestSnapshot, environmentId);
              expect(
                (yield* Effect.result(pauseThreadQueue({ threadId, commandId, createdAt })))._tag,
              ).toBe("Failure");
              expect(
                (yield* Effect.result(routing!.receipt(threadId, commandId, environmentId)))._tag,
              ).toBe("Failure");
            }).pipe(Effect.provide(h.layer));
            expect(
              (yield* Effect.promise(() =>
                controls.action.run(h.registry, {
                  environmentId,
                  threadId,
                  action: { type: "resume" },
                }),
              ))._tag,
            ).toBe("Failure");
            expect(
              (yield* Effect.result(
                AtomRegistry.getResult(h.registry, commands.pendingAtom(environmentId, threadId), {
                  suspendOnWaiting: true,
                }),
              ))._tag,
            ).toBe("Failure");
            expect(tokenReads).toBe(2);
            expect(verificationCalls).toEqual([
              "GET /v1/threads/portable/placement",
              "GET /v1/threads/portable/placement",
            ]);
            expect(h.direct).toEqual([]);
          }
        }),
      ),
  );

  it.effect("keeps the stable ID on a lost submission response and retries through the relay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bodies: unknown[] = [];
        const h = yield* harness(async (input, init) => {
          bodies.push(await new Request(input, init).json());
          if (bodies.length === 1) throw new Error("lost response");
          return Response.json(pending);
        });
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          const input = { threadId, commandId, createdAt };
          yield* Effect.flip(pauseThreadQueue(input));
          expect(h.registry.get(portableCommandStatesAtom)[0]?.receipt).toBeNull();
          expect(yield* pauseThreadQueue(input)).toEqual({ relay: pending });
          expect(bodies[0]).toEqual(bodies[1]);
          expect(h.direct).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("surfaces a persisted rejection instead of reporting execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rejected = { ...pending, receipt: { status: "rejected", detail: "Setup failed" } };
        const h = yield* harness(async () => Response.json(rejected));
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          expect(
            (yield* Effect.flip(pauseThreadQueue({ threadId, commandId, createdAt }))).message,
          ).toBe("Setup failed");
          expect(h.registry.get(portableCommandStatesAtom)[0]?.receipt).toEqual(rejected);
          expect(h.direct).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect("reads execution receipts without connecting or waking compute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const accepted = { ...pending, receipt: { status: "accepted", sequence: 200 } };
        const h = yield* harness(async (input, init) => {
          const request = new Request(input, init);
          calls.push(request.method);
          return Response.json(request.method === "POST" ? pending : accepted);
        });
        yield* SubscriptionRef.set(h.supervisor.session, Option.none());
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          yield* pauseThreadQueue({ threadId, commandId, createdAt });
          const state = h.registry.get(portableCommandStatesAtom)[0]!;
          expect(yield* refreshPortableCommandReceipt(h.registry, state)).toEqual(accepted);
          expect(h.registry.get(portableCommandStatesAtom)).toEqual([]);
          expect(calls).toEqual(["POST", "GET"]);
          expect(h.direct).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );

  it.effect(
    "reloads queued changes from the relay without a live environment or local receipts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const h = yield* harness(async (input, init) => {
            const request = new Request(input, init);
            calls.push(request.method + " " + new URL(request.url).pathname);
            return Response.json({ entries: [pending], hasMore: false });
          });
          yield* SubscriptionRef.set(h.supervisor.session, Option.none());
          const source = Atom.make(snapshot);
          const commands = createPortableThreadCommandAtoms(Atom.runtime(h.layer), () => source);
          const query = commands.pendingAtom(environmentId, threadId);
          yield* AtomRegistry.mount(h.registry, query);
          expect(
            yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }),
          ).toEqual({ entries: [pending], hasMore: false });
          expect(
            h.registry.get(commands.viewAtom(environmentId, threadId))?.waitingForEnvironment,
          ).toBe(1);
          expect(calls).toEqual(["GET /v1/threads/portable/commands"]);
          expect(h.direct).toEqual([]);
        }),
      ),
  );

  it.effect("removes a waiting change only after its persisted execution receipt arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "POST") return Response.json(pending);
          if (new URL(request.url).pathname.endsWith("/stable-command"))
            return Response.json({ ...pending, receipt: { status: "accepted", sequence: 200 } });
          return Response.json({ entries: [pending], hasMore: false });
        });
        yield* SubscriptionRef.set(h.supervisor.session, Option.none());
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          yield* pauseThreadQueue({ threadId, commandId, createdAt });
        }).pipe(Effect.provide(h.layer));
        const source = Atom.make(snapshot);
        const commands = createPortableThreadCommandAtoms(Atom.runtime(h.layer), () => source);
        const query = commands.pendingAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, query);
        expect(
          yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }),
        ).toEqual({ entries: [], hasMore: false });
        expect(h.registry.get(portableCommandStatesAtom)).toEqual([]);
        expect(
          h.registry.get(commands.viewAtom(environmentId, threadId))?.waitingForEnvironment,
        ).toBe(0);
        expect(h.direct).toEqual([]);
      }),
    ),
  );

  it.effect("queues a move next on the relay without waking the source environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async (url, init) => {
          const request = new Request(url, init);
          expect(request.method).toBe("POST");
          expect(new URL(request.url).pathname).toBe("/v1/threads/portable/commands");
          expect(await request.json()).toMatchObject({
            command: {
              type: "thread.move.enqueue",
              threadId,
              commandId,
              messageId: "move-next",
              position: "next",
              destination: { kind: "vm" },
            },
          });
          return Response.json(pending);
        });
        yield* SubscriptionRef.set(h.supervisor.session, Option.none());
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          expect(
            yield* enqueueThreadMove({
              threadId,
              commandId,
              messageId: MessageId.make("move-next"),
              createdAt,
              position: "next",
              destination: { kind: "vm" },
            }),
          ).toEqual({ relay: pending });
        }).pipe(Effect.provide(h.layer));
        expect(h.direct).toEqual([]);
      }),
    ),
  );

  it.effect("reconciles a lost relay reply without asking the old environment for a receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const h = yield* harness(async (input, init) => {
          const req = new Request(input, init);
          calls.push(req.method + " " + new URL(req.url).pathname);
          if (req.method === "POST") throw new Error("Lost acknowledgement");
          return Response.json(pending);
        });
        yield* SubscriptionRef.set(h.supervisor.session, Option.none());
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          yield* Effect.flip(pauseThreadQueue({ threadId, commandId, createdAt }));
          const receipt = yield* getThreadCommandReceipt({ threadId, commandId });
          expect(receipt).toEqual({ relay: pending });
          expect(threadCommandAcceptance(receipt, commandId)).toEqual({ status: "accepted" });
          expect(threadCommandAcceptance(receipt, CommandId.make("another-command"))).toEqual({
            status: "unknown",
          });
        }).pipe(Effect.provide(h.layer));
        expect(calls).toEqual([
          "POST /v1/threads/portable/commands",
          "GET /v1/threads/portable/commands/stable-command",
        ]);
        expect(h.direct).toEqual([]);
      }),
    ),
  );

  it.effect("clears stale pending counts when relay access is denied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let denied = false;
        const h = yield* harness(async () =>
          denied
            ? Response.json(
                {
                  _tag: "RelayTenancyNotFoundError",
                  code: "tenancy_not_found",
                  reason: "thread_not_found",
                  traceId: "trace",
                },
                { status: 404 },
              )
            : Response.json({ entries: [pending], hasMore: false }),
        );
        const commands = createPortableThreadCommandAtoms(Atom.runtime(h.layer), () =>
          Atom.make(snapshot),
        );
        const query = commands.pendingAtom(environmentId, threadId);
        yield* AtomRegistry.mount(h.registry, query);
        yield* AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
        expect(
          h.registry.get(commands.viewAtom(environmentId, threadId))?.waitingForEnvironment,
        ).toBe(1);
        denied = true;
        h.registry.refresh(query);
        yield* Effect.flip(AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true }));
        const state = h.registry.get(commands.viewAtom(environmentId, threadId));
        expect(state?.waitingForEnvironment).toBe(0);
        expect(state?.hasMore).toBe(false);
        expect(state?.error).not.toBeNull();
      }),
    ),
  );

  it.effect("rejects an account change while obtaining a token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(async () => {
          throw new Error("No HTTP allowed");
        });
        h.registry.set(managedRelaySessionAtom, {
          accountId: "account",
          readClerkToken: () =>
            Effect.sync(() => {
              h.registry.set(managedRelaySessionAtom, null);
              return "token";
            }),
        });
        yield* Effect.gen(function* () {
          const routing = yield* ThreadCommandRouting;
          routing!.remember(snapshot, environmentId);
          expect(
            (yield* Effect.flip(pauseThreadQueue({ threadId, commandId, createdAt }))).message,
          ).toContain("Sign in again");
          expect(h.direct).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
});
