import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  WorkflowInvalidError,
  type WorkflowDefinition,
  type WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vmWorkflowDefinitionIssue } from "../jobs/WorkflowTarget.ts";
import { selectWorkflowVmGitHubBinding } from "../jobs/WorkflowVmGithub.ts";
import { CODEX_VM_REFRESH_CLAIM_TIMEOUT_SECONDS } from "../tenancy/CodexVmConnections.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntimeConfiguration.ts";
import * as Fence from "./Fence.ts";

export const vmAutomationAvailable = Effect.fnUntraced(function* (organizationId: string) {
  const linear = yield* Fence.configuration;
  if (!linear?.admissionEnabled || linear.organizationId !== organizationId) return false;
  const vm = Option.getOrUndefined(yield* Effect.serviceOption(ThreadVmRuntimeConfiguration));
  return vm?.settings?.workflowExecutionEnabled === true;
});

export const establishedWorkflowVmCodex = Effect.fnUntraced(function* (
  sql: PgClient,
  organizationId: string,
  lock = false,
) {
  const [connection] = yield* sql<{
    connectionId: string;
    status: "connected" | "disconnected" | "reconnect_required";
  }>`SELECT connection_id AS "connectionId",
    CASE WHEN status='connected' AND refresh_started_at::timestamptz <=
      clock_timestamp() - (${CODEX_VM_REFRESH_CLAIM_TIMEOUT_SECONDS}::int * interval '1 second') THEN 'reconnect_required'
    ELSE status END AS status
    FROM relay_codex_vm_connections
    WHERE organization_id=${organizationId} AND issuer IS NOT NULL AND subject IS NOT NULL AND client_id IS NOT NULL
    ${lock ? sql`FOR SHARE` : sql``}`;
  return connection ?? null;
});

export function vmAutomationDefinitionIssue(
  target: Extract<WorkflowDefinition["target"], { kind: "vm" }>,
  steps: WorkflowDefinition["steps"],
  catalog: WorkflowVmModelCatalog | null,
) {
  if (!catalog)
    return "Verify the workflow VM build and its Codex models before enabling automation.";
  if (steps.some((step) => step.kind === "action"))
    return "Remove Push and Open PR before enabling automatic runs on this VM workflow.";
  return vmWorkflowDefinitionIssue(target.baseBranch, steps, catalog);
}

export const checkVmAutomationTarget = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { organizationId: string; repositoryId: string },
  target: Extract<WorkflowDefinition["target"], { kind: "vm" }>,
  steps: WorkflowDefinition["steps"],
  lock = false,
) {
  const vm = Option.getOrUndefined(yield* Effect.serviceOption(ThreadVmRuntimeConfiguration));
  const issue = vmAutomationDefinitionIssue(
    target,
    steps,
    vm?.settings?.workflowModelCatalog ?? null,
  );
  if (issue) return yield* new WorkflowInvalidError({ message: issue });
  const binding = yield* selectWorkflowVmGitHubBinding(sql, scope, lock);
  if (!(yield* establishedWorkflowVmCodex(sql, scope.organizationId, lock)))
    return yield* new WorkflowInvalidError({
      message: "Connect Codex for this organization before enabling automatic VM runs.",
    });
  return binding.canonicalKey;
});
