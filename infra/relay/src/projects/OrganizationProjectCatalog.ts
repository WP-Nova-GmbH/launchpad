import type { RelayProjectCatalogEntry } from "@t3tools/contracts/relay";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayMachines,
  relayOrganizationProjectCatalogs,
  relayOrganizationProjects,
} from "../persistence/schema.ts";

export interface OrganizationProjectRecord {
  readonly environmentId: string;
  readonly machineId: string;
  readonly machineLabel: string;
  readonly projectId: string;
  readonly title: string;
  readonly repositoryCanonicalKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly catalogUpdatedAt: string;
}

export class OrganizationProjectCatalogPersistenceError extends Schema.TaggedErrorClass<OrganizationProjectCatalogPersistenceError>()(
  "OrganizationProjectCatalogPersistenceError",
  {
    operation: Schema.Literals(["replace-catalog", "list-projects", "read-revision"]),
    environmentId: Schema.optionalKey(Schema.String),
    organizationId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Organization project catalog '${this.operation}' failed`;
  }
}

export class OrganizationProjectCatalog extends Context.Service<
  OrganizationProjectCatalog,
  {
    readonly replace: (input: {
      readonly organizationId: string;
      readonly machineId: string;
      readonly environmentId: string;
      readonly revision: number;
      readonly projects: ReadonlyArray<RelayProjectCatalogEntry>;
    }) => Effect.Effect<number, OrganizationProjectCatalogPersistenceError>;
    readonly listForOrganization: (input: {
      readonly organizationId: string;
    }) => Effect.Effect<
      ReadonlyArray<OrganizationProjectRecord>,
      OrganizationProjectCatalogPersistenceError
    >;
  }
>()("t3code-relay/projects/OrganizationProjectCatalog") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;

  const readRevision = Effect.fn("relay.organization_project_catalog.read_revision")(function* (
    environmentId: string,
  ) {
    const rows = yield* db
      .select({ revision: relayOrganizationProjectCatalogs.revision })
      .from(relayOrganizationProjectCatalogs)
      .where(eq(relayOrganizationProjectCatalogs.environmentId, environmentId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrganizationProjectCatalogPersistenceError({
              operation: "read-revision",
              environmentId,
              cause,
            }),
        ),
      );
    return rows[0]?.revision ?? 0;
  });

  return OrganizationProjectCatalog.of({
    replace: Effect.fn("relay.organization_project_catalog.replace")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.organization_id": input.organizationId,
        "relay.environment_id": input.environmentId,
        "relay.machine_id": input.machineId,
        "relay.project_catalog.revision": input.revision,
        "relay.project_catalog.project_count": input.projects.length,
      });

      const now = DateTime.formatIso(yield* DateTime.now);
      const accepted = yield* transactions
        .withTransaction(
          Effect.gen(function* () {
            const claimed = yield* db
              .insert(relayOrganizationProjectCatalogs)
              .values({
                environmentId: input.environmentId,
                organizationId: input.organizationId,
                machineId: input.machineId,
                revision: input.revision,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: relayOrganizationProjectCatalogs.environmentId,
                set: {
                  organizationId: input.organizationId,
                  machineId: input.machineId,
                  revision: input.revision,
                  updatedAt: now,
                },
                setWhere: lt(relayOrganizationProjectCatalogs.revision, input.revision),
              })
              .returning({ revision: relayOrganizationProjectCatalogs.revision });

            if (claimed.length === 0) {
              return false;
            }

            yield* db
              .delete(relayOrganizationProjects)
              .where(eq(relayOrganizationProjects.environmentId, input.environmentId));

            if (input.projects.length > 0) {
              yield* db.insert(relayOrganizationProjects).values(
                input.projects.map((project) => ({
                  environmentId: input.environmentId,
                  projectId: project.projectId as string,
                  organizationId: input.organizationId,
                  machineId: input.machineId,
                  title: project.title,
                  repositoryCanonicalKey: project.repositoryCanonicalKey,
                  projectCreatedAt: project.createdAt,
                  projectUpdatedAt: project.updatedAt,
                  catalogUpdatedAt: now,
                })),
              );
            }

            return true;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationProjectCatalogPersistenceError({
                operation: "replace-catalog",
                environmentId: input.environmentId,
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );

      return accepted ? input.revision : yield* readRevision(input.environmentId);
    }),

    listForOrganization: Effect.fn("relay.organization_project_catalog.list")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.organization_id": input.organizationId });
      return yield* db
        .select({
          environmentId: relayOrganizationProjects.environmentId,
          machineId: relayOrganizationProjects.machineId,
          machineLabel: relayMachines.label,
          projectId: relayOrganizationProjects.projectId,
          title: relayOrganizationProjects.title,
          repositoryCanonicalKey: relayOrganizationProjects.repositoryCanonicalKey,
          createdAt: relayOrganizationProjects.projectCreatedAt,
          updatedAt: relayOrganizationProjects.projectUpdatedAt,
          catalogUpdatedAt: relayOrganizationProjects.catalogUpdatedAt,
        })
        .from(relayOrganizationProjects)
        .innerJoin(relayMachines, eq(relayMachines.machineId, relayOrganizationProjects.machineId))
        .where(
          and(
            eq(relayOrganizationProjects.organizationId, input.organizationId),
            isNull(relayMachines.deprovisionedAt),
          ),
        )
        .orderBy(desc(relayOrganizationProjects.projectUpdatedAt))
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrganizationProjectCatalogPersistenceError({
                operation: "list-projects",
                organizationId: input.organizationId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(OrganizationProjectCatalog, make);
