import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";

export class ThreadVmPauseConflict extends Schema.TaggedError<ThreadVmPauseConflict>()(
  "ThreadVmPauseConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadVmPauseConflict({ message });
type Owner = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly generation: number;
};
export interface ThreadVmPauseRecovery extends Owner {
  readonly allocationId: string;
  readonly operationId: string;
  readonly phase: "pending" | "sealed" | "completed" | "cancelled";
  readonly bootId: string | null;
  readonly sourceSequence: number | null;
  readonly nativeCheckpointOperationId: string | null;
  readonly canActivate: boolean;
  readonly sourceReopened: boolean;
}

/** A pause retains its exact stopped conversation, independently of the VM's disk and memory. */
export function makeThreadVmPauseRecoveryStore(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects);
  const get = Effect.fn("relay.thread_vm.pause.recovery.get")(function* (owner: Owner) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${owner.threadId} FOR UPDATE`;
        const [row] =
          yield* sql<ThreadVmPauseRecovery>`SELECT x.allocation_id AS "allocationId",x.operation_id AS "operationId",
        a.thread_id AS "threadId",b.environment_id AS "environmentId",x.generation,x.phase,x.boot_id AS "bootId",
        (x.source_reopened_at IS NOT NULL) AS "sourceReopened",x.source_sequence AS "sourceSequence",x.native_checkpoint_operation_id AS "nativeCheckpointOperationId",
        (a.state='running' AND t.operation_id IS NULL AND (x.phase='cancelled' OR (x.phase='completed' AND EXISTS
          (SELECT 1 FROM relay_thread_vm_resumes r JOIN relay_thread_vm_capacity c ON c.operation_id=r.operation_id
           WHERE r.allocation_id=a.allocation_id AND r.generation=x.generation AND r.phase='completed'
             AND c.state='started' AND c.compute_ref=a.compute_ref)))) AS "canActivate"
        FROM relay_thread_vm_pauses x JOIN relay_thread_vm_allocations a USING(allocation_id)
        JOIN relay_thread_vm_bindings b USING(allocation_id) JOIN relay_thread_placements t ON t.thread_id=a.thread_id
        WHERE a.thread_id=${owner.threadId} AND b.environment_id=${owner.environmentId}
          AND x.generation=${owner.generation} AND t.environment_id=b.environment_id AND t.generation=x.generation
          AND b.generation=x.generation AND b.revoked_at IS NULL AND a.deleted_at IS NULL`;
        if (!row) return null;
        return row;
      }),
    );
  });
  const sourceFrozen = Effect.fn("relay.thread_vm.pause.recovery.source_frozen")(function* (
    input: Owner & {
      readonly operationId: string;
      readonly nativeCheckpointOperationId: string;
      readonly bootId: string;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const pause = yield* get(input);
        if (!pause || pause.operationId !== input.operationId || pause.phase === "cancelled")
          return yield* conflict("The source no longer owns this pause operation.");
        if (pause.nativeCheckpointOperationId) {
          if (
            pause.nativeCheckpointOperationId !== input.nativeCheckpointOperationId ||
            pause.bootId !== input.bootId
          )
            return yield* conflict("Pause recovery identity changed.");
          return pause;
        }
        const [owned] =
          yield* sql`SELECT 1 FROM relay_thread_placements t JOIN relay_thread_vm_allocations a USING(thread_id)
        WHERE t.thread_id=${input.threadId} AND t.generation=${input.generation} AND t.operation_id IS NULL
          AND a.allocation_id=${pause.allocationId} AND a.state='running' AND a.deleted_at IS NULL FOR UPDATE OF a`;
        if (!owned || pause.phase !== "pending")
          return yield* conflict("Pause cannot accept a source acknowledgement.");
        const point = yield* natives.get(input.nativeCheckpointOperationId);
        if (
          !point ||
          point.threadId !== input.threadId ||
          point.sourceEnvironmentId !== input.environmentId ||
          point.generation !== input.generation ||
          point.captureOperationId !== input.operationId
        )
          return yield* conflict("Pause requires its exact complete frozen recovery point.");
        const [mirrored] =
          yield* sql`SELECT 1 FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId}
        AND environment_id=${input.environmentId} AND generation=${input.generation} AND source_sequence>=${point.sourceSequence}`;
        const unsettled =
          yield* sql`SELECT 1 FROM relay_thread_history WHERE thread_id=${input.threadId}
        AND environment_id=${input.environmentId} AND source_sequence>${point.sourceSequence}
        UNION ALL SELECT 1 FROM relay_thread_execution_admissions WHERE thread_id=${input.threadId} AND NOT completed
        UNION ALL SELECT 1 FROM relay_thread_commands WHERE thread_id=${input.threadId} AND receipt_json IS NULL LIMIT 1`;
        if (!mirrored || unsettled.length)
          return yield* conflict("Pause source history and work must settle first.");
        yield* natives.pinCompleteForOperation({
          threadId: input.threadId,
          operationId: input.operationId,
          checkpointOperationId: point.operationId,
          expected: point,
        });
        yield* sql`UPDATE relay_thread_vm_pauses SET boot_id=${input.bootId},source_sequence=${point.sourceSequence},
        native_checkpoint_operation_id=${point.operationId},source_frozen_at=clock_timestamp()
        WHERE allocation_id=${pause.allocationId} AND operation_id=${input.operationId} AND phase='pending'`;
        return (yield* get(input))!;
      }),
    );
  });
  const confirmActivation = Effect.fn("relay.thread_vm.pause.recovery.confirm_activation")(
    function* (input: Owner & { readonly operationId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const pause = yield* get(input);
          if (!pause || pause.operationId !== input.operationId || !pause.canActivate)
            return yield* conflict("Pause activation has not been confirmed by the relay.");
          if (pause.sourceReopened) return pause;
          if (pause.nativeCheckpointOperationId)
            yield* natives.releaseOperation({
              threadId: input.threadId,
              operationId: input.operationId,
            });
          yield* sql`UPDATE relay_thread_vm_pauses SET source_reopened_at=clock_timestamp()
        WHERE allocation_id=${pause.allocationId} AND operation_id=${input.operationId}`;
          return (yield* get(input))!;
        }),
      );
    },
  );
  const cancelBeforeFreeze = Effect.fn("relay.thread_vm.pause.recovery.cancel_before_freeze")(
    function* (input: Owner & { readonly operationId: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const pause = yield* get(input);
          if (!pause || pause.operationId !== input.operationId)
            return yield* conflict("Another operation owns this pause.");
          if (pause.phase === "cancelled") return pause;
          if (!(yield* makeThreadVmPauseStore(sql).cancelBeforeFreeze(input)))
            return yield* conflict("Certified pause cannot be cancelled by its source.");
          return (yield* get(input))!;
        }),
      );
    },
  );
  return { get, sourceFrozen, confirmActivation, cancelBeforeFreeze };
}
