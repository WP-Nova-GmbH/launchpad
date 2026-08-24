import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayClientPrincipal,
  RelayEnvironmentPrincipal,
  RelayInternalError,
  RelayMachineId,
  RelayProjectCatalogPublishProofExpiredError,
  RelayProjectCatalogPublishProofInvalidError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentProjectCatalogSignatures from "../environments/EnvironmentProjectCatalogSignatures.ts";
import * as Machines from "../machines/Machines.ts";
import * as OrganizationProjectCatalog from "../projects/OrganizationProjectCatalog.ts";
import * as Repositories from "../tenancy/Repositories.ts";
import { mapErrorTags, mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
import { resolveMembership } from "./TenancyApi.ts";

export function visibleOrganizationProjectRecords(input: {
  readonly isAdmin: boolean;
  readonly projects: ReadonlyArray<OrganizationProjectCatalog.OrganizationProjectRecord>;
  readonly repositories: ReadonlyArray<Repositories.RepositoryRecord>;
  readonly repositoryAccess: ReadonlyMap<string, unknown>;
}) {
  if (input.isAdmin) {
    return input.projects;
  }
  const visibleCanonicalKeys = new Set(
    input.repositories
      .filter((repository) => input.repositoryAccess.has(repository.repositoryId))
      .flatMap((repository) => repository.canonicalKeys),
  );
  return input.projects.filter(
    (project) =>
      project.repositoryCanonicalKey !== null &&
      visibleCanonicalKeys.has(project.repositoryCanonicalKey),
  );
}

export const organizationProjectsApi = HttpApiBuilder.group(
  RelayApi,
  "organizationProjects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* OrganizationProjectCatalog.OrganizationProjectCatalog;
    const repositories = yield* Repositories.Repositories;

    return handlers.handle(
      "listOrganizationProjects",
      Effect.fn("relay.api.organization_projects.list")(
        function* () {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* resolveMembership({ userId });
          const organizationId = membership.organization.organizationId;
          const [catalog, ownedRepositories, repositoryAccess] = yield* Effect.all(
            [
              projects.listForOrganization({ organizationId }),
              repositories.listForOrganization({ organizationId }),
              repositories.listAccessForUser({ organizationId, userId }),
            ],
            { concurrency: "unbounded" },
          );
          const visible = visibleOrganizationProjectRecords({
            isAdmin: membership.role === "admin",
            projects: catalog,
            repositories: ownedRepositories,
            repositoryAccess,
          });
          return {
            projects: visible.map((project) => ({
              environmentId: EnvironmentId.make(project.environmentId),
              machineId: RelayMachineId.make(project.machineId),
              machineLabel: project.machineLabel,
              projectId: ProjectId.make(project.projectId),
              title: project.title,
              repositoryCanonicalKey: project.repositoryCanonicalKey,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              catalogUpdatedAt: project.catalogUpdatedAt,
            })),
          };
        },
        Effect.catchTag("OrganizationProjectCatalogPersistenceError", () =>
          relayInternalErrorResponse("persistence_failed"),
        ),
        mapRelayCommonApiErrors("invalid_bearer"),
      ),
    );
  }),
);

export const projectCatalogServerApi = HttpApiBuilder.group(
  RelayApi,
  "projectCatalogServer",
  Effect.fnUntraced(function* (handlers) {
    const signatures =
      yield* EnvironmentProjectCatalogSignatures.EnvironmentProjectCatalogSignatures;
    const machines = yield* Machines.Machines;
    const catalog = yield* OrganizationProjectCatalog.OrganizationProjectCatalog;

    return handlers.handle(
      "publishProjectCatalog",
      Effect.fn("relay.api.project_catalog.publish")(
        function* (args) {
          const { params, payload } = args;
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new HttpApiError.Unauthorized({});
          }
          yield* signatures.verify({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            request: payload,
          });
          const machine = yield* machines.getActiveByEnvironmentId({
            environmentId: params.environmentId,
          });
          if (
            machine === null ||
            machine.role !== "agent_executor" ||
            machine.environmentPublicKey !== principal.environmentPublicKey
          ) {
            return yield* new HttpApiError.Unauthorized({});
          }
          const acceptedRevision = yield* catalog.replace({
            organizationId: machine.organizationId,
            machineId: machine.machineId,
            environmentId: params.environmentId,
            revision: payload.revision,
            projects: payload.projects,
          });
          return { ok: true, acceptedRevision };
        },
        mapErrorTags({
          ProjectCatalogPublishSignatureExpired: (_error, traceId) =>
            new RelayProjectCatalogPublishProofExpiredError({
              code: "project_catalog_publish_proof_expired",
              traceId,
            }),
          ProjectCatalogPublishSignatureInvalid: (error, traceId) =>
            new RelayProjectCatalogPublishProofInvalidError({
              code: "project_catalog_publish_proof_invalid",
              reason: error.reason,
              traceId,
            }),
          DpopProofReplayPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
          OrganizationProjectCatalogPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    );
  }),
);
