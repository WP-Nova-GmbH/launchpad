import { CodexVmConnectionError, type RelayCodexVmToken } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

export class ThreadVmCodexTokenError extends Schema.TaggedError<ThreadVmCodexTokenError>()(
  "ThreadVmCodexTokenError",
  { reason: Schema.Literals(["not_managed", "not_connected", "selection_changed", "unavailable"]) },
) {
  override get message() {
    switch (this.reason) {
      case "not_managed":
        return "Organization Codex is not selected for this VM.";
      case "not_connected":
        return "Reconnect the organization's Codex account in Organization settings before starting work.";
      case "selection_changed":
        return "This VM's Codex account selection changed. Finish VM preparation before starting work.";
      case "unavailable":
        return "Could not obtain the organization's Codex access token. Check Launchpad Connect and retry.";
    }
  }
}
const failed = (reason: ThreadVmCodexTokenError["reason"]) =>
  new ThreadVmCodexTokenError({ reason });
const isTokenError = Schema.is(ThreadVmCodexTokenError);
const isConnectionError = Schema.is(CodexVmConnectionError);
const sanitizeError = (error: unknown) => {
  if (isTokenError(error)) return error;
  if (isConnectionError(error) && ["not_connected", "invalid_grant"].includes(error.reason))
    return failed("not_connected");
  return failed("unavailable");
};

/** Pending is a durable shared-renewal claim, not permission to refresh the grant ourselves. */
export function waitForThreadVmCodexToken<E, R>(
  connectionId: string,
  request: Effect.Effect<RelayCodexVmToken, E, R>,
): Effect.Effect<Redacted.Redacted<string>, ThreadVmCodexTokenError, R> {
  return Effect.gen(function* () {
    while (true) {
      const response = yield* request;
      if (response.status === "pending") {
        yield* Effect.sleep(response.retryAfterMs);
        continue;
      }
      if (response.connectionId !== connectionId) return yield* failed("selection_changed");
      if (
        Date.parse(response.expiresAt) <= (yield* DateTime.now).epochMilliseconds ||
        !Number.isFinite(Date.parse(response.expiresAt)) ||
        !/^[\x21-\x7e]+$/u.test(response.token)
      )
        return yield* failed("unavailable");
      return Redacted.make(response.token);
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(failed("unavailable")),
    }),
    Effect.mapError(sanitizeError),
    Effect.withTracerEnabled(false),
  );
}

/** Access tokens exist only in process memory/stdout. Never read or write a personal provider store. */
export const mintThreadVmCodexToken = Effect.fnUntraced(
  function* (connectionId: string) {
    const vm = yield* readInstalledThreadVm();
    if (!vm) return yield* failed("not_managed");
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const url = normalizeSecureRelayUrl(vm.relayUrl),
      issuer = normalizeSecureRelayUrl(vm.relayIssuer);
    if (environmentId !== vm.environmentId || !url || !issuer)
      return yield* failed("selection_changed");
    // The token endpoint checks the current selection and binding before and after renewal.
    const client = yield* makeExecutorRelayApiClient({
      url,
      issuer,
      environmentCredential: vm.environmentCredential,
    });
    return yield* waitForThreadVmCodexToken(
      connectionId,
      client.threadVmCodexAuth.codexAuthToken({
        params: { environmentId, threadId: vm.scope.threadId },
        payload: { generation: vm.scope.generation, connectionId },
      }),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(failed("unavailable")),
      }),
      Effect.mapError(sanitizeError),
      Effect.withTracerEnabled(false),
    ),
);
