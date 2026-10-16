import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { and, eq } from "drizzle-orm";
import {
  WorkflowConflictError,
  WorkflowInvalidError,
  type RepositoryWorkflow,
  type SaveRepositoryWorkflow,
  type WorkflowTrigger,
} from "@t3tools/contracts/workflows";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { RelayDb } from "../db.ts";
import { relayRepositoryWorkflows } from "../persistence/schema.ts";
import * as Sources from "../workflowSources/Store.ts";
import * as Fence from "./Fence.ts";
import { lockWorkflowTarget } from "../jobs/WorkflowTarget.ts";

export const automation = (value: RepositoryWorkflow["automation"] | null | undefined) => ({
  enabled: value?.enabled ?? false,
  trigger: value?.trigger
    ? { ...value.trigger, labelIds: [...new Set(value.trigger.labelIds)].sort() }
    : null,
});
export const triggerKey = (trigger: WorkflowTrigger | null) => stableStringify(trigger);
export const targetKey = (definition: RepositoryWorkflow["definition"]) =>
  stableStringify({
    environmentId: definition.environmentId,
    projectId: definition.projectId,
    actions: [
      ...new Set(definition.steps.filter((s) => s.kind === "action").map((s) => s.action)),
    ].sort(),
  });
export const EnableProof = Schema.Struct({
  epoch: Schema.Int,
  connectionId: Schema.String,
  generation: Schema.String,
  triggerKey: Schema.String,
  targetKey: Schema.String,
  canonicalKey: Schema.String,
});
export type EnableProof = typeof EnableProof.Type;
export interface SaveContext {
  readonly userId: string;
  readonly proof?: EnableProof;
}
export interface RoutingRow {
  workflow_id: string;
  revision: number;
  source_application_id: string | null;
  source_workspace_id: string | null;
  routing_generation: number;
  effective_after: string | null;
  target_capability: unknown;
  record: RepositoryWorkflow;
}
export const read = Effect.fn("workflowEvents.readRouting")(function* (id: string) {
  const sql = (yield* RelayDb).$client;
  return (
    (yield* sql<RoutingRow>`SELECT * FROM relay_repository_workflows WHERE workflow_id=${id}`)[0] ??
    null
  );
});
const invalid = (message: string) => new WorkflowInvalidError({ message });
const conflict = () =>
  new WorkflowConflictError({
    message: "This workflow changed. Reload before saving; your draft has been retained.",
  });
