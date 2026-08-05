import * as NodeCrypto from "node:crypto";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudRelayConfigResult,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import {
  RelayCloudDispatchJobProofPayload,
  RelayCloudDispatchJobRequest,
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentDispatchJobResponseProofPayload,
  type RelayEnvironmentDispatchJobResponse as RelayEnvironmentDispatchJobResponseShape,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentMintResponse as RelayEnvironmentMintResponseShape,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
  RelayOkResponse,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_DISPATCH_JOB_REQUEST_TYP,
  RELAY_DISPATCH_JOB_RESPONSE_TYP,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { isSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { JobRunner } from "../jobs/Services/JobRunner.ts";
import { m0Workflow } from "../jobs/workflow.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  encodeEndpointRuntimeConfigJson,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";
import {
  readCliDesiredCloudLink,
  readCliDesiredLinkMode,
  setCliDesiredCloudLink,
} from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
const CLOUD_DISPATCH_JOB_JTI_PREFIX = "cloud-dispatch-job-jti-";
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

const failCloudCliTokenManagerError = (error: CliTokenManager.CloudCliTokenManagerError) =>
  failEnvironmentCloudInternalError(error.message)(error);

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    () =>
      new EnvironmentHttpInternalServerError({
        message: "T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
      }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.all(
    input.names.map((name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
            }),
          ),
    ),
  );
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay environment credential is required.",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Cloud user id is required.",
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly cloudUserId: string;
}): Effect.Effect<void, EnvironmentAuth.ServerAuthInternalError | EnvironmentHttpConflictError> {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({
          cause,
        }),
    ),
    Effect.flatMap((existing) => {
      if (Option.isNone(existing)) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing.value);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpConflictError({
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
            }),
          );
    }),
  );
}

function readInstalledCloudUserId(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({
          cause,
        }),
    ),
    Effect.flatMap((bytes) =>
      Option.isSome(bytes)
        ? Effect.succeed(bytesToString(bytes.value))
        : Effect.fail(new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({})),
    ),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

// A managed (Cloudflare tunnel) endpoint is provisioned by the relay and must
// point at a loopback origin. A manual endpoint is reached out of band (e.g.
// Tailscale) or not advertised at all for publish-only links, so it is not
// tied to the managed-tunnel scope.
export function isSupportedLinkProviderKind(request: RelayLinkProofRequest): boolean {
  return (
    request.endpoint.providerKind === "cloudflare_tunnel" ||
    request.endpoint.providerKind === "manual"
  );
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);
const decodeCloudDispatchJobProof = Schema.decodeUnknownEffect(RelayCloudDispatchJobProofPayload);

/** The key every relay → environment proof is verified against. */
function readCloudMintPublicKey(secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  return secrets
    .get(CLOUD_MINT_PUBLIC_KEY)
    .pipe(
      Effect.flatMap((bytes) =>
        Option.isSome(bytes)
          ? Effect.succeed(bytesToString(bytes.value))
          : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
      ),
    );
}

/** The issuer those proofs must carry; older links only stored the relay URL. */
function readCloudRelayIssuer(secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  return secrets
    .get(RELAY_ISSUER_SECRET)
    .pipe(
      Effect.flatMap((bytes) =>
        Option.isSome(bytes)
          ? Effect.succeed(bytesToString(bytes.value))
          : secrets
              .get(RELAY_URL_SECRET)
              .pipe(
                Effect.flatMap((fallbackBytes) =>
                  Option.isSome(fallbackBytes)
                    ? Effect.succeed(bytesToString(fallbackBytes.value))
                    : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                ),
              ),
      ),
    );
}

interface CloudHttpDependencies {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"];
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly cliTokenManager: CliTokenManager.CloudCliTokenManager["Service"];
  readonly httpClient: HttpClient.HttpClient;
}

const cloudHttpDependencies = Effect.gen(function* () {
  return {
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environment: yield* ServerEnvironment.ServerEnvironment,
    endpointRuntime: yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime,
    environmentAuth: yield* EnvironmentAuth.EnvironmentAuth,
    cliTokenManager: yield* CliTokenManager.CloudCliTokenManager,
    httpClient: yield* HttpClient.HttpClient,
  } satisfies CloudHttpDependencies;
});

