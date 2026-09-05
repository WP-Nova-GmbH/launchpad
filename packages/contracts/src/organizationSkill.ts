import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * An organization skill: a directory of text files with a `SKILL.md` at its
 * root, in the shape Claude Code, Codex, Cursor, and OpenCode all load. The
 * relay holds them per organization and executors place a copy where each
 * provider CLI looks for user-level skills.
 */
export const ORGANIZATION_SKILL_MANIFEST_FILE = "SKILL.md";
export const ORGANIZATION_SKILL_NAME_MAX_LENGTH = 64;
export const ORGANIZATION_SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const ORGANIZATION_SKILL_FILE_MAX_LENGTH = 256 * 1024;
export const ORGANIZATION_SKILL_MAX_FILES = 64;
export const ORGANIZATION_SKILL_MAX_TOTAL_LENGTH = 1024 * 1024;

/** The name every agent CLI accepts: lowercase letters and digits, single hyphens between them. */
export const OrganizationSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ORGANIZATION_SKILL_NAME_MAX_LENGTH),
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
);
export type OrganizationSkillName = typeof OrganizationSkillName.Type;

/** Relative to the skill's directory on the executor; never a directory escape. */
export const OrganizationSkillFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/),
  Schema.isPattern(/^(?!.*(^|\/)\.\.(\/|$))/),
);
export type OrganizationSkillFilePath = typeof OrganizationSkillFilePath.Type;

export const OrganizationSkillFile = Schema.Struct({
  path: OrganizationSkillFilePath,
  content: Schema.String.check(Schema.isMaxLength(ORGANIZATION_SKILL_FILE_MAX_LENGTH)),
});
export type OrganizationSkillFile = typeof OrganizationSkillFile.Type;

const organizationSkillFilesFilter = Schema.makeFilter(
  (files: ReadonlyArray<{ readonly path: string; readonly content: string }>) => {
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (paths.has(file.path)) {
        return `Skill files must have distinct paths ('${file.path}' appears twice).`;
      }
      paths.add(file.path);
      total += file.content.length;
    }
    if (!paths.has(ORGANIZATION_SKILL_MANIFEST_FILE)) {
      return `A skill needs a ${ORGANIZATION_SKILL_MANIFEST_FILE} at its root.`;
    }
    return (
      total <= ORGANIZATION_SKILL_MAX_TOTAL_LENGTH ||
      `Skill files must total at most ${ORGANIZATION_SKILL_MAX_TOTAL_LENGTH} characters.`
    );
  },
);

/** The files of one skill: at least the manifest, distinct paths, bounded in count and size. */
export const OrganizationSkillFiles = Schema.Array(OrganizationSkillFile).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ORGANIZATION_SKILL_MAX_FILES),
  organizationSkillFilesFilter,
);
export type OrganizationSkillFiles = typeof OrganizationSkillFiles.Type;
