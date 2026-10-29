import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderAccountAuthError,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  RelayThreadVmProviderAuth,
  type ThreadVmProviderAuthControl,
} from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAuthServiceLive } from "../provider/Layers/ProviderAuthService.ts";
import {
  makeThreadVmCodexAuth,
  parseCodexDeviceSignIn,
  threadVmCodexAuthServiceLayer,
} from "./ThreadVmCodexAuth.ts";
import { THREAD_VM_IDENTITY_SECRET, type InstalledThreadVm } from "./ThreadVmEnrollment.ts";
import {
  THREAD_VM_PROVIDER_AUTH_PATH,
  threadVmProviderAuthRouteLayer,
} from "./ThreadVmProviderAuth.ts";

const instanceId = ProviderInstanceId.make("codex"),
  driver = ProviderDriverKind.make("codex");
const codeOutput =
  "Open this link in your browser:\nhttps://auth.openai.com/codex/device\n\nThen enter this code:\nN20N-IKIRK\n";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAuth = Schema.decodeUnknownEffect(RelayThreadVmProviderAuth);
const unused = () => Effect.die("Sign-in must not execute a thread");
const harness = Effect.gen(function* () {
  const complete = yield* Deferred.make<void>(),
    stopped = yield* Deferred.make<void>(),
    emitted = yield* Deferred.make<void>();
  let attempts = 0,
    authenticated = false;
  const status = (): ServerProvider => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "0.159.3",
    status: "ready",
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-10-13T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  });
  const accountAuth = {
    login: Stream.unwrap(
      Effect.sync(() => {
        attempts++;
        return Stream.concat(
          Stream.fromIterable(
            codeOutput
              .match(/.{1,7}|\n/gu)!
              .map((text) => ({ type: "output" as const, stream: "stderr" as const, text })),
          ),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(Stream.drain),
            Stream.fromEffect(Deferred.await(complete)).pipe(Stream.drain),
          ),
        ).pipe(Stream.ensuring(Deferred.succeed(stopped, undefined)));
      }),
    ),
    logout: Effect.void,
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    enabled: true,
    continuationIdentity: { driverKind: driver, continuationKey: "test" },
    displayName: undefined,
    accountAuth,
    snapshot: {
      getSnapshot: Effect.sync(status),
      refresh: Effect.sync(status),
      resolveMaintenance: unused,
      streamChanges: Stream.empty,
      applyUsageLimits: unused,
    },
    textGeneration: {
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generateApprovalVerdict: unused,
    },
    adapter: {
      provider: driver,
      capabilities: { sessionModelSwitch: "in-session" },
      hasSession: () => Effect.succeed(false),
      startSession: unused,
      stopSession: unused,
      sendTurn: unused,
      interruptTurn: unused,
      respondToRequest: unused,
      respondToUserInput: unused,
      listSessions: unused,
      readThread: unused,
      rollbackThread: unused,
      stopAll: unused,
      streamEvents: Stream.empty,
    },
  };
  let currentInstance = instance;
  const changes = yield* PubSub.unbounded<void>();
  const services = Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: () => Effect.sync(() => currentInstance),
      listInstances: Effect.sync(() => [currentInstance]),
      subscribeChanges: PubSub.subscribe(changes),
    }),
    Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]), stopSession: unused }),
    Layer.mock(ProviderSessionDirectory)({ listBindings: () => Effect.succeed([]) }),
  );
  const auth = Context.get(
    yield* Layer.build(threadVmCodexAuthServiceLayer.pipe(Layer.provide(services))),
    ProviderAuthService,
  );
  const phase = (phase: "waiting" | "succeeded", owner = "owner") =>
    auth.subscribe({ instanceId }, owner).pipe(
      Stream.filter((s) => s.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    auth,
    services,
    phase,
    stopped,
    emitted,
    attempts: () => attempts,
    replaceInstance: (personal: boolean) =>
      Effect.sync(() => {
        currentInstance = personal ? { ...instance } : { ...instance, accountAuth: undefined };
      }),
    finish: Effect.sync(() => {
      authenticated = true;
    }).pipe(Effect.andThen(Deferred.succeed(complete, undefined))),
  };
});

