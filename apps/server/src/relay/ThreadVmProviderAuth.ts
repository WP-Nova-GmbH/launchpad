import * as NodeCrypto from "node:crypto";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import { RelayThreadVmProviderAuth, ThreadVmProviderAuthControl } from "@t3tools/contracts/relay";
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
import * as Layer from "effect/Layer";

export const THREAD_VM_PROVIDER_AUTH_PATH = "/api/internal/thread-vm/provider-auth";
export class ThreadVmProviderAuthError extends Schema.TaggedError<ThreadVmProviderAuthError>()(
  "ThreadVmProviderAuthError",
  {},
) {}
const fail = () => new ThreadVmProviderAuthError();
const instanceId = ProviderInstanceId.make("codex");

/** A pending guest can change only its own Codex sign-in. This grants no thread execution. */
export const controlThreadVmProviderAuth = Effect.fn("ThreadVmProviderAuth.control")(function* (
  vm: InstalledThreadVm,
  input: ThreadVmProviderAuthControl,
) {
  const binding = input.binding;
  if (
    vm.scope.generation <= 1 ||
    vm.environmentId !== binding.environmentId ||
    vm.operationId !== binding.operationId ||
    vm.scope.allocationId !== binding.allocationId ||
    vm.scope.generation !== binding.generation
  )
    return yield* fail();
  const fence = yield* makeThreadExecutionFence(yield* SqlClient.SqlClient).get(vm.scope.threadId);
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
  const instance = yield* registry.getInstance(instanceId);
  const unavailable = (message: string) =>
    ({
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
    }) satisfies RelayThreadVmProviderAuth;
  if (
    !instance ||
    !instance.enabled ||
    instance.driverKind !== "codex" ||
    (!instance.auth && !instance.accountAuth)
  )
    return unavailable("This VM needs an enabled Codex provider with device sign-in support.");
  const status = yield* instance.snapshot.refresh;
  if (!status.installed) return unavailable("This VM needs an installed Codex provider.");
  const service = yield* ProviderAuthService;
  // Stable across HTTP/E2B retries and relay restarts, private to this exact guest operation.
  const owner = `thread-vm-auth:${binding.operationId}:${binding.allocationId}:${binding.generation}`;
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
  return {
    ...binding,
    requirement:
      status.auth.status === "authenticated"
        ? ("authenticated" as const)
        : ("sign_in_required" as const),
    auth,
  } satisfies RelayThreadVmProviderAuth;
}, Effect.mapError(fail));

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
  return yield* HttpServerResponse.json(yield* controlThreadVmProviderAuth(vm, input), {
    headers: { "cache-control": "no-store" },
  });
}).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 409 }))));
export const threadVmProviderAuthRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* ProviderAuthService;
    // Route registration does not capture its service context. Bind this one
    // server-lifetime controller so requests share the guest's sign-in flow.
    yield* router.add(
      "POST",
      THREAD_VM_PROVIDER_AUTH_PATH,
      handleThreadVmProviderAuthRequest.pipe(Effect.provideService(ProviderAuthService, auth)),
    );
  }),
).pipe(Layer.provide(threadVmCodexAuthServiceLayer));
