import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import { RelayApi } from "@t3tools/contracts/relay";
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
