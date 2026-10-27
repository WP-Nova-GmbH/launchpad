import { ThreadId } from "@t3tools/contracts";
import type { ThreadVmRestore } from "../threads/ThreadVmRestoreStore.ts";

export const serializeThreadVmRestore = (
  restore: Pick<
    ThreadVmRestore,
    | "operationId"
    | "allocationId"
    | "threadId"
    | "generation"
    | "phase"
    | "savedDiskOperationId"
    | "errorCode"
  >,
) => ({
  operationId: restore.operationId,
  allocationId: restore.allocationId,
  threadId: ThreadId.make(restore.threadId),
  generation: restore.generation + 1,
  phase: restore.phase,
  canCancel:
    !!restore.savedDiskOperationId &&
    ["pending", "preparing", "prepared", "boot_preparing", "boot_prepared"].includes(restore.phase),
  errorCode: restore.errorCode,
});

export const serializeBackupRecovery = (row: {
  operationId: string;
  allocationId: string;
  threadId: string;
  generation: number;
  phase: string;
  errorCode: string | null;
}) => ({
  operationId: row.operationId,
  allocationId: row.allocationId,
  threadId: ThreadId.make(row.threadId),
  generation: row.generation + 1,
  phase:
    row.phase === "cancelled"
      ? ("aborted" as const)
      : row.phase === "completed"
        ? ("completed" as const)
        : ("pending" as const),
  canCancel: row.phase === "pending",
  recoveryStage:
    row.phase === "pending"
      ? ("saving_history" as const)
      : row.phase === "retaining"
        ? ("retaining_source" as const)
        : row.phase === "retained"
          ? ("stopping_source" as const)
          : ("restoring_workspace" as const),
  errorCode: row.errorCode,
});
