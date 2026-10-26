import type { PgClient } from "@effect/sql-pg/PgClient";
import { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadPlacementStore, ThreadPlacementConflict } from "./ThreadPlacementStore.ts";

export interface LocalEnrollment {
  readonly threadId: string;
  readonly operationId: string;
  readonly phase: "preparing" | "active" | "aborted";
  readonly sourceSequence: number | null;
  readonly receiptCount: number | null;
}
const fail = (message: string) => new ThreadPlacementConflict({ message });
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommandReceipt));

/** A pending baseline owns no execution admission. Its source remains the only possible owner. */
export function makeThreadLocalEnrollmentStore(sql: PgClient) {
  const placements = makeThreadPlacementStore(sql);
  const get = Effect.fnUntraced(function* (threadId: string) {
    const [row] =
      yield* sql<LocalEnrollment>`SELECT thread_id AS "threadId",operation_id AS "operationId",
      phase,source_sequence::float8 AS "sourceSequence",receipt_count AS "receiptCount"
      FROM relay_thread_local_enrollments WHERE thread_id=${threadId}`;
    return row ?? null;
  });
  const prepare = Effect.fn("relay.thread_local_enrollment.prepare")(function* (
    input: Omit<
      import("@t3tools/contracts/relay").RelayPortableThreadPlacement,
      "generation" | "operationId" | "originalLocation"
    > & { operationId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.threadId},4))`;
        const cancelled =
          yield* sql`SELECT 1 FROM relay_thread_local_enrollment_aborts WHERE operation_id=${input.operationId}`;
        if (cancelled.length) return yield* fail("Local enrollment was cancelled");
        const prior = yield* placements.get(input.threadId);
        if (prior) {
          const enrollment = yield* get(input.threadId);
          if (
            !enrollment ||
            (enrollment.phase !== "aborted" && enrollment.operationId !== input.operationId) ||
            prior.generation !== 1 ||
            prior.environmentId !== input.environmentId ||
            prior.projectId !== input.projectId ||
            prior.repositoryId !== input.repositoryId ||
            prior.organizationId !== input.organizationId ||
            prior.ownerUserId !== input.ownerUserId ||
            (prior.originalLocation != null &&
              (prior.originalLocation.environmentId !== input.environmentId ||
                prior.originalLocation.projectId !== input.projectId)) ||
            (enrollment.phase === "preparing" || enrollment.phase === "aborted"
              ? prior.operationId !== enrollment.operationId
              : prior.operationId !== null)
          )
            return yield* fail("Local enrollment identity changed");
          if (enrollment.phase === "aborted") {
            if (input.operationId === enrollment.operationId)
              return yield* fail("Local enrollment was cancelled");
            yield* sql`UPDATE relay_thread_local_enrollments SET operation_id=${input.operationId},phase='preparing',source_sequence=NULL,receipt_count=NULL
              WHERE thread_id=${input.threadId}`;
            yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
          }
        } else {
          yield* placements.enroll(input);
          yield* sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id)
          VALUES(${input.threadId},${input.operationId})`;
          yield* sql`UPDATE relay_thread_placements SET operation_id=${input.operationId} WHERE thread_id=${input.threadId}`;
        }
        // The authenticated local source owns these IDs; VM enrollment never sets an origin.
        yield* sql`UPDATE relay_thread_placements SET original_environment_id=${input.environmentId},original_project_id=${input.projectId}
          WHERE thread_id=${input.threadId} AND original_environment_id IS NULL`;
        return {
          placement: (yield* placements.get(input.threadId))!,
          ...(yield* get(input.threadId))!,
        };
      }),
    );
  });
  const receipts = Effect.fn("relay.thread_local_enrollment.receipts")(function* (input: {
    threadId: string;
    operationId: string;
    receipts: ReadonlyArray<OrchestrationCommandReceipt>;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const enrollment = yield* get(input.threadId),
          placement = yield* placements.get(input.threadId);
        if (
          !enrollment ||
          !placement ||
          enrollment.phase === "aborted" ||
          enrollment.operationId !== input.operationId ||
          input.receipts.length > 100
        )
          return yield* fail("Local enrollment receipt scope changed");
        for (const receipt of input.receipts) {
          if (
            receipt.aggregateKind !== "thread" ||
            receipt.aggregateId !== input.threadId ||
            receipt.projectId !== placement.projectId
          )
            return yield* fail("Enrollment includes an unrelated or unsettled receipt");
          const json = yield* encodeReceipt(receipt);
          const [prior] = yield* sql<{
            same: boolean;
          }>`SELECT thread_id=${input.threadId} AND receipt_json=${json}::jsonb AS same
          FROM relay_thread_local_receipts WHERE command_id=${receipt.commandId}`;
          if (prior) {
            if (!prior.same) return yield* fail("Enrollment receipt identity reused");
            continue;
          }
          if (enrollment.phase !== "preparing")
            return yield* fail("The enrollment baseline is sealed");
          yield* sql`INSERT INTO relay_thread_local_receipts(command_id,thread_id,receipt_json)
          VALUES(${receipt.commandId},${input.threadId},${json}::jsonb)`;
        }
        return { ok: true as const };
      }),
    );
  });
  const confirm = Effect.fn("relay.thread_local_enrollment.confirm")(function* (input: {
    threadId: string;
    operationId: string;
    sourceSequence: number;
    receiptCount: number;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const enrollment = yield* get(input.threadId),
          placement = yield* placements.get(input.threadId);
        if (
          !enrollment ||
          !placement ||
          enrollment.phase === "aborted" ||
          enrollment.operationId !== input.operationId ||
          placement.generation !== 1
        )
          return yield* fail("Local enrollment identity changed");
        if (enrollment.phase === "active") {
          if (
            enrollment.sourceSequence !== input.sourceSequence ||
            enrollment.receiptCount !== input.receiptCount
          )
            return yield* fail("Local enrollment baseline changed");
          return { placement, ...enrollment };
        }
        const [baseline] = yield* sql<{ ready: boolean }>`SELECT
        EXISTS(SELECT 1 FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId}
          AND environment_id=${placement.environmentId} AND generation=1 AND source_sequence>=${input.sourceSequence})
        AND EXISTS(SELECT 1 FROM relay_thread_history WHERE thread_id=${input.threadId}
          AND environment_id=${placement.environmentId} AND event_json->>'type'='thread.created')
        AND NOT EXISTS(SELECT 1 FROM relay_thread_history WHERE thread_id=${input.threadId}
          AND environment_id=${placement.environmentId} AND source_sequence>${input.sourceSequence})
        AND (SELECT COUNT(*) FROM relay_thread_local_receipts WHERE thread_id=${input.threadId})=${input.receiptCount}
        AND NOT EXISTS(SELECT 1 FROM relay_thread_local_receipts WHERE thread_id=${input.threadId}
          AND receipt_json->>'status'='accepted' AND (receipt_json->>'resultSequence')::bigint>${input.sourceSequence}) AS ready`;
        if (!baseline?.ready || placement.operationId !== input.operationId)
          return yield* fail("The complete frozen local baseline has not been received");
        yield* sql`UPDATE relay_thread_local_enrollments SET phase='active',source_sequence=${input.sourceSequence},
        receipt_count=${input.receiptCount} WHERE thread_id=${input.threadId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${input.threadId}
        AND operation_id=${input.operationId}`;
        return {
          placement: (yield* placements.get(input.threadId))!,
          ...(yield* get(input.threadId))!,
        };
      }),
    );
  });
  const abort = Effect.fn("relay.thread_local_enrollment.abort")(function* (input: {
    threadId: string;
    environmentId: string;
    operationId: string;
    projectId: string;
    actorUserId: string;
    canonicalKey: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.threadId},4))`;
        const [certificate] = yield* sql<{
          same: boolean;
        }>`SELECT thread_id=${input.threadId} AND environment_id=${input.environmentId}
        AND project_id=${input.projectId} AND actor_user_id=${input.actorUserId} AND canonical_key=${input.canonicalKey} AS same
        FROM relay_thread_local_enrollment_aborts WHERE operation_id=${input.operationId}`;
        if (certificate) {
          if (!certificate.same) return yield* fail("Enrollment abort identity changed");
          return { ...input, outcome: "aborted" as const };
        }
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const placement = yield* placements.get(input.threadId),
          enrollment = yield* get(input.threadId);
        if (placement) {
          if (
            !enrollment ||
            enrollment.operationId !== input.operationId ||
            placement.environmentId !== input.environmentId ||
            placement.projectId !== input.projectId ||
            placement.ownerUserId !== input.actorUserId ||
            placement.generation !== 1
          )
            return yield* fail("Enrollment abort no longer owns this placement");
          const aliases =
            yield* sql`SELECT 1 FROM relay_repository_aliases WHERE canonical_key=${input.canonicalKey}
          AND repository_id=${placement.repositoryId} AND organization_id=${placement.organizationId}`;
          if (!aliases.length) return yield* fail("Enrollment repository identity changed");
          // Preserve accepted commands. They require completing enrollment and cancelling through the inbox.
          const commands =
            yield* sql`SELECT 1 FROM relay_thread_commands WHERE thread_id=${input.threadId} LIMIT 1`;
          if (enrollment.phase === "active" || commands.length)
            return { ...input, outcome: "continue" as const };
          if (placement.operationId !== input.operationId)
            return yield* fail("Enrollment abort operation changed");
          yield* sql`UPDATE relay_thread_local_enrollments SET phase='aborted' WHERE thread_id=${input.threadId}`;
        }
        yield* sql`INSERT INTO relay_thread_local_enrollment_aborts(operation_id,thread_id,environment_id,project_id,actor_user_id,canonical_key)
        VALUES(${input.operationId},${input.threadId},${input.environmentId},${input.projectId},${input.actorUserId},${input.canonicalKey})`;
        return { ...input, outcome: "aborted" as const };
      }),
    );
  });
  return { get, prepare, receipts, confirm, abort };
}
