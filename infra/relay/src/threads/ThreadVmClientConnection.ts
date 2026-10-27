import { ThreadId } from "@t3tools/contracts";
import type {
  RelayManagedEndpoint,
  RelayCloudEnvironmentHealthProofPayload,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { verifyEnvironmentHealthResponse } from "../environments/EnvironmentConnector.ts";
import {
  ManagedEndpointAllocations,
  resolveReadyManagedEndpoint,
} from "../environments/ManagedEndpointAllocations.ts";
import { makeManagedThreadVmEndpoint } from "../machines/E2BThreadVmEndpoint.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import {
  mintThreadVmConnection,
  sameThreadVmTarget,
  ThreadVmConnectionUnavailable,
  type ThreadVmConnectionTarget,
} from "./ThreadVmConnection.ts";
import {
  authorizeThreadVmConnection,
  authorizeThreadVmStatus,
} from "./ThreadVmConnectionAccess.ts";
import { threadVmEndpointOwner } from "./threadVmEndpointOwner.ts";

export interface ThreadVmClientEndpoint {
  readonly endpoint: RelayManagedEndpoint;
  readonly control: ReturnType<typeof makeManagedThreadVmEndpoint>;
}

/** Installed only by the Node dev relay; the Worker always uses its managed allocation. */
export const DevThreadVmClientEndpoint = Context.Reference<
  | ((input: {
      readonly userId: string;
      readonly threadId: ThreadId;
      readonly target: ThreadVmConnectionTarget & { readonly state: "running" | "paused" };
    }) => Effect.Effect<ThreadVmClientEndpoint, ThreadVmConnectionUnavailable>)
  | undefined
>("relay/DevThreadVmClientEndpoint", { defaultValue: () => undefined });

/** A recorded VM identity never falls through to personal-link or organization-machine access. */
const resolveThreadVmEndpoint = Effect.fn("relay.thread_vm_client.resolve")(function* (
  input: { userId: string; environmentId: string },
  operation: "connect" | "status",
  transport: typeof fetch,
) {
  const sql = (yield* RelayDb).$client;
  const [binding] = yield* sql<{
    threadId: string;
  }>`SELECT thread_id AS "threadId" FROM relay_thread_vm_bindings WHERE environment_id = ${input.environmentId}`;
  if (!binding) return null;
  const threadId = ThreadId.make(binding.threadId);
  const settings = yield* RelayConfiguration;
  const readTarget =
    operation === "connect" ? authorizeThreadVmConnection : authorizeThreadVmStatus;
  const target = yield* readTarget(input.userId, threadId);
  if (target.environmentId !== input.environmentId)
    return yield* new ThreadVmConnectionUnavailable();
  const local = yield* DevThreadVmClientEndpoint;
  if (local) {
    const resolved = yield* local({ ...input, threadId, target });
    const authorize = (userId: string, requestedThreadId: ThreadId) =>
      readTarget(userId, requestedThreadId).pipe(
        Effect.flatMap((current) =>
          sameThreadVmTarget(current, target) && current.state === target.state
            ? Effect.succeed(current)
            : Effect.fail(new ThreadVmConnectionUnavailable()),
        ),
      );
    return { threadId, settings, target, ...resolved, authorize };
  }
  const allocations = yield* ManagedEndpointAllocations;
  const key = {
    userId: threadVmEndpointOwner(target.identity.scope.allocationId),
    environmentId: target.environmentId,
  };
  const allocation = yield* allocations.get(key);
  const endpoint =
    allocation &&
    resolveReadyManagedEndpoint({ allocation, baseDomain: settings.managedEndpointBaseDomain });
  if (
    !allocation ||
    !endpoint ||
    allocation.origin?.localHttpHost !== "127.0.0.1" ||
    allocation.origin.localHttpPort !== 3773
  )
    return yield* new ThreadVmConnectionUnavailable();
  const authorize = (userId: string, requestedThreadId: ThreadId) =>
    Effect.gen(function* () {
      const current = yield* readTarget(userId, requestedThreadId);
      const currentAllocation = yield* allocations.get(key);
      if (
        !sameThreadVmTarget(current, target) ||
        current.state !== target.state ||
        !currentAllocation ||
        currentAllocation.generation !== allocation.generation ||
        currentAllocation.hostname !== allocation.hostname ||
        currentAllocation.tunnelId !== allocation.tunnelId ||
        currentAllocation.dnsRecordId !== allocation.dnsRecordId ||
        currentAllocation.readyAt === null ||
        currentAllocation.origin?.localHttpHost !== "127.0.0.1" ||
        currentAllocation.origin.localHttpPort !== 3773
      )
        return yield* new ThreadVmConnectionUnavailable();
      return current;
    });
  return {
    threadId,
    settings,
    target,
    endpoint,
    authorize,
    control: makeManagedThreadVmEndpoint(endpoint.httpBaseUrl, transport),
  };
});