describe("VM-only structured native Codex sign-in", () => {
  it.effect("drops a replaced personal auth controller and cancels its old device process", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const previous = yield* f.auth.start({ instanceId }, "owner");
      yield* f.phase("waiting");
      yield* Deferred.await(f.emitted);
      yield* f.replaceInstance(false);
      const unavailable = yield* f.auth
        .subscribe({ instanceId }, "owner")
        .pipe(Stream.runHead, Effect.flip);
      expect(unavailable.detail).toContain("does not support sign-in");
      yield* Deferred.await(f.stopped);
      expect(f.attempts()).toBe(1);
      yield* f.replaceInstance(true);
      const next = yield* f.auth.start({ instanceId }, "owner");
      yield* f.phase("waiting");
      expect(next.flowId).not.toBe(previous.flowId);
      expect(f.attempts()).toBe(2);
      yield* f.auth.cancel({ instanceId, flowId: next.flowId! }, "owner");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "binds the guest sign-in service to the real router across requests without replacing ordinary auth",
    () =>
      Effect.gen(function* () {
        const f = yield* harness,
          sql = yield* SqlClient.SqlClient,
          config = yield* ServerConfig;
        const vm: InstalledThreadVm = {
          operationId: "integration-move",
          environmentId: EnvironmentId.make("integration-vm"),
          scope: {
            allocationId: "integration-allocation",
            threadId: ThreadId.make("integration-thread"),
            repositoryId: "integration-repository",
            generation: 4,
          },
          relayUrl: "https://relay.test",
          relayIssuer: "https://relay.test",
          environmentCredential: "fixture-guest-secret-must-not-leak",
          cloudMintPublicKey: "fixture-public-key",
        };
        const binding = {
          operationId: vm.operationId,
          allocationId: vm.scope.allocationId,
          environmentId: vm.environmentId,
          generation: vm.scope.generation,
          instanceId: "codex" as const,
        };
        yield* sql`INSERT INTO thread_execution_fences(thread_id,relay_url,environment_id,project_id,generation,operation_id,phase)
          VALUES(${vm.scope.threadId},${vm.relayUrl},${vm.environmentId},${`vm:${vm.scope.threadId}`},4,${vm.operationId},'frozen')`;
        const dependencies = Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          NodeCrypto.layer,
          f.services,
          Layer.succeed(ServerConfig, {
            ...config,
            host: "127.0.0.1",
            baseDir: "/home/user/.launchpad",
          }),
          Layer.mock(ServerSecretStore)({
            get: (key) =>
              Effect.succeed(
                key === THREAD_VM_IDENTITY_SECRET
                  ? Option.some(new TextEncoder().encode(encode(vm)))
                  : Option.none(),
              ),
          }),
        );
        const ordinaryRoute = HttpRouter.add(
          "GET",
          "/ordinary-auth",
          Effect.gen(function* () {
            const service = yield* ProviderAuthService;
            yield* service.subscribe({ instanceId }, "ordinary-client").pipe(Stream.runHead);
            return HttpServerResponse.text("unexpected guest controller");
          }).pipe(
            Effect.catchTag("ProviderSetupError", () =>
              Effect.succeed(
                HttpServerResponse.text("ordinary auth is unchanged", { status: 403 }),
              ),
            ),
          ),
        );
        const router = HttpRouter.toWebHandler(
          Layer.mergeAll(threadVmProviderAuthRouteLayer, ordinaryRoute).pipe(
            Layer.provideMerge(ProviderAuthServiceLive),
            Layer.provideMerge(dependencies),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => router.dispose()));
        const request = Effect.fnUntraced(function* (
          action: ThreadVmProviderAuthControl["action"],
          flowId?: string,
        ) {
          const response = yield* Effect.promise(() =>
            router.handler(
              new Request(`http://127.0.0.1:3773${THREAD_VM_PROVIDER_AUTH_PATH}`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${vm.environmentCredential}`,
                  "content-type": "application/json",
                },
                body: encode({ action, binding, ...(flowId ? { flowId } : {}) }),
              }),
            ),
          );
          expect(response.status).toBe(200);
          const body: unknown = yield* Effect.promise(() => response.json());
          expect(encode(body)).not.toContain(vm.environmentCredential);
          return yield* decodeAuth(body);
        });
        const idle = yield* request("status");
        expect(idle.requirement).toBe("sign_in_required");
        expect(idle.auth.phase).toBe("idle");
        expect(f.attempts()).toBe(0);
        const first = yield* request("start");
        yield* Deferred.await(f.emitted);
        const waiting = yield* request("status");
        expect(waiting.auth.flowId).toBe(first.auth.flowId);
        expect(waiting.auth.interaction).toMatchObject({
          type: "deviceCode",
          userCode: "N20N-IKIRK",
        });
        const retry = yield* request("start");
        expect(retry.auth.flowId).toBe(first.auth.flowId);
        expect(f.attempts()).toBe(1);
        const cancelled = yield* request("cancel", first.auth.flowId!);
        expect(cancelled.auth.phase).toBe("cancelled");
        expect(cancelled.auth.interaction).toBeNull();
        expect((yield* request("status")).auth.phase).toBe("cancelled");
        expect((yield* request("cancel", first.auth.flowId!)).auth.phase).toBe("cancelled");
        yield* Deferred.await(f.stopped);
        const ordinary = yield* Effect.promise(() =>
          router.handler(new Request("http://127.0.0.1:3773/ordinary-auth")),
        );
        expect(ordinary.status).toBe(403);
        expect(yield* Effect.promise(() => ordinary.text())).toBe("ordinary auth is unchanged");
        const denied = yield* Effect.promise(() =>
          router.handler(
            new Request(`http://127.0.0.1:3773${THREAD_VM_PROVIDER_AUTH_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encode({ action: "status", binding }),
            }),
          ),
        );
        expect(denied.status).toBe(404);
        expect(yield* Effect.promise(() => denied.text())).not.toContain("N20N-IKIRK");
        expect((yield* makeThreadExecutionFence(sql).get(vm.scope.threadId))?.phase).toBe("frozen");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          SqlitePersistenceMemory.pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "vm-auth-route-" })),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
  it("recognizes the pinned CLI output and refuses untrusted URLs or token-looking text", () => {
    expect(parseCodexDeviceSignIn(codeOutput)).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "N20N-IKIRK",
    });
    expect(
      parseCodexDeviceSignIn(codeOutput.replace("N20N-IKIRK", "\u001b[1mN20N-IKIRK\u001b[0m")),
    ).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "N20N-IKIRK" });
    for (const url of [
      "https://auth.openai.com.evil.test/codex/device",
      "https://user@auth.openai.com/codex/device",
      "https://auth.openai.com/codex/device?token=secret",
      "http://auth.openai.com/codex/device",
      "https://auth.openai.com/other",
    ])
      expect(
        parseCodexDeviceSignIn(codeOutput.replace("https://auth.openai.com/codex/device", url)),
      ).toBeNull();
    expect(
      parseCodexDeviceSignIn(codeOutput.replace("N20N-IKIRK", "a-secret-access-token")),
    ).toBeNull();
  });
  it.effect(
    "adapts Codex's existing raw login through the real service, preserving flow/privacy/retry behavior",
    () =>
      Effect.gen(function* () {
        const f = yield* harness;
        const first = yield* f.auth.start({ instanceId }, "owner");
        const waiting = yield* f.phase("waiting");
        expect(waiting.interaction).toEqual({
          type: "deviceCode",
          id: first.flowId,
          url: "https://auth.openai.com/codex/device",
          userCode: "N20N-IKIRK",
        });
        const retry = yield* f.auth.start({ instanceId }, "owner");
        expect(retry.flowId).toBe(first.flowId);
        expect(f.attempts()).toBe(1);
        const other = yield* f.auth
          .subscribe({ instanceId }, "other")
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(other.interaction).toBeNull();
        expect(other.flowId).toBeNull();
        expect(other.authorizationUrl).toBeNull();
        yield* f.finish;
        expect((yield* f.phase("succeeded")).message).toBe("Sign-in complete.");
        yield* Deferred.await(f.stopped);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("cancels the native stream and exposes only a safe failure", () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const first = yield* f.auth.start({ instanceId }, "owner");
      yield* f.phase("waiting");
      expect((yield* f.auth.cancel({ instanceId, flowId: first.flowId! }, "owner")).phase).toBe(
        "cancelled",
      );
      yield* Deferred.await(f.stopped);
      const auth = yield* makeThreadVmCodexAuth(
        {
          login: Stream.fail(
            new ServerProviderAccountAuthError({
              instanceId,
              reason: "command_failed",
              detail: "private-token-must-not-leak",
            }),
          ),
          logout: Effect.void,
        },
        Effect.succeed(false),
      );
      yield* auth.start("owner");
      const failed = yield* auth.subscribe("owner").pipe(
        Stream.filter((s) => s.phase === "failed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(encode(failed)).not.toContain("private-token-must-not-leak");
      expect(failed.message).toBe("Codex sign-in failed. Start again.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
