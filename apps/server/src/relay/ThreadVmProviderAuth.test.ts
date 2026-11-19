import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ThreadVmProviderAuthControl } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../provider/Services/ProviderInstanceRegistryMutator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { THREAD_VM_IDENTITY_SECRET, type InstalledThreadVm } from "./ThreadVmEnrollment.ts";
import {
  controlThreadVmProviderAuth,
  handleThreadVmProviderAuthRequest,
  makeThreadVmProviderAuth,
  ThreadVmProviderAuth,
} from "./ThreadVmProviderAuth.ts";
import {
  ThreadVmCodexAuthContext,
  ThreadVmCodexAuthSourceError,
  type ManagedThreadVmCodexAuthContext,
} from "./ThreadVmCodexAuthSource.ts";

const instanceId = ProviderInstanceId.make("codex"),
  driverKind = ProviderDriverKind.make("codex");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const vm: InstalledThreadVm = {
  operationId: "move",
  environmentId: EnvironmentId.make("vm"),
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repo",
    generation: 2,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "private-credential",
  cloudMintPublicKey: "public-key",
};
const input: ThreadVmProviderAuthControl = {
  action: "status",
  binding: {
    operationId: vm.operationId,
    allocationId: vm.scope.allocationId,
    environmentId: vm.environmentId,
    generation: vm.scope.generation,
    instanceId: "codex",
  },
};
const base = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "vm-auth-" })),
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.gen(function* () {
  const started = yield* Deferred.make<void>(),
    finish = yield* Deferred.make<void>();
  let attempts = 0;
  let cancellations = 0;
  let available = true;
  let status: ServerProvider = {
    instanceId,
    driver: driverKind,
    enabled: true,
    installed: true,
    version: "0.159.3",
    status: "ready",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-10-13T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const auth = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "provider", key: "guest-only" },
    methods: Effect.succeed([
      { id: "device", name: "Codex sign-in", description: null, type: "agent" },
    ]),
    authenticate: (_, context) =>
      Effect.gen(function* () {
        attempts++;
        yield* context.setInteraction({
          type: "deviceCode",
          id: "device",
          url: "https://auth.openai.com/codex/device",
          userCode: "TEST-CODE",
        });
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
        status = { ...status, auth: { status: "authenticated" } };
      }),
    logout: Effect.void,
  });
  const instance: ProviderInstance = {
    instanceId,
    driverKind,
    enabled: true,
    continuationIdentity: { driverKind, continuationKey: "test" },
    displayName: undefined,
    auth,
    snapshot: {
      getSnapshot: Effect.sync(() => status),
      refresh: Effect.sync(() => status),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
      resolveMaintenance: () => Effect.die("Unexpected maintenance"),
    },
    get adapter(): never {
      throw new Error("Sign-in must not start a thread");
    },
    get textGeneration(): never {
      throw new Error("Sign-in must not generate text");
    },
  };
  const services = Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: () => Effect.sync(() => (available ? instance : undefined)),
    }),
    Layer.mock(ProviderAuthService)({
      subscribe: (_, owner) => auth.subscribe(owner),
      start: (_, owner) => auth.start(owner),
      cancel: (request, owner) =>
        Effect.sync(() => {
          cancellations++;
        }).pipe(Effect.andThen(auth.cancel(owner, request.flowId))),
    }),
  );
  const run = (request = input) =>
    controlThreadVmProviderAuth(vm, request).pipe(Effect.provide(services));
  return {
    run,
    controller: makeThreadVmProviderAuth.pipe(Effect.provide(services)),
    started,
    finish,
    attempts: () => attempts,
    cancellations: () => cancellations,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setVersion: (version: string | null) => {
      status = { ...status, version };
    },
    setInstalled: (installed: boolean) => {
      status = { ...status, installed };
    },
    setStatus: (next: Partial<ServerProvider>) => {
      status = { ...status, ...next };
    },
    waitSuccess: auth.subscribe(`thread-vm-auth:move:allocation:2`).pipe(
      Stream.filter((s) => s.phase === "succeeded"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  };
});

