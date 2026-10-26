import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { RelayDb } from "../db.ts";
import {
  relayIssueTrackerWriteOperations as operations,
  relayUserIssueTrackerConnections as connections,
} from "../persistence/schema.ts";
import { linearRow } from "./Connections.test-fixture.ts";
import { make as makeConnections } from "./ConnectionStore.ts";
import { WriteOperationStore, make as makeOperations } from "./WriteOperationStore.ts";

// Explicitly opt in with an isolated, migrated database. This never reads the live relay config.
const databaseUrl = process.env.ISSUE_TRACKER_WRITE_TEST_DATABASE_URL;
const ownerUserId = "issue-tracker-write-operation-test";
const key = { ownerUserId, service: "linear" as const };
const layer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "") })),
  Layer.provideMerge(NodeCrypto.layer),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(layer), Effect.scoped);
const input = {
  ...key,
  environmentId: "write-test-environment",
  threadId: "write-test-thread",
  commandId: "write-test-command",
  providerSessionId: "write-test-session",
  invocationId: "write-test-invocation",
  connectionVersion: "initial",
  writeGeneration: 4,
  runtimeMode: "approval-required",
  action: "add_comment",
  target: "WP-218",
  payloadDigest: "a".repeat(64),
  payloadSealed: "sealed:test-comment",
  baselineSealed: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
} satisfies Parameters<WriteOperationStore["Service"]["prepare"]>[0];

