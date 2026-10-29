import * as NodeCrypto from "node:crypto";
import { RelayThreadVmGitMetadata } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { THREAD_VM_GIT_CREDENTIAL_HELPER } from "../vcs/threadVmCredentials.ts";
import { workspaceGit as git, workspaceGitText as gitText } from "./ThreadWorkspaceGit.ts";
import { workspaceFailure } from "./ThreadWorkspaceTransferError.ts";

const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(RelayThreadVmGitMetadata));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(RelayThreadVmGitMetadata));
export const threadVmGitConfigHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Build with Git's own parser before taking checkout admission or config.lock. */
export const prepareThreadVmGitConfig = Effect.fn("ThreadVmGitConfig.prepare")(function* (
  root: string,
  canonicalKey: string,
  metadata: RelayThreadVmGitMetadata | undefined,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  if (
    path.resolve(root) !== root ||
    (yield* fs.realPath(root)) !== root ||
    (yield* fs.realPath(yield* gitText(root, ["rev-parse", "--show-toplevel"]))) !== root
  )
    return yield* workspaceFailure("The VM repository path changed.");
  const gitDirectory = yield* fs.realPath(
      yield* gitText(root, ["rev-parse", "--absolute-git-dir"]),
    ),
    commonDirectory = yield* fs.realPath(
      yield* gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ),
    configPath = path.join(commonDirectory, "config"),
    headPath = path.join(gitDirectory, "HEAD"),
    markerPath = path.join(root, ".git"),
    markerIsFile = (yield* fs.stat(markerPath)).type === "File",
    marker = markerIsFile ? yield* fs.readFileString(markerPath) : null,
    commonPath = path.join(gitDirectory, "commondir"),
    common = (yield* fs.exists(commonPath)) ? yield* fs.readFileString(commonPath) : null,
    original = yield* fs.readFileString(configPath),
    originalHash = threadVmGitConfigHash(original),
    head = yield* fs.readFileString(headPath),
    branch = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/u.exec(head)?.[1] ?? null;
  if (
    (yield* fs.realPath(configPath)) !== configPath ||
    (gitDirectory !== commonDirectory &&
      !gitDirectory.startsWith(path.join(commonDirectory, "worktrees") + path.sep))
  )
    return yield* workspaceFailure("The VM Git directory changed.");
  const readEffective = gitText(root, [
    "config",
    "--local",
    "--includes",
    "--show-origin",
    "--null",
    "--list",
  ]);
  const effectiveText = yield* readEffective,
    effective = effectiveText.split("\0"),
    includedFiles = new Map<string, string>();
  for (let index = 0; index + 1 < effective.length; index += 2) {
    const source = effective[index]!,
      entry = effective[index + 1]!,
      split = entry.indexOf("\n"),
      key = (split < 0 ? entry : entry.slice(0, split)).toLowerCase();
    if (
      key === "extensions.worktreeconfig" &&
      (yield* gitText(root, ["config", "--local", "--includes", "--type=bool", "--get-all", key]))
        .split("\n")
        .includes("true")
    )
      return yield* workspaceFailure(
        "VM Git setup does not support extensions.worktreeConfig. Use the shared repository configuration before retrying.",
      );
    if (source.startsWith("file:")) {
      const file = yield* fs.realPath(path.resolve(root, source.slice(5)));
      if (file !== configPath && !includedFiles.has(file))
        includedFiles.set(file, threadVmGitConfigHash(yield* fs.readFileString(file)));
    }
    const originArray = /^remote\.origin\.(?:url|pushurl|push|fetch)$/u.test(key),
      scopedCredential =
        /^credential\.https:\/\/github\.com(?:[:/].*)?\.(?:helper|usehttppath|username)$/u.test(
          key,
        );
    if (
      (originArray ||
        scopedCredential ||
        (branch !== null && key === `branch.${branch.toLowerCase()}.merge`)) &&
      (!source.startsWith("file:") ||
        (yield* fs.realPath(path.resolve(root, source.slice(5)))) !== configPath)
    )
      return yield* workspaceFailure(
        "An included Git configuration overrides the VM's origin, branch tracking, or GitHub credentials. Move those settings into the repository's main Git config before retrying.",
      );
  }
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "launchpad-vm-git-" }),
    candidate = path.join(scratch, "config"),
    fragment = path.join(scratch, "managed");
  yield* fs.writeFileString(candidate, original);
  yield* fs.writeFileString(fragment, "");
  const get = Effect.fnUntraced(function* (key: string) {
    const result = yield* git(root, ["config", "--file", candidate, "--get", key], {
      allowFailure: true,
    });
    if (result.code !== 0 && result.code !== 1)
      return yield* workspaceFailure("The VM Git configuration could not be read.");
    return result.code === 0 ? result.stdout.trimEnd() : null;
  });
  const previousRaw = yield* get("launchpad.gitIdentity"),
    previous = previousRaw === null ? Option.none() : decodeIdentity(previousRaw),
    previousIdentity =
      Option.isSome(previous) && previous.value.status === "ready" ? previous.value : null;
  const identity =
    metadata?.status === "ready"
      ? metadata
      : metadata?.status === "unconfigured" ||
          (metadata?.status === "pending" &&
            previousIdentity !== null &&
            (metadata.appId !== previousIdentity.appId ||
              (metadata.appSlug !== undefined && metadata.appSlug !== previousIdentity.appSlug)))
        ? null
        : previousIdentity;
  const getCurrent = Effect.fnUntraced(function* (key: string) {
    const result = yield* git(root, ["config", "--local", "--includes", "--get", key], {
      allowFailure: true,
    });
    if (result.code !== 0 && result.code !== 1)
      return yield* workspaceFailure("The VM branch configuration could not be read.");
    return result.code === 0 ? result.stdout.trimEnd() : null;
  });
  const remote = branch === null ? null : yield* getCurrent(`branch.${branch}.remote`),
    merge = branch === null ? null : yield* getCurrent(`branch.${branch}.merge`),
    base = branch === null ? null : yield* getCurrent(`branch.${branch}.gh-merge-base`);
  const origin = `https://${canonicalKey}.git`;
  const managed: Array<readonly [string, string]> = [
    ["remote.origin.url", origin],
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["remote.origin.pushurl", origin],
    ["remote.origin.mirror", "false"],
    ["remote.pushDefault", "origin"],
    ["push.default", "current"],
    ["push.autoSetupRemote", "true"],
    ["branch.autoSetupMerge", "simple"],
    ["credential.helper", ""],
    ["credential.helper", THREAD_VM_GIT_CREDENTIAL_HELPER],
    ["credential.useHttpPath", "true"],
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", THREAD_VM_GIT_CREDENTIAL_HELPER],
    ["credential.https://github.com.useHttpPath", "true"],
    ["credential.https://github.com.username", "x-access-token"],
    ["commit.gpgsign", "false"],
    ["user.useConfigOnly", "true"],
    ["user.name", identity?.name ?? ""],
    ["user.email", identity?.email ?? ""],
    ["author.name", identity?.name ?? ""],
    ["author.email", identity?.email ?? ""],
    ["committer.name", identity?.name ?? ""],
    ["committer.email", identity?.email ?? ""],
  ];
  if (identity) managed.push(["launchpad.gitIdentity", encodeIdentity(identity)]);
  if (branch !== null) {
    managed.push(
      [`branch.${branch}.remote`, "origin"],
      [`branch.${branch}.pushRemote`, "origin"],
      [`branch.${branch}.merge`, `refs/heads/${branch}`],
    );
    if (
      !base &&
      remote === "origin" &&
      merge?.startsWith("refs/heads/") &&
      merge !== `refs/heads/${branch}`
    )
      managed.push([`branch.${branch}.gh-merge-base`, merge.slice("refs/heads/".length)]);
  }
  const names = (yield* gitText(root, [
    "config",
    "--file",
    candidate,
    "--name-only",
    "--list",
    "-z",
  ]))
    .split("\0")
    .filter(Boolean);
  const remove = new Set([
    ...managed.map(([key]) => key),
    "launchpad.gitIdentity",
    "remote.origin.push",
    ...names.filter((key) =>
      /^credential\.https:\/\/github\.com(?:[:/].*)?\.(?:helper|usehttppath|username)$/iu.test(key),
    ),
  ]);
  for (const key of remove) {
    const result = yield* git(root, ["config", "--file", candidate, "--unset-all", key], {
      allowFailure: true,
    });
    if (result.code !== 0 && result.code !== 5)
      return yield* workspaceFailure("The VM Git configuration could not be prepared.");
  }
  for (const [key, value] of managed)
    yield* git(root, ["config", "--file", fragment, "--add", key, value]);
  // Last definitions override imported includes; the empty helper resets inherited account helpers.
  const text = `${yield* fs.readFileString(candidate)}\n${yield* fs.readFileString(fragment)}`;
  if ((yield* readEffective) !== effectiveText)
    return yield* workspaceFailure(
      "Included Git configuration changed while preparing VM setup. Retry setup.",
    );
  const recheck = Effect.gen(function* () {
    for (const [file, hash] of includedFiles)
      if (threadVmGitConfigHash(yield* fs.readFileString(file)) !== hash)
        return yield* workspaceFailure(
          "Included Git configuration changed while preparing VM setup. Retry setup.",
        );
    if (
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.realPath(configPath)) !== configPath ||
      (yield* fs.realPath(gitDirectory)) !== gitDirectory ||
      (yield* fs.readFileString(headPath)) !== head ||
      ((yield* fs.stat(markerPath)).type === "File"
        ? yield* fs.readFileString(markerPath)
        : null) !== marker ||
      ((yield* fs.exists(commonPath)) ? yield* fs.readFileString(commonPath) : null) !== common ||
      threadVmGitConfigHash(yield* fs.readFileString(configPath)) !== originalHash
    )
      return yield* workspaceFailure("The VM checkout changed while preparing Git. Retry setup.");
  });
  return {
    root,
    gitDirectory,
    commonDirectory,
    configPath,
    head,
    branch,
    originalHash,
    text,
    configHash: threadVmGitConfigHash(text),
    recheck,
    metadataPending: metadata?.status !== "ready",
  };
});

