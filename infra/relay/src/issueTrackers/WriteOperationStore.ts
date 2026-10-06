import { RelayIssueTrackerError, type RelayIssueTrackerService } from "@t3tools/contracts/relay";
import { and, eq, gt, inArray, lte, ne, or } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayDb } from "../db.ts";
import {
  relayIssueTrackerWriteOperations as operations,
  relayUserIssueTrackerConnections as connections,
} from "../persistence/schema.ts";

export type WriteOperationRecord = typeof operations.$inferSelect;
type WriteOperationInput = Pick<
  WriteOperationRecord,
  | "ownerUserId"
  | "service"
  | "environmentId"
  | "threadId"
  | "commandId"
  | "providerSessionId"
  | "invocationId"
  | "connectionVersion"
  | "writeGeneration"
  | "runtimeMode"
  | "action"
  | "target"
  | "payloadDigest"
  | "payloadSealed"
  | "baselineSealed"
  | "expiresAt"
> & { readonly retryOfOperationId?: string };
type ConnectionFence = Pick<
  WriteOperationRecord,
  "ownerUserId" | "service" | "connectionVersion" | "writeGeneration"
>;
const error = (code: RelayIssueTrackerError["code"], message: string) =>
  new RelayIssueTrackerError({ code, message });
const stale = () =>
  error("conflict", "This issue change is no longer current. Send a new request.");
const databaseFailure = () =>
  error("unavailable", "Could not save this issue change. Try again later.");
const isIssueTrackerError = Schema.is(RelayIssueTrackerError);
const pendingStates = ["awaiting_approval", "ready"] as const;

