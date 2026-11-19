import * as NodeCrypto from "node:crypto";
import { ProviderDriverKind, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import {
  RelayThreadVmProviderAuth,
  ThreadVmProviderAuthControl,
  type RelayThreadVmProviderAuthBinding,
  type ThreadMoveWaitingForAuth,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { readInstalledThreadVm, type InstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { threadVmCodexAuthServiceLayer } from "./ThreadVmCodexAuth.ts";
import {
  ThreadVmCodexAuthContext,
  type ThreadVmCodexAuthSourceError,
} from "./ThreadVmCodexAuthSource.ts";
import { ProviderInstanceRegistryMutator } from "../provider/Services/ProviderInstanceRegistryMutator.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Layer from "effect/Layer";

export const THREAD_VM_PROVIDER_AUTH_PATH = "/api/internal/thread-vm/provider-auth";
export class ThreadVmProviderAuthError extends Schema.TaggedError<ThreadVmProviderAuthError>()(
  "ThreadVmProviderAuthError",
  {},
) {}
const fail = () => new ThreadVmProviderAuthError();
const instanceId = ProviderInstanceId.make("codex");

export type ThreadVmAuthReadiness =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Waiting"; readonly reason: ThreadMoveWaitingForAuth }
  | { readonly _tag: "Unavailable"; readonly message: string };

const authWaitingReason = (
  error: ThreadVmCodexAuthSourceError,
): ThreadMoveWaitingForAuth | undefined => {
  switch (error.reason) {
    case "account_selection_required":
    case "selection_changed":
      return "account_selection";
    case "reconnect_required":
      return "organization_connection";
    default:
      return undefined;
  }
};
const controlResult = (
  reply: RelayThreadVmProviderAuth,
  waitingForAuth?: ThreadMoveWaitingForAuth,
): { reply: RelayThreadVmProviderAuth; readiness: ThreadVmAuthReadiness } => ({
  reply,
  readiness: waitingForAuth
    ? { _tag: "Waiting", reason: waitingForAuth }
    : reply.requirement === "authenticated"
      ? { _tag: "Ready" }
      : reply.requirement === "sign_in_required"
        ? {
            _tag: "Waiting",
            reason: ["starting", "verifying"].includes(reply.auth.phase)
              ? "verification"
              : "personal_sign_in",
          }
        : {
            _tag: "Unavailable",
            message: reply.auth.message ?? "This VM's Codex provider is not ready.",
          },
});

/** A pending guest can change only its own Codex sign-in. This grants no thread execution. */
const inspectThreadVmProviderAuth = Effect.fn("ThreadVmProviderAuth.inspect")(
  function* (vm: InstalledThreadVm, input: ThreadVmProviderAuthControl) {
    const binding = input.binding;
    if (
      vm.scope.generation <= 1 ||
      vm.environmentId !== binding.environmentId ||
      vm.operationId !== binding.operationId ||
      vm.scope.allocationId !== binding.allocationId ||
      vm.scope.generation !== binding.generation
    )
      return yield* fail();
    const fence = yield* makeThreadExecutionFence(yield* SqlClient.SqlClient).get(
      vm.scope.threadId,
    );
    if (
      fence &&
      (fence.phase !== "frozen" ||
        fence.operationId !== vm.operationId ||
        fence.generation !== vm.scope.generation ||
        fence.environmentId !== vm.environmentId ||
        fence.relayUrl !== vm.relayUrl ||
        fence.projectId !== `vm:${vm.scope.threadId}`)
    )
      return yield* fail();
    const registry = yield* ProviderInstanceRegistry;
    const service = yield* ProviderAuthService;
    const source = yield* ThreadVmCodexAuthContext;
    const owner = `thread-vm-auth:${binding.operationId}:${binding.allocationId}:${binding.generation}`;
    const unavailable = (
      message: string,
      waitingForAuth?: ThreadMoveWaitingForAuth,
      authSource?: RelayThreadVmProviderAuth["authSource"],
    ) =>
      controlResult(
        {
          ...binding,
          requirement: "provider_unavailable" as const,
          auth: {
            instanceId,
            phase: "failed" as const,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            interaction: null,
            message,
          },
          ...(authSource ? { authSource } : {}),
        },
        waitingForAuth,
      );
    const changed = yield* source.refresh.pipe(Effect.result);
    if (changed._tag === "Failure")
      return unavailable(changed.failure.message, authWaitingReason(changed.failure));
    if (changed.success) {
      const prior = yield* service.subscribe({ instanceId }, owner).pipe(
        Stream.runHead,
        Effect.orElseSucceed(() => Option.none()),
      );
      if (
        Option.isSome(prior) &&
        prior.value.flowId &&
        ["starting", "waiting", "verifying"].includes(prior.value.phase)
      )
        yield* service.cancel({ instanceId, flowId: prior.value.flowId }, owner);
      const mutator = yield* Effect.serviceOption(ProviderInstanceRegistryMutator);
      const settings = yield* Effect.serviceOption(ServerSettingsService);
      if (Option.isNone(mutator) || Option.isNone(settings))
        return unavailable("This VM cannot reload its Codex account. Restart VM preparation.");
      const config = yield* settings.value.getSettings;
      yield* mutator.value.reconcile(deriveProviderInstanceConfigMap(config), {
        rebuildDrivers: new Set([ProviderDriverKind.make("codex")]),
      });
    }
    const selected = yield* source.current.pipe(Effect.result);
    if (selected._tag === "Failure")
      return unavailable(selected.failure.message, authWaitingReason(selected.failure));
    const instance = yield* registry.getInstance(instanceId);
    if (instance) yield* source.markApplied;
    if (selected.success) {
      const managed = selected.success;
      const connection = yield* managed.status.pipe(Effect.result);
      if (connection._tag === "Failure")
        return unavailable(connection.failure.message, authWaitingReason(connection.failure));
      const authSource = {
        mode: "organization" as const,
        connectionId: managed.connectionId,
        connection: connection.success,
      };
      if (input.action !== "status")
        return unavailable(
          "This VM uses the organization's Codex account. Change its account source in VM preparation; device sign-in is unavailable.",
          undefined,
          authSource,
        );
      if (connection.success.errorCode === "configuration_error")
        return unavailable(
          "The organization's Codex connection needs a configuration check.",
          undefined,
          authSource,
        );
      if (connection.success.status !== "connected")
        return unavailable(
          "Reconnect the organization's Codex account in Organization settings.",
          "organization_connection",
          authSource,
        );
      if (!instance?.enabled || instance.driverKind !== "codex")
        return unavailable("This VM needs an enabled Codex provider.", undefined, authSource);
      const snapshot = yield* instance.snapshot.refresh;
      const ready =
        snapshot.installed &&
        snapshot.status === "ready" &&
        snapshot.auth.status === "authenticated" &&
        connection.success.status === "connected";
      return controlResult(
        {
          ...binding,
          authSource,
          requirement: ready ? ("authenticated" as const) : ("provider_unavailable" as const),
          auth: {
            instanceId,
            phase: ready ? ("succeeded" as const) : ("failed" as const),
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            interaction: null,
            message: ready
              ? `Using the organization's Codex account (${managed.label}).`
              : (snapshot.message ??
                (!snapshot.installed
                  ? "This VM needs an installed Codex provider."
                  : connection.success.status !== "connected"
                    ? "Reconnect the organization's Codex account in Organization settings."
                    : "This VM's Codex provider is not ready. Check its configuration and retry.")),
          },
        },
        !ready && connection.success.refreshing ? "verification" : undefined,
      );
    }
    if (
      !instance ||
      !instance.enabled ||
      instance.driverKind !== "codex" ||
      (!instance.auth && !instance.accountAuth)
    )
      return unavailable("This VM needs an enabled Codex provider with device sign-in support.");
    const status = yield* instance.snapshot.refresh;
    if (!status.installed) return unavailable("This VM needs an installed Codex provider.");
    // Stable across HTTP/E2B retries and relay restarts, private to this exact guest operation.
    const current = yield* service.subscribe({ instanceId }, owner).pipe(Stream.runHead);
    if (Option.isNone(current)) return yield* fail();
    let auth: ProviderAuthState = current.value;
    if (input.action === "start" && status.auth.status !== "authenticated")
      auth = yield* service.start({ instanceId }, owner);
    if (input.action === "cancel") {
      if (!input.flowId) return yield* fail();
      // A lost cancellation reply must not cancel a later flow or force a new sign-in.
      if (!(auth.phase === "cancelled" && auth.flowId === input.flowId))
        auth = yield* service.cancel({ instanceId, flowId: input.flowId }, owner);
    }
    return controlResult({
      ...binding,
      authSource: { mode: "personal" as const },
      requirement:
        status.auth.status === "authenticated"
          ? ("authenticated" as const)
          : ("sign_in_required" as const),
      auth,
    });
  },
  (effect) => Effect.flatMap(ThreadVmCodexAuthContext, (source) => source.withReloadLock(effect)),
  Effect.mapError(fail),
);

/** Direct seam for callers already providing the guest controller's dependencies. */
export const controlThreadVmProviderAuth = Effect.fn("ThreadVmProviderAuth.control")(function* (
  vm: InstalledThreadVm,
  input: ThreadVmProviderAuthControl,
) {
  return (yield* inspectThreadVmProviderAuth(vm, input)).reply;
});

export class ThreadVmProviderAuth extends Context.Service<
  ThreadVmProviderAuth,
  {
    readonly control: (
      vm: InstalledThreadVm,
      input: ThreadVmProviderAuthControl,
    ) => Effect.Effect<RelayThreadVmProviderAuth, ThreadVmProviderAuthError>;
    readonly readiness: (
      vm: InstalledThreadVm,
      binding: RelayThreadVmProviderAuthBinding,
    ) => Effect.Effect<ThreadVmAuthReadiness, ThreadVmProviderAuthError>;
  }
>()("t3/relay/ThreadVmProviderAuth") {
  static readonly layer = Layer.effect(
    ThreadVmProviderAuth,
    Effect.suspend(() => makeThreadVmProviderAuth),
  ).pipe(Layer.provide(threadVmCodexAuthServiceLayer));
}

/** Capture the private device flow once; HTTP reads and move sweeps share its lifetime. */
export const makeThreadVmProviderAuth = Effect.gen(function* () {
  const context =
    yield* Effect.context<Effect.Services<ReturnType<typeof inspectThreadVmProviderAuth>>>();
  const inspect = (vm: InstalledThreadVm, input: ThreadVmProviderAuthControl) =>
    inspectThreadVmProviderAuth(vm, input).pipe(Effect.provideContext(context));
  return ThreadVmProviderAuth.of({
    control: (vm, input) => inspect(vm, input).pipe(Effect.map((result) => result.reply)),
    readiness: (vm, binding) =>
      inspect(vm, { action: "status", binding }).pipe(
        Effect.map((result) => result.readiness),
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () =>
            Effect.succeed<ThreadVmAuthReadiness>({
              _tag: "Unavailable",
              message: "Could not verify Codex sign-in within 45 seconds. The VM will retry.",
            }),
        }),
      ),
  });
});

/** Only the host management CLI knows this guest's installed narrow credential.
 * Browser/normal environment sessions and origins are never accepted here. */
export const handleThreadVmProviderAuthRequest = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (
    config.host !== "127.0.0.1" ||
    config.baseDir !== "/home/user/.launchpad" ||
    request.headers.origin
  )
    return HttpServerResponse.empty({ status: 404 });
  const vm = yield* readInstalledThreadVm();
  const received = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(vm ? `Bearer ${vm.environmentCredential}` : "");
  if (!vm || received.length !== expected.length || !NodeCrypto.timingSafeEqual(received, expected))
    return HttpServerResponse.empty({ status: 404 });
  const input = yield* HttpServerRequest.schemaBodyJson(ThreadVmProviderAuthControl);
  const controller = yield* ThreadVmProviderAuth;
  return yield* HttpServerResponse.json(yield* controller.control(vm, input), {
    headers: { "cache-control": "no-store" },
  });
}).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 409 }))));
export const threadVmProviderAuthRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const controller = yield* ThreadVmProviderAuth;
    // Route registration does not capture its service context. Bind this one
    // server-lifetime controller so requests share the guest's sign-in flow.
    yield* router.add(
      "POST",
      THREAD_VM_PROVIDER_AUTH_PATH,
      handleThreadVmProviderAuthRequest.pipe(
        Effect.provideService(ThreadVmProviderAuth, controller),
      ),
    );
  }),
).pipe(Layer.provide(ThreadVmProviderAuth.layer));
