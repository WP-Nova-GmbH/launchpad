import { WorkflowInvalidError, type WorkflowDefinition } from "@t3tools/contracts/workflows";
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
  const machine = yield* (yield* Machines).getActiveByEnvironmentId({
    environmentId: definition.environmentId,
  });
  const repository = yield* (yield* Repositories).getById({ repositoryId });
  const catalog = yield* (yield* OrganizationProjectCatalog).listForOrganization({
    organizationId,
  });
  const project = catalog.find(
    (entry) =>
      entry.environmentId === definition.environmentId && entry.projectId === definition.projectId,
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
        eq(relayMachines.environmentId, definition.environmentId),
        isNull(relayMachines.deprovisionedAt),
      ),
    )
    .orderBy(relayMachines.machineId)
    .limit(1)
    .for("share");
  const [catalog] = yield* db
    .select()
    .from(relayOrganizationProjectCatalogs)
    .where(eq(relayOrganizationProjectCatalogs.environmentId, definition.environmentId))
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
        eq(relayOrganizationProjects.environmentId, definition.environmentId),
        eq(relayOrganizationProjects.projectId, definition.projectId),
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