export const save = Effect.fn("workflowEvents.saveRouting")(function* (
  record: RepositoryWorkflow,
  input: typeof SaveRepositoryWorkflow.Type,
  previous: RepositoryWorkflow | null,
  context: SaveContext | undefined,
) {
  if (!context) return yield* invalid("An authenticated repository maintainer is required.");
  const config = yield* Fence.configuration;
  const next = automation(record.automation);
  if (record.archived) next.enabled = false;
  if (next.enabled && (!next.trigger || !config?.admissionEnabled))
    return yield* invalid("Automatic event admission is not enabled on this relay.");
  const db = yield* RelayDb;
  const sql = db.$client;
  const hint = yield* read(record.workflowId);
  const grantHint = next.trigger
    ? (yield* sql<Sources.Grant>`SELECT * FROM relay_workflow_repository_grants WHERE grant_id=${next.trigger.grantId}`)[0]
    : null;
  const connectionHint = grantHint ? yield* Sources.connection(grantHint.connection_id) : null;
  const keys = [
    ...(hint?.source_application_id && hint.source_workspace_id
      ? [[hint.source_application_id, hint.source_workspace_id] as const]
      : []),
    ...(connectionHint
      ? [[connectionHint.application_id, connectionHint.workspace_id] as const]
      : []),
  ];
  const unique = [...new Map(keys.map((k) => [stableStringify(k), k])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v);
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        for (const [app, workspace] of unique) yield* Fence.lock(app, workspace);
        let bound: Effect.Success<ReturnType<typeof Sources.authority>> | null = null;
        if (next.enabled && next.trigger)
          bound = yield* Sources.authority(
            record.repositoryId,
            next.trigger.grantId,
            context.userId,
          );
        else yield* Sources.repositoryAuthority(record.repositoryId, context.userId, null, true);
        const current =
          (yield* sql<RoutingRow>`SELECT * FROM relay_repository_workflows WHERE workflow_id=${record.workflowId} FOR UPDATE`)[0] ??
          null;
        if (
          (current?.revision ?? 0) !== input.expectedRevision ||
          (current?.record.repositoryId && current.record.repositoryId !== record.repositoryId) ||
          (hint?.source_application_id ?? null) !== (current?.source_application_id ?? null) ||
          (hint?.source_workspace_id ?? null) !== (current?.source_workspace_id ?? null)
        )
          return yield* conflict();
        if (
          next.trigger &&
          (!grantHint ||
            grantHint.repository_id !== record.repositoryId ||
            grantHint.connection_id !== next.trigger.connectionId) &&
          triggerKey(next.trigger) !== triggerKey(previous?.automation?.trigger ?? null)
        )
          return yield* invalid("The source grant does not belong to this repository.");
        const proof = context.proof;
        if (
          next.enabled &&
          bound &&
          (!config ||
            !proof ||
            bound.connection.application_id !== config.applicationId ||
            bound.connection.connection_id !== next.trigger!.connectionId ||
            proof.epoch !== bound.connection.authorization_epoch ||
            proof.connectionId !== bound.connection.connection_id ||
            proof.generation !== config.generation ||
            proof.triggerKey !== triggerKey(next.trigger) ||
            proof.targetKey !== targetKey(record.definition) ||
            !Fence.covers(bound.connection, config.generation, next.trigger!.teamId))
        )
          return yield* invalid(
            "Source authority, delivery coverage or target validation changed. Refresh before enabling.",
          );
        if (next.enabled) {
          const canonicalKey = yield* lockWorkflowTarget(
            record.organizationId,
            record.repositoryId,
            record.definition,
          );
          if (canonicalKey !== proof?.canonicalKey)
            return yield* invalid(
              "The target repository binding changed. Refresh before enabling.",
            );
        }
        const old = automation(current?.record.automation);
        const changed =
          next.enabled && (!old.enabled || triggerKey(old.trigger) !== triggerKey(next.trigger));
        const stamp = yield* Fence.timestamp;
        const saved = { ...record, automation: next, updatedAt: stamp };
        const projection = {
          revision: saved.revision,
          record: saved,
          automationEnabled: next.enabled,
          sourceApplicationId:
            connectionHint?.application_id ??
            (next.trigger ? current?.source_application_id : null) ??
            null,
          sourceWorkspaceId:
            connectionHint?.workspace_id ??
            (next.trigger ? current?.source_workspace_id : null) ??
            null,
          triggerTeamId: next.trigger?.teamId ?? null,
          triggerEvent: next.trigger?.event ?? null,
          triggerGrantId: next.trigger?.grantId ?? null,
          routingGeneration: (current?.routing_generation ?? 0) + (changed ? 1 : 0),
          effectiveAfter: changed ? stamp : (current?.effective_after ?? null),
          targetCapability: next.enabled ? (proof ?? null) : (current?.target_capability ?? null),
        };
        const rows = current
          ? yield* db
              .update(relayRepositoryWorkflows)
              .set(projection)
              .where(
                and(
                  eq(relayRepositoryWorkflows.workflowId, saved.workflowId),
                  eq(relayRepositoryWorkflows.revision, input.expectedRevision),
                ),
              )
              .returning({ id: relayRepositoryWorkflows.workflowId })
          : yield* db
              .insert(relayRepositoryWorkflows)
              .values({
                workflowId: saved.workflowId,
                repositoryId: saved.repositoryId,
                ...projection,
              })
              .onConflictDoNothing()
              .returning({ id: relayRepositoryWorkflows.workflowId });
        if (!rows.length) return yield* conflict();
        return saved;
      }),
    )
    .pipe(Effect.catchTag("WorkflowSourceError", (e) => invalid(e.message)));
});
