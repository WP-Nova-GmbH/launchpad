/**
 * Placing the organization's skills on this machine, for one provider.
 *
 * Drivers call `applyOrganizationSkills` while building an instance, naming
 * the directory their provider CLI reads user-level skills from. Every
 * organization skill becomes `<directory>/<name>/` with its files and a
 * marker recording the relay's version; a directory carrying a marker for a
 * skill the organization no longer holds is removed; a directory without a
 * marker belongs to whoever put it there and is left alone. Nothing here can
 * fail an instance: a placement problem is logged and the instance comes up
 * without that skill.
 *
 * @module provider/organizationSkills
 */
import type { OrganizationSkillFile, ProviderAccountProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { OrganizationSkills } from "../relay/OrganizationSkills.ts";

/** Sits inside each placed skill directory and records which relay version it came from. */
export const ORGANIZATION_SKILL_MARKER_FILE = ".launchpad-organization-skill";

/** A file in the skill would land outside the skill's own directory. */
export class OrganizationSkillFileEscapesError extends Schema.TaggedErrorClass<OrganizationSkillFileEscapesError>()(
  "OrganizationSkillFileEscapesError",
  {
    skill: Schema.String,
    filePath: Schema.String,
    directory: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to place '${this.filePath}' of skill '${this.skill}' outside '${this.directory}'`;
  }
}

export interface OrganizationSkillPlacement {
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyArray<OrganizationSkillFile>;
}

export interface SyncOrganizationSkillsResult {
  /** Skills written or rewritten this time. */
  readonly written: ReadonlyArray<string>;
  /** Skills whose placed version already matched. */
  readonly unchanged: ReadonlyArray<string>;
  /** Directories removed because the organization no longer holds the skill. */
  readonly removed: ReadonlyArray<string>;
  /** Skills skipped because a directory of that name is not ours. */
  readonly skipped: ReadonlyArray<string>;
}

/** Scripts keep working when the upload lost their mode bit: a shebang makes a file executable. */
function fileMode(content: string): number {
  return content.startsWith("#!") ? 0o755 : 0o644;
}

const readMarker = (fileSystem: FileSystem.FileSystem, markerPath: string) =>
  fileSystem.readFileString(markerPath).pipe(
    Effect.map((contents) => contents.trim()),
    Effect.orElseSucceed(() => null),
  );

/**
 * Bring a provider's user-level skills directory in line with the
 * organization's skills. Idempotent: a second run with the same set changes
 * nothing. The directory is only created when there is something to place,
 * so a machine without skills gains no empty directories.
 */
export const syncOrganizationSkills = Effect.fn("syncOrganizationSkills")(function* (input: {
  readonly directory: string;
  readonly skills: ReadonlyArray<OrganizationSkillPlacement>;
}): Effect.fn.Return<
  SyncOrganizationSkillsResult,
  PlatformError | OrganizationSkillFileEscapesError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.resolve(input.directory);
  const wanted = new Map(input.skills.map((skill) => [skill.name, skill]));
  const written: Array<string> = [];
  const unchanged: Array<string> = [];
  const removed: Array<string> = [];
  const skipped: Array<string> = [];

  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const entry of entries) {
    if (wanted.has(entry)) continue;
    const marker = path.join(directory, entry, ORGANIZATION_SKILL_MARKER_FILE);
    if ((yield* readMarker(fileSystem, marker)) === null) continue;
    yield* fileSystem.remove(path.join(directory, entry), { recursive: true });
    removed.push(entry);
  }

  for (const skill of input.skills) {
    const target = path.join(directory, skill.name);
    const marker = path.join(target, ORGANIZATION_SKILL_MARKER_FILE);
    const placed = yield* readMarker(fileSystem, marker);
    if (placed === skill.version) {
      unchanged.push(skill.name);
      continue;
    }
    if (placed === null && (yield* fileSystem.exists(target))) {
      skipped.push(skill.name);
      continue;
    }
    // Replace wholesale so a file dropped from the skill does not linger.
    yield* fileSystem.remove(target, { recursive: true, force: true });
    yield* fileSystem.makeDirectory(target, { recursive: true });
    for (const file of skill.files) {
      const filePath = path.resolve(target, file.path);
      // The contract already forbids `..`; this is the belt to that suspender.
      if (filePath !== target && !filePath.startsWith(`${target}${path.sep}`)) {
        return yield* new OrganizationSkillFileEscapesError({
          skill: skill.name,
          filePath: file.path,
          directory: target,
        });
      }
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, file.content);
      yield* fileSystem.chmod(filePath, fileMode(file.content));
    }
    yield* fileSystem.writeFileString(marker, skill.version);
    written.push(skill.name);
  }

  return { written, unchanged, removed, skipped };
});

export const applyOrganizationSkills = Effect.fn("applyOrganizationSkills")(function* (input: {
  readonly provider: ProviderAccountProvider;
  /** Where this provider reads user-level skills from. */
  readonly directory: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const skills = yield* OrganizationSkills;
  const current = yield* skills.current;
  const result = yield* syncOrganizationSkills({
    directory: input.directory,
    skills: [...current.values()],
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("organization skills could not be placed", {
        provider: input.provider,
        directory: input.directory,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (result === null) return;
  if (result.skipped.length > 0) {
    yield* Effect.logWarning(
      "organization skills left alone: a directory of that name is not ours",
      {
        provider: input.provider,
        directory: input.directory,
        skills: result.skipped,
      },
    );
  }
  if (result.written.length > 0 || result.removed.length > 0) {
    yield* Effect.logInfo("organization skills placed", {
      provider: input.provider,
      directory: input.directory,
      written: result.written,
      removed: result.removed,
    });
  }
});
