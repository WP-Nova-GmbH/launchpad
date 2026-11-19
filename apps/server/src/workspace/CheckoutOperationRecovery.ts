import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type BootEvidence,
  decodeBootEvidence,
  encodeBootEvidence,
} from "../terminal/SetupProcessAdapter.ts";

export const encodeCheckoutOperationBoot = encodeBootEvidence;

/** An OS reboot ends old writers; restarting the server alone does not. */
export const recoverCheckoutOperations = Effect.fn("CheckoutOperationRecovery.recover")(function* (
  sql: SqlClient.SqlClient,
  currentBoot: typeof BootEvidence.Type | null,
) {
  if (!currentBoot) return;
  const encoded = encodeCheckoutOperationBoot(currentBoot);
  const rows = yield* sql<{
    operationId: string;
    bootJson: string | null;
  }>`SELECT operation_id AS "operationId",boot_json AS "bootJson" FROM checkout_operations`;
  for (const row of rows) {
    if (row.bootJson === null) {
      // Legacy rows need a baseline before a later boot can establish stop evidence.
      yield* sql`UPDATE checkout_operations SET boot_json=${encoded}
          WHERE operation_id=${row.operationId} AND boot_json IS NULL`;
      continue;
    }
    const prior = decodeBootEvidence(row.bootJson);
    if (
      Option.isSome(prior) &&
      prior.value.host === currentBoot.host &&
      prior.value.session !== currentBoot.session
    )
      yield* sql`DELETE FROM checkout_operations
          WHERE operation_id=${row.operationId} AND boot_json=${row.bootJson}`;
  }
});
