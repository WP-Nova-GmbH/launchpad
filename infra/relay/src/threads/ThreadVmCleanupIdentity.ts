import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Effect from "effect/Effect";
import type { E2BRestoreError, E2BRestoreStatus } from "../machines/E2BRestoreClient.ts";
import type {
  ThreadVmComputeError,
  ThreadVmCreationIdentity,
} from "../machines/E2BThreadVmCompute.ts";
import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";

export interface ThreadVmCleanupCompute {
  readonly inspect: (id: string) => Effect.Effect<SandboxInfo | null, ThreadVmComputeError>;
  readonly inspectCreation?: (
    operationId: string,
  ) => Effect.Effect<ThreadVmCreationIdentity | null, ThreadVmComputeError>;
  readonly restore?: {
    readonly inspect: (
      operationId: string,
      generation: string,
    ) => Effect.Effect<E2BRestoreStatus, E2BRestoreError>;
  };
}

/** Caller first authorizes cleanup of this allocation. Pause disk readiness is
 * separate from ownership; its failure cannot erase durable control-plane identity. */
export const confirmThreadVmCleanupIdentity = Effect.fn("relay.thread_vm.cleanup_identity")(
  function* (
    sql: PgClient,
    compute: ThreadVmCleanupCompute,
    input: {
      readonly allocationId: string;
      readonly threadId: string;
      readonly operationId: string;
      readonly generation: number;
      readonly computeRef: string;
    },
  ) {
    const inspection = yield* compute.inspect(input.computeRef).pipe(Effect.result);
    if (inspection._tag === "Success") {
      const info = inspection.success;
      // A missing routing entry still needs the caller's physical-stop receipt.
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
    const [restored] = yield* sql<{
      bootReceipt: E2BRestoreStatus;
    }>`SELECT boot_receipt AS "bootReceipt" FROM relay_thread_vm_restores WHERE allocation_id=${input.allocationId} AND thread_id=${input.threadId} AND operation_id=${input.operationId} AND generation+1=${input.generation} AND phase='completed' AND boot_receipt->>'sandboxID'=${input.computeRef}`;
    if (restored) {
      if (!compute.restore) return false;
      const expected = restored.bootReceipt;
      const receipt = yield* compute.restore.inspect(expected.operationID, expected.generation);
      return (
        receipt.operationID === expected.operationID &&
        receipt.generation === String(input.generation) &&
        receipt.generation === expected.generation &&
        receipt.sandboxID === input.computeRef &&
        receipt.executionID === expected.executionID &&
        receipt.preparedBuildID === expected.preparedBuildID &&
        ["active", "activating", "failed"].includes(receipt.state)
      );
    }
    const identity = compute.inspectCreation
      ? yield* compute.inspectCreation(input.operationId)
      : null;
    return (
      !!identity &&
      identity.operationId === input.operationId &&
      identity.computeRef === input.computeRef &&
      identity.metadata["launchpad.managed"] === "thread-vm-v1" &&
      identity.metadata["launchpad.allocation_id"] === input.allocationId &&
      identity.metadata["launchpad.thread_id"] === input.threadId &&
      identity.metadata["launchpad.operation_id"] === input.operationId &&
      identity.metadata["launchpad.generation"] === String(input.generation)
    );
  },
);
