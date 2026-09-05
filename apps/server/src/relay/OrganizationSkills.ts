/**
 * The organization's skills, as a managed executor sees them.
 *
 * An admin uploads a skill once, in Organization settings; the relay keeps
 * it. An enrolled agent executor fetches the set here, keeps it in memory,
 * and re-fetches on a timer so a new or removed skill reaches every executor
 * without anyone touching the machine (ADR-0016). Drivers read `current`
 * when they build an instance, placing a copy where their provider CLI
 * looks for skills, and `changes` is what makes the registry rebuild them.
 *
 * On a personal machine the reference keeps its default: no skills, no
 * changes, nothing to start.
 *
 * @module relay/OrganizationSkills
 */
import type { OrganizationSkillFile } from "@t3tools/contracts";
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

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../cloud/machineEnrollment.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

export interface OrganizationSkill {
  readonly name: string;
  readonly description: string;
  /** Changes on every save at the relay; what drivers compare against what they placed. */
  readonly version: string;
  readonly files: ReadonlyArray<OrganizationSkillFile>;
}

/** Keyed by skill name. */
export type OrganizationSkillMap = ReadonlyMap<string, OrganizationSkill>;

export interface OrganizationSkillsShape {
  /** The last set fetched from the relay; empty until the first fetch lands. */
  readonly current: Effect.Effect<OrganizationSkillMap>;
  /** The names of skills that appeared, changed version, or disappeared. */
  readonly changes: Stream.Stream<ReadonlySet<string>>;
  /** Fetch now. False when this environment is not an executor or the relay did not answer. */
  readonly refresh: Effect.Effect<boolean>;
  /** Fetch now and keep fetching on a timer for the life of the scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

const EMPTY: OrganizationSkillMap = new Map();

export const none: OrganizationSkillsShape = {
  current: Effect.succeed(EMPTY),
  changes: Stream.never,
  refresh: Effect.succeed(false),
  start: () => Effect.void,
};

/**
 * A reference rather than a service so drivers need nothing new from their
 * environment: anywhere the executor layer is not provided, this reads as
 * "no organization skills".
 */
export const OrganizationSkills = Context.Reference<OrganizationSkillsShape>(
  "t3/relay/OrganizationSkills",
  { defaultValue: () => none },
);

// An uploaded skill should reach executors within minutes, not on the next
// boot; the fetch is one small request against the executor's own relay.
const REFRESH_INTERVAL = "5 minutes";

export function diffOrganizationSkills(
  previous: OrganizationSkillMap,
  next: OrganizationSkillMap,
): ReadonlySet<string> {
  const changed = new Set<string>();
  for (const [name, skill] of next) {
    if (previous.get(name)?.version !== skill.version) changed.add(name);
  }
  for (const name of previous.keys()) {
    if (!next.has(name)) changed.add(name);
  }
  return changed;
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const stateRef = yield* Ref.make<OrganizationSkillMap>(EMPTY);
  const changes = yield* PubSub.unbounded<ReadonlySet<string>>();

  const fetch = Effect.fn("OrganizationSkills.fetch")(
    function* () {
      const relayConfig = yield* readManagedExecutorRelayConfig(secrets);
      if (relayConfig === null) {
        return false;
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const relayClient = yield* makeExecutorRelayApiClient(relayConfig).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      const response = yield* relayClient.organizationSkillsServer.fetchOrganizationSkills({
        params: { environmentId },
      });
      const next: OrganizationSkillMap = new Map(
        response.skills.map((skill) => [
          skill.name,
          {
            name: skill.name,
            description: skill.description,
            version: skill.version,
            files: skill.files,
          },
        ]),
      );
      const previous = yield* Ref.getAndSet(stateRef, next);
      const changed = diffOrganizationSkills(previous, next);
      if (changed.size > 0) {
        yield* Effect.logInfo("organization skills changed", {
          skills: [...changed],
          held: [...next.keys()],
        });
        yield* PubSub.publish(changes, changed);
      }
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("organization skills request failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
    withRelayClientTracing,
  );

  const start: OrganizationSkillsShape["start"] = () =>
    forkParked(fetch().pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL))));

  return {
    current: Ref.get(stateRef),
    get changes() {
      return Stream.fromPubSub(changes);
    },
    refresh: fetch(),
    start,
  } satisfies OrganizationSkillsShape;
});

export const layer = Layer.effect(OrganizationSkills, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