const makeCloudLinkProof = Effect.fn("environment.cloud.makeLinkProof")(function* (
  dependencies: CloudHttpDependencies,
  request: RelayLinkProofRequest,
  requestUrl: string,
) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
  if (
    !isSupportedLinkProviderKind(request) ||
    !isAllowedEndpointOrigin({
      origin: request.origin,
      requestUrl,
    })
  ) {
    return yield* new EnvironmentHttpBadRequestError({
      message: "Invalid managed endpoint origin.",
    });
  }
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const descriptor = yield* dependencies.environment.getDescriptor;
  const payload = {
    iss: `t3-env:${descriptor.environmentId}`,
    aud: normalizeRelayIssuer(request.relayIssuer),
    sub: descriptor.environmentId,
    jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    iat: nowSeconds,
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge: request.challenge,
    descriptor,
    environmentId: descriptor.environmentId,
    environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
    endpoint: request.endpoint,
    origin: request.origin,
    scopes: linkProofScopes(request),
  } satisfies RelayEnvironmentLinkProofPayload;
  return yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_LINK_PROOF_TYP,
    payload,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({
          cause,
        }),
    ),
  );
});

const cloudLinkProofHandler = Effect.fn("environment.cloud.linkProof")(
  function* (dependencies: CloudHttpDependencies, request: RelayLinkProofRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = requestAbsoluteUrl(httpRequest);
    if (requestUrl === null || hasForwardedAuthorityHeaders(httpRequest)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Invalid managed endpoint origin.",
      });
    }
    const proof = yield* makeCloudLinkProof(dependencies, request, requestUrl);
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
);

const applyCloudRelayConfig = Effect.fn("environment.cloud.applyRelayConfig")(function* (
  dependencies: CloudHttpDependencies,
  payload: RelayEnvironmentConfigRequest,
) {
  yield* validateRelayConfigPayload(payload);
  yield* validateLinkedCloudUser({
    secrets: dependencies.secrets,
    cloudUserId: payload.cloudUserId,
  });
  yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
  const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(
    payload.endpointRuntime,
  );
  const ok =
    endpointRuntimeStatus.status === "disabled" || endpointRuntimeStatus.status === "running";
  if (!ok) {
    return yield* new EnvironmentCloudEndpointUnavailableError({
      message: "Managed endpoint runtime could not be started.",
      endpointRuntimeStatus,
    });
  }

  yield* dependencies.secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
  yield* dependencies.secrets.set(
    RELAY_ISSUER_SECRET,
    stringToBytes(payload.relayIssuer ?? payload.relayUrl),
  );
  yield* dependencies.secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
  yield* dependencies.secrets.set(
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    stringToBytes(payload.environmentCredential),
  );
  yield* dependencies.secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
  if (payload.endpointRuntime) {
    const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
    yield* dependencies.secrets.set(
      CLOUD_ENDPOINT_RUNTIME_CONFIG,
      stringToBytes(endpointRuntimeJson),
    );
  } else {
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  }
  return { ok, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
});

const cloudRelayConfigHandler = Effect.fn("environment.cloud.relayConfig")(
  function* (dependencies: CloudHttpDependencies, payload: RelayEnvironmentConfigRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    return yield* applyCloudRelayConfig(dependencies, payload);
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
  ),
  Effect.catchTag(
    "SchemaError",
    failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
  ),
);

const relayClientRequest = <A>(
  dependencies: CloudHttpDependencies,
  input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
  },
) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.bodyJson(input.payload),
    Effect.flatMap(dependencies.httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    Effect.mapError(
      (cause) =>
        new EnvironmentHttpInternalServerError({
          message: `T3 Connect relay request failed: ${String(cause)}`,
        }),
    ),
    withRelayClientTracing,
  );

const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
  function* (dependencies: CloudHttpDependencies, localOrigin: string) {
    const localUrl = yield* Effect.try({
      try: () => new URL(localOrigin),
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
    });
    if (localUrl.origin !== localOrigin) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Could not resolve local environment origin.",
      });
    }
    const localWsOrigin = localOrigin.replace(/^http/u, "ws");
    const token = yield* dependencies.cliTokenManager.getExisting.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                message: "Run `t3 connect link` to authorize this environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const mode = yield* readCliDesiredLinkMode;
    const managedTunnelsEnabled = mode !== "publish_only";
    const relayUrl = yield* requireRelayUrl;
    const challenge = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-link-challenges`,
      token: token.accessToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkChallengeResponse,
    });
    const proof = yield* makeCloudLinkProof(
      dependencies,
      {
        challenge: challenge.challenge,
        relayIssuer: relayUrl,
        endpoint: {
          httpBaseUrl: localOrigin,
          wsBaseUrl: localWsOrigin,
          providerKind: managedTunnelsEnabled ? "cloudflare_tunnel" : "manual",
        },
        origin: {
          localHttpHost: localUrl.hostname,
          localHttpPort: endpointRequestPort(localUrl),
        },
      },
      localOrigin,
    );
    const link = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-links`,
      token: token.accessToken,
      payload: {
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkResponse,
    });
    yield* setCliDesiredCloudLink(true, mode);
    return yield* applyCloudRelayConfig(dependencies, {
      relayUrl,
      relayIssuer: link.relayIssuer,
      cloudUserId: link.cloudUserId,
      environmentCredential: link.environmentCredential,
      cloudMintPublicKey: link.cloudMintPublicKey,
      endpointRuntime: link.endpointRuntime,
    });
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist desired T3 Connect link state."),
  ),
  Effect.catchTags({
    CloudCliCredentialRemovalError: failCloudCliTokenManagerError,
    CloudCliCredentialRefreshError: failCloudCliTokenManagerError,
    CloudCliCredentialReadError: failCloudCliTokenManagerError,
    CloudCliAuthorizationError: failCloudCliTokenManagerError,
    CloudCliAuthorizationTimeoutError: failCloudCliTokenManagerError,
  }),
);

