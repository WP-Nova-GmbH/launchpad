/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import { CommandId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

import { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
export { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepositoryShape - Service API for command receipts.
 */
export interface OrchestrationCommandReceiptRepositoryShape {
  /**
   * Insert or replace a command receipt row.
   *
   * Upserts by `commandId` for idempotent command-result tracking.
   */
  readonly upsert: (
    receipt: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Read a command receipt by command id.
   */
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()("t3/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}
