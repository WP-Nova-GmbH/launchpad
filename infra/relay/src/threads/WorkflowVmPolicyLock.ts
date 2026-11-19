import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/** Serialize workflow limit edits and admission across hosts without locking personal VM policy. */
export const lockWorkflowVmOrganization = Effect.fnUntraced(function* (
  sql: PgClient,
  organizationId: string,
) {
  yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 721866))`;
});
