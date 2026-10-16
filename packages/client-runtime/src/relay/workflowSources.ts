import {
  RelayApi,
  WorkflowSourceError,
  type RelayRepositoryId,
  type BeginWorkflowSource,
  type DisconnectWorkflowSource,
  type AllowWorkflowSource,
  type WorkflowSourceMetadataQuery,
  RelayAuthInvalidError,
  RelayTenancyForbiddenError,
  RelayTenancyNotFoundError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import {
  bearerHeaders,
  relayRequestError,
  timeoutRelayRequest,
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
} from "./managedRelay.ts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

const isSourceError = Schema.is(WorkflowSourceError);

const finish = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isSourceError(error)
        ? error
        : relayRequestError("workflow sources")(
            error as Parameters<ReturnType<typeof relayRequestError>>[0],
          ),
    ),
    timeoutRelayRequest("workflow sources"),
  );
/** Uses the configured relay and existing bearer transport on web, desktop and mobile. */
export const client = Effect.gen(function* () {
  const { relayUrl } = yield* ManagedRelayTenancyClient;
  if (normalizeSecureRelayUrl(relayUrl) === null)
    return yield* new ManagedRelayUrlInvalidError({ relayUrl });
  const { workflowSources: api } = yield* HttpApiClient.make(RelayApi, { baseUrl: relayUrl });
  return {
    owner: (token: string) => finish(api.owner({ headers: bearerHeaders(token) })),
    begin: (token: string, payload: typeof BeginWorkflowSource.Type) =>
      finish(api.begin({ headers: bearerHeaders(token), payload })),
    cancel: (token: string, attemptId: string) =>
      finish(api.cancel({ headers: bearerHeaders(token), payload: { attemptId } })),
    disconnect: (token: string, payload: typeof DisconnectWorkflowSource.Type) =>
      finish(api.disconnect({ headers: bearerHeaders(token), payload })),
    refreshOwner: (token: string, connectionId: string) =>
      finish(api.refreshOwner({ headers: bearerHeaders(token), payload: { connectionId } })),
    repository: (token: string, repositoryId: RelayRepositoryId) =>
      finish(api.repository({ headers: bearerHeaders(token), params: { repositoryId } })),
    health: (token: string, repositoryId: RelayRepositoryId) =>
      finish(api.health({ headers: bearerHeaders(token), params: { repositoryId } })),
    allow: (
      token: string,
      repositoryId: RelayRepositoryId,
      payload: typeof AllowWorkflowSource.Type,
    ) => finish(api.allow({ headers: bearerHeaders(token), params: { repositoryId }, payload })),
    withdraw: (token: string, repositoryId: RelayRepositoryId, grantId: string) =>
      finish(
        api.withdraw({
          headers: bearerHeaders(token),
          params: { repositoryId },
          payload: { grantId },
        }),
      ),
    withdrawOwner: (token: string, grantId: string) =>
      finish(api.withdrawOwner({ headers: bearerHeaders(token), payload: { grantId } })),
    refreshRepository: (token: string, repositoryId: RelayRepositoryId, grantId: string) =>
      finish(
        api.refreshRepository({
          headers: bearerHeaders(token),
          params: { repositoryId },
          payload: { grantId },
        }),
      ),
    metadata: (
      token: string,
      repositoryId: RelayRepositoryId,
      payload: WorkflowSourceMetadataQuery,
    ) => finish(api.metadata({ headers: bearerHeaders(token), params: { repositoryId }, payload })),
  };
});
export type Client = Effect.Success<typeof client>;
const isRequestFailed = Schema.is(ManagedRelayRequestFailedError);
const rejected = Schema.is(
  Schema.Union([RelayAuthInvalidError, RelayTenancyForbiddenError, RelayTenancyNotFoundError]),
);
export const accessRejected = (error: unknown) =>
  isSourceError(error)
    ? ["forbidden", "not_found"].includes(error.code)
    : isRequestFailed(error) && rejected(error.cause);
export const sourceHealthLabel = (source: { status: string; health: { code: string } }) =>
  source.status === "disconnected"
    ? "Disconnected"
    : source.status === "reconnect_required"
      ? "Owner reconnect required"
      : source.health.code === "service_configuration"
        ? "Service configuration needs attention"
        : source.health.code === "rate_limited"
          ? "Waiting for Linear rate limit"
          : source.health.code === "unavailable"
            ? "Linear unavailable"
            : "Connected";

export const sourceDeliveryLabel = (source: { delivery: string }) =>
  source.delivery === "verified"
    ? "Event delivery verified for observed teams."
    : "Event delivery is not verified.";
