import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";

export interface ThreadVmCleanupCompute {
  readonly inspect: (id: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
}

/** Caller first fences this allocation for deletion, preventing new recovery claims.
 * Provisioning and unsettled connects block cleanup even after a claim expires. */
export const confirmThreadVmCleanupIdentity = Effect.fn("relay.thread_vm.cleanup_identity")(
  function* (
    sql: {
      readonly unsafe: (
        ...args: Parameters<PgClient["unsafe"]>
      ) => Effect.Effect<ReadonlyArray<object>, SqlError>;
    },
    compute: ThreadVmCleanupCompute,
    input: {
      readonly allocationId: string;
      readonly threadId: string;
      readonly operationId: string;
      readonly generation: number;
      readonly computeRef: string;
    },
  ) {
    const pending = yield* sql.unsafe(
      `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=$1 AND runtime_protocol='native-v1' AND resource_kind='personal')
       UNION ALL SELECT 1 FROM relay_thread_vm_provisions WHERE allocation_id=$1 AND (phase IN ('pending','creating') OR ingress_recovery_claim_id IS NOT NULL)
       UNION ALL SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=$1 AND pause_dispatch_claim_id IS NOT NULL
       UNION ALL SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=$1 AND connect_claim_id IS NOT NULL
       UNION ALL SELECT 1 FROM relay_thread_vm_restores WHERE allocation_id=$1 AND
         (boot_ingress_recovery_claim_id IS NOT NULL OR (boot_create_started_at IS NOT NULL AND
           (boot_receipt IS NULL OR boot_receipt->>'kind' IS DISTINCT FROM 'native-restore-boot-v1')))`,
      [input.allocationId],
    );
    if (pending.length) return false;
    const inspection = yield* compute.inspect(input.computeRef).pipe(Effect.result);
    if (inspection._tag === "Success") {
      const info = inspection.success;
      // A native 404 still needs the caller's exact DELETE acknowledgement.
      return (
        !info ||
        (info.sandboxId === input.computeRef &&
          info.metadata["launchpad.managed"] === "thread-vm-v1" &&
          info.metadata["launchpad.allocation_id"] === input.allocationId &&
          info.metadata["launchpad.thread_id"] === input.threadId &&
          threadVmOperationMatches(info.metadata, input.operationId) &&
          info.metadata["launchpad.generation"] === String(input.generation))
      );
    }
    return false;
  },
);
