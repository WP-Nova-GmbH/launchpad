#!/usr/bin/env node
/**
 * Cuts a Launchpad release from the current checkout:
 *
 *   vp run release patch      # 0.1.8 -> 0.1.9
 *   vp run release minor      # 0.1.8 -> 0.2.0
 *   vp run release 0.2.0-beta.1
 *   vp run release patch --dry-run
 *
 * It bumps the version in the release package manifests, refreshes the
 * lockfile, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and pushes the
 * commit and the tag together. The push starts `.github/workflows/release.yml`,
 * which builds and publishes the release. Refuses to run off `main`, behind
 * `origin/main`, with staged changes, or for a version that already has a tag.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";

export const RELEASE_BRANCH = "main";
export const RELEASE_REMOTE = "origin";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const ReleaseBump = Schema.Literals(["patch", "minor", "major"]);
export type ReleaseBump = typeof ReleaseBump.Type;
const isReleaseBump = Schema.is(ReleaseBump);

export class InvalidReleaseVersionError extends Schema.TaggedErrorClass<InvalidReleaseVersionError>()(
  "InvalidReleaseVersionError",
  { input: Schema.String },
) {
  override get message(): string {
    return `'${this.input}' is neither patch, minor, major, nor a version like 0.2.0 or 0.2.0-beta.1.`;
  }
}

export class ReleaseNotAnIncreaseError extends Schema.TaggedErrorClass<ReleaseNotAnIncreaseError>()(
  "ReleaseNotAnIncreaseError",
  { current: Schema.String, requested: Schema.String },
) {
  override get message(): string {
    return `Requested version ${this.requested} is not newer than the current ${this.current}.`;
  }
}

export class ReleasePreconditionError extends Schema.TaggedErrorClass<ReleasePreconditionError>()(
  "ReleasePreconditionError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ReleaseCommandError extends Schema.TaggedErrorClass<ReleaseCommandError>()(
  "ReleaseCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    return `\`${this.command}\` exited with code ${this.exitCode}${this.stderr ? `: ${this.stderr}` : ""}`;
  }
}

export class ReleaseCommandSpawnError extends Schema.TaggedErrorClass<ReleaseCommandSpawnError>()(
  "ReleaseCommandSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not run \`${this.command}\`.`;
  }
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | undefined;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  // A prerelease sorts before the release it precedes.
  if (left.prerelease === undefined && right.prerelease === undefined) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

/**
 * The version a release request resolves to: a bump keyword applied to the
 * current version (dropping any prerelease suffix), or an explicit version
 * that must be newer than the current one.
 */
export function resolveNextVersion(
  current: string,
  input: string,
): Effect.Effect<string, InvalidReleaseVersionError | ReleaseNotAnIncreaseError> {
  const parsedCurrent = parseVersion(current);
  if (!parsedCurrent) {
    return Effect.fail(new InvalidReleaseVersionError({ input: current }));
  }
  const trimmed = input.trim();
  if (isReleaseBump(trimmed)) {
    switch (trimmed) {
      case "patch":
        return Effect.succeed(
          parsedCurrent.prerelease === undefined
            ? `${parsedCurrent.major}.${parsedCurrent.minor}.${parsedCurrent.patch + 1}`
            : `${parsedCurrent.major}.${parsedCurrent.minor}.${parsedCurrent.patch}`,
        );
      case "minor":
        return Effect.succeed(`${parsedCurrent.major}.${parsedCurrent.minor + 1}.0`);
      case "major":
        return Effect.succeed(`${parsedCurrent.major + 1}.0.0`);
    }
  }
  const requested = trimmed.replace(/^v/, "");
  const parsedRequested = parseVersion(requested);
  if (!parsedRequested) {
    return Effect.fail(new InvalidReleaseVersionError({ input }));
  }
  if (compareVersions(parsedRequested, parsedCurrent) <= 0) {
    return Effect.fail(new ReleaseNotAnIncreaseError({ current, requested }));
  }
  return Effect.succeed(requested);
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

/** Runs a command in the repository root and returns its trimmed stdout. */
const run = Effect.fn("release.run")(function* (
  cwd: string,
  executable: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = [executable, ...args].join(" ");
  const child = yield* spawner
    .spawn(ChildProcess.make(executable, args, { cwd }))
    .pipe(Effect.mapError((cause) => new ReleaseCommandSpawnError({ command, cause })));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError((cause) => new ReleaseCommandSpawnError({ command, cause })));
  if (exitCode !== 0) {
    return yield* new ReleaseCommandError({ command, exitCode, stderr: stderr.trim() });
  }
  return stdout.trim();
});

const DesktopPackageJson = fromJsonStringPretty(Schema.Struct({ version: Schema.String }));
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(DesktopPackageJson);

