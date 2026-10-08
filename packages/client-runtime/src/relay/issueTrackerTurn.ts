import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import { ISSUE_TRACKER_WRITE_REQUEST_PREFIX, RelayApi } from "@t3tools/contracts/relay";
import { issueTrackerCommandDigest } from "@t3tools/shared/issueTrackerTurn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { ManagedRelayClient } from "./managedRelay.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";

export class IssueTrackerClientRegistry extends Context.Reference<
  AtomRegistry.AtomRegistry | undefined
>("@t3tools/client-runtime/relay/IssueTrackerClientRegistry", { defaultValue: () => undefined }) {}

/** The registry belongs to this client, including when it is connected to a local environment. */
export const authorizeIssueTrackerTurn = Effect.fn("issueTrackers.authorizeTurn")(function* (
  command: ClientOrchestrationCommand,
  expectedAccountId?: string | null,
) {
  const registry = yield* IssueTrackerClientRegistry;
  const session = registry?.get(managedRelaySessionAtom);
  const supervisor = yield* EnvironmentSupervisor;
  const fail = () =>
    new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message:
        "Could not authorize your personal connections. Check your account and send the prompt again.",
    });
  if (expectedAccountId !== undefined && expectedAccountId !== (session?.accountId ?? null)) {
    return yield* fail();
  }
  if (!session || !registry) return command;
  return yield* Effect.gen(function* () {
    const relay = yield* Effect.serviceOption(ManagedRelayClient);
    if (Option.isNone(relay)) return yield* fail();
    const token = yield* session.readClerkToken();
    if (!token || !("threadId" in command)) return yield* fail();
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: relay.value.relayUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    });
    const result = yield* client.issueTrackers.authorizeTurn({
      headers: { authorization: `Bearer ${token}` },
      payload: {
        environmentId: supervisor.target.environmentId,
        threadId: command.threadId,
        commandId: command.commandId,
        commandDigest: yield* issueTrackerCommandDigest(command),
        ...("runtimeMode" in command
          ? { runtimeMode: command.runtimeMode }
          : command.type === "thread.prompt.edit" && command.expectedRuntimeMode
            ? { runtimeMode: command.expectedRuntimeMode }
            : {}),
      },
    });
    if (registry.get(managedRelaySessionAtom) !== session) return yield* fail();
    return result.authorization
      ? { ...command, issueTrackerAuthorization: result.authorization }
      : command;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(fail()) }),
    Effect.mapError(fail),
  );
});

/** Personal issue changes are approved with the signed-in user's relay token. */
export const decideIssueTrackerWrite = Effect.fn("issueTrackers.decideWrite")(function* (
  requestId: string,
  decision: string,
) {
  if (!requestId.startsWith(ISSUE_TRACKER_WRITE_REQUEST_PREFIX)) return;
  const registry = yield* IssueTrackerClientRegistry;
  const session = registry?.get(managedRelaySessionAtom);
  const supervisor = yield* EnvironmentSupervisor;
  const fail = () =>
    new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message:
        "Could not approve this issue change with your personal account. Check your sign-in and try again.",
    });
  if (!session || !registry || (decision !== "accept" && decision !== "decline"))
    return yield* fail();
  return yield* Effect.gen(function* () {
    const relay = yield* Effect.serviceOption(ManagedRelayClient);
    if (Option.isNone(relay)) return yield* fail();
    const token = yield* session.readClerkToken();
    if (!token) return yield* fail();
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: relay.value.relayUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    });
    yield* client.issueTrackers.decideWrite({
      headers: { authorization: `Bearer ${token}` },
      payload: {
        operationId: requestId.slice(ISSUE_TRACKER_WRITE_REQUEST_PREFIX.length),
        decision: decision === "accept" ? "approve" : "reject",
      },
    });
    if (registry.get(managedRelaySessionAtom) !== session) return yield* fail();
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(fail()) }),
    Effect.mapError(fail),
  );
});
