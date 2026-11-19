import type { RepositoryWorkflow, WorkflowAutomationSummary } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { selectWorkflowVmGitHubBinding } from "../jobs/WorkflowVmGithub.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntimeConfiguration.ts";
import type { Connection, Grant } from "../workflowSources/Store.ts";
import * as Fence from "./Fence.ts";
import { EnableProof, targetKey, triggerKey, automation } from "./Routing.ts";
import {
  establishedWorkflowVmCodex,
  vmAutomationAvailable,
  vmAutomationDefinitionIssue,
} from "./VmAutomation.ts";

const decodeProof = Schema.decodeUnknownOption(EnableProof);
/** Readiness only uses local state. */
export const summaries = Effect.fn("workflowEvents.summaries")(function* (repo: string) {
  const sql = (yield* RelayDb).$client;
  const config = yield* Fence.configuration;
  const rows = yield* sql<{
    record: RepositoryWorkflow;
    target_capability: unknown;
    connection: Connection | null;
    grant: Grant | null;
    reconnecting: boolean;
    target_bound: boolean;
  }>`SELECT w.record,w.target_capability,
    to_jsonb(c) AS connection,to_jsonb(g) AS grant,
    a.exchange_lease_until IS NOT NULL AS reconnecting,
    EXISTS(SELECT 1 FROM relay_machines m
      JOIN relay_organization_project_catalogs pc ON pc.machine_id=m.machine_id AND pc.environment_id=m.environment_id AND pc.organization_id=r.organization_id
      JOIN relay_organization_projects p ON p.machine_id=m.machine_id AND p.environment_id=pc.environment_id AND p.organization_id=r.organization_id
      JOIN relay_repository_aliases a ON a.canonical_key=p.repository_canonical_key AND a.repository_id=w.repository_id AND a.organization_id=r.organization_id
      WHERE m.organization_id=r.organization_id AND m.enrolled_at IS NOT NULL AND m.deprovisioned_at IS NULL
        AND m.environment_id=w.record#>>'{definition,target,environmentId}' AND p.project_id=w.record#>>'{definition,target,projectId}'
        AND p.repository_canonical_key=w.target_capability->>'canonicalKey') AS target_bound
    FROM relay_repository_workflows w
    JOIN relay_repositories r ON r.repository_id=w.repository_id
    LEFT JOIN relay_workflow_repository_grants g ON g.grant_id=w.record->'automation'->'trigger'->>'grantId' AND g.repository_id=w.repository_id AND g.organization_id=r.organization_id
    LEFT JOIN relay_workflow_connections c ON c.connection_id=g.connection_id AND c.organization_id=g.organization_id
    LEFT JOIN relay_workflow_authorizations a ON a.organization_id=c.organization_id AND a.application_id=c.application_id
    WHERE w.repository_id=${repo}`;
  const vmOrganization = rows.find(
    ({ record }) => record.automation?.enabled && record.definition.target.kind === "vm",
  )?.record.organizationId;
  const vm = Option.getOrUndefined(yield* Effect.serviceOption(ThreadVmRuntimeConfiguration));
  const vmEnabled = vmOrganization !== undefined && (yield* vmAutomationAvailable(vmOrganization));
  const vmGithub =
    vmOrganization !== undefined && vmEnabled
      ? yield* selectWorkflowVmGitHubBinding(
          sql,
          { organizationId: vmOrganization, repositoryId: repo },
          false,
        ).pipe(Effect.catchTag("WorkflowInvalidError", () => Effect.succeed(null)))
      : null;
  const vmCodex =
    vmOrganization !== undefined && vmEnabled
      ? yield* establishedWorkflowVmCodex(sql, vmOrganization)
      : null;
  return rows.map((row): WorkflowAutomationSummary => {
    const saved = automation(row.record.automation);
    const trigger = saved.trigger;
    const c = row.connection,
      g = row.grant;
    const proof = decodeProof(row.target_capability);
    const { target, steps } = row.record.definition;
    const vmIssue =
      target.kind === "vm"
        ? vmAutomationDefinitionIssue(target, steps, vm?.settings?.workflowModelCatalog ?? null)
        : null;
    const targetBound =
      target.kind === "vm"
        ? vmGithub !== null &&
          proof._tag === "Some" &&
          vmGithub.canonicalKey === proof.value.canonicalKey
        : row.target_bound;
    let reason: string | null = null;
    if (saved.enabled) {
      if (!config?.admissionEnabled)
        reason = "Automatic event admission is unavailable on this relay.";
      else if (target.kind === "vm" && !vmEnabled)
        reason = "Automatic VM runs are unavailable for this repository.";
      else if (!trigger || !g || g.revoked || !c || c.connection_id !== trigger.connectionId)
        reason = "Repository source permission needs attention.";
      else if (
        c.organization_id !== config.organizationId ||
        c.application_id !== config.applicationId ||
        c.health.code === "service_configuration"
      )
        reason = "Linear service configuration needs attention.";
      else if (row.reconnecting) reason = "Linear reconnection has not finished.";
      else if (c.status !== "connected" || !c.payload_sealed)
        reason = "An organization admin must reconnect Linear.";
      else if (c.health.code !== "healthy")
        reason =
          c.health.code === "rate_limited"
            ? "Linear is rate limited. Retry later."
            : "Linear is currently unavailable.";
      else if (!Fence.covers(c, config.generation, trigger.teamId))
        reason = "Event delivery is not verified for the selected team.";
      else if (vmIssue) reason = vmIssue;
      else if (target.kind === "vm" && !vmCodex)
        reason = "Connect Codex for this organization before running this workflow.";
      else if (target.kind === "vm" && vmCodex?.status !== "connected")
        reason = "An organization admin must reconnect Codex.";
      else if (
        !targetBound ||
        proof._tag !== "Some" ||
        proof.value.targetKey !== targetKey(row.record.definition) ||
        proof.value.triggerKey !== triggerKey(trigger) ||
        // Reconnect/configuration recovery is proven by current team delivery above.
        proof.value.connectionId !== c.connection_id
      )
        reason = "Save the trigger settings to validate source and execution target.";
    }
    return {
      workflowId: row.record.workflowId,
      revision: row.record.revision,
      state: !saved.enabled ? "off" : reason ? "needs_attention" : "on",
      reason,
    };
  });
});
