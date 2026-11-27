import type { RelayThreadMove } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../persistence/ThreadExecutionFence.ts";
import type { ThreadMoveOwner } from "./ThreadMoveTransport.ts";

/** Record only a relay-confirmed abort after local destination cleanup. Retain
 * the tombstone: a restart may reuse its uncommitted generation, never execute it.
 */
export function makeThreadTransferAborts(sql: SqlClient.SqlClient) {
  const fences = makeThreadExecutionFence(sql);
  const record = Effect.fn("ThreadTransferAbort.record")(function* (
    owner: ThreadMoveOwner,
    move: RelayThreadMove,
  ) {
    const fail = () =>
      new ThreadExecutionFenceError({
        threadId: owner.threadId,
        detail: "Destination cleanup has not been confirmed for this abort.",
      });
    if (
      move.phase !== "aborted" ||
      move.operationId !== owner.operationId ||
      move.threadId !== owner.threadId ||
      move.destinationEnvironmentId !== owner.environmentId ||
      move.expectedGeneration + 1 !== owner.generation
    )
      return yield* fail();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const fence = yield* fences.get(owner.threadId);
        if (!fence || fence.operationId !== owner.operationId) return;
        if (
          fence.generation !== owner.generation ||
          fence.environmentId !== owner.environmentId ||
          !["frozen", "retired"].includes(fence.phase)
        )
          return yield* fail();
        const busy =
          yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${owner.threadId} AND (completed=0 OR relay_completed=0)
        UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id=${owner.threadId} AND status!='stopped'
        UNION ALL SELECT 1 FROM thread_checkout_claims WHERE operation_id=${owner.operationId} AND (phase!='released' OR release_reason!='cancelled') LIMIT 1`;
        if (busy.length) return yield* fail();
        yield* sql`INSERT INTO thread_transfer_aborts (operation_id,thread_id,environment_id,generation)
        VALUES (${owner.operationId},${owner.threadId},${owner.environmentId},${owner.generation}) ON CONFLICT(operation_id) DO NOTHING`;
        yield* fences.retire(owner);
      }),
    );
  });
  const eventIds = Effect.fnUntraced(function* (threadId: string) {
    return new Set(
      (yield* sql<{
        operationId: string;
      }>`SELECT operation_id AS "operationId" FROM thread_transfer_aborts WHERE thread_id=${threadId}`).map(
        (row) => `thread-transfer:${row.operationId}`,
      ),
    );
  });
  return { record, eventIds };
}