describe("pending VM provider sign-in", () => {
  it.effect(
    "rebuilds an initially unavailable organization provider without a client request",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        f.setAvailable(false);
        f.setStatus({ auth: { status: "authenticated" } });
        const connection = {
          connectionId: "org-account",
          label: "Organization account",
          status: "connected" as const,
          epoch: 1,
          tokenRevision: 1,
          errorCode: null,
          refreshing: false,
        };
        const managed: ManagedThreadVmCodexAuthContext = {
          connectionId: connection.connectionId,
          label: connection.label,
          status: Effect.succeed(connection),
          preflight: Effect.void,
        };
        let selected = false,
          applied = false,
          rebuilds = 0;
        const absent = new ThreadVmCodexAuthSourceError({ reason: "account_selection_required" });
        const controller = yield* f.controller.pipe(
          Effect.provideService(ThreadVmCodexAuthContext, {
            current: Effect.suspend(() =>
              selected ? Effect.succeed(managed) : Effect.fail(absent),
            ),
            refresh: Effect.suspend(() =>
              selected ? Effect.succeed(!applied) : Effect.fail(absent),
            ),
            markApplied: Effect.sync(() => {
              applied = true;
            }),
            withReloadLock: (effect) => effect,
            personalPreflight: Effect.fail(absent),
          }),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ServerSettingsService)({
                getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              }),
              Layer.succeed(ProviderInstanceRegistryMutator, {
                reconcile: (_, options) =>
                  Effect.sync(() => {
                    expect(options?.rebuildDrivers?.has(driverKind)).toBe(true);
                    rebuilds++;
                    f.setAvailable(true);
                  }),
              }),
            ),
          ),
        );
        expect(yield* controller.readiness(vm, input.binding)).toEqual({
          _tag: "Waiting",
          reason: "account_selection",
        });
        selected = true;
        expect(yield* controller.readiness(vm, input.binding)).toEqual({ _tag: "Ready" });
        expect(yield* controller.readiness(vm, input.binding)).toEqual({ _tag: "Ready" });
        expect(rebuilds).toBe(1);
        expect(f.attempts()).toBe(0);
        expect(f.cancellations()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect("shares a private flow between UI controls and client-independent readiness", () =>
    Effect.gen(function* () {
      const f = yield* harness,
        controller = yield* f.controller;
      expect(yield* controller.readiness(vm, input.binding)).toEqual({
        _tag: "Waiting",
        reason: "personal_sign_in",
      });
      expect(f.attempts()).toBe(0);
      const first = yield* controller.control(vm, { ...input, action: "start" });
      yield* Deferred.await(f.started);
      expect(yield* controller.readiness(vm, input.binding)).toEqual({
        _tag: "Waiting",
        reason: "personal_sign_in",
      });
      expect((yield* controller.control(vm, input)).auth.flowId).toBe(first.auth.flowId);
      expect(f.attempts()).toBe(1);
      yield* Deferred.succeed(f.finish, undefined);
      yield* f.waitSuccess;
      expect(yield* controller.readiness(vm, input.binding)).toEqual({ _tag: "Ready" });
      expect(f.attempts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );

  for (const [reason, expected] of [
    ["account_selection_required", "account_selection"],
    ["reconnect_required", "organization_connection"],
    ["selection_changed", "account_selection"],
    ["unavailable", null],
    ["configuration", null],
    ["access_denied", null],
  ] as const)
    it.effect(`distinguishes ${reason} from personal sign-in`, () =>
      Effect.gen(function* () {
        const f = yield* harness,
          failure = new ThreadVmCodexAuthSourceError({ reason });
        const controller = yield* f.controller.pipe(
          Effect.provideService(ThreadVmCodexAuthContext, {
            current: Effect.fail(failure),
            refresh: Effect.fail(failure),
            markApplied: Effect.void,
            withReloadLock: (effect) => effect,
            personalPreflight: Effect.fail(failure),
          }),
        );
        const result = yield* controller.readiness(vm, input.binding);
        expect(result).toEqual(
          expected
            ? { _tag: "Waiting", reason: expected }
            : { _tag: "Unavailable", message: failure.message },
        );
        expect(f.attempts()).toBe(0);
        expect(f.cancellations()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(base)),
    );

  it.effect("bounds a blocked readiness check without cancelling an existing sign-in", () =>
    Effect.gen(function* () {
      const f = yield* harness,
        entered = yield* Deferred.make<void>();
      let blocked = false;
      const controller = yield* f.controller.pipe(
        Effect.provideService(ThreadVmCodexAuthContext, {
          current: Effect.succeed(null),
          refresh: Effect.succeed(false),
          markApplied: Effect.void,
          personalPreflight: Effect.void,
          withReloadLock: (effect) =>
            Effect.suspend(() =>
              blocked
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : effect,
            ),
        }),
      );
      const first = yield* controller.control(vm, { ...input, action: "start" });
      yield* Deferred.await(f.started);
      blocked = true;
      const pending = yield* controller.readiness(vm, input.binding).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("45 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Unavailable" });
      expect(f.cancellations()).toBe(0);
      blocked = false;
      expect((yield* controller.control(vm, input)).auth.flowId).toBe(first.auth.flowId);
      yield* controller.control(vm, { ...input, action: "cancel", flowId: first.auth.flowId! });
      expect(f.cancellations()).toBe(1);
      expect(f.attempts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );
  it.effect("uses organization connection metadata and rejects device sign-in actions", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      f.setStatus({ auth: { status: "authenticated" } });
      const connection = {
        connectionId: "managed-connection",
        label: "Organization account",
        status: "connected" as const,
        epoch: 1,
        tokenRevision: 1,
        errorCode: null,
        refreshing: false,
      };
      const managed: ManagedThreadVmCodexAuthContext = {
        connectionId: connection.connectionId,
        label: connection.label,
        status: Effect.succeed(connection),
        preflight: Effect.void,
      };
      const source = {
        current: Effect.succeed(managed),
        refresh: Effect.succeed(false),
        markApplied: Effect.void,
        withReloadLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        personalPreflight: Effect.void,
      };
      const status = yield* f.run().pipe(Effect.provideService(ThreadVmCodexAuthContext, source));
      expect(status).toMatchObject({
        requirement: "authenticated",
        authSource: { mode: "organization", connectionId: connection.connectionId },
        auth: { phase: "succeeded", interaction: null },
      });
      f.setStatus({
        status: "error",
        auth: { status: "unknown" },
        message: "Codex app-server probe failed. Check its configuration.",
      });
      const failedProbe = yield* f
        .run()
        .pipe(Effect.provideService(ThreadVmCodexAuthContext, source));
      expect(failedProbe).toMatchObject({
        requirement: "provider_unavailable",
        auth: {
          phase: "failed",
          message: "Codex app-server probe failed. Check its configuration.",
        },
      });
      f.setStatus({ status: "ready" });
      expect(
        (yield* f.run().pipe(Effect.provideService(ThreadVmCodexAuthContext, source))).requirement,
      ).toBe("provider_unavailable");
      for (const action of ["start", "cancel"] as const) {
        const result = yield* f
          .run({ ...input, action, flowId: "old-flow" })
          .pipe(Effect.provideService(ThreadVmCodexAuthContext, source));
        expect(result.requirement).toBe("provider_unavailable");
        expect(result.auth.message).toContain("device sign-in is unavailable");
      }
      expect(f.attempts()).toBe(0);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("keeps unavailable source discovery out of the personal device flow", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const failure = new ThreadVmCodexAuthSourceError({ reason: "unavailable" });
      const result = yield* f.run({ ...input, action: "start" }).pipe(
        Effect.provideService(ThreadVmCodexAuthContext, {
          current: Effect.fail(failure),
          refresh: Effect.fail(failure),
          markApplied: Effect.void,
          withReloadLock: (effect) => effect,
          personalPreflight: Effect.fail(failure),
        }),
      );
      expect(result.requirement).toBe("provider_unavailable");
      expect(result.auth.message).toContain("Could not verify");
      expect(f.attempts()).toBe(0);
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect(
    "discovers login without starting it and reuses the same code after a lost start reply",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        expect((yield* f.run()).requirement).toBe("sign_in_required");
        expect(f.attempts()).toBe(0);
        const first = yield* f.run({ ...input, action: "start" });
        yield* Deferred.await(f.started);
        const retry = yield* f.run({ ...input, action: "start" });
        expect(retry.auth.flowId).toBe(first.auth.flowId);
        expect(retry.auth.interaction).toMatchObject({ type: "deviceCode", userCode: "TEST-CODE" });
        expect(f.attempts()).toBe(1);
        expect(encodeJson(retry)).not.toContain(vm.environmentCredential);
        yield* Deferred.succeed(f.finish, undefined);
        yield* f.waitSuccess;
        expect((yield* f.run()).requirement).toBe("authenticated");
        yield* f.run({ ...input, action: "start" });
        expect(f.attempts()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect("cancels the exact flow idempotently and rejects a stale flow", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const first = yield* f.run({ ...input, action: "start" });
      yield* Deferred.await(f.started);
      const cancel = { ...input, action: "cancel" as const, flowId: first.auth.flowId! };
      expect((yield* f.run(cancel)).auth.phase).toBe("cancelled");
      expect((yield* f.run(cancel)).auth.phase).toBe("cancelled");
      expect(yield* f.run({ ...cancel, flowId: "stale" }).pipe(Effect.isFailure)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );

  for (const binding of [
    { ...input.binding, generation: 3 },
    { ...input.binding, allocationId: "other" },
    { ...input.binding, operationId: "other" },
    { ...input.binding, environmentId: EnvironmentId.make("other") },
  ]) {
    it.effect(`rejects stale guest identity ${JSON.stringify(binding)}`, () =>
      Effect.gen(function* () {
        const f = yield* harness;
        expect(yield* f.run({ action: "start", binding }).pipe(Effect.isFailure)).toBe(true);
        expect(f.attempts()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(base)),
    );
  }
  it.effect("does not control sign-in after local ownership has activated or changed", () =>
    Effect.gen(function* () {
      const f = yield* harness,
        sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase)
      VALUES('thread','https://relay.test','vm','vm:thread',2,'move','active')`;
      expect(yield* f.run({ ...input, action: "start" }).pipe(Effect.isFailure)).toBe(true);
      yield* sql`UPDATE thread_execution_fences SET phase='frozen',operation_id='different' WHERE thread_id='thread'`;
      expect(yield* f.run({ ...input, action: "start" }).pipe(Effect.isFailure)).toBe(true);
      expect((yield* makeThreadExecutionFence(sql).get("thread"))?.phase).toBe("frozen");
      expect(f.attempts()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect("allows sign-in with a different installed Codex version", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      f.setVersion("0.163.0-alpha.10.2");
      const state = yield* f.run({ ...input, action: "start" });
      yield* Deferred.await(f.started);
      expect(state.requirement).toBe("sign_in_required");
      expect(f.attempts()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );

  it.effect("reports missing Codex without starting login", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      f.setInstalled(false);
      const state = yield* f.run({ ...input, action: "start" });
      expect(state.requirement).toBe("provider_unavailable");
      expect(state.auth.message).toContain("installed Codex");
      expect(f.attempts()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(base)),
  );

  for (const headers of [
    {},
    { authorization: "Bearer other" },
    { authorization: `Bearer ${vm.environmentCredential}`, origin: "https://app.test" },
  ]) {
    it.effect(
      `rejects unauthenticated or browser control requests ${Object.keys(headers).join(",")}`,
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const response = yield* handleThreadVmProviderAuthRequest.pipe(
            Effect.provideService(ServerConfig, {
              ...config,
              host: "127.0.0.1",
              baseDir: "/home/user/.launchpad",
            }),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://127.0.0.1:3773/api/internal/thread-vm/provider-auth", {
                  method: "POST",
                  headers,
                  body: "not-json",
                }),
              ),
            ),
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(ServerSecretStore)({
                  get: (key) =>
                    Effect.succeed(
                      key === THREAD_VM_IDENTITY_SECRET
                        ? Option.some(new TextEncoder().encode(encodeJson(vm)))
                        : Option.none(),
                    ),
                }),
                Layer.mock(ProviderAuthService)({
                  start: () => Effect.die("Unauthorized request started auth"),
                }),
                Layer.mock(ProviderInstanceRegistry)({
                  getInstance: () => Effect.die("Unauthorized request reached registry"),
                }),
                Layer.mock(ThreadVmProviderAuth)({
                  control: () => Effect.die("Unauthorized request reached guest auth"),
                }),
              ),
            ),
          );
          expect(response.status).toBe(404);
        }).pipe(Effect.scoped, Effect.provide(base)),
    );
  }
});
