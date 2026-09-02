/**
 * The organization's GitHub access, as a managed executor sees it.
 *
 * An enrolled agent executor has no GitHub credential of its own: nobody ran
 * `gh auth login` on it and nobody should have to. What it has is membership
 * in an organization that connected GitHub by installing the relay's App. This
 * service turns that connection into a token the executor's own git and `gh`
 * subprocesses can use, by asking the relay to mint one from the installation
 * (ADR-0015). The token lives in memory only, is refreshed before it expires,
 * and is handed to child processes one spawn at a time by `VcsProcess`.
 *
 * On a personal machine the service is simply not provided, and nothing here
 * runs.
 *
 * @module relay/OrganizationSourceControlCredentials
 */
import { RelayApi } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../cloud/machineEnrollment.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export interface OrganizationGithubCredential {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly accountLogin: string;
}

export class OrganizationSourceControlCredentials extends Context.Service<
  OrganizationSourceControlCredentials,
  {
    /**
     * A usable installation token, or null when this environment is not an
     * enrolled agent executor, its organization has not connected GitHub, or
     * the relay could not be reached. Null means "behave as before": the
     * caller keeps whatever ambient credentials the machine has.
     */
    readonly github: Effect.Effect<OrganizationGithubCredential | null>;
  }
>()("t3/relay/OrganizationSourceControlCredentials") {}

// Refresh well before expiry so a clone that starts near the boundary still
// finishes on a valid token.
const REFRESH_LEAD = Duration.minutes(5);
// How long a "no" is trusted before asking again. Not being connected is a
// deliberate organization state; a failed request is probably transient.
const NOT_CONNECTED_RETRY = Duration.minutes(1);
const FAILURE_RETRY = Duration.seconds(30);
const FALLBACK_TOKEN_LIFETIME = { hours: 1 } as const;

type CredentialState =
  | { readonly _tag: "empty" }
  | { readonly _tag: "credential"; readonly credential: OrganizationGithubCredential }
  | { readonly _tag: "unavailable"; readonly retryAtMillis: number };

function isFresh(credential: OrganizationGithubCredential, now: DateTime.Utc): boolean {
  return (
    now.epochMilliseconds + Duration.toMillis(REFRESH_LEAD) < credential.expiresAt.epochMilliseconds
  );
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const stateRef = yield* Ref.make<CredentialState>({ _tag: "empty" });
  const refreshLock = yield* Semaphore.make(1);

  const unavailable = (retryAfter: Duration.Duration) =>
    DateTime.now.pipe(
      Effect.map(
        (now): CredentialState => ({
          _tag: "unavailable",
          retryAtMillis: now.epochMilliseconds + Duration.toMillis(retryAfter),
        }),
      ),
    );

  const mint = Effect.fn("OrganizationSourceControlCredentials.mint")(
    function* () {
      const relayConfig = yield* readManagedExecutorRelayConfig(secrets);
      if (relayConfig === null) {
        return yield* unavailable(NOT_CONNECTED_RETRY);
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const relayClient = yield* HttpApiClient.make(RelayApi, {
        baseUrl: relayConfig.url,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader(
            "authorization",
            `Bearer ${relayConfig.environmentCredential}`,
          ),
        ),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const response = yield* relayClient.sourceControlServer.mintGithubInstallationToken({
        params: { environmentId },
      });
      const now = yield* DateTime.now;
      const credential: OrganizationGithubCredential = {
        token: response.token,
        expiresAt: Option.getOrElse(DateTime.make(response.expiresAt), () =>
          DateTime.add(now, FALLBACK_TOKEN_LIFETIME),
        ),
        accountLogin: response.accountLogin,
      };
      yield* Effect.logInfo("organization GitHub credential minted", {
        accountLogin: credential.accountLogin,
        expiresAt: DateTime.formatIso(credential.expiresAt),
      });
      return { _tag: "credential", credential } satisfies CredentialState;
    },
    Effect.catchTag("RelayTenancyNotFoundError", (error) =>
      Effect.logInfo("organization GitHub credential unavailable", { reason: error.reason }).pipe(
        Effect.andThen(unavailable(NOT_CONNECTED_RETRY)),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("organization GitHub credential request failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.andThen(unavailable(FAILURE_RETRY))),
    ),
    withRelayClientTracing,
  );

  // Serialized so concurrent spawns share one refresh instead of each asking
  // the relay; the fast path is a Ref read under an uncontended permit.
  const github = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const state = yield* Ref.get(stateRef);
      if (state._tag === "credential" && isFresh(state.credential, now)) {
        return state.credential;
      }
      if (state._tag === "unavailable" && state.retryAtMillis > now.epochMilliseconds) {
        return null;
      }
      const next = yield* mint();
      yield* Ref.set(stateRef, next);
      return next._tag === "credential" ? next.credential : null;
    }),
  );

  return OrganizationSourceControlCredentials.of({ github });
});

export const layer = Layer.effect(OrganizationSourceControlCredentials, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);

/** No organization behind this process: tests, and tooling that never runs as an executor. */
export const layerNone = Layer.succeed(
  OrganizationSourceControlCredentials,
  OrganizationSourceControlCredentials.of({ github: Effect.succeed(null) }),
);