export type ThreadVmGitConfig = Effect.Success<ReturnType<typeof prepareThreadVmGitConfig>>;

/** Publish a complete snapshot with Git's own nonblocking lock. Never remove somebody else's lock. */
export const publishThreadVmGitConfig = Effect.fn("ThreadVmGitConfig.publish")(function* (
  config: ThreadVmGitConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const lockPath = `${config.configPath}.lock`;
      const file = yield* fs
        .open(lockPath, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.mapError(() =>
            workspaceFailure(
              "Git configuration is locked. Finish other Git commands and retry. If none are running, inspect the repository's config.lock before removing it.",
            ),
          ),
        );
      const opened = yield* file.stat;
      let renamed = false;
      const owned = Effect.gen(function* () {
        const current = yield* fs.stat(lockPath);
        return (
          current.dev === opened.dev &&
          Option.isSome(current.ino) &&
          Option.isSome(opened.ino) &&
          current.ino.value === opened.ino.value
        );
      });
      yield* Effect.gen(function* () {
        yield* config.recheck;
        yield* file.writeAll(new TextEncoder().encode(config.text));
        yield* file.sync;
        if (!(yield* owned))
          return yield* workspaceFailure("The VM Git configuration lock changed.");
        yield* fs.rename(lockPath, config.configPath);
        renamed = true;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!renamed && (yield* owned.pipe(Effect.orElseSucceed(() => false))))
              yield* fs.remove(lockPath).pipe(Effect.ignore);
          }),
        ),
      );
    }),
  );
});
