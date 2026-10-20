import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { makeThreadPlacementStore, ThreadPlacementConflict } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import type { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";

/** Internal coordinator only. The caller rechecks the private owner and source
 * credential. A reserved destination is quarantined, never the serving owner. */
export function makeThreadVmMoveDestinationStore(sql: PgClient) {
  const placements = makeThreadPlacementStore(sql),
    allocations = makeThreadVmAllocationStore(sql);
  const conflict = (message: string) => new ThreadPlacementConflict({ message });
  const enqueue = Effect.fn("relay.thread_vm_move.enqueue")(function* (input: {
    threadId: string;
    operationId: string;
    actorUserId: string;
    sourceEnvironmentId: string;
    expectedGeneration: number;
    hostId: string;
    templateId: string;
    cancelBeforeStart: boolean;
    replacementRequestId?: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const placement = yield* placements.get(input.threadId);
        if (!placement || placement.ownerUserId !== input.actorUserId)
          return yield* conflict("Only the private thread owner can move it to a VM");
        const [prior] = yield* sql<{
          allocationId: string;
        }>`SELECT allocation_id AS "allocationId" FROM relay_thread_vm_move_destinations WHERE operation_id=${input.operationId}`;
        if (prior) {
          const move = yield* placements.getMove(input);
          const provision = yield* makeThreadVmProvisionStore(sql).get(prior.allocationId);
          if (
            move.actorUserId !== input.actorUserId ||
            move.sourceEnvironmentId !== input.sourceEnvironmentId ||
            move.expectedGeneration !== input.expectedGeneration ||
            !provision ||
            provision.threadId !== input.threadId ||
            provision.operationId !== input.operationId ||
            provision.generation !== input.expectedGeneration + 1
          )
            return yield* conflict("VM move identity was reused with different intent");
          return move;
        }
        const move = yield* placements.beginMove({
          ...input,
          destinationEnvironmentId: `pending-vm:${input.operationId}`,
          destinationProjectId: `vm:${input.threadId}`,
        });
        if (input.cancelBeforeStart) {
          yield* placements.requestAbort(input);
          // This transaction has never reserved or attempted a destination create.
          return yield* placements.destinationRemoved(input);
        }
        if (move.phase === "aborted") return move;
        yield* allocations.reserve({
          allocationId: input.operationId,
          threadId: input.threadId,
          organizationId: placement.organizationId,
          ownerUserId: input.actorUserId,
          templateId: input.templateId,
          ...(input.replacementRequestId
            ? { replacementRequestId: input.replacementRequestId }
            : {}),
        });
        yield* makeThreadVmProvisionStore(sql).enqueue({
          allocationId: input.operationId,
          operationId: input.operationId,
          generation: input.expectedGeneration + 1,
          hostId: input.hostId,
        });
        yield* sql`INSERT INTO relay_thread_vm_move_destinations (operation_id,allocation_id) VALUES (${input.operationId},${input.operationId})`;
        return move;
      }),
    );
  });
  const assigned = Effect.fn("relay.thread_vm_move.assign_enrolled")(function* (
    receipt: RelayThreadVmEnrollmentReceipt,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [intent] = yield* sql`SELECT d.operation_id FROM relay_thread_vm_move_destinations d
        JOIN relay_thread_moves m USING(operation_id) WHERE d.operation_id=${receipt.operationId}
          AND d.allocation_id=${receipt.allocationId} AND m.thread_id=${receipt.threadId}`;
        if (!intent) return false; // Ordinary initial setup uses its existing generation-one path.
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${receipt.threadId} FOR UPDATE`;
        const move = yield* placements.getMove(receipt);
        if (move.phase === "aborting" || move.phase === "aborted") return false;
        const [binding] = yield* sql`SELECT b.environment_id FROM relay_thread_vm_bindings b
        JOIN relay_thread_vm_enrollments e USING(allocation_id)
        JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        WHERE b.allocation_id=${receipt.allocationId} AND b.environment_id=${receipt.environmentId}
          AND b.thread_id=${receipt.threadId} AND b.generation=${receipt.generation}
          AND b.generation=${move.expectedGeneration + 1} AND b.revoked_at IS NULL
          AND e.installed_at IS NOT NULL AND e.operation_id=${receipt.operationId} AND c.revoked_at IS NULL FOR SHARE OF b,c`;
        if (!binding) return yield* conflict("VM move requires its confirmed narrow enrollment");
        if (move.destinationEnvironmentId === receipt.environmentId) return true;
        if (
          !["preparing", "frozen"].includes(move.phase) ||
          move.destinationEnvironmentId !== `pending-vm:${receipt.operationId}`
        )
          return yield* conflict("The destination identity already changed");
        yield* sql`UPDATE relay_thread_moves SET destination_environment_id=${receipt.environmentId} WHERE operation_id=${receipt.operationId}`;
        return true;
      }),
    );
  });
  return { enqueue, assigned };
}
