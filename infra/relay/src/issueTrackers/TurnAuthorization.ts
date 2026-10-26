import {
  RelayAuthInvalidError,
  RelayIssueTrackerTurnAuth,
  RelayIssueTrackerTurnClaims,
  RelayIssueTrackerTurnPrincipal,
  type RelayIssueTrackerTurnRequest,
  type RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { ConnectionStore } from "./ConnectionStore.ts";
import { syncWriteCapabilities } from "./Connections.ts";
import { currentTraceId } from "../observability.ts";

const Envelope = Schema.Struct({
  purpose: Schema.Literals(["personal-issue-read-turn-v1", "personal-issue-turn-v2"]),
  claims: RelayIssueTrackerTurnClaims,
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Envelope));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope));
const denied = () =>
  currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RelayAuthInvalidError({ code: "auth_invalid", reason: "not_authorized", traceId }),
      ),
    ),
  );
const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

/** A browser may close after submission. Grants expire after one day and never refresh themselves. */
export const authorizeTurn = Effect.fn("issueTrackers.authorizeTurn")(function* (
  ownerUserId: string,
  request: typeof RelayIssueTrackerTurnRequest.Type,
) {
  const store = yield* ConnectionStore;
  let rows = yield* store.list(ownerUserId);
  if (request.runtimeMode && (yield* syncWriteCapabilities(rows)))
    rows = yield* store.list(ownerUserId);
  const connections: { jira?: string; linear?: string } = {};
  const writeGenerations: { jira?: number; linear?: number } = {};
  for (const row of rows) {
    if (row.status === "connected") {
      connections[row.service] = row.version;
      if (request.runtimeMode && row.writesEnabled)
        writeGenerations[row.service] = row.writeGeneration;
    }
  }
  if (Object.keys(connections).length === 0) return { authorization: null };
  const box = yield* RelaySecretBox;
  const authorization = yield* encode({
    purpose: request.runtimeMode ? "personal-issue-turn-v2" : "personal-issue-read-turn-v1",
    claims: {
      ...request,
      ownerUserId,
      connections,
      ...(request.runtimeMode ? { writeGenerations } : {}),
      expiresAt: (yield* now) + 24 * 60 * 60_000,
    },
  }).pipe(Effect.flatMap(box.seal), Effect.catch(denied));
  return { authorization };
});

export const openTurn = Effect.fn("issueTrackers.openTurn")(function* (token: string) {
  if (token.length > 8192) return yield* denied();
  const box = yield* RelaySecretBox;
  const { claims } = yield* box.open(token).pipe(Effect.flatMap(decode), Effect.catch(denied));
  if (claims.expiresAt <= (yield* now)) return yield* denied();
  return claims;
});

/** A grant cannot adopt newly connected credentials after disconnect or replacement. */
export const authorizeRead = Effect.fn("issueTrackers.authorizeRead")(function* (
  environmentId: string,
  service: RelayIssueTrackerService,
) {
  const claims = yield* RelayIssueTrackerTurnPrincipal;
  if (claims.environmentId !== environmentId || claims.expiresAt <= (yield* now))
    return yield* denied();
  const store = yield* ConnectionStore;
  const row = yield* store.get({ ownerUserId: claims.ownerUserId, service });
  if (!row || row.status !== "connected" || claims.connections[service] !== row.version)
    return yield* denied();
  return { ownerUserId: claims.ownerUserId, connectionVersion: row.version };
});

export const authorizeWrite = Effect.fn("issueTrackers.authorizeWrite")(function* (
  environmentId: string,
  service: RelayIssueTrackerService,
) {
  const claims = yield* RelayIssueTrackerTurnPrincipal;
  if (
    claims.environmentId !== environmentId ||
    claims.expiresAt <= (yield* now) ||
    !claims.runtimeMode ||
    claims.writeGenerations?.[service] === undefined
  )
    return yield* denied();
  const store = yield* ConnectionStore;
  const row = yield* store.get({ ownerUserId: claims.ownerUserId, service });
  if (
    !row ||
    row.status !== "connected" ||
    !row.writesEnabled ||
    row.version !== claims.connections[service] ||
    row.writeGeneration !== claims.writeGenerations[service]
  )
    return yield* denied();
  return {
    ownerUserId: claims.ownerUserId,
    connectionVersion: row.version,
    writeGeneration: row.writeGeneration,
    runtimeMode: claims.runtimeMode,
    commandId: claims.commandId,
    threadId: claims.threadId,
  };
});

export const turnAuthLayer = Layer.effect(
  RelayIssueTrackerTurnAuth,
  Effect.gen(function* () {
    const box = yield* RelaySecretBox;
    return {
      turnBearer: (effect, { credential }) =>
        openTurn(Redacted.value(credential)).pipe(
          Effect.provideService(RelaySecretBox, box),
          Effect.flatMap((claims) =>
            Effect.provideService(effect, RelayIssueTrackerTurnPrincipal, claims),
          ),
        ),
    };
  }),
);
