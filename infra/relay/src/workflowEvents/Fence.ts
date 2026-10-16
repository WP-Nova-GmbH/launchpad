import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import type { Connection } from "../workflowSources/Store.ts";

// Webhook intake is optional; absence leaves existing source management usable.
export const configuration = Effect.serviceOption(RelayConfiguration).pipe(
  Effect.map((service) => {
    const config = Option.getOrUndefined(service)?.linearWorkflowWebhook;
    return config?.applicationId.trim() && config.generation.trim() ? config : undefined;
  }),
);
export const lock = Effect.fn("workflowEvents.sourceFence")(function* (
  applicationId: string,
  workspaceId: string,
) {
  const sql = (yield* RelayDb).$client;
  yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${stableStringify(["workflow-events", applicationId, workspaceId])},0))`;
});
export const timestamp = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  const [r] = yield* sql<{
    stamp: string;
  }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp`;
  return r!.stamp;
});
export const revocationCutoff = Effect.fn("workflowEvents.revocationCutoff")(function* (
  app: string,
  workspace: string,
) {
  const sql = (yield* RelayDb).$client;
  const [row] = yield* sql<{
    cutoff: string | null;
  }>`SELECT max(occurred_at) AS cutoff FROM relay_workflow_occurrences WHERE application_id=${app} AND workspace_id=${workspace} AND event_type='revocation'`;
  return row?.cutoff ?? null;
});
export const DeliveryEvidence = Schema.Struct({
  generation: Schema.String,
  epoch: Schema.Int,
  teams: Schema.Record(
    Schema.String,
    Schema.Struct({ created: Schema.Boolean, entered: Schema.Boolean }),
  ),
});
export type DeliveryEvidence = typeof DeliveryEvidence.Type;
const decode = Schema.decodeUnknownOption(DeliveryEvidence);
export function evidence(
  connection: Pick<Connection, "delivery_evidence" | "authorization_epoch">,
  generation: string,
) {
  const parsed = decode(connection.delivery_evidence);
  return parsed._tag === "Some" &&
    parsed.value.generation === generation &&
    parsed.value.epoch === connection.authorization_epoch
    ? parsed.value
    : null;
}
export const covers = (
  connection: Pick<Connection, "delivery_evidence" | "authorization_epoch">,
  generation: string,
  teamId: string,
) => {
  const team = evidence(connection, generation)?.teams[teamId];
  return Boolean(team?.created && team.entered);
};