const readCurrentVersion = Effect.fn("release.readCurrentVersion")(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(repoRoot, "apps/desktop/package.json"));
  return (yield* decodeDesktopPackageJson(text)).version;
});

const requirePrecondition = (ok: boolean, reason: string) =>
  ok ? Effect.void : Effect.fail(new ReleasePreconditionError({ reason }));

const checkPreconditions = Effect.fn("release.checkPreconditions")(function* (
  repoRoot: string,
  tag: string,
) {
  const git = (...args: ReadonlyArray<string>) => run(repoRoot, "git", args);

  const branch = yield* git("rev-parse", "--abbrev-ref", "HEAD");
  yield* requirePrecondition(
    branch === RELEASE_BRANCH,
    `Releases are cut from ${RELEASE_BRANCH}; the checkout is on ${branch}.`,
  );

  const staged = yield* git("diff", "--cached", "--name-only");
  yield* requirePrecondition(
    staged.length === 0,
    "The index has staged changes; commit or unstage them before releasing.",
  );

  const releaseFiles = [...releasePackageFiles, "pnpm-lock.yaml"];
  const dirtyReleaseFiles = yield* git("status", "--porcelain", "--", ...releaseFiles);
  yield* requirePrecondition(
    dirtyReleaseFiles.length === 0,
    `Release files have uncommitted changes:\n${dirtyReleaseFiles}`,
  );

  yield* git("fetch", "--quiet", RELEASE_REMOTE, RELEASE_BRANCH, "--tags");
  const remoteIsAncestor = yield* git(
    "merge-base",
    "--is-ancestor",
    `${RELEASE_REMOTE}/${RELEASE_BRANCH}`,
    "HEAD",
  ).pipe(
    Effect.as(true),
    Effect.catchTag("ReleaseCommandError", () => Effect.succeed(false)),
  );
  yield* requirePrecondition(
    remoteIsAncestor,
    `The checkout is behind ${RELEASE_REMOTE}/${RELEASE_BRANCH}; pull first.`,
  );

  const localTag = yield* git("tag", "--list", tag);
  yield* requirePrecondition(localTag.length === 0, `Tag ${tag} already exists locally.`);
  const remoteTag = yield* git("ls-remote", "--tags", RELEASE_REMOTE, `refs/tags/${tag}`);
  yield* requirePrecondition(
    remoteTag.length === 0,
    `Tag ${tag} already exists on ${RELEASE_REMOTE}.`,
  );
});

export const cutRelease = Effect.fn("release.cutRelease")(function* (options: {
  readonly repoRoot: string;
  readonly input: string;
  readonly dryRun: boolean;
}) {
  const { repoRoot, dryRun } = options;
  const current = yield* readCurrentVersion(repoRoot);
  const version = yield* resolveNextVersion(current, options.input);
  const tag = `v${version}`;

  yield* checkPreconditions(repoRoot, tag);
  yield* Console.log(`Release ${current} -> ${version} (tag ${tag})`);
  if (dryRun) {
    yield* Console.log(
      `Dry run: would bump ${releasePackageFiles.length} manifests, refresh pnpm-lock.yaml, ` +
        `commit "chore(release): ${tag}", tag ${tag}, and push ${RELEASE_BRANCH} and ${tag} to ${RELEASE_REMOTE}.`,
    );
    return { version, tag, pushed: false };
  }

  yield* updateReleasePackageVersions(version, { rootDir: repoRoot });
  const vp = (...args: ReadonlyArray<string>) => run(repoRoot, "vp", args);
  yield* vp("fmt", ...releasePackageFiles);
  yield* vp("install", "--lockfile-only", "--ignore-scripts");

  const git = (...args: ReadonlyArray<string>) => run(repoRoot, "git", args);
  yield* git("add", "--", ...releasePackageFiles, "pnpm-lock.yaml");
  yield* git("commit", "--quiet", "-m", `chore(release): ${tag}`);
  yield* git("tag", "-a", tag, "-m", `Launchpad ${tag}`);
  yield* git("push", "--atomic", RELEASE_REMOTE, RELEASE_BRANCH, tag);

  const remoteUrl = yield* git("remote", "get-url", RELEASE_REMOTE);
  const slug = remoteUrl.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  yield* Console.log(
    `Pushed ${tag}. Release build: https://github.com/${slug}/actions/workflows/release.yml`,
  );
  return { version, tag, pushed: true };
});

const command = Command.make(
  "release",
  {
    version: Argument.string("version").pipe(
      Argument.withDescription("patch, minor, major, or an explicit version such as 0.2.0-beta.1."),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Check preconditions and print the plan without changing anything."),
      Flag.withDefault(false),
    ),
  },
  ({ version, dryRun }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      yield* cutRelease({ repoRoot, input: version, dryRun });
    }),
).pipe(Command.withDescription("Bump, commit, tag, and push a Launchpad release."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
