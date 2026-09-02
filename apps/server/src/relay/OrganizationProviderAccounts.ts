/**
 * The organization's provider accounts, as a managed executor sees them.
 *
 * An admin signs in to Codex, Claude, Cursor, or OpenCode once, on their own
 * machine, and shares that sign-in with the organization; the relay keeps it
 * sealed. An enrolled agent executor fetches the set here, keeps it in
 * memory, and re-fetches on a timer so a re-sign-in or a removal reaches
 * every executor without anyone touching the machine (ADR-0003, organization
 * provider accounts amendment). Drivers read `current` when they build an
 * instance and `changes` is what makes the registry rebuild them.
 *
 * On a personal machine the reference keeps its default: no accounts, no
 * changes, nothing to start.
 *
 * @module relay/OrganizationProviderAccounts
 */
import type { ProviderAccountPayload, ProviderAccountProvider } from "@t3tools/contracts";
import { RelayApi } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../cloud/machineEnrollment.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";

export interface OrganizationProviderAccount {
  readonly provider: ProviderAccountProvider;
  readonly label: string;
  /** Changes on every save at the relay; what drivers compare against what they placed. */
  readonly version: string;
  readonly payload: ProviderAccountPayload;
}

export type OrganizationProviderAccountMap = ReadonlyMap<
  ProviderAccountProvider,
  OrganizationProviderAccount
>;

export interface OrganizationProviderAccountsShape {
  /** The last set fetched from the relay; empty until the first fetch lands. */
  readonly current: Effect.Effect<OrganizationProviderAccountMap>;
  /** The providers whose account appeared, changed version, or disappeared. */
  readonly changes: Stream.Stream<ReadonlySet<ProviderAccountProvider>>;
  /** Fetch now. False when this environment is not an executor or the relay did not answer. */
  readonly refresh: Effect.Effect<boolean>;
  /** Fetch now and keep fetching on a timer for the life of the scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

const EMPTY: OrganizationProviderAccountMap = new Map();

export const none: OrganizationProviderAccountsShape = {
  current: Effect.succeed(EMPTY),
  changes: Stream.never,
  refresh: Effect.succeed(false),
  start: () => Effect.void,
};

/**
 * A reference rather than a service so drivers need nothing new from their
 * environment: anywhere the executor layer is not provided, this reads as
 * "no organization accounts".
 */
export const OrganizationProviderAccounts = Context.Reference<OrganizationProviderAccountsShape>(
  "t3/relay/OrganizationProviderAccounts",
  { defaultValue: () => none },
);

// A re-sign-in should reach executors within minutes, not on the next boot;
// the fetch is one small request against the executor's own relay.
const REFRESH_INTERVAL = "5 minutes";

export function diffProviderAccounts(
  previous: OrganizationProviderAccountMap,
  next: OrganizationProviderAccountMap,
): ReadonlySet<ProviderAccountProvider> {
  const changed = new Set<ProviderAccountProvider>();
  for (const [provider, account] of next) {
    if (previous.get(provider)?.version !== account.version) changed.add(provider);
  }
  for (const provider of previous.keys()) {
    if (!next.has(provider)) changed.add(provider);
  }
  return changed;
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const stateRef = yield* Ref.make<OrganizationProviderAccountMap>(EMPTY);
  const changes = yield* PubSub.unbounded<ReadonlySet<ProviderAccountProvider>>();

  const fetch = Effect.fn("OrganizationProviderAccounts.fetch")(
    function* () {
      const relayConfig = yield* readManagedExecutorRelayConfig(secrets);
      if (relayConfig === null) {
        return false;
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
      const response = yield* relayClient.providerAccountsServer.fetchProviderAccounts({
        params: { environmentId },
      });
      const next: OrganizationProviderAccountMap = new Map(
        response.accounts.map((account) => [
          account.provider,
          {
            provider: account.provider,
            label: account.label,
            version: account.version,
            payload: account.payload,
          },
        ]),
      );
      const previous = yield* Ref.getAndSet(stateRef, next);
      const changed = diffProviderAccounts(previous, next);
      if (changed.size > 0) {
        yield* Effect.logInfo("organization provider accounts changed", {
          providers: [...changed],
          held: [...next.keys()],
        });
        yield* PubSub.publish(changes, changed);
      }
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("organization provider accounts request failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
    withRelayClientTracing,
  );

  const start: OrganizationProviderAccountsShape["start"] = () =>
    forkParked(fetch().pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL))));

  return {
    current: Ref.get(stateRef),
    get changes() {
      return Stream.fromPubSub(changes);
    },
    refresh: fetch(),
    start,
  } satisfies OrganizationProviderAccountsShape;
});

export const layer = Layer.effect(OrganizationProviderAccounts, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
