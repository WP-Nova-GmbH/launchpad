import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  VcsProcessExitError,
  VcsProcessOutputReadError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsError,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { readWorkflowIgnoreRules } from "./WorkflowCheckpointIgnore.ts";
import { copyWorkflowCheckpointWorkspace } from "./WorkflowCheckpointWorkspace.ts";
import {
  readWorkflowCheckpointExclude,
  stageWorkflowCheckpoint,
  WorkflowCheckpointReadError,
} from "./WorkflowCheckpointReader.ts";
import {
  WORKFLOW_REVIEW_SOURCE_REF,
  WorkflowReviewGitDirectory,
} from "./WorkflowReviewGitDirectory.ts";
import { VmCoordinatorProcess, VmWorkloadTracking, WorkflowVmGuest } from "../vmWorkloadCommand.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /**
   * With `appendTruncationMarker`, keep invoking the line callbacks after the
   * buffered copy is full. For long-running commands whose output is only
   * consumed through `progress`.
   */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

/**
 * Progress callbacks for `createWorktree`. Git prints `Updating files: 78% (2104/2700)`
 * to stderr during checkout, and `Submodule path 'x': checked out` during
 * submodule init. The tracker uses these to drive the worktree setup card.
 */
export interface CreateWorktreeProgress {
  /**
   * Fires once `git worktree add` has created and registered the directory,
   * before the (possibly long) submodule step. Git refuses an existing path,
   * so a path reported here belongs to this call and is safe to remove on
   * cancel.
   */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  /** Fires when `.gitmodules` exists but the resolved submodule mode is `"none"`. */
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "launchpad.json" | "t3.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /**
   * The project-over-environment `worktreeSubmodules` setting. Null (or
   * omitted, for callers without settings access) defers to the checkout's
   * own launchpad.json.
   */
  readonly submodules?: WorktreeSubmodules | null;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestHeadCommitInput {
  cwd: string;
  prNumber: number;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /**
   * Commit the checkout is allowed to be hard-reset away from: the upstream commit read before
   * the fetch. HEAD sitting there means the checkout holds no work of its own.
   */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Fetches `refs/pull/<n>/head` without writing a branch, for heads that exist nowhere else. */
    readonly fetchPullRequestHeadCommit: (
      input: GitFetchPullRequestHeadCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    /** Moves the branch checked out in `cwd` onto `targetCommit`, from inside that worktree. */
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Drops worktree admin entries whose directory is already gone (`git worktree prune`). */
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
// Git hunk lines carry an addition, deletion, or context prefix. Match only whole LF lines.
const GIT_BINARY_DIFF_SUMMARY = /(?:^|\n)Binary files [^\n]+ differ(?:\n|$)/;
// Git deliberately skips symlinked worktree ignore files while still listing their paths.
const GIT_SYMLINK_IGNORE_WARNING =
  /^warning: unable to access '(?:[^\0\r\n]+\/)?\.gitignore': Too many levels of symbolic links$/u;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;
export const workflowGitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "",
  GIT_ALLOW_PROTOCOL: "",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_ATTR_SOURCE: undefined,
  LC_ALL: "C",
} as const satisfies NodeJS.ProcessEnv;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    readonly appendTruncationMarker?: boolean;
  },
) =>
  Effect.flatMap(WorkflowVmGuest, (workflowGuest) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      // The VM launcher enters cwd after dropping UID; coordinator home is private.
      ...(workflowGuest ? {} : { spawnCwd: globalThis.process.cwd() }),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    }),
  );

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  // Git renames loose objects and refs into place without fsync by default, so
  // an unclean restart can leave 0-byte files under refs/t3/** that break every
  // later fetch and push. Checkpoint writes flush before they are published;
  // macOS defaults to writeout-only, which does not reach the disk either.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
  ] as const;

  const reviewDirectory = Effect.fnUntraced(function* (cwd: string, operation: string) {
    const directory = yield* WorkflowReviewGitDirectory;
    if (
      (!directory && ((yield* WorkflowVmGuest) || (yield* VmWorkloadTracking))) ||
      (directory &&
        (!path.isAbsolute(directory) ||
          path.normalize(directory) !== directory ||
          directory === cwd ||
          directory.startsWith(path.resolve(cwd) + path.sep)))
    )
      return yield* new VcsProcessExitError({
        operation,
        command: "git checkpoint",
        cwd,
        exitCode: 1,
        detail: "The private workflow checkpoint repository is unavailable.",
      });
    return directory;
  });

  const executeReviewGit = (directory: string, input: Omit<Parameters<typeof execute>[0], "cwd">) =>
    execute({
      ...input,
      cwd: directory,
      args: ["--git-dir", directory, ...input.args],
      env: { ...workflowGitEnvironment, ...input.env },
    }).pipe(Effect.provideService(VmCoordinatorProcess, true));

  const writeCheckpoint = Effect.fnUntraced(function* (
    input: VcsDriver.VcsCaptureCheckpointInput,
    git: (args: ReadonlyArray<string>) => ReturnType<typeof execute>,
    updateRef: (args: ReadonlyArray<string>) => ReturnType<typeof execute>,
  ) {
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    const treeOid = (yield* git([...durableWrite, "write-tree"])).stdout.trim();
    if (treeOid.length === 0) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git write-tree",
        cwd: input.cwd,
        exitCode: 0,
        detail: "git write-tree returned an empty tree oid.",
      });
    }
    const commitOid = (yield* git([
      ...durableWrite,
      "commit-tree",
      treeOid,
      "-m",
      `t3 checkpoint ref=${input.checkpointRef}`,
    ])).stdout.trim();
    if (commitOid.length === 0) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git commit-tree",
        cwd: input.cwd,
        exitCode: 0,
        detail: "git commit-tree returned an empty commit oid.",
      });
    }
    yield* updateRef([...durableWrite, "update-ref", "--no-deref", input.checkpointRef, commitOid]);
    return { commitId: commitOid, treeId: treeOid };
  });

  const captureStrictWorkflowCheckpoint = Effect.fn("GitVcsDriver.captureStrictWorkflowCheckpoint")(
    function* (input: VcsDriver.VcsCaptureCheckpointInput) {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      const unavailable = (detail: string) =>
        new VcsProcessExitError({
          operation,
          command: "git checkpoint",
          cwd: input.cwd,
          exitCode: 1,
          detail,
        });
      const localPathError = () =>
        unavailable("The workflow Git checkpoint metadata is unavailable.");
      const cwd = yield* fileSystem.realPath(input.cwd).pipe(Effect.mapError(localPathError));
      const protectedDir = yield* reviewDirectory(cwd, operation);
      const isolated = yield* WorkflowVmGuest;
      if (protectedDir && cwd !== input.cwd) return yield* localPathError();
      const gitDir = path.join(cwd, ".git");
      const objectDir = path.join(protectedDir ?? gitDir, "objects");
      if (
        (!protectedDir &&
          (yield* fileSystem.realPath(gitDir).pipe(Effect.mapError(localPathError))) !== gitDir) ||
        (yield* fileSystem.realPath(objectDir).pipe(Effect.mapError(localPathError))) !== objectDir
      )
        return yield* localPathError();

      const env = workflowGitEnvironment;
      const workloadGit = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
        execute({
          operation,
          cwd,
          args: [
            "--git-dir",
            gitDir,
            "--work-tree",
            cwd,
            "-c",
            "core.hooksPath=/dev/null",
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...args,
          ],
          env,
          allowNonZeroExit,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          outputMode: "error",
        });
      const sourceGit = protectedDir
        ? (args: ReadonlyArray<string>) =>
            executeReviewGit(protectedDir, {
              operation,
              args: ["-c", "core.hooksPath=/dev/null", ...args],
              maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
              outputMode: "error",
            })
        : workloadGit;
      const objectFormat = (yield* sourceGit(["rev-parse", "--show-object-format"])).stdout.trim();
      if (objectFormat !== "sha1" && objectFormat !== "sha256")
        return yield* unavailable("The workflow Git object format is unsupported.");
      if (protectedDir)
        yield* sourceGit(["rev-parse", "--verify", `${WORKFLOW_REVIEW_SOURCE_REF}^{commit}`]);
      const readHead = Effect.fnUntraced(function* () {
        const result = yield* workloadGit(["rev-parse", "--verify", "HEAD^{commit}"]);
        const head = result.stdout.trim();
        if (
          result.stderr !== "" ||
          !/^[0-9a-f]+$/u.test(head) ||
          head.length !== (objectFormat === "sha1" ? 40 : 64)
        )
          return yield* localPathError();
        return head;
      });
      const requireFullCheckout = Effect.fnUntraced(function* () {
        const sparse = yield* workloadGit(
          ["config", "--bool", "--get", "core.sparseCheckout"],
          true,
        );
        if (sparse.stderr !== "" || (sparse.exitCode !== 0 && sparse.exitCode !== 1))
          return yield* unavailable("The workflow Git sparse checkout setting is invalid.");
        const sparseCheckout = () =>
          unavailable("The workflow Git checkpoint requires a full checkout.");
        if (sparse.stdout.trim() === "true") return yield* sparseCheckout();
        if (protectedDir) {
          // Index flags can omit files independently of the effective sparse configuration.
          const index = yield* workloadGit(["ls-files", "-v", "--cached", "--sparse", "-z"]);
          if (
            index.stderr !== "" ||
            index.stdoutInvalidUtf8 ||
            (index.stdout !== "" && !index.stdout.endsWith("\0"))
          )
            return yield* localPathError();
          if (index.stdout.split("\0").some((entry) => /^[Ss] /u.test(entry)))
            return yield* sparseCheckout();
        }
      });
      const head = yield* readHead();
      yield* requireFullCheckout();
      const requireLocalIgnoreRules = Effect.gen(function* () {
        const configured = yield* workloadGit(["config", "--get", "core.excludesFile"], true);
        if (configured.exitCode === 0)
          return yield* unavailable(
            "The workflow Git checkpoint does not support custom exclude files.",
          );
        if (configured.exitCode !== 1 || configured.stderr.trim() !== "")
          return yield* unavailable("The workflow Git exclude settings could not be checked.");
        return yield* (
          isolated ? readWorkflowCheckpointExclude(spawner, cwd) : readWorkflowIgnoreRules(cwd)
        ).pipe(
          Effect.mapError((_error: unknown) =>
            unavailable("The workflow Git ignore rules are unavailable."),
          ),
        );
      });
      const localIgnoreRules = yield* requireLocalIgnoreRules;
      const workflowIgnoreRules = input.workflowIgnoreRules ?? localIgnoreRules;
      const ignoreRulesChanged = () =>
        unavailable("The workflow Git ignore rules changed after preparation.");
      if (Buffer.compare(workflowIgnoreRules, localIgnoreRules) !== 0)
        return yield* ignoreRulesChanged();

      // A fresh Git directory ignores the workload's index stat cache, hooks, clean
      // filters, worktree settings and attributes outside the checkout.
      const scratch = yield* fileSystem
        .makeTempDirectoryScoped({
          prefix: "workflow-checkpoint-",
          directory: protectedDir ? path.dirname(protectedDir) : undefined,
        })
        .pipe(Effect.mapError(localPathError));
      const captureGit = (command: Parameters<typeof execute>[0]) =>
        protectedDir
          ? execute({ ...command, cwd: protectedDir }).pipe(
              Effect.provideService(VmCoordinatorProcess, true),
            )
          : execute(command);
      yield* captureGit({
        operation,
        cwd,
        args: ["init", "--bare", "--template=", `--object-format=${objectFormat}`, "--", scratch],
        env,
      });
      const writeIgnoreRules = Effect.fnUntraced(function* (directory: string, mode: number) {
        if (workflowIgnoreRules.byteLength === 0) return;
        const info = path.join(directory, "info");
        yield* fileSystem
          .makeDirectory(info, { recursive: true })
          .pipe(Effect.mapError(localPathError));
        yield* fileSystem
          .writeFile(path.join(info, "exclude"), workflowIgnoreRules, { mode })
          .pipe(Effect.mapError(localPathError));
      });
      yield* writeIgnoreRules(scratch, 0o600);
      const completePaths = (result: VcsProcess.VcsProcessOutput, scansIgnoreRules = false) => {
        const unexpectedWarning =
          result.stderr !== "" &&
          (!scansIgnoreRules ||
            !result.stderr
              .trimEnd()
              .split("\n")
              .every((line) => GIT_SYMLINK_IGNORE_WARNING.test(line)));
        if (
          result.stdoutInvalidUtf8 ||
          (protectedDir &&
            (result.stderrInvalidUtf8 ||
              unexpectedWarning ||
              (result.stdout !== "" && !result.stdout.endsWith("\0"))))
        )
          return Effect.fail(unavailable("The workflow Git checkpoint paths are unavailable."));
        return Effect.succeed(result.stdout.split("\0").filter(Boolean));
      };
      const requireReviewableIgnoreFiles = Effect.fnUntraced(function* (
        git: (args: ReadonlyArray<string>) => ReturnType<typeof execute>,
        tracked?: ReadonlySet<string>,
      ) {
        const ignored = yield* git([
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "-z",
          "--",
          ":(glob)**/.gitignore",
        ]);
        // Git can report a pruned directory instead of its files. An ignored
        // rule file in a scanned directory can hide paths from the checkpoint.
        if (
          (yield* completePaths(ignored, true)).some(
            (entry) =>
              (entry === ".gitignore" || entry.endsWith("/.gitignore")) && !tracked?.has(entry),
          )
        )
          return yield* unavailable(
            "The workflow Git checkpoint cannot verify an ignored .gitignore file.",
          );
      });
      let workTree = cwd;
      let trackedPaths: ReadonlySet<string> | undefined;
      let recheckPaths: Effect.Effect<void, VcsError> = Effect.void;
      if (protectedDir) {
        // Enumerate untracked names under the workload identity and without the
        // workload's config or index. The listing directory contains no private
        // objects. The coordinator never lets Git open mutable worktree paths.
        const listing = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: (yield* VmWorkloadTracking) ? "/tmp" : undefined,
            prefix: "workflow-checkpoint-listing-",
          })
          .pipe(Effect.mapError(localPathError));
        yield* captureGit({
          operation,
          cwd,
          args: ["init", "--bare", "--template=", `--object-format=${objectFormat}`, "--", listing],
          env,
        });
        yield* writeIgnoreRules(listing, 0o644);
        // The coordinator may use a private umask. Publish only the neutral
        // metadata the workload needs, with no writable files or directories.
        for (const name of ["objects", "refs", ...(workflowIgnoreRules.byteLength ? ["info"] : [])])
          yield* fileSystem
            .chmod(path.join(listing, name), 0o755)
            .pipe(Effect.mapError(localPathError));
        for (const name of [
          "HEAD",
          "config",
          ...(workflowIgnoreRules.byteLength ? ["info/exclude"] : []),
        ])
          yield* fileSystem
            .chmod(path.join(listing, name), 0o644)
            .pipe(Effect.mapError(localPathError));
        yield* fileSystem.chmod(listing, 0o755).pipe(Effect.mapError(localPathError));
        const listGit = (args: ReadonlyArray<string>) =>
          execute({
            operation,
            cwd: listing,
            args: [
              "--git-dir",
              listing,
              "--work-tree",
              cwd,
              "-c",
              `safe.directory=${listing}`,
              "-c",
              "core.bare=false",
              "-c",
              "core.ignorecase=false",
              "-c",
              "core.excludesFile=/dev/null",
              ...args,
            ],
            env,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
        const tracked = new Set<string>();
        const tree = yield* workloadGit(["ls-tree", "-r", "-z", "--full-tree", head]);
        for (const entry of yield* completePaths(tree)) {
          if (entry.startsWith("160000 "))
            return yield* unavailable(
              "The workflow Git checkpoint does not support embedded repositories.",
            );
          const pathStart = entry.indexOf("\t");
          if (pathStart < 0 || pathStart === entry.length - 1) return yield* localPathError();
          tracked.add(entry.slice(pathStart + 1));
        }
        trackedPaths = tracked;
        const readUntracked = Effect.fnUntraced(function* () {
          yield* requireReviewableIgnoreFiles(listGit, tracked);
          const result = yield* listGit(["ls-files", "--others", "--exclude-standard", "-z"]);
          return new Set(yield* completePaths(result, true));
        });
        const untracked = yield* readUntracked();
        recheckPaths = Effect.gen(function* () {
          const latest = yield* readUntracked();
          if (latest.size !== untracked.size || [...latest].some((name) => !untracked.has(name)))
            return yield* unavailable("The workflow Git checkpoint paths changed during capture.");
        });
        const candidates = [...tracked, ...untracked];
        workTree = path.join(scratch, "worktree");
        yield* fileSystem
          .makeDirectory(workTree, { mode: 0o700 })
          .pipe(Effect.mapError(localPathError));
        yield* (
          isolated
            ? stageWorkflowCheckpoint(spawner, cwd, workTree, candidates)
            : copyWorkflowCheckpointWorkspace(cwd, workTree, candidates)
        ).pipe(
          Effect.mapError((error: unknown) =>
            unavailable(
              Schema.is(WorkflowCheckpointReadError)(error)
                ? error.message
                : "The workflow files could not be safely read for the checkpoint.",
            ),
          ),
        );
      }
      const checkpointGit = (args: ReadonlyArray<string>, stdin?: string) =>
        captureGit({
          operation,
          cwd,
          args: [
            "--git-dir",
            scratch,
            "--work-tree",
            workTree,
            "-c",
            "core.bare=false",
            "-c",
            "core.filemode=true",
            "-c",
            "core.symlinks=true",
            "-c",
            "core.ignorecase=false",
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
            "core.excludesFile=/dev/null",
            ...args,
          ],
          env: {
            ...env,
            GIT_OBJECT_DIRECTORY: objectDir,
            GIT_AUTHOR_NAME: "Launchpad",
            GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
            GIT_COMMITTER_NAME: "Launchpad",
            GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
          },
          ...(stdin === undefined ? {} : { stdin }),
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          outputMode: "error",
        });
      if (!trackedPaths) {
        yield* checkpointGit(["read-tree", head]);
      } else if (trackedPaths.size > 0) {
        // Seed only path membership. Git reads all bytes and modes from private staging.
        const emptyBlob = (yield* checkpointGit(
          ["hash-object", "-w", "--stdin"],
          "",
        )).stdout.trim();
        const entries = [...trackedPaths].map((name) => `100644 ${emptyBlob}\t${name}\0`).join("");
        yield* checkpointGit(["update-index", "-z", "--index-info"], entries);
      }
      yield* requireReviewableIgnoreFiles(checkpointGit);
      yield* checkpointGit([...durableWrite, "add", "-A", "--", "."]);
      if (
        protectedDir &&
        (yield* checkpointGit(["ls-files", "--stage", "-z"])).stdout
          .split("\0")
          .some((entry) => entry.startsWith("160000 "))
      )
        return yield* unavailable(
          "The workflow Git checkpoint does not support embedded repositories.",
        );
      yield* requireReviewableIgnoreFiles(checkpointGit);
      const attributeFiles = yield* checkpointGit([
        "ls-files",
        "-z",
        "--",
        ":(glob)**/.gitattributes",
      ]);
      if (attributeFiles.stdout.length > 0) {
        const paths = yield* checkpointGit(["ls-files", "-z"]);
        if (paths.stdoutInvalidUtf8)
          return yield* unavailable("The workflow Git filter attributes could not be checked.");
        // Inspect the captured index, since the working-tree attributes can change
        // while the checkpoint is being made.
        const filters = yield* checkpointGit(
          ["check-attr", "--cached", "-z", "--stdin", "filter"],
          paths.stdout,
        );
        const fields = filters.stdout.split("\0");
        if (filters.stdoutInvalidUtf8 || fields.pop() !== "" || fields.length % 3 !== 0)
          return yield* unavailable("The workflow Git filter attributes could not be checked.");
        if (
          fields.some(
            (value, index) => index % 3 === 2 && value !== "unspecified" && value !== "unset",
          )
        )
          return yield* unavailable(
            "The workflow Git checkpoint does not support checkout filters.",
          );
      }
      const publish = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
        if (protectedDir) {
          yield* recheckPaths;
          yield* requireFullCheckout();
        }
        if (Buffer.compare(workflowIgnoreRules, yield* requireLocalIgnoreRules) !== 0)
          return yield* ignoreRulesChanged();
        if (protectedDir && (yield* readHead()) !== head)
          return yield* unavailable("The workflow Git HEAD changed during capture.");
        return yield* sourceGit(args);
      });
      const checkpoint = yield* writeCheckpoint(input, checkpointGit, publish);
      return { ...checkpoint, workflowIgnoreRules };
    },
    Effect.scoped,
  );

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      if (input.strictWorkflowCapture) return yield* captureStrictWorkflowCheckpoint(input);
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      const indexConfig = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "sparse.expectFilesOutsideOfPatterns=false",
      ];
      const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
      const tempIndexPath = path.join(
        gitCommonDir,
        `t3-checkpoint-index-${NodeCrypto.randomUUID()}`,
      );
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "Launchpad",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Launchpad",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
      };

      // Forced process termination can leave Git's private index lock behind.
      const cleanupTempIndex = Effect.forEach(
        [tempIndexPath, `${tempIndexPath}.lock`],
        (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
        { discard: true },
      );

      return yield* Effect.gen(function* () {
        const headExists = yield* hasHeadCommit(input.cwd);
        const sparseConfig = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["config", "--bool", "core.sparseCheckout"],
          allowNonZeroExit: true,
        });
        let sparseCheckout = sparseConfig.stdout.trim() === "true";
        if (sparseCheckout) {
          const help = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["add", "-h"],
            allowNonZeroExit: true,
          });
          sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
        }
        if (headExists) {
          const reusedIndex = yield* Effect.gen(function* () {
            const indexPath = yield* execute({
              operation,
              cwd: input.cwd,
              args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
            });
            const { mtime } = yield* fileSystem.stat(indexPath.stdout.trim());
            if (Option.isNone(mtime)) return false;
            // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
            const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
            if (indexTime <= 0) return false;
            yield* fileSystem.copyFile(indexPath.stdout.trim(), tempIndexPath);
            // Retain stat data only where the copied index already matches HEAD.
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "read-tree", "--reset", "HEAD"],
              env: commitEnv,
            });
            // read-tree can rewrite the index, so restore its racy timestamp afterward.
            yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            let specialFlags = false;
            let recordStart = true;
            let skipped = false;
            let skippedRecord: number[] = [];
            const skippedPaths: string[] = [];
            yield* vcsProcess.run({
              operation,
              command: "git",
              cwd: input.cwd,
              args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
              env: commitEnv,
              maxOutputBytes: 4_096,
              outputMode: "truncate",
              // Inspect every tag; retain only skipped file paths for checking sparse rules.
              onStdoutChunk: (chunk) => {
                for (const byte of chunk) {
                  if (recordStart) skipped = byte === 83;
                  if (skipped && sparseCheckout) {
                    if (byte !== 0) skippedRecord.push(byte);
                    else {
                      if (skippedRecord.at(-1) !== 47) {
                        const name = Buffer.from(skippedRecord).subarray(2);
                        if (!NodeBuffer.isUtf8(name)) specialFlags = true;
                        else skippedPaths.push(name.toString("utf8"));
                      }
                      skippedRecord = [];
                    }
                  }
                  if (
                    recordStart &&
                    ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))
                  ) {
                    specialFlags = true;
                  }
                  recordStart = byte === 0;
                }
              },
            });
            if (skippedPaths.length > 0 && !specialFlags) {
              const selected = yield* execute({
                operation,
                cwd: input.cwd,
                args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                stdin: skippedPaths.join("\0") + "\0",
                env: commitEnv,
                maxOutputBytes: 1,
                outputMode: "truncate",
              });
              // Any selected skipped file has a manual flag, not a sparse exclusion.
              specialFlags = selected.stdout.length > 0 || selected.stdoutTruncated;
            }
            // Sparse Git clears skip-worktree for present files. Manual flags still need a reset.
            return !specialFlags;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!reusedIndex) {
            if (sparseCheckout) {
              const cone = yield* execute({
                operation,
                cwd: input.cwd,
                args: ["config", "--bool", "core.sparseCheckoutCone"],
                allowNonZeroExit: true,
              });
              // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
              if (cone.stdout.trim() !== "true") {
                return yield* new VcsProcessExitError({
                  operation,
                  command: "git read-tree",
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                });
              }
            }
            yield* cleanupTempIndex;
            yield* execute({
              operation,
              cwd: input.cwd,
              // A fresh sparse index represents excluded directories without marking them deleted.
              args: sparseCheckout
                ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                : ["read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        const stageFiles = (exclusions: ReadonlyArray<string>) =>
          execute({
            operation,
            cwd: input.cwd,
            // Preserve absent skipped entries, but capture present nonignored files outside the cone.
            args: [
              ...indexConfig,
              ...durableWrite,
              "add",
              ...(sparseCheckout ? ["--sparse"] : []),
              "-A",
              "--",
              ".",
              ...exclusions,
            ],
            env: commitEnv,
          });
        yield* stageFiles([]).pipe(
          Effect.catchTags({
            VcsProcessExitError: (error) =>
              Effect.gen(function* () {
                // Git cannot stage an embedded repository until it has a commit. Discover these
                // only after staging fails so ordinary checkpoints do not need another file scan.
                const untracked = yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                  env: commitEnv,
                  maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                });
                if (untracked.stdoutTruncated) return yield* error;
                const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                  entry.endsWith("/"),
                );
                // Refuse excessive recovery work before probing any nested repositories.
                if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                // Discover each child's repository instead of inheriting the server's Git bindings.
                const nestedRepoEnv: NodeJS.ProcessEnv = {
                  ...process.env,
                  GIT_DIR: undefined,
                  GIT_WORK_TREE: undefined,
                  GIT_COMMON_DIR: undefined,
                  GIT_INDEX_FILE: undefined,
                  GIT_OBJECT_DIRECTORY: undefined,
                  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                };
                const exclusions: Array<string> = [];
                for (const entry of candidates) {
                  const nestedCwd = path.join(input.cwd, entry);
                  if (
                    (yield* fileSystem
                      .exists(path.join(nestedCwd, ".git"))
                      .pipe(Effect.mapError(() => error))) &&
                    !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                  ) {
                    exclusions.push(`:(exclude,literal)${entry}`);
                  }
                }
                if (exclusions.length === 0) return yield* error;
                return yield* stageFiles(exclusions);
              }).pipe(
                // One budget covers discovery, queued Git admission, probes, and the staging retry.
                Effect.timeoutOrElse({
                  duration: CHECKPOINT_RECOVERY_TIMEOUT,
                  orElse: () => Effect.fail(error),
                }),
              ),
          }),
        );

        return yield* writeCheckpoint(
          input,
          (args) =>
            execute({ operation, cwd: input.cwd, args: [...indexConfig, ...args], env: commitEnv }),
          (args) => execute({ operation, cwd: input.cwd, args }),
        );
      }).pipe(Effect.ensuring(cleanupTempIndex));
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    resolvePinnedTree: Effect.fn("GitVcsDriver.checkpoints.resolvePinnedTree")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.resolvePinnedTree";
      const directory = yield* reviewDirectory(input.cwd, operation);
      const command = {
        operation,
        args: [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${input.checkpointRef}^{tree}`,
        ],
        allowNonZeroExit: true,
      };
      const result = yield* directory
        ? executeReviewGit(directory, command)
        : execute({ ...command, cwd: input.cwd, env: workflowGitEnvironment });
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    }),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
      });
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      if (tracked.stdout.length > 0) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
        });
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      yield* fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      const cleaned = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
        allowNonZeroExit: true,
      });
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace)
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
      }

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      const directory = input.pinned ? yield* reviewDirectory(input.cwd, operation) : undefined;
      const strictPatch = input.requireComplete === true && input.format !== "numstat";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (!input.pinned && input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const command: Omit<Parameters<typeof execute>[0], "cwd"> = {
        operation,
        args: [
          ...(input.requireComplete || input.pinned ? ["--no-replace-objects"] : []),
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.requireComplete ? ["--ignore-submodules=none", "--submodule=short"] : []),
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          "--",
        ],
        ...(strictPatch ? { env: { LC_ALL: "C" } } : {}),
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode:
          input.format === "numstat" || input.requireComplete || input.pinned
            ? "error"
            : "truncate",
      };
      const result = yield* directory
        ? executeReviewGit(directory, command)
        : execute({ ...command, cwd: input.cwd });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      if (strictPatch) {
        const reason = result.stdoutInvalidUtf8
          ? "invalid_utf8"
          : result.stdout.includes("\0")
            ? "nul_byte"
            : GIT_BINARY_DIFF_SUMMARY.test(result.stdout)
              ? "binary_summary"
              : null;
        if (reason)
          return yield* new VcsProcessOutputReadError({
            operation,
            command: "git diff",
            cwd: input.cwd,
            stream: "stdout",
            reason,
            cause: new Error(
              reason === "invalid_utf8"
                ? "The patch contains invalid UTF-8."
                : reason === "nul_byte"
                  ? "The textual patch contains a NUL byte."
                  : "Git supplied a binary summary without the change contents.",
            ),
          });
      }

      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.deleteCheckpointRefs";
        const directory = input.pinned ? yield* reviewDirectory(input.cwd, operation) : undefined;
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) => {
            const command = {
              operation,
              args: [
                "-c",
                "core.hooksPath=/dev/null",
                "update-ref",
                "--no-deref",
                "-d",
                checkpointRef,
              ],
              allowNonZeroExit: true,
            };
            return directory
              ? executeReviewGit(directory, command)
              : execute({ ...command, cwd: input.cwd });
          },
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
