import {
  RelayApi,
  RelayInternalError,
  RelayOrganizationSkillFiles,
  type RelayExecutorOrganizationSkill,
  type RelayOrganizationSkill,
} from "@t3tools/contracts/relay";
import {
  ORGANIZATION_SKILL_DESCRIPTION_MAX_LENGTH,
  ORGANIZATION_SKILL_MANIFEST_FILE,
} from "@t3tools/contracts";
import { parseSkillFrontmatter } from "@t3tools/shared/skillFrontmatter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as OrganizationSkills from "../tenancy/OrganizationSkills.ts";
import { mapErrorTags, mapRelayCommonApiErrors } from "./Api.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";
import { tenancyInvalid } from "./tenancyErrors.ts";

const encodeFilesJson = Schema.encodeEffect(Schema.fromJsonString(RelayOrganizationSkillFiles));
const decodeFilesJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayOrganizationSkillFiles),
);

export class OrganizationSkillFilesUnreadable extends Schema.TaggedErrorClass<OrganizationSkillFilesUnreadable>()(
  "OrganizationSkillFilesUnreadable",
  { name: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Organization skill files for '${this.name}' could not be read`;
  }
}

/**
 * What the upload says about itself. The schema already guarantees a
 * `SKILL.md`; this reads its frontmatter the way the provider CLIs will, and
 * refuses a manifest they would not load under the name being saved.
 */
export const describeOrganizationSkillUpload = Effect.fn("relay.organization_skills.describe")(
  function* (input: { readonly name: string; readonly files: RelayOrganizationSkillFiles }) {
    const manifest = input.files.find((file) => file.path === ORGANIZATION_SKILL_MANIFEST_FILE);
    const frontmatter = parseSkillFrontmatter(manifest?.content ?? "");
    if (frontmatter.kind === "malformed") {
      return yield* tenancyInvalid("skill_manifest_malformed");
    }
    if (
      frontmatter.kind === "parsed" &&
      frontmatter.name !== undefined &&
      frontmatter.name !== input.name
    ) {
      return yield* tenancyInvalid("skill_name_mismatch");
    }
    const description = frontmatter.kind === "parsed" ? (frontmatter.description ?? "") : "";
    return { description: description.slice(0, ORGANIZATION_SKILL_DESCRIPTION_MAX_LENGTH) };
  },
);

/** The files as they go into the row. */
export const encodeOrganizationSkillFiles = Effect.fn("relay.organization_skills.encode")(
  function* (files: RelayOrganizationSkillFiles) {
    return yield* encodeFilesJson(files);
  },
);

/** The row's files, decoded; unreadable rows fail rather than degrade. */
export const decodeOrganizationSkillFiles = Effect.fn("relay.organization_skills.decode")(
  function* (record: OrganizationSkills.OrganizationSkillRecord) {
    return yield* decodeFilesJson(record.filesJson).pipe(
      Effect.mapError(
        (cause) => new OrganizationSkillFilesUnreadable({ name: record.name, cause }),
      ),
    );
  },
);

export const toApiOrganizationSkill = Effect.fn("relay.organization_skills.to_api")(function* (
  record: OrganizationSkills.OrganizationSkillRecord,
): Effect.fn.Return<RelayOrganizationSkill, OrganizationSkillFilesUnreadable> {
  const files = yield* decodeOrganizationSkillFiles(record);
  return {
    name: record.name,
    description: record.description,
    filePaths: files.map((file) => file.path),
    version: record.version,
    updatedByUserId: record.updatedByUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
});

/** Every skill the organization holds, with files, for the executor that asked. */
export const openOrganizationSkillsForExecutor = Effect.fn(
  "relay.organization_skills.open_for_executor",
)(function* (input: { readonly environmentId: string }) {
  const machine = yield* requireEnrolledExecutor({ environmentId: input.environmentId });
  const skills = yield* OrganizationSkills.OrganizationSkills;
  const records = yield* skills.listForOrganization({ organizationId: machine.organizationId });
  const opened: Array<RelayExecutorOrganizationSkill> = [];
  for (const record of records) {
    opened.push({
      name: record.name,
      description: record.description,
      version: record.version,
      files: yield* decodeOrganizationSkillFiles(record),
    });
  }
  return { machine, skills: opened };
});

/**
 * Organization skills for managed executors (ADR-0016). An enrolled agent
 * executor receives the organization's skills with their files; the relay
 * keeps nothing about the request.
 */
export const organizationSkillsServerApi = HttpApiBuilder.group(
  RelayApi,
  "organizationSkillsServer",
  (handlers) =>
    handlers.handle(
      "fetchOrganizationSkills",
      Effect.fn("relay.api.organization_skills.fetch")(
        function* (args) {
          const { machine, skills } = yield* openOrganizationSkillsForExecutor({
            environmentId: args.params.environmentId,
          });
          yield* Effect.logInfo("organization skills delivered to executor", {
            organizationId: machine.organizationId,
            machineId: machine.machineId,
            skills: skills.map((skill) => skill.name),
          });
          return { skills };
        },
        mapErrorTags({
          OrganizationSkillFilesUnreadable: (_error, traceId) =>
            new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    ),
);