export const connectThreadVmIfBound = Effect.fn("relay.thread_vm_client.connect")(
  function* (
    input: {
      userId: string;
      environmentId: string;
      clientProofKeyThumbprint: string;
      deviceId?: string;
    },
    transport: typeof fetch = fetch,
  ) {
    const resolved = yield* resolveThreadVmEndpoint(input, "connect", transport);
    if (!resolved) return null;
    const { threadId, settings, endpoint, control, authorize } = resolved;
    const profile = (yield* (yield* UserDirectory).lookup({ userIds: [input.userId] })).get(
      input.userId,
    );
    const minted = yield* mintThreadVmConnection({
      ...input,
      threadId,
      relayIssuer: settings.relayIssuer,
      cloudMintPrivateKey: settings.cloudMintPrivateKey,
      ...(profile ? { profile } : {}),
      endpoint: control,
      authorize,
    });
    return {
      environmentId: minted.target.environmentId,
      endpoint,
      credential: Redacted.value(minted.credential),
      expiresAt: minted.expiresAt,
    };
  },
  Effect.mapError(() => new ThreadVmConnectionUnavailable()),
);

/** Status never provisions, renews or wakes compute and never mints a client credential. */
export const getThreadVmStatusIfBound = Effect.fn("relay.thread_vm_client.status")(
  function* (input: { userId: string; environmentId: string }, transport: typeof fetch = fetch) {
    const resolved = yield* resolveThreadVmEndpoint(input, "status", transport);
    if (!resolved) return null;
    const { threadId, settings, target, endpoint, control, authorize } = resolved;
    const now = yield* DateTime.now;
    const offline = {
      environmentId: target.environmentId,
      endpoint,
      status: "offline" as const,
      checkedAt: DateTime.formatIso(now),
    };
    if (target.state === "paused") {
      yield* authorize(input.userId, threadId);
      return offline;
    }
    const crypto = yield* Crypto.Crypto;
    const nonce = yield* crypto.randomUUIDv4;
    const relayIssuer = normalizeRelayIssuer(settings.relayIssuer);
    const payload: RelayCloudEnvironmentHealthProofPayload = {
      iss: relayIssuer,
      aud: `t3-env:${target.environmentId}`,
      sub: input.userId,
      jti: yield* crypto.randomUUIDv4,
      iat: Math.floor(now.epochMilliseconds / 1000),
      exp: Math.floor(now.epochMilliseconds / 1000) + 120,
      environmentId: target.environmentId,
      nonce,
      scope: ["environment:status"],
    };
    const proof = yield* signRelayJwt({
      privateKey: Redacted.value(settings.cloudMintPrivateKey),
      typ: RELAY_HEALTH_REQUEST_TYP,
      payload,
    });
    const response = yield* control.health(proof).pipe(Effect.option);
    // Removed access or a moved/reset VM must not produce a response from the old identity.
    yield* authorize(input.userId, threadId);
    if (Option.isNone(response)) return offline;
    const verified = yield* verifyEnvironmentHealthResponse({
      response: response.value,
      environmentId: target.environmentId,
      requestNonce: nonce,
      requestIssuedAt: now,
      environmentPublicKeys: [target.environmentPublicKey],
      relayIssuer,
      now: yield* DateTime.now,
    });
    if (!verified) return yield* new ThreadVmConnectionUnavailable();
    return {
      environmentId: target.environmentId,
      endpoint,
      status: "online" as const,
      checkedAt: response.value.checkedAt,
      descriptor: response.value.descriptor,
    };
  },
  Effect.mapError(() => new ThreadVmConnectionUnavailable()),
);
