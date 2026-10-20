import * as NodeUtil from "node:util";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { workspaceGit as git, workspaceGitText as gitText } from "./ThreadWorkspaceGit.ts";
import {
  copyWorkspaceFiles,
  materializeWorkspaceFiles,
  safeWorkspacePath,
  scanWorkspaceFiles,
  validateWorkspaceFiles,
  workspaceFailure,
  workspaceFileHash,
} from "./ThreadWorkspaceFiles.ts";

import { ThreadWorkspaceManifest } from "@t3tools/contracts/threadTransfer";
export { ThreadWorkspaceManifest } from "@t3tools/contracts/threadTransfer";
const decodeManifest = Schema.decodeUnknownEffect(ThreadWorkspaceManifest);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ThreadWorkspaceManifest));
const checkpointPrefix = (threadId: string) =>
  `refs/t3/checkpoints/${Encoding.encodeBase64Url(threadId)}/turn/`;
const headRef = "refs/t3/transfer/head";
const indexRef = "refs/t3/transfer/index";

const readSourceState = Effect.fnUntraced(function* (cwd: string, threadId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const top = yield* gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if ((yield* fs.realPath(top)) !== cwd)
    return yield* workspaceFailure("Transfer must start at the repository checkout root.");
  const head = yield* gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolic = yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true,
  });
  if (symbolic.code !== 0 && symbolic.code !== 1)
    return yield* workspaceFailure("Cannot determine the source branch.");
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() : null;
  const objectFormat = yield* gitText(cwd, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    return yield* workspaceFailure("Unsupported Git object format.");
  const gitDir = yield* fs.realPath(yield* gitText(cwd, ["rev-parse", "--absolute-git-dir"]));
  for (const marker of [
    "index.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    if (yield* fs.exists(path.join(gitDir, marker)))
      return yield* workspaceFailure("Finish the active Git operation before moving this thread.");
  }
  if ((yield* gitText(cwd, ["rev-parse", "--is-shallow-repository"])) !== "false")
    return yield* workspaceFailure("Fetch complete Git history before moving this checkout.");
  const listing = (yield* git(cwd, ["ls-files", "--stage", "-z"])).stdout;
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (
      !match ||
      match[3] !== "0" ||
      !["100644", "100755", "120000"].includes(match[1]!) ||
      !safeWorkspacePath(match[4]!)
    )
      return yield* workspaceFailure(
        "Unmerged, sparse, nested, or excluded Git entries cannot be transferred.",
      );
  }
  const tracked = (yield* git(cwd, ["ls-files", "-z"])).stdout;
  const filters = (yield* git(cwd, ["check-attr", "-z", "--stdin", "filter"], {
    stdin: tracked,
  })).stdout.split("\0");
  for (let i = 2; i < filters.length; i += 3) {
    if (filters[i] !== "unspecified" && filters[i] !== "unset")
      return yield* workspaceFailure(
        "Git LFS and custom checkout filters require a supported transfer adapter.",
      );
  }
  const refs = (yield* git(cwd, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    checkpointPrefix(threadId),
  ])).stdout;
  const checkpoints = refs.trim()
    ? refs
        .trim()
        .split("\n")
        .map((line) => {
          const [ref, commit] = line.split(" ");
          return { ref: ref!, commit: commit! };
        })
    : [];
  const indexPath = path.join(gitDir, "index");
  const index = yield* workspaceFileHash(indexPath);
  return {
    head,
    branch,
    objectFormat: objectFormat as "sha1" | "sha256",
    checkpoints,
    index,
    indexPath,
  };
});