export const reconcileDesiredCloudLink = Effect.fn("environment.cloud.reconcileDesiredLink")(
  function* (localOrigin: string) {
    return yield* reconcileDesiredCloudLinkWith(yield* cloudHttpDependencies, localOrigin);
  },
);

// Cloudflare bills per provisioned tunnel, so an environment that goes offline
// must not leave its tunnel behind. Releasing deletes only the tunnel — the
// relay keeps the link and its hostname reservation, and the next startup's
// link reconcile provisions a replacement tunnel under the same URL.
export const releaseManagedTunnelOnShutdown = Effect.fn(
  "environment.cloud.releaseManagedTunnelOnShutdown",
)(function* () {
  const dependencies = yield* cloudHttpDependencies;
  // Only a managed link stores a runtime config; publish-only links have no
  // tunnel to release.
  const runtimeConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(runtimeConfig)) {
    return false;
  }
  // Only CLI-desired managed links release on shutdown, because the startup
  // reconcile that provisions the replacement tunnel only runs for them. A
  // link installed by a web/mobile client comes back after a restart by
  // reapplying the stored connector token — it has no boot-time re-provision
  // path — so its tunnel must survive the restart. (Unlink still deletes it.)
  if (!(yield* readCliDesiredCloudLink) || (yield* readCliDesiredLinkMode) !== "managed") {
    return false;
  }
  const token = yield* dependencies.cliTokenManager.getExisting;
  if (Option.isNone(token)) {
    return false;
  }
  // The link belongs to the relay it was installed against, so target the
  // persisted URL: T3CODE_RELAY_URL may have changed since the link was made.
  const relayUrl = yield* dependencies.secrets.get(RELAY_URL_SECRET);
  if (Option.isNone(relayUrl)) {
    return false;
  }
  const environmentId = yield* dependencies.environment.getEnvironmentId;
  // Stop the local connector before the relay deletes the tunnel it serves.
  yield* dependencies.endpointRuntime.applyConfig(null);
  const response = yield* HttpClientRequest.delete(
    `${bytesToString(relayUrl.value)}/v1/client/environment-links/${encodeURIComponent(environmentId)}/tunnel`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    dependencies.httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  // ok:false means the relay skipped deletion because a concurrent provision
  // owns the recorded tunnel now — leave the stored config alone.
  if (!response.ok) {
    return false;
  }
  // The connector token died with the tunnel. Drop the stored config so the
  // next start waits for the link reconcile instead of respawning the relay
  // client with a dead token. Kept when the release request fails: the tunnel
  // still exists, so the stored token keeps working across the restart.
  // Only dropped while it is still the config this shutdown released — a fast
  // restart may already have reconciled and stored a fresh config for its
  // replacement tunnel, and that one must survive this finalizer.
  const storedConfig = yield* dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (
    Option.isSome(storedConfig) &&
    bytesToString(storedConfig.value) === bytesToString(runtimeConfig.value)
  ) {
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  }
  return true;
});

const readCloudLinkState = Effect.fn("environment.cloud.readLinkState")(function* (
  dependencies: CloudHttpDependencies,
) {
  const [cloudUserId, relayUrl, relayIssuer, endpointRuntimeConfig, publishAgentActivity] =
    yield* Effect.all(
      [
        dependencies.secrets.get(CLOUD_LINKED_USER_ID),
        dependencies.secrets.get(RELAY_URL_SECRET),
        dependencies.secrets.get(RELAY_ISSUER_SECRET),
        dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        dependencies.secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
      ],
      { concurrency: 5 },
    );
  return {
    linked: Option.isSome(cloudUserId),
    cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
    relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
    relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
    // The managed tunnel runtime config is only stored for managed links; a
    // publish-only link leaves it absent.
    managedTunnelActive: Option.isSome(endpointRuntimeConfig),
    publishAgentActivity: Option.isSome(publishAgentActivity)
      ? bytesToString(publishAgentActivity.value) === "true"
      : false,
  } satisfies EnvironmentCloudLinkStateResult;
});

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not read environment relay configuration."),
  ),
);

