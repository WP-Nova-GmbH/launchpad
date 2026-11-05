import { ProviderDriverKind, defaultInstanceIdForDriver } from "@t3tools/contracts";
import {
  WorkflowInvalidError,
  type WorkflowDefinition,
  type WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { and, eq, isNull } from "drizzle-orm";
import { RelayDb } from "../db.ts";
import {
  relayMachines,
  relayRepositories,
  relayRepositoryAliases,
  relayOrganizationProjectCatalogs,
  relayOrganizationProjects,
} from "../persistence/schema.ts";
import { Machines } from "../machines/Machines.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";

export const vmWorkflowExecutionUnavailable = () =>
  new WorkflowInvalidError({ message: "Running VM workflows is not available yet." });

export const workflowRunTargetChanged = () =>
  new WorkflowInvalidError({
    message: "The workflow execution target changed. Review the saved target and try again.",
  });

export const vmWorkflowAutomationUnavailable = () =>
  new WorkflowInvalidError({
    message: "Turn off automatic triggering to save this workflow with a VM target.",
  });

const codexInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));

/** Git short branch names without ref expressions or checkout history expansion. */
function validBranchName(branch: string) {
  return (
    branch !== "HEAD" &&
    !branch.startsWith("-") &&
    !branch.endsWith(".") &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !Array.from(branch).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char),
    ) &&
    branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

export function vmWorkflowDefinitionIssue(
  baseBranch: string | null,
  steps: WorkflowDefinition["steps"],
  catalog: WorkflowVmModelCatalog | null,
): string | null {
  if (baseBranch !== null && !validBranchName(baseBranch)) return "Enter a valid Git branch name.";
  for (const step of steps) {
    if (step.kind !== "agent" || !step.modelSelection) continue;
    const { instanceId, model, options } = step.modelSelection;
    if (instanceId !== codexInstanceId) return "Choose a managed Codex model for this VM workflow.";
    if (!catalog)
      return "This VM build has no verified model catalog. Verify its models or choose the managed default before saving.";
    const selected = catalog.models.find((entry) => entry.slug === model);
    if (!selected) return "Choose a model supported by this VM build.";
    const seen = new Set<string>();
    for (const option of options ?? []) {
      const descriptor = selected.capabilities?.optionDescriptors?.find(
        ({ id }) => id === option.id,
      );
      if (
        seen.has(option.id) ||
        !descriptor ||
        (descriptor.type === "boolean"
          ? typeof option.value !== "boolean"
          : !descriptor.options.some(({ id }) => id === option.value))
      ) {
        return "Choose model options supported by this VM build.";
      }
      seen.add(option.id);
    }
  }
  return null;
}

const invalidTarget = () =>
  new WorkflowInvalidError({
    message: "Choose an enrolled organization environment and a checkout of this repository.",
  });
const requireBinding = Effect.fnUntraced(function* (
  organizationId: string,
  machine:
    | { readonly organizationId: string; readonly enrolledAt: string | null }
    | null
    | undefined,
  repository:
    | { readonly organizationId: string; readonly canonicalKeys: ReadonlyArray<string> }
    | null
    | undefined,
  canonicalKey: string | null | undefined,
) {
  if (
    !machine ||
    machine.organizationId !== organizationId ||
    machine.enrolledAt === null ||
    !repository ||
    repository.organizationId !== organizationId ||
    !canonicalKey ||
    !repository.canonicalKeys.includes(canonicalKey)
  )
    return yield* invalidTarget();
  return canonicalKey;
});

export const validateWorkflowTarget = Effect.fn("WorkflowDispatcher.validateTarget")(function* (
  organizationId: string,
  repositoryId: string,
  definition: WorkflowDefinition,
) {
  if (definition.target.kind !== "machine") return yield* vmWorkflowExecutionUnavailable();
  const target = definition.target;
  const machine = yield* (yield* Machines).getActiveByEnvironmentId({
    environmentId: target.environmentId,
  });
  const repository = yield* (yield* Repositories).getById({ repositoryId });
  const catalog = yield* (yield* OrganizationProjectCatalog).listForOrganization({
    organizationId,
  });
  const project = catalog.find(
    (entry) => entry.environmentId === target.environmentId && entry.projectId === target.projectId,
  );
  return yield* requireBinding(
    organizationId,
    machine,
    repository,
    project?.repositoryCanonicalKey,
  );
});

/** Caller holds repository authority; retain these database fences through the enabled Save. */
export const lockWorkflowTarget = Effect.fn("WorkflowTarget.lock")(function* (
  organizationId: string,
  repositoryId: string,
  definition: WorkflowDefinition,
) {
  if (definition.target.kind !== "machine") return yield* vmWorkflowExecutionUnavailable();
  const target = definition.target;
  const db = yield* RelayDb;
  const [repository] = yield* db
    .select()
    .from(relayRepositories)
    .where(eq(relayRepositories.repositoryId, repositoryId))
    .for("share");
  const [machine] = yield* db
    .select()
    .from(relayMachines)
    .where(
      and(
        eq(relayMachines.environmentId, target.environmentId),
        isNull(relayMachines.deprovisionedAt),
      ),
    )
    .orderBy(relayMachines.machineId)
    .limit(1)
    .for("share");
  const [catalog] = yield* db
    .select()
    .from(relayOrganizationProjectCatalogs)
    .where(eq(relayOrganizationProjectCatalogs.environmentId, target.environmentId))
    .for("share");
  if (
    !machine ||
    !catalog ||
    catalog.machineId !== machine.machineId ||
    catalog.organizationId !== organizationId
  )
    return yield* invalidTarget();
  // replace() locks the catalog cursor before replacing even an empty project set.
  const [project] = yield* db
    .select()
    .from(relayOrganizationProjects)
    .where(
      and(
        eq(relayOrganizationProjects.environmentId, target.environmentId),
        eq(relayOrganizationProjects.projectId, target.projectId),
      ),
    )
    .for("share");
  if (
    !project?.repositoryCanonicalKey ||
    project.machineId !== machine.machineId ||
    project.organizationId !== organizationId
  )
    return yield* invalidTarget();
  const aliases = yield* db
    .select()
    .from(relayRepositoryAliases)
    .where(
      and(
        eq(relayRepositoryAliases.canonicalKey, project.repositoryCanonicalKey),
        eq(relayRepositoryAliases.repositoryId, repositoryId),
        eq(relayRepositoryAliases.organizationId, organizationId),
      ),
    )
    .for("share");
  return yield* requireBinding(
    organizationId,
    machine,
    repository
      ? { ...repository, canonicalKeys: aliases.map((alias) => alias.canonicalKey) }
      : null,
    project.repositoryCanonicalKey,
  );
});