describe.skipIf(!databaseUrl)("issue tracker write operation fencing (PostgreSQL)", () => {
  it.effect(
    "keeps old uncertain writes guarded across a connection change and approves a retry",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* RelayDb;
          yield* db.delete(operations).where(eq(operations.ownerUserId, ownerUserId));
          yield* db.delete(connections).where(eq(connections.ownerUserId, ownerUserId));
          yield* db.insert(connections).values({
            ...linearRow(),
            ...key,
            writesEnabled: true,
            writeGeneration: 4,
          });
          const writes = yield* makeOperations;
          const oldSuccess = yield* writes.prepare({
            ...input,
            runtimeMode: "full-access",
            invocationId: "old-success",
            payloadDigest: "q".repeat(64),
          });
          const successClaim = yield* writes.claim(oldSuccess.operation.operationId, input);
          yield* writes.outcomeUnknown(
            oldSuccess.operation.operationId,
            successClaim.claimFence!,
            "Awaiting verification.",
            {
              resourceId: "old-comment",
              url: "https://linear.app/launchpad/issue/WP-218#old-comment",
            },
          );
          yield* writes.reconcileUnknown(oldSuccess.operation.operationId, "old-comment", input);
          const unknown = yield* writes.prepare({
            ...input,
            runtimeMode: "full-access",
            invocationId: "old-unknown",
            payloadDigest: "r".repeat(64),
          });
          const unknownClaim = yield* writes.claim(unknown.operation.operationId, input);
          yield* writes.outcomeUnknown(
            unknown.operation.operationId,
            unknownClaim.claimFence!,
            "Could not confirm the write.",
          );
          yield* db
            .update(connections)
            .set({ version: "rotated", writeGeneration: 5 })
            .where(eq(connections.ownerUserId, ownerUserId));
          const current = { ...input, connectionVersion: "rotated", writeGeneration: 5 };
          const newSuccess = yield* writes.prepare({
            ...current,
            runtimeMode: "full-access",
            invocationId: "new-success",
            payloadDigest: "q".repeat(64),
          });
          expect(newSuccess.reused).toBe(false);
          expect(newSuccess.operation.operationId).not.toBe(oldSuccess.operation.operationId);
          expect(
            (yield* writes.findUnknown({
              ...current,
              payloadDigest: "r".repeat(64),
            }))?.operationId,
          ).toBe(unknown.operation.operationId);
          const ordinary = yield* writes.prepare({
            ...current,
            runtimeMode: "full-access",
            invocationId: "unapproved-duplicate",
            payloadDigest: "r".repeat(64),
          });
          expect(
            yield* writes.claim(ordinary.operation.operationId, current).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          const retryInput = {
            ...current,
            commandId: "explicit-retry-command",
            runtimeMode: "full-access" as const,
            payloadDigest: "r".repeat(64),
            retryOfOperationId: unknown.operation.operationId,
          };
          const rejected = yield* writes.prepare({ ...retryInput, invocationId: "rejected-retry" });
          expect(rejected.operation.state).toBe("awaiting_approval");
          expect(
            yield* writes.claim(rejected.operation.operationId, retryInput).pipe(Effect.flip),
          ).toMatchObject({ code: "conflict" });
          yield* writes.reject(rejected.operation.operationId);
          expect((yield* writes.get(unknown.operation.operationId))?.state).toBe("outcome_unknown");
          const approved = yield* writes.prepare({ ...retryInput, invocationId: "approved-retry" });
          yield* writes.approve(approved.operation.operationId, ownerUserId);
          expect((yield* writes.claim(approved.operation.operationId, retryInput)).state).toBe(
            "executing",
          );
          expect((yield* writes.get(unknown.operation.operationId))?.state).toBe("superseded");
          yield* db.delete(operations).where(eq(operations.ownerUserId, ownerUserId));
          yield* db.delete(connections).where(eq(connections.ownerUserId, ownerUserId));
        }),
      ),
  );
  it.effect("deduplicates safe retries and serializes approval, claim and permission disable", () =>
    run(
      Effect.gen(function* () {
        const db = yield* RelayDb;
        yield* db.delete(operations).where(eq(operations.ownerUserId, ownerUserId));
        yield* db.delete(connections).where(eq(connections.ownerUserId, ownerUserId));
        yield* db.insert(connections).values({
          ...linearRow(),
          ...key,
          writesEnabled: true,
          writeGeneration: 4,
        });
        const writes = yield* makeOperations;
        const connection = yield* makeConnections;
        const first = yield* writes.prepare(input);
        expect(first.reused).toBe(false);
        expect(first.operation.state).toBe("awaiting_approval");
        expect((yield* writes.prepare(input)).operation.operationId).toBe(
          first.operation.operationId,
        );
        const replay = yield* writes
          .prepare({ ...input, invocationId: "another-invocation" })
          .pipe(Effect.flip);
        expect(replay).toMatchObject({ code: "write_in_progress" });
        expect(
          (yield* writes.approve(first.operation.operationId, ownerUserId)).approvedByUserId,
        ).toBe(ownerUserId);
        expect((yield* writes.approve(first.operation.operationId, ownerUserId)).state).toBe(
          "ready",
        );
        const concurrentClaims = yield* Effect.all(
          [
            writes.claim(first.operation.operationId, input).pipe(Effect.exit),
            writes.claim(first.operation.operationId, input).pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        expect(concurrentClaims.filter(Exit.isSuccess)).toHaveLength(1);
        const claimed = concurrentClaims.find(Exit.isSuccess)!.value;
        expect(claimed.state).toBe("executing");
        expect(
          yield* writes.claim(first.operation.operationId, input).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(
          yield* writes.outcomeUnknown(first.operation.operationId, "wrong-fence", "Uncertain.", {
            resourceId: "comment-1",
            url: "https://linear.app/launchpad/issue/WP-218#comment-1",
          }),
        ).toBe(false);
        expect(
          yield* writes.outcomeUnknown(
            first.operation.operationId,
            claimed.claimFence!,
            "Uncertain.",
            {
              resourceId: "comment-1",
              url: "https://linear.app/launchpad/issue/WP-218#comment-1",
            },
          ),
        ).toBe(true);
        expect((yield* writes.get(first.operation.operationId))?.state).toBe("outcome_unknown");
        expect(
          yield* writes
            .reconcileUnknown(first.operation.operationId, "comment-1", {
              ...input,
              writeGeneration: input.writeGeneration + 1,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(
          (yield* writes.reconcileUnknown(first.operation.operationId, "comment-1", input)).state,
        ).toBe("succeeded");
        expect((yield* writes.get(first.operation.operationId))?.state).toBe("succeeded");
        const newRequest = yield* writes.prepare({
          ...input,
          commandId: "explicit-new-request",
          invocationId: "new-request-invocation",
          payloadDigest: "z".repeat(64),
        });
        expect(newRequest.reused).toBe(false);
        expect(newRequest.operation.operationId).not.toBe(first.operation.operationId);
        yield* db
          .update(operations)
          .set({ expiresAt: "1900-01-01T00:00:00.000Z" })
          .where(eq(operations.operationId, newRequest.operation.operationId));
        expect((yield* writes.get(newRequest.operation.operationId))?.expiresAt).toBe(
          "1900-01-01T00:00:00.000Z",
        );
        yield* writes.prepare({
          ...input,
          invocationId: "cleanup-trigger",
          payloadDigest: "d".repeat(64),
        });
        expect((yield* writes.get(newRequest.operation.operationId))?.state).toBe("cancelled");
        expect((yield* writes.get(newRequest.operation.operationId))?.payloadSealed).toBeNull();
        const uncertain = yield* writes.prepare({
          ...input,
          invocationId: "uncertain",
          payloadDigest: "c".repeat(64),
        });
        yield* writes.approve(uncertain.operation.operationId, ownerUserId);
        const uncertainClaim = yield* writes.claim(uncertain.operation.operationId, input);
        yield* writes.outcomeUnknown(
          uncertain.operation.operationId,
          uncertainClaim.claimFence!,
          "Result could not be confirmed.",
        );
        const crossTurnRetry = yield* writes.prepare({
          ...input,
          commandId: "later-turn",
          invocationId: "later-turn-invocation",
          payloadDigest: "c".repeat(64),
        });
        expect(crossTurnRetry.reused).toBe(true);
        expect(crossTurnRetry.operation.operationId).toBe(uncertain.operation.operationId);
        const candidate = yield* writes.prepare({
          ...input,
          invocationId: "candidate-write",
          payloadDigest: "h".repeat(64),
        });
        yield* writes.approve(candidate.operation.operationId, ownerUserId);
        const candidateClaim = yield* writes.claim(candidate.operation.operationId, input);
        yield* writes.outcomeUnknown(
          candidate.operation.operationId,
          candidateClaim.claimFence!,
          "Read-back failed.",
          {
            resourceId: "comment-candidate",
            url: "https://linear.app/launchpad/issue/WP-218#comment-candidate",
          },
        );
        expect(
          (yield* writes.findUnknown({ ...input, payloadDigest: "h".repeat(64) }))?.operationId,
        ).toBe(candidate.operation.operationId);
        expect(
          (yield* writes.reconcileUnknown(
            candidate.operation.operationId,
            "comment-candidate",
            input,
          )).state,
        ).toBe("succeeded");
        expect(
          (yield* writes.prepare({
            ...input,
            commandId: "candidate-retry",
            invocationId: "candidate-retry",
            payloadDigest: "h".repeat(64),
          })).reused,
        ).toBe(true);
        const abandoned = yield* writes.prepare({
          ...input,
          invocationId: "abandoned-proposal",
          payloadDigest: "g".repeat(64),
        });
        const replacement = yield* writes.prepare({
          ...input,
          commandId: "replacement-command",
          invocationId: "replacement-invocation",
          payloadDigest: "g".repeat(64),
        });
        expect(replacement.reused).toBe(false);
        expect(replacement.operation.operationId).not.toBe(abandoned.operation.operationId);
        expect((yield* writes.get(abandoned.operation.operationId))?.state).toBe("cancelled");
        expect((yield* writes.cancel(replacement.operation.operationId)).state).toBe("cancelled");
        const interrupted = yield* writes.prepare({
          ...input,
          invocationId: "interrupted",
          payloadDigest: "e".repeat(64),
        });
        yield* writes.approve(interrupted.operation.operationId, ownerUserId);
        yield* writes.claim(interrupted.operation.operationId, input);
        yield* db
          .update(operations)
          .set({ claimedAt: "1900-01-01T00:00:00.000Z" })
          .where(eq(operations.operationId, interrupted.operation.operationId));
        const afterRestart = yield* writes.prepare({
          ...input,
          commandId: "after-restart",
          invocationId: "after-restart-invocation",
          payloadDigest: "e".repeat(64),
        });
        expect(afterRestart.reused).toBe(true);
        expect(afterRestart.operation.state).toBe("outcome_unknown");
        expect(afterRestart.operation.operationId).toBe(interrupted.operation.operationId);
        const fullAccess = yield* writes.prepare({
          ...input,
          runtimeMode: "full-access",
          invocationId: "full-access-invocation",
          payloadDigest: "f".repeat(64),
        });
        expect(fullAccess.operation.state).toBe("ready");
        expect((yield* writes.claim(fullAccess.operation.operationId, input)).state).toBe(
          "executing",
        );
        const second = yield* writes.prepare({
          ...input,
          invocationId: "second",
          payloadDigest: "b".repeat(64),
        });
        expect(second.operation.state).toBe("awaiting_approval");
        yield* writes.approve(second.operation.operationId, ownerUserId);
        const [disableResult, claimResult] = yield* Effect.all(
          [
            connection.withLock(key, () =>
              connection.syncWriteCapability({ ...key, version: "initial", enabled: false }),
            ),
            writes.claim(second.operation.operationId, input).pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        expect(disableResult).toBe(true);
        expect((yield* writes.get(second.operation.operationId))?.state).toBe(
          Exit.isSuccess(claimResult) ? "executing" : "cancelled",
        );
        expect(
          yield* writes.claim(second.operation.operationId, input).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect((yield* writes.get(first.operation.operationId))?.state).toBe("succeeded");
        yield* db.delete(operations).where(eq(operations.ownerUserId, ownerUserId));
        yield* db.delete(connections).where(eq(connections.ownerUserId, ownerUserId));
      }),
    ),
  );
});