const cloudUnlinkHandler = Effect.fn("environment.cloud.unlink")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(null);
    yield* Effect.all(
      [
        dependencies.secrets.remove(CLOUD_LINKED_USER_ID),
        dependencies.secrets.remove(RELAY_URL_SECRET),
        dependencies.secrets.remove(RELAY_ISSUER_SECRET),
        dependencies.secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        dependencies.secrets.remove(CLOUD_MINT_PUBLIC_KEY),
        dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        dependencies.secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
      ],
      { concurrency: 7 },
    );
    yield* setCliDesiredCloudLink(false);
    return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
  ),
);

const cloudPreferencesHandler = Effect.fn("environment.cloud.preferences")(
  function* (
    dependencies: CloudHttpDependencies,
    payload: { readonly publishAgentActivity: boolean },
  ) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    yield* dependencies.secrets.set(
      PUBLISH_AGENT_ACTIVITY_SECRET,
      stringToBytes(String(payload.publishAgentActivity)),
    );
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment cloud preferences."),
  ),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const cloudMintPublicKey = yield* readCloudMintPublicKey(dependencies.secrets);
    const relayIssuer = yield* readCloudRelayIssuer(dependencies.secrets);
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_HEALTH_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud health request.",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud health request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const descriptor = yield* dependencies.environment.getDescriptor;
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      requestNonce: proof.nonce,
      status: "online",
      descriptor,
      checkedAt: DateTime.formatIso(now),
    } satisfies RelayEnvironmentHealthResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_HEALTH_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      environmentId,
      status: "online",
      descriptor,
      checkedAt: responsePayload.checkedAt,
      proof: responseProof,
    } satisfies RelayEnvironmentHealthResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
);

const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const cloudMintPublicKey = yield* readCloudMintPublicKey(dependencies.secrets);
    const relayIssuer = yield* readCloudRelayIssuer(dependencies.secrets);
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_MINT_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud mint request.",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud mint request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const issued = yield* dependencies.environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "cloud-connect",
      ttl: Duration.minutes(2),
      label: "T3 Connect connect",
      proofKeyThumbprint: proof.clientProofKeyThumbprint,
    });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
      environmentId,
      clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
      requestNonce: proof.nonce,
      credential: issued.credential,
    } satisfies RelayEnvironmentMintResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MINT_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      credential: issued.credential,
      expiresAt: DateTime.formatIso(issued.expiresAt),
      proof: responseProof,
    } satisfies RelayEnvironmentMintResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
);

/**
 * What the job dispatch handler needs, and nothing the rest of this module
 * carries: the relay-facing crypto material plus the executor-side services
 * that turn an accepted dispatch into a running job.
 */
export interface CloudDispatchJobDependencies {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly jobRunner: JobRunner["Service"];
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly repositoryIdentity: RepositoryIdentityResolver["Service"];
}

const cloudDispatchJobDependencies = Effect.gen(function* () {
  return {
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environment: yield* ServerEnvironment.ServerEnvironment,
    jobRunner: yield* JobRunner,
    snapshotQuery: yield* ProjectionSnapshotQuery,
    repositoryIdentity: yield* RepositoryIdentityResolver,
  } satisfies CloudDispatchJobDependencies;
});

/**
 * Find the project this environment already holds for `repositoryCanonicalKey`.
 *
 * The canonical key is derived from each checkout's git remote rather than read
 * off the projection, so a project whose remote changed is matched by what it
 * actually points at now. A checkout with no remote resolves to `null` and can
 * never match.
 */
const resolveDispatchJobProject = Effect.fn("environment.cloud.resolveDispatchJobProject")(
  function* (dependencies: CloudDispatchJobDependencies, repositoryCanonicalKey: string) {
    const shell = yield* dependencies.snapshotQuery.getShellSnapshot();
    let matched: OrchestrationProjectShell | null = null;
    for (const project of shell.projects) {
      const identity = yield* dependencies.repositoryIdentity.resolve(project.workspaceRoot);
      if (identity !== null && identity.canonicalKey === repositoryCanonicalKey) {
        matched = project;
        break;
      }
    }
    return matched;
  },
);

