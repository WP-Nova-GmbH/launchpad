import { config } from "../workflowSources/test-fixture.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpClient } from "effect/unstable/http";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { automation } from "../workflowEvents/Routing.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { Organizations } from "../tenancy/Organizations.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import { Machines } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { Workflows } from "../jobs/Workflows.ts";
import { saveRepositoryWorkflow } from "./WorkflowsApi.ts";
const definition: RepositoryWorkflow["definition"] = {
  name: "Workflow",
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  steps: [
    { kind: "agent", id: "agent", title: "Agent", instruction: "Implement", modelSelection: null },
  ],
};
const trigger = {
  provider: "linear",
  connectionId: "connection",
  grantId: "grant",
  teamId: "team",
  event: "issue_created",
  labelIds: [],
} as const;
const previous: RepositoryWorkflow = {
  workflowId: "flow",
  repositoryId: "repo",
  organizationId: "org",
  revision: 1,
  definition,
  archived: false,
  automation: { enabled: true, trigger },
  createdAt: "2026",
  updatedAt: "2026",
};
describe("manual target validation with explicit automation Off", () => {
  for (const mode of ["create", "changed target", "restore", "disable", "archive"] as const)
    it.effect(mode, () =>
      Effect.gen(function* () {
        const baseline = mode === "create" ? null : { ...previous, archived: mode === "restore" };
        const input = {
          workflowId: "flow",
          expectedRevision: baseline?.revision ?? 0,
          definition:
            mode === "changed target"
              ? { ...definition, projectId: ProjectId.make("changed") }
              : definition,
          archived: mode === "archive",
          automation: { enabled: false, trigger: mode === "create" ? null : trigger },
        };
        let saves = 0;
        const layer = Layer.mergeAll(
          NodeCrypto.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Off recovery must not call Linear")),
          ),
          Layer.succeed(RelayDb, {} as unknown as RelayDb["Service"]),
          Layer.succeed(RelayConfiguration, config),
          Layer.mock(RelaySecretBox)({}),
          Layer.mock(EnvironmentConnector)({}),
          Layer.mock(Organizations)({
            getMembershipForUser: () =>
              Effect.succeed({
                userId: "maintainer",
                role: "admin",
                organization: { organizationId: "org", name: "Org", createdAt: "2026" },
                joinedAt: "2026",
              }),
          }),
          Layer.mock(Repositories)({
            getById: () =>
              Effect.succeed({
                repositoryId: "repo",
                organizationId: "org",
                name: "Repo",
                canonicalKeys: [],
                createdAt: "2026",
                updatedAt: "2026",
              }),
            getAccess: () => Effect.succeed("maintainer"),
          }),
          Layer.mock(Machines)({ getActiveByEnvironmentId: () => Effect.succeed(null) }),
          Layer.mock(OrganizationProjectCatalog)({ listForOrganization: () => Effect.succeed([]) }),
          Layer.mock(Workflows)({
            get: () => Effect.succeed(baseline),
            save: () => {
              saves++;
              return Effect.succeed({
                ...previous,
                ...input,
                automation: automation(input.automation),
                revision: 2,
              });
            },
          }),
        );
        const result = yield* saveRepositoryWorkflow("repo", input).pipe(
          Effect.provide(layer),
          Effect.provideService(RelayClientPrincipal, { userId: "maintainer", token: "fixture" }),
          Effect.result,
        );
        const recovery = mode === "disable" || mode === "archive";
        expect(result._tag).toBe(recovery ? "Success" : "Failure");
        expect(saves).toBe(recovery ? 1 : 0);
      }),
    );
});