export class WriteOperationStore extends Context.Service<
  WriteOperationStore,
  {
    readonly prepare: (
      input: WriteOperationInput,
    ) => Effect.Effect<
      { operation: WriteOperationRecord; reused: boolean },
      RelayIssueTrackerError
    >;
    readonly get: (
      operationId: string,
    ) => Effect.Effect<WriteOperationRecord | null, RelayIssueTrackerError>;
    readonly findUnknown: (
      fingerprint: Pick<
        WriteOperationRecord,
        | "ownerUserId"
        | "service"
        | "environmentId"
        | "threadId"
        | "action"
        | "target"
        | "payloadDigest"
      >,
    ) => Effect.Effect<WriteOperationRecord | null, RelayIssueTrackerError>;
    readonly approve: (
      operationId: string,
      actorUserId: string,
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    readonly reject: (
      operationId: string,
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    readonly cancel: (
      operationId: string,
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    readonly claim: (
      operationId: string,
      fence: ConnectionFence & { readonly retryOfOperationId?: string },
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    readonly succeed: (
      operationId: string,
      claimFence: string,
      result: { resourceId: string; url: string },
    ) => Effect.Effect<boolean, RelayIssueTrackerError>;
    readonly outcomeUnknown: (
      operationId: string,
      claimFence: string,
      safeError: string,
      candidate?: { resourceId: string; url: string },
    ) => Effect.Effect<boolean, RelayIssueTrackerError>;
    readonly reconcileUnknown: (
      operationId: string,
      resourceId: string,
      fence: ConnectionFence,
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    /** Only after the caller has read the exact result using the current grant. Never dispatches a write. */
    readonly reconcileVerifiedUnknown: (
      operationId: string,
      resourceId: string,
      fence: ConnectionFence & Pick<WriteOperationRecord, "environmentId">,
    ) => Effect.Effect<WriteOperationRecord, RelayIssueTrackerError>;
    readonly cancelPending: (
      ownerUserId: string,
      service: RelayIssueTrackerService,
    ) => Effect.Effect<void, RelayIssueTrackerError>;
  }
>()("launchpad-relay/issueTrackers/WriteOperationStore") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(databaseFailure));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const byId = (operationId: string) => eq(operations.operationId, operationId);
  const byConnection = (fence: ConnectionFence) =>
    and(eq(connections.ownerUserId, fence.ownerUserId), eq(connections.service, fence.service));
  const currentConnection = (fence: ConnectionFence) =>
    db
      .select()
      .from(connections)
      .where(byConnection(fence))
      .for("update")
      .pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(databaseFailure),
      );
  const requireConnection = (fence: ConnectionFence) =>
    currentConnection(fence).pipe(
      Effect.flatMap((row) =>
        row?.status === "connected" &&
        row.writesEnabled &&
        row.version === fence.connectionVersion &&
        row.writeGeneration === fence.writeGeneration
          ? Effect.succeed(row)
          : Effect.fail(stale()),
      ),
    );
  const lockedOperation = (operationId: string) =>
    db
      .select()
      .from(operations)
      .where(byId(operationId))
      .for("update")
      .pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(databaseFailure),
      );
  const transact = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    db.$client
      .withTransaction(effect)
      .pipe(Effect.mapError((cause) => (isIssueTrackerError(cause) ? cause : databaseFailure())));

  return WriteOperationStore.of({
    prepare: (input) =>
      transact(
        Effect.gen(function* () {
          yield* requireConnection(input);
          const currentTime = yield* DateTime.now;
          const timestamp = DateTime.formatIso(currentTime);
          if (input.expiresAt <= timestamp) return yield* stale();
          const effectiveRuntimeMode = input.retryOfOperationId
            ? "approval-required"
            : input.runtimeMode;
          yield* db
            .update(operations)
            .set({
              state: "cancelled",
              payloadSealed: null,
              baselineSealed: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(operations.ownerUserId, input.ownerUserId),
                eq(operations.service, input.service),
                inArray(operations.state, [...pendingStates]),
                lte(operations.expiresAt, timestamp),
              ),
            )
            .pipe(Effect.mapError(databaseFailure));
          const abandonedBefore = DateTime.formatIso(
            DateTime.subtract(currentTime, { minutes: 1 }),
          );
          yield* db
            .update(operations)
            .set({
              state: "outcome_unknown",
              safeError:
                "The issue tracker change may have completed. Read the issue before retrying.",
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(operations.ownerUserId, input.ownerUserId),
                eq(operations.service, input.service),
                eq(operations.state, "executing"),
                lte(operations.claimedAt, abandonedBefore),
              ),
            )
            .pipe(Effect.mapError(databaseFailure));
          const existingInvocation = yield* db
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.environmentId, input.environmentId),
                eq(operations.providerSessionId, input.providerSessionId),
                eq(operations.invocationId, input.invocationId),
              ),
            )
            .pipe(Effect.mapError(databaseFailure));
          if (existingInvocation[0]) {
            const prior = existingInvocation[0];
            if (
              prior.expiresAt <= timestamp &&
              pendingStates.some((state) => state === prior.state)
            )
              return yield* stale();
            if (
              prior.ownerUserId !== input.ownerUserId ||
              prior.service !== input.service ||
              prior.threadId !== input.threadId ||
              prior.commandId !== input.commandId ||
              prior.runtimeMode !== effectiveRuntimeMode ||
              prior.connectionVersion !== input.connectionVersion ||
              prior.writeGeneration !== input.writeGeneration ||
              prior.payloadDigest !== input.payloadDigest ||
              prior.target !== input.target ||
              prior.action !== input.action
            )
              return yield* stale();
            return { operation: prior, reused: true };
          }
          if (input.retryOfOperationId) {
            const prior = yield* lockedOperation(input.retryOfOperationId);
            if (
              !prior ||
              prior.state !== "outcome_unknown" ||
              prior.ownerUserId !== input.ownerUserId ||
              prior.service !== input.service ||
              prior.environmentId !== input.environmentId ||
              prior.threadId !== input.threadId ||
              prior.action !== input.action ||
              prior.target !== input.target ||
              prior.payloadDigest !== input.payloadDigest
            )
              return yield* stale();
          }
          // A new admitted command supersedes an unexecuted identical proposal left by
          // an interrupted tool call. Executing/unknown outcomes are never cleared here.
          yield* db
            .update(operations)
            .set({
              state: "cancelled",
              payloadSealed: null,
              baselineSealed: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(operations.ownerUserId, input.ownerUserId),
                eq(operations.service, input.service),
                eq(operations.environmentId, input.environmentId),
                eq(operations.threadId, input.threadId),
                eq(operations.action, input.action),
                eq(operations.target, input.target),
                eq(operations.payloadDigest, input.payloadDigest),
                ne(operations.commandId, input.commandId),
                inArray(operations.state, [...pendingStates]),
              ),
            )
            .pipe(Effect.mapError(databaseFailure));
          const fingerprints = yield* db
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.ownerUserId, input.ownerUserId),
                eq(operations.service, input.service),
                eq(operations.environmentId, input.environmentId),
                eq(operations.threadId, input.threadId),
                eq(operations.action, input.action),
                eq(operations.target, input.target),
                eq(operations.payloadDigest, input.payloadDigest),
                eq(operations.connectionVersion, input.connectionVersion),
                eq(operations.writeGeneration, input.writeGeneration),
                input.retryOfOperationId
                  ? ne(operations.operationId, input.retryOfOperationId)
                  : undefined,
                or(
                  inArray(operations.state, ["executing", "outcome_unknown"]),
                  and(eq(operations.state, "succeeded"), gt(operations.expiresAt, timestamp)),
                  and(
                    inArray(operations.state, [...pendingStates]),
                    gt(operations.expiresAt, timestamp),
                  ),
                ),
              ),
            )
            .orderBy(operations.createdAt)
            .limit(1)
            .pipe(Effect.mapError(databaseFailure));
          const duplicate = fingerprints[0];
          if (duplicate) {
            if (input.retryOfOperationId && duplicate.state !== "succeeded") return yield* stale();
            if (pendingStates.some((state) => state === duplicate.state))
              return yield* error(
                "write_in_progress",
                "An identical issue change is already in progress.",
              );
            return { operation: duplicate, reused: true };
          }
          const { retryOfOperationId: _retryOfOperationId, ...record } = input;
          const inserted = yield* db
            .insert(operations)
            .values({
              ...record,
              operationId: yield* uuid,
              runtimeMode: effectiveRuntimeMode,
              state: effectiveRuntimeMode === "full-access" ? "ready" : "awaiting_approval",
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return { operation: inserted[0]!, reused: false };
        }),
      ),
    get: (operationId) =>
      db
        .select()
        .from(operations)
        .where(byId(operationId))
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(databaseFailure),
        ),
    findUnknown: (fingerprint) =>
      Effect.gen(function* () {
        const currentTime = yield* DateTime.now;
        const timestamp = DateTime.formatIso(currentTime);
        const match = and(
          eq(operations.ownerUserId, fingerprint.ownerUserId),
          eq(operations.service, fingerprint.service),
          eq(operations.environmentId, fingerprint.environmentId),
          eq(operations.threadId, fingerprint.threadId),
          eq(operations.action, fingerprint.action),
          eq(operations.target, fingerprint.target),
          eq(operations.payloadDigest, fingerprint.payloadDigest),
        );
        yield* db
          .update(operations)
          .set({
            state: "outcome_unknown",
            safeError:
              fingerprint.action === "add_comment"
                ? "Could not confirm whether the comment was posted. Read the issue before trying again."
                : "Could not confirm whether the issue changed. Read it before trying again.",
            updatedAt: timestamp,
          })
          .where(
            and(
              match,
              eq(operations.state, "executing"),
              lte(
                operations.claimedAt,
                DateTime.formatIso(DateTime.subtract(currentTime, { minutes: 1 })),
              ),
            ),
          )
          .pipe(Effect.mapError(databaseFailure));
        const rows = yield* db
          .select()
          .from(operations)
          .where(and(match, inArray(operations.state, ["executing", "outcome_unknown"])))
          .orderBy(operations.createdAt)
          .limit(1)
          .pipe(Effect.mapError(databaseFailure));
        return rows[0] ?? null;
      }),
    approve: (operationId, actorUserId) =>
      transact(
        Effect.gen(function* () {
          const preview = yield* db
            .select()
            .from(operations)
            .where(byId(operationId))
            .pipe(
              Effect.map((rows) => rows[0] ?? null),
              Effect.mapError(databaseFailure),
            );
          if (!preview) return yield* stale();
          yield* requireConnection(preview);
          const operation = yield* lockedOperation(operationId);
          if (
            operation?.state === "ready" &&
            operation.approvedByUserId === actorUserId &&
            operation.expiresAt > (yield* now)
          )
            return operation;
          if (
            !operation ||
            operation.state !== "awaiting_approval" ||
            operation.expiresAt <= (yield* now) ||
            operation.connectionVersion !== preview.connectionVersion ||
            operation.writeGeneration !== preview.writeGeneration
          )
            return yield* stale();
          const rows = yield* db
            .update(operations)
            .set({
              state: "ready",
              approvedByUserId: actorUserId,
              approvedAt: yield* now,
              updatedAt: yield* now,
            })
            .where(byId(operationId))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    reject: (operationId) =>
      transact(
        Effect.gen(function* () {
          const operation = yield* lockedOperation(operationId);
          if (!operation) return yield* stale();
          if (operation.state === "rejected") return operation;
          if (operation.state !== "awaiting_approval" && operation.state !== "ready")
            return yield* stale();
          const rows = yield* db
            .update(operations)
            .set({
              state: "rejected",
              payloadSealed: null,
              baselineSealed: null,
              updatedAt: yield* now,
            })
            .where(byId(operationId))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    cancel: (operationId) =>
      transact(
        Effect.gen(function* () {
          const operation = yield* lockedOperation(operationId);
          if (!operation) return yield* stale();
          if (!pendingStates.some((state) => state === operation.state)) return operation;
          const rows = yield* db
            .update(operations)
            .set({
              state: "cancelled",
              payloadSealed: null,
              baselineSealed: null,
              updatedAt: yield* now,
            })
            .where(byId(operationId))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    claim: (operationId, fence) =>
      transact(
        Effect.gen(function* () {
          yield* requireConnection(fence);
          const operation = yield* lockedOperation(operationId);
          if (
            !operation ||
            operation.state !== "ready" ||
            operation.expiresAt <= (yield* now) ||
            operation.ownerUserId !== fence.ownerUserId ||
            operation.service !== fence.service ||
            operation.connectionVersion !== fence.connectionVersion ||
            operation.writeGeneration !== fence.writeGeneration ||
            (operation.runtimeMode !== "full-access" &&
              operation.approvedByUserId !== operation.ownerUserId)
          )
            return yield* stale();
          const unresolved = yield* db
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.ownerUserId, operation.ownerUserId),
                eq(operations.service, operation.service),
                eq(operations.environmentId, operation.environmentId),
                eq(operations.threadId, operation.threadId),
                eq(operations.action, operation.action),
                eq(operations.target, operation.target),
                eq(operations.payloadDigest, operation.payloadDigest),
                ne(operations.operationId, operation.operationId),
                inArray(operations.state, ["executing", "outcome_unknown"]),
              ),
            )
            .orderBy(operations.createdAt)
            .limit(2)
            .pipe(Effect.mapError(databaseFailure));
          if (
            unresolved.length > 1 ||
            (unresolved[0] && unresolved[0].operationId !== fence.retryOfOperationId)
          )
            return yield* stale();
          if (fence.retryOfOperationId) {
            const prior = yield* lockedOperation(fence.retryOfOperationId);
            if (
              !prior ||
              prior.state !== "outcome_unknown" ||
              prior.ownerUserId !== operation.ownerUserId ||
              prior.service !== operation.service ||
              prior.environmentId !== operation.environmentId ||
              prior.threadId !== operation.threadId ||
              prior.action !== operation.action ||
              prior.target !== operation.target ||
              prior.payloadDigest !== operation.payloadDigest ||
              operation.runtimeMode !== "approval-required"
            )
              return yield* stale();
            const superseded = yield* db
              .update(operations)
              .set({ state: "superseded", updatedAt: yield* now })
              .where(and(byId(prior.operationId), eq(operations.state, "outcome_unknown")))
              .returning({ id: operations.operationId })
              .pipe(Effect.mapError(databaseFailure));
            if (superseded.length !== 1) return yield* stale();
          }
          const rows = yield* db
            .update(operations)
            .set({
              state: "executing",
              claimedAt: yield* now,
              claimFence: yield* uuid,
              updatedAt: yield* now,
            })
            .where(byId(operationId))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    succeed: (operationId, claimFence, result) =>
      Effect.gen(function* () {
        const rows = yield* db
          .update(operations)
          .set({
            state: "succeeded",
            resultResourceId: result.resourceId,
            resultUrl: result.url,
            payloadSealed: null,
            baselineSealed: null,
            updatedAt: yield* now,
          })
          .where(
            and(
              byId(operationId),
              eq(operations.state, "executing"),
              eq(operations.claimFence, claimFence),
            ),
          )
          .returning({ id: operations.operationId })
          .pipe(Effect.mapError(databaseFailure));
        return rows.length === 1;
      }),
    outcomeUnknown: (operationId, claimFence, safeError, candidate) =>
      Effect.gen(function* () {
        const rows = yield* db
          .update(operations)
          .set({
            state: "outcome_unknown",
            safeError: safeError.slice(0, 1024),
            ...(candidate
              ? { resultResourceId: candidate.resourceId, resultUrl: candidate.url }
              : {}),
            updatedAt: yield* now,
          })
          .where(
            and(
              byId(operationId),
              eq(operations.state, "executing"),
              eq(operations.claimFence, claimFence),
            ),
          )
          .returning({ id: operations.operationId })
          .pipe(Effect.mapError(databaseFailure));
        return rows.length === 1;
      }),
    reconcileUnknown: (operationId, resourceId, fence) =>
      transact(
        Effect.gen(function* () {
          yield* requireConnection(fence);
          const operation = yield* lockedOperation(operationId);
          if (
            !operation ||
            operation.state !== "outcome_unknown" ||
            operation.resultResourceId !== resourceId ||
            !operation.resultUrl ||
            operation.ownerUserId !== fence.ownerUserId ||
            operation.service !== fence.service ||
            operation.connectionVersion !== fence.connectionVersion ||
            operation.writeGeneration !== fence.writeGeneration
          )
            return yield* stale();
          const rows = yield* db
            .update(operations)
            .set({
              state: "succeeded",
              payloadSealed: null,
              baselineSealed: null,
              safeError: null,
              updatedAt: yield* now,
            })
            .where(and(byId(operationId), eq(operations.state, "outcome_unknown")))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    reconcileVerifiedUnknown: (operationId, resourceId, fence) =>
      transact(
        Effect.gen(function* () {
          yield* requireConnection(fence);
          const operation = yield* lockedOperation(operationId);
          if (
            !operation ||
            operation.state !== "outcome_unknown" ||
            operation.resultResourceId !== resourceId ||
            !operation.resultUrl ||
            operation.ownerUserId !== fence.ownerUserId ||
            operation.service !== fence.service ||
            operation.environmentId !== fence.environmentId
          )
            return yield* stale();
          const rows = yield* db
            .update(operations)
            .set({
              state: "succeeded",
              payloadSealed: null,
              baselineSealed: null,
              safeError: null,
              updatedAt: yield* now,
            })
            .where(and(byId(operationId), eq(operations.state, "outcome_unknown")))
            .returning()
            .pipe(Effect.mapError(databaseFailure));
          return rows[0]!;
        }),
      ),
    cancelPending: (ownerUserId, service) =>
      Effect.gen(function* () {
        yield* db
          .update(operations)
          .set({
            state: "cancelled",
            payloadSealed: null,
            baselineSealed: null,
            updatedAt: yield* now,
          })
          .where(
            and(
              eq(operations.ownerUserId, ownerUserId),
              eq(operations.service, service),
              inArray(operations.state, [...pendingStates]),
            ),
          )
          .pipe(Effect.mapError(databaseFailure));
      }),
  });
});

export const layer = Layer.effect(WriteOperationStore, make);