/**
 * Relay → environment job dispatch (ADR-0005: the relay triggers, the executor
 * orchestrates).
 *
 * Authenticated exactly like `mint-credential`: a proof signed by the relay
 * issuer, audience-bound to this environment, and single-use by `jti`. The
 * answer says only whether the job was accepted — a run takes minutes and the
 * relay's request deadline is seconds, so the run is forked into the caller's
 * scope and the response goes back the moment the job is under way.
 */
export const cloudDispatchJobHandler = Effect.fn("environment.cloud.dispatchJob")(
  function* (dependencies: CloudDispatchJobDependencies, request: RelayCloudDispatchJobRequest) {
    const cloudMintPublicKey = yield* readCloudMintPublicKey(dependencies.secrets);
    const relayIssuer = yield* readCloudRelayIssuer(dependencies.secrets);
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_DISPATCH_JOB_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudDispatchJobProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      // The relay signs `sub` with the user it dispatched on behalf of. Binding
      // it to this install's linked account means a proof minted for someone
      // else's link cannot drive this machine, matching what the mint and
      // health legs already require.
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud job dispatch request.",
      });
    }
    const proof = proofOption.value;

    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [`${CLOUD_DISPATCH_JOB_JTI_PREFIX}${proof.jti}`],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud job dispatch request was already consumed.",
      });
    }

    // ADR-0006: an executor works only on repositories it already has. A job
    // aimed at a checkout this environment does not hold is refused, not
    // failed — refusing is the answer, and the relay picks another executor.
    const project = yield* resolveDispatchJobProject(
      dependencies,
      proof.repositoryCanonicalKey,
    ).pipe(
      Effect.catch(
        failEnvironmentCloudInternalError("Could not resolve the dispatched job's repository."),
      ),
    );
    const accepted = project !== null;

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      jobId: proof.jobId,
      accepted,
    } satisfies RelayEnvironmentDispatchJobResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_DISPATCH_JOB_RESPONSE_TYP,
      payload: responsePayload,
    });

    // Signed before the fork so a signing failure cannot leave a job running
    // that the relay was told nothing about.
    if (project !== null) {
      yield* forkParked(
        dependencies.jobRunner
          .run({
            jobId: proof.jobId,
            projectId: project.id,
            instruction: proof.instruction,
            baseBranch: proof.baseBranch,
            workflow: m0Workflow({ instruction: proof.instruction }),
          })
          .pipe(
            // Nothing consumes the outcome yet — reporting it back to the relay
            // is the next seam, not this one.
            Effect.tap((outcome) =>
              Effect.logInfo("Dispatched job finished", {
                jobId: outcome.jobId,
                status: outcome.status,
                threadId: outcome.threadId,
                failedStepId: outcome.failedStepId,
                pullRequestUrl: outcome.pullRequestUrl,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Dispatched job could not run", { jobId: proof.jobId, cause }),
            ),
          ),
      );
    }

    yield* appendCloudCredentialResponseHeaders;
    return { accepted, proof: responseProof } satisfies RelayEnvironmentDispatchJobResponseShape;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not answer the cloud job dispatch request."),
  ),
  Effect.catchTag(
    "RelayJwtError",
    failEnvironmentCloudInternalError("Could not answer the cloud job dispatch request."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not answer the cloud job dispatch request."),
  ),
);

export const connectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const dependencies = yield* cloudHttpDependencies;
    const dispatchJobDependencies = yield* cloudDispatchJobDependencies;
    // A dispatched job outlives the request that started it, so it is forked
    // into this layer's scope — the request scope closes with the response.
    const jobScope = yield* Effect.scope;
    return handlers
      .handle("linkProof", ({ payload }) => cloudLinkProofHandler(dependencies, payload))
      .handle("relayConfig", ({ payload }) => cloudRelayConfigHandler(dependencies, payload))
      .handle("linkState", () => cloudLinkStateHandler(dependencies))
      .handle("unlink", () => cloudUnlinkHandler(dependencies))
      .handle("preferences", ({ payload }) => cloudPreferencesHandler(dependencies, payload))
      .handle("health", ({ payload }) => cloudEnvironmentHealthHandler(dependencies, payload))
      .handle("mintCredential", ({ payload }) => cloudMintCredentialHandler(dependencies, payload))
      .handle("t3MintCredential", ({ payload }) =>
        traceRelayRequest(cloudMintCredentialHandler(dependencies, payload)),
      )
      .handle("t3DispatchJob", ({ payload }) =>
        traceRelayRequest(
          cloudDispatchJobHandler(dispatchJobDependencies, payload).pipe(
            Effect.provideService(Scope.Scope, jobScope),
          ),
        ),
      );
  }),
);