/** Requires a frozen thread and stopped external writers; never publishes or changes placement. */
export const exportThreadWorkspace = Effect.fn("exportThreadWorkspace")(function* (input: {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(input.workspaceRoot);
  const requestedArtifactRoot = path.resolve(input.artifactRoot);
  let ancestor = requestedArtifactRoot;
  while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
  const resolvedArtifactRoot = path.resolve(
    yield* fs.realPath(ancestor),
    path.relative(ancestor, requestedArtifactRoot),
  );
  if (resolvedArtifactRoot === root || resolvedArtifactRoot.startsWith(`${root}${path.sep}`))
    return yield* workspaceFailure("Workspace artifacts must be stored outside the checkout.");
  yield* fs.makeDirectory(requestedArtifactRoot, { recursive: true, mode: 0o700 });
  const artifactRoot = yield* fs.realPath(requestedArtifactRoot);
  if (artifactRoot === root || artifactRoot.startsWith(`${root}${path.sep}`))
    return yield* workspaceFailure("Workspace artifacts must be stored outside the checkout.");
  const state = yield* readSourceState(root, input.threadId);
  const scan = yield* scanWorkspaceFiles(root);
  yield* fs.makeDirectory(artifactRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({ directory: artifactRoot, prefix: "workspace-" });
  return yield* Effect.gen(function* () {
    const temporaryGit = path.join(directory, "git-build");
    yield* git(directory, [
      "init",
      "--bare",
      `--object-format=${state.objectFormat}`,
      temporaryGit,
    ]);
    const sourceObjects = yield* fs.realPath(
      path.resolve(root, yield* gitText(root, ["rev-parse", "--git-path", "objects"])),
    );
    // The alternate exists only in the temporary builder. The final bundle is self-contained.
    yield* fs.writeFileString(
      path.join(temporaryGit, "objects", "info", "alternates"),
      `${sourceObjects}\n`,
      { mode: 0o600 },
    );
    const indexPath = path.join(directory, "index");
    yield* fs.copyFile(state.indexPath, indexPath);
    const indexEnv = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: path.join(temporaryGit, "objects"),
    };
    yield* git(
      root,
      ["update-index", "--no-split-index", "--no-fsmonitor", "--no-untracked-cache"],
      { env: indexEnv },
    );
    const indexTree = yield* gitText(root, ["write-tree"], indexEnv);
    const indexCommit = (yield* git(temporaryGit, ["commit-tree", indexTree, "-p", state.head], {
      stdin: "Portable workspace index\n",
      env: {
        GIT_AUTHOR_NAME: "Launchpad",
        GIT_AUTHOR_EMAIL: "workspace@localhost",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "Launchpad",
        GIT_COMMITTER_EMAIL: "workspace@localhost",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    })).stdout.trim();
    const refs = [
      { ref: headRef, commit: state.head },
      { ref: indexRef, commit: indexCommit },
      ...state.checkpoints,
    ];
    for (const ref of refs) yield* git(temporaryGit, ["update-ref", ref.ref, ref.commit]);
    const bundlePath = path.join(directory, "repository.bundle");
    yield* git(temporaryGit, ["bundle", "create", bundlePath, ...refs.map((ref) => ref.ref)]);
    const files = yield* copyWorkspaceFiles(root, directory, scan);
    if (!NodeUtil.isDeepStrictEqual(yield* readSourceState(root, input.threadId), state))
      return yield* workspaceFailure(
        "Git state changed during export; stop its writers and retry.",
      );
    yield* fs.remove(temporaryGit, { recursive: true });
    const manifest: ThreadWorkspaceManifest = {
      format: "launchpad-workspace-v1",
      threadId: input.threadId,
      objectFormat: state.objectFormat,
      head: state.head,
      branch: state.branch,
      indexTree,
      indexCommit,
      checkpoints: state.checkpoints,
      bundle: yield* workspaceFileHash(bundlePath),
      index: yield* workspaceFileHash(indexPath),
      files,
    };
    yield* fs.chmod(indexPath, 0o600);
    yield* fs.chmod(bundlePath, 0o600);
    yield* fs.writeFileString(
      path.join(directory, "manifest.json"),
      yield* encodeManifest(manifest),
      { mode: 0o600, flag: "wx" },
    );
    return { directory, manifest };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

/** Imports to a new quarantine checkout. Checkout claims and ownership activation happen separately. */
export const importThreadWorkspace = Effect.fn("importThreadWorkspace")(function* (input: {
  readonly threadId: string;
  readonly manifest: unknown;
  readonly artifactDirectory: string;
  readonly destinationRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* decodeManifest(input.manifest);
  if (manifest.threadId !== input.threadId)
    return yield* workspaceFailure("Workspace belongs to another thread.");
  yield* validateWorkspaceFiles(manifest.files);
  const prefix = checkpointPrefix(input.threadId);
  if (
    new Set(manifest.checkpoints.map((ref) => ref.ref)).size !== manifest.checkpoints.length ||
    manifest.checkpoints.some(
      (ref) => !ref.ref.startsWith(prefix) || !/^\d+$/.test(ref.ref.slice(prefix.length)),
    )
  )
    return yield* workspaceFailure("Workspace contains checkpoint references from another thread.");
  const root = yield* fs.realPath(input.artifactDirectory);
  for (const [name, expected] of [
    ["repository.bundle", manifest.bundle],
    ["index", manifest.index],
  ] as const) {
    const file = path.join(root, name);
    if (
      (yield* fs.realPath(file)) !== file ||
      !NodeUtil.isDeepStrictEqual(yield* workspaceFileHash(file), expected)
    )
      return yield* workspaceFailure("Git artifact failed its integrity check.");
  }
  yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({
    directory: input.destinationRoot,
    prefix: "checkout-",
  });
  return yield* Effect.gen(function* () {
    yield* git(directory, ["init", `--object-format=${manifest.objectFormat}`, "."]);
    if (manifest.branch)
      yield* git(directory, ["check-ref-format", `refs/heads/${manifest.branch}`]);
    const bundle = path.join(root, "repository.bundle");
    yield* git(directory, ["bundle", "verify", bundle]);
    const expectedRefs = [
      { ref: headRef, commit: manifest.head },
      { ref: indexRef, commit: manifest.indexCommit },
      ...manifest.checkpoints,
    ];
    const actual = (yield* gitText(directory, ["bundle", "list-heads", bundle])).split("\n").sort();
    if (
      !NodeUtil.isDeepStrictEqual(
        actual,
        expectedRefs.map((ref) => `${ref.commit} ${ref.ref}`).sort(),
      )
    )
      return yield* workspaceFailure("Git bundle does not match the selected thread's references.");
    yield* git(directory, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      bundle,
      ...expectedRefs.map((ref) => `+${ref.ref}:${ref.ref}`),
    ]);
    yield* git(directory, ["fsck", "--full", "--strict", "--no-reflogs"]);
    if (
      (yield* gitText(directory, ["rev-parse", `${manifest.indexCommit}^{tree}`])) !==
      manifest.indexTree
    )
      return yield* workspaceFailure("The saved Git index is not bound to its bundle.");
    yield* fs.copyFile(path.join(root, "index"), path.join(directory, ".git", "index"));
    // Intent-to-add entries refer to Git's empty blob, which write-tree omits from the saved tree.
    yield* git(directory, ["hash-object", "-w", "--stdin"], { stdin: "" });
    if ((yield* gitText(directory, ["write-tree"])) !== manifest.indexTree)
      return yield* workspaceFailure("The saved Git index failed validation.");
    if (manifest.branch) {
      yield* git(directory, ["symbolic-ref", "HEAD", `refs/heads/${manifest.branch}`]);
      yield* git(directory, ["update-ref", `refs/heads/${manifest.branch}`, manifest.head]);
    } else yield* git(directory, ["update-ref", "--no-deref", "HEAD", manifest.head]);
    yield* materializeWorkspaceFiles(manifest.files, root, directory);
    yield* git(directory, ["update-ref", "-d", headRef]);
    yield* git(directory, ["update-ref", "-d", indexRef]);
    return { workspaceRoot: directory, manifest };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});
