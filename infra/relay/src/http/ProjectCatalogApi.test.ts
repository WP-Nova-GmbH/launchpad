import { describe, expect, it } from "vite-plus/test";

import type * as OrganizationProjectCatalog from "../projects/OrganizationProjectCatalog.ts";
import type * as Repositories from "../tenancy/Repositories.ts";
import { visibleOrganizationProjectRecords } from "./ProjectCatalogApi.ts";

const timestamp = "2026-08-24T12:00:00.000Z";

const repositories: ReadonlyArray<Repositories.RepositoryRecord> = [
  {
    repositoryId: "repository-visible",
    organizationId: "organization-1",
    name: "Visible repository",
    canonicalKeys: ["github.com/acme/visible", "gitlab.com/acme/visible"],
    createdAt: timestamp,
  },
  {
    repositoryId: "repository-private",
    organizationId: "organization-1",
    name: "Private repository",
    canonicalKeys: ["github.com/acme/private"],
    createdAt: timestamp,
  },
];

function project(
  projectId: string,
  repositoryCanonicalKey: string | null,
): OrganizationProjectCatalog.OrganizationProjectRecord {
  return {
    environmentId: "environment-1",
    machineId: "machine-1",
    machineLabel: "Primary executor",
    projectId,
    title: projectId,
    repositoryCanonicalKey,
    createdAt: timestamp,
    updatedAt: timestamp,
    catalogUpdatedAt: timestamp,
  };
}

const projects = [
  project("visible-primary", "github.com/acme/visible"),
  project("visible-alias", "gitlab.com/acme/visible"),
  project("private", "github.com/acme/private"),
  project("local", null),
  project("unregistered", "github.com/acme/unregistered"),
];

describe("visibleOrganizationProjectRecords", () => {
  it("shows an organization admin every project without requiring repository grants", () => {
    expect(
      visibleOrganizationProjectRecords({
        isAdmin: true,
        projects,
        repositories,
        repositoryAccess: new Map(),
      }),
    ).toEqual(projects);
  });

  it("limits members to projects whose repository or alias they can access", () => {
    expect(
      visibleOrganizationProjectRecords({
        isAdmin: false,
        projects,
        repositories,
        repositoryAccess: new Map([["repository-visible", "developer"]]),
      }),
    ).toEqual([projects[0], projects[1]]);
  });
});
