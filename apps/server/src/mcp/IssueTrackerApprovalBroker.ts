import { ApprovalRequestId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { ISSUE_TRACKER_WRITE_REQUEST_PREFIX, RelayApi } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { readTurnAuthorization } from "./IssueTrackerTurnAuthorization.ts";

type Decision = {
  readonly decision: "accept" | "decline" | "cancel";
  readonly actorUserId: string | null;
};
type Pending = {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly ownerUserId: string;
  readonly environmentId: EnvironmentId;
  readonly authorizationId: string;
  readonly deferred: Deferred.Deferred<Decision>;
};
const pending = new Map<string, Pending>();
export const requestIdForIssueWrite = (operationId: string) =>
  ApprovalRequestId.make(`${ISSUE_TRACKER_WRITE_REQUEST_PREFIX}${operationId}`);

export const isIssueWriteRequest = (requestId: string) =>
  requestId.startsWith(ISSUE_TRACKER_WRITE_REQUEST_PREFIX);

export const hasPendingIssueWrite = (requestId: string, threadId: ThreadId) =>
  pending.get(requestId)?.threadId === threadId;

/** A waiting MCP tool owns this entry; no relay credential is kept in the broker. */
export const registerIssueWrite = Effect.fn("issueWriteApproval.register")(function* (
  operationId: string,
  threadId: ThreadId,
  providerSessionId: string,
  ownerUserId: string,
  environmentId: EnvironmentId,
  authorizationId: string,
) {
  const requestId = requestIdForIssueWrite(operationId);
  const deferred = yield* Deferred.make<Decision>();
  if (pending.has(requestId)) return null;
  pending.set(requestId, {
    threadId,
    providerSessionId,
    ownerUserId,
    environmentId,
    authorizationId,
    deferred,
  });
  return { requestId, deferred };
});

export const releaseIssueWrite = (requestId: string, deferred: Deferred.Deferred<Decision>) =>
  Effect.sync(() => {
    if (pending.get(requestId)?.deferred === deferred) pending.delete(requestId);
  });

/** The relay's owner-authenticated decision is authoritative for local and remote sessions. */
export const resolveIssueWrite = Effect.fn("issueWriteApproval.resolve")(function* (
  requestId: string,
  threadId: ThreadId,
  actorUserId: string | undefined,
  decision: string,
) {
  const entry = pending.get(requestId);
  if (
    !entry ||
    entry.threadId !== threadId ||
    (actorUserId !== undefined && actorUserId !== entry.ownerUserId) ||
    (decision !== "accept" && decision !== "decline")
  )
    return false;
  return yield* Effect.gen(function* () {
    const http = yield* Effect.serviceOption(HttpClient.HttpClient);
    if (Option.isNone(http)) return false;
    const grant = yield* readTurnAuthorization(entry.authorizationId, threadId);
    if (
      !grant ||
      grant.claims.ownerUserId !== entry.ownerUserId ||
      grant.claims.environmentId !== entry.environmentId
    )
      return false;
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: grant.relayUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(grant.authorization)),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http.value));
    const verified = yield* client.issueTrackersServer.verifyWriteDecision({
      params: { environmentId: entry.environmentId },
      payload: {
        operationId: requestId.slice(ISSUE_TRACKER_WRITE_REQUEST_PREFIX.length),
        providerSessionId: entry.providerSessionId,
      },
    });
    if (verified.decision !== decision || pending.get(requestId) !== entry) return false;
    return yield* Deferred.succeed(entry.deferred, {
      decision,
      actorUserId: entry.ownerUserId,
    });
  }).pipe(
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
    Effect.orElseSucceed(() => false),
  );
});

export const cancelIssueWritesForSession = (threadId: ThreadId, providerSessionId: string) => {
  for (const [requestId, entry] of pending) {
    if (entry.threadId !== threadId || entry.providerSessionId !== providerSessionId) continue;
    pending.delete(requestId);
    Effect.runSync(Deferred.succeed(entry.deferred, { decision: "cancel", actorUserId: null }));
  }
};
