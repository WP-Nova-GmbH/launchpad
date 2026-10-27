import { threadVmOperationMatches } from "./E2BThreadVmRestoreAttempt.ts";
import { Sandbox, type SandboxInfo } from "e2b";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { type E2BThreadVmIdentity, inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";

type Renew = (
  sandboxId: string,
  timeoutMs: number,
  options: { apiUrl: string; sandboxUrl: string; apiKey: string; signal: AbortSignal },
) => Promise<void>;
const renewE2B: Renew = (sandboxId, timeoutMs, options) =>
  Sandbox.setTimeout(sandboxId, timeoutMs, options);
type Inspect = (
  sandboxId: string,
  options: { apiUrl: string; apiKey: string; signal: AbortSignal },
) => Promise<SandboxInfo>;
const inspectE2B: Inspect = (sandboxId, options) => Sandbox.getInfo(sandboxId, options);

/** Non-waking identity verification precedes the E2B timeout extension. */
export function makeE2BThreadVmLease(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  renew: Renew = renewE2B,
  inspect: Inspect = inspectE2B,
) {
  return Effect.fn("relay.thread_vm.renew_lease")(function* (
    sandboxId: string,
    identity: E2BThreadVmIdentity,
  ) {
    const requestedEnd = (yield* Clock.currentTimeMillis) + settings.timeoutMs;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        await inspectE2BThreadVmConnection(settings, sandboxId, identity, transport, signal);
        await renew(sandboxId, settings.timeoutMs, {
          apiUrl: settings.apiUrl,
          sandboxUrl: settings.sandboxUrl,
          apiKey: Redacted.value(settings.apiKey),
          signal,
        });
        const info = await inspect(sandboxId, {
          apiUrl: settings.apiUrl,
          apiKey: Redacted.value(settings.apiKey),
          signal,
        });
        if (
          info.sandboxId !== sandboxId ||
          info.state !== "running" ||
          info.metadata["launchpad.managed"] !== "thread-vm-v1" ||
          info.metadata["launchpad.allocation_id"] !== identity.scope.allocationId ||
          !threadVmOperationMatches(info.metadata, identity.operationId) ||
          info.metadata["launchpad.thread_id"] !== identity.scope.threadId ||
          info.metadata["launchpad.generation"] !== String(identity.scope.generation) ||
          !Number.isFinite(info.endAt.getTime()) ||
          info.endAt.getTime() < requestedEnd - 1_000
        )
          throw new Error("E2B did not confirm the requested finite VM lease.");
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "renew lease",
          message: "VM lease renewal could not be confirmed.",
        }),
    });
  });
}
