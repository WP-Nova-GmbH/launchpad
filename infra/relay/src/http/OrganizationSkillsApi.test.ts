import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as Machines from "../machines/Machines.ts";
import * as OrganizationSkills from "../tenancy/OrganizationSkills.ts";
import {
  describeOrganizationSkillUpload,
  encodeOrganizationSkillFiles,
  openOrganizationSkillsForExecutor,
  toApiOrganizationSkill,
} from "./OrganizationSkillsApi.ts";

const timestamp = "2026-09-05T00:00:00.000Z";

const principal = { environmentId: "environment-1", environmentPublicKey: "public-key-1" };

const unexpected = (name: string) => () => Effect.die(`unexpected ${name}`);

function machine(overrides: Partial<Machines.MachineRecord> = {}): Machines.MachineRecord {
  return {
    machineId: "machine-1",
    organizationId: "organization-1",
    role: "agent_executor",
    label: "Executor 1",
    computeKind: "self_hosted",
    computeRef: null,
    seedExpiresAt: timestamp,
    environmentId: "environment-1",
    environmentPublicKey: "public-key-1",
    endpointHttpBaseUrl: null,
    endpointWsBaseUrl: null,
    endpointProviderKind: null,
    createdByUserId: "user-1",
    enrolledAt: timestamp,
    deprovisionedAt: null,
    createdAt: timestamp,
    ...overrides,
  };
}

function machinesLayer(found: Machines.MachineRecord | null) {
  return Layer.succeed(
    Machines.Machines,
    Machines.Machines.of({
      create: unexpected("create"),
      getById: unexpected("getById"),
      listForOrganization: unexpected("listForOrganization"),
      countActiveForOrganization: unexpected("countActiveForOrganization"),
      getBySeedHash: unexpected("getBySeedHash"),
      getActiveByEnvironmentId: () => Effect.succeed(found),
      recordComputeRef: unexpected("recordComputeRef"),
      claimEnrollment: unexpected("claimEnrollment"),
      deprovision: unexpected("deprovision"),
      remove: unexpected("remove"),
    }),
  );
}

function skillsLayer(
  records: ReadonlyArray<OrganizationSkills.OrganizationSkillRecord>,
  seen: Array<string>,
) {
  return Layer.succeed(
    OrganizationSkills.OrganizationSkills,
    OrganizationSkills.OrganizationSkills.of({
      listForOrganization: (input) =>
        Effect.sync(() => {
          seen.push(input.organizationId);
          return records;
        }),
      save: unexpected("save"),
      delete: unexpected("delete"),
    }),
  );
}

const manifest = (name: string, description = "Review the change.") =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

const reviewFiles = [
  { path: "SKILL.md", content: manifest("review") },
  { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n" },
] as const;

function record(
  name: string,
  filesJson: string,
  overrides: Partial<OrganizationSkills.OrganizationSkillRecord> = {},
): OrganizationSkills.OrganizationSkillRecord {
  return {
    organizationId: "organization-1",
    name,
    description: "Review the change.",
    filesJson,
    version: `${name}-v1`,
    createdByUserId: "user-1",
    updatedByUserId: "user-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("describeOrganizationSkillUpload", () => {
  it.effect("takes the description from the manifest frontmatter", () =>
    Effect.gen(function* () {
      const described = yield* describeOrganizationSkillUpload({
        name: "review",
        files: reviewFiles,
      });
      expect(described).toEqual({ description: "Review the change." });
    }),
  );

  it.effect("accepts a manifest without frontmatter and records no description", () =>
    Effect.gen(function* () {
      const described = yield* describeOrganizationSkillUpload({
        name: "review",
        files: [{ path: "SKILL.md", content: "# Review\n" }],
      });
      expect(described).toEqual({ description: "" });
    }),
  );

  it.effect("refuses a manifest whose frontmatter names a different skill", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        describeOrganizationSkillUpload({
          name: "review",
          files: [{ path: "SKILL.md", content: manifest("deploy") }],
        }),
      );
      expect(error._tag).toBe("RelayTenancyInvalidError");
      expect(error.reason).toBe("skill_name_mismatch");
    }),
  );

  it.effect("refuses frontmatter the provider CLIs would not load", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        describeOrganizationSkillUpload({
          name: "review",
          files: [{ path: "SKILL.md", content: "---\n- not\n- a mapping\n---\n" }],
        }),
      );
      expect(error.reason).toBe("skill_manifest_malformed");
    }),
  );
});

describe("toApiOrganizationSkill", () => {
  it.effect("lists file paths without their contents", () =>
    Effect.gen(function* () {
      const filesJson = yield* encodeOrganizationSkillFiles(reviewFiles);
      expect(filesJson).toContain("echo ok");
      const api = yield* toApiOrganizationSkill(record("review", filesJson));
      expect(api).toEqual({
        name: "review",
        description: "Review the change.",
        filePaths: ["SKILL.md", "scripts/check.sh"],
        version: "review-v1",
        updatedByUserId: "user-1",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }),
  );

  it.effect("fails on a row whose files cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(toApiOrganizationSkill(record("review", "not json")));
      expect(error._tag).toBe("OrganizationSkillFilesUnreadable");
    }),
  );
});

describe("openOrganizationSkillsForExecutor", () => {
  it.effect("returns every skill of the executor's organization with its files", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const filesJson = yield* encodeOrganizationSkillFiles(reviewFiles);
      const result = yield* openOrganizationSkillsForExecutor({
        environmentId: "environment-1",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            machinesLayer(machine()),
            skillsLayer([record("review", filesJson)], seen),
          ),
        ),
      );
      expect(seen).toEqual(["organization-1"]);
      expect(result.skills).toEqual([
        {
          name: "review",
          description: "Review the change.",
          version: "review-v1",
          files: reviewFiles,
        },
      ]);
    }).pipe(Effect.provideService(RelayEnvironmentPrincipal, principal)),
  );

  it.effect("refuses anything that is not an enrolled agent executor", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const error = yield* Effect.flip(
        openOrganizationSkillsForExecutor({ environmentId: "environment-1" }).pipe(
          Effect.provide(
            Layer.mergeAll(machinesLayer(machine({ role: "review_host" })), skillsLayer([], seen)),
          ),
        ),
      );
      expect(error).toBeInstanceOf(HttpApiError.Unauthorized);
      expect(seen).toEqual([]);
    }).pipe(Effect.provideService(RelayEnvironmentPrincipal, principal)),
  );
});
