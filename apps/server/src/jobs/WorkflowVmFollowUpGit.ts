import { WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES } from "@t3tools/contracts/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { LAUNCHPAD_JOB_BRANCH_PREFIX, jobBranchName } from "@t3tools/shared/workflowStorage";
import { assertWorkflowThreadReleased } from "../persistence/WorkflowThreadOwnership.ts";
import { ProcessRunner } from "../processRunner.ts";
import { WorkflowReviewGitDirectory } from "../vcs/WorkflowReviewGitDirectory.ts";
import { workflowGitEnvironment } from "../vcs/GitVcsDriver.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkflowRunStore } from "./WorkflowRunStore.ts";
import { workflowVmPublishingGit } from "./WorkflowVmPublishingGit.ts";
import { workflowPushNeedsLfsUpload } from "./WorkflowPushLfs.ts";

export class WorkflowVmFollowUpGitError extends Schema.TaggedError<WorkflowVmFollowUpGitError>()(
  "WorkflowVmFollowUpGitError",
  { message: Schema.String },
) {}

const failure = (message: string) => new WorkflowVmFollowUpGitError({ message });
const oid = /^[a-f0-9]{40}$/u;
const baselineRef = "refs/t3/follow-up/baseline";
const checkoutBridgeRef = "refs/t3/follow-up/baseline-import";
const zero = "0000000000000000000000000000000000000000";
const lock = Semaphore.makeUnsafe(1);
const pushRef = "refs/t3/follow-up/push";
const preparedPushRef = "refs/t3/follow-up/prepared-push";
const defaultIdentity = { name: "Launchpad", email: "launchpad@users.noreply.github.com" };

interface Binding {
  readonly jobId: string;
  readonly threadId: string;
  readonly generation: number;
}

const open = Effect.fnUntraced(function* (input: Binding) {
  const store = yield* WorkflowRunStore;
  const run = yield* store.get(input.jobId);
  const sql = yield* SqlClient.SqlClient;
  yield* assertWorkflowThreadReleased(sql, input.threadId);
  const directory = yield* WorkflowReviewGitDirectory;
  const runner = yield* ProcessRunner;
  if (
    !run ||
    !run.worktreePath ||
    !directory ||
    !oid.test(run.baseSha) ||
    run.runtime.kind !== "vm" ||
    run.runtime.jobId !== input.jobId ||
    run.runtime.threadId !== input.threadId ||
    run.runtime.generation !== input.generation ||
    !/^[A-Za-z0-9-]+$/u.test(run.jobId) ||
    !/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(run.repositoryCanonicalKey)
  )
    return yield* failure("This workflow checkout is unavailable.");
  const { worktreePath, runtime } = run;
  const git = workflowVmPublishingGit(runner, directory, run.repositoryCanonicalKey.slice(11));
  const checkout = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    options: { readonly allowNonZero?: boolean; readonly localFetch?: boolean } = {},
  ) {
    const result = yield* runner.run({
      command: "/usr/bin/git",
      args: [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        worktreePath,
        ...args,
      ],
      cwd: worktreePath,
      env: options.localFetch
        ? { ...workflowGitEnvironment, GIT_ALLOW_PROTOCOL: "file" }
        : workflowGitEnvironment,
      maxOutputBytes: 4096,
      timeout: "45 seconds",
    });
    if (result.timedOut || result.stdoutTruncated || result.stdoutInvalidUtf8)
      return yield* failure("The workflow branch could not be read.");
    if (result.code !== 0 && !options.allowNonZero)
      return yield* failure("The workflow branch could not be prepared.");
    return result.stdout.trim();
  });
  return { store, run, runtime, worktreePath, git, checkout, runner };
});

export const openWorkflowVmFollowUpGit = (input: Binding) =>
  open(input).pipe(Effect.mapError(() => failure("This workflow checkout is unavailable.")));

export const installWorkflowVmFollowUpGitBaseline = (
  input: Binding & {
    readonly publishedSha: string | null;
    readonly publishedBranch: string | null;
  },
) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const { store, run, runtime, git, checkout } = yield* open(input);
      const branch = input.publishedBranch ?? jobBranchName(run.jobId, LAUNCHPAD_JOB_BRANCH_PREFIX);
      const ref = `refs/heads/${branch}`;
      if (
        !/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/u.test(branch) ||
        (input.publishedSha !== null && !oid.test(input.publishedSha))
      )
        return yield* failure("The workflow branch identity is invalid.");
      const installed = yield* git.git(["rev-parse", "--verify", baselineRef], {
        allowNonZero: true,
      });
      if (installed.code === 0) {
        const sha = installed.stdout.trim();
        const { stdout: tree } = yield* git.git(["rev-parse", "--verify", `${sha}^{tree}`]);
        if (!oid.test(sha) || !oid.test(tree.trim()))
          return yield* failure("The workflow's Git baseline could not be verified.");
        return { branch, sha, treeSha: tree.trim(), baseSha: run.baseSha };
      }

      let sha = input.publishedSha;
      if (sha === null) {
        const result = run.sequence?.completed.findLast((step) => step.checkpoint)?.checkpoint;
        // A safely captured failed/cancelled result is also an eligible final tree.
        const [latest] = yield* (yield* SqlClient.SqlClient)<{
          turnId: string;
          checkpointRef: string;
        }>`SELECT turn_id AS "turnId",checkpoint_ref AS "checkpointRef"
          FROM workflow_vm_checkpoint_pins WHERE job_id=${runtime.jobId}
            AND thread_id=${runtime.threadId} AND allocation_id=${runtime.allocationId}
            AND operation_id=${runtime.operationId} AND generation=${runtime.generation}
            AND turn_id!='' ORDER BY turn_count DESC LIMIT 1`;
        const checkpoint = latest ?? result;
        const pin = checkpoint
          ? yield* store.getCheckpointPinForRun(
              runtime,
              checkpoint.turnId,
              checkpoint.checkpointRef,
            )
          : null;
        if (checkpoint && (!pin || !oid.test(pin.treeId)))
          return yield* failure("The finished workflow result could not be verified.");
        const tree = (yield* git.git([
          "rev-parse",
          "--verify",
          `${run.baseSha}^{tree}`,
        ])).stdout.trim();
        if (pin && pin.treeId !== tree) {
          const parsed = DateTime.make(run.createdAt);
          if (Option.isNone(parsed))
            return yield* failure("The finished workflow result time is invalid.");
          const date = DateTime.formatIso(parsed.value);
          sha = (yield* git.git(
            ["commit-tree", pin.treeId, "-p", run.baseSha, "-m", "Workflow result"],
            {
              identity: {
                ...defaultIdentity,
                dates: [date, date],
              },
            },
          )).stdout.trim();
        } else sha = run.baseSha;
      }
      if (!oid.test(sha)) return yield* failure("The workflow baseline could not be prepared.");
      yield* git.git(["merge-base", "--is-ancestor", run.baseSha, sha]);
      const treeSha = (yield* git.git(["rev-parse", "--verify", `${sha}^{tree}`])).stdout.trim();

      // Export only the verified baseline objects. The workload can read but cannot mutate
      // this coordinator-owned bundle. Its live files are never overwritten during pinning.
      if (sha !== run.baseSha) {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "follow-up-baseline-" });
        yield* fs.chmod(directory, 0o755);
        const bundle = (yield* Path.Path).join(directory, "baseline.bundle");
        yield* git.git(["update-ref", checkoutBridgeRef, sha]);
        yield* git.git(["bundle", "create", bundle, checkoutBridgeRef, `^${run.baseSha}`]);
        yield* fs.chmod(bundle, 0o644);
        // The Git process has the workflow workload's UID, even for this local fetch.
        yield* checkout(
          [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            bundle,
            checkoutBridgeRef,
          ],
          { localFetch: true },
        );
      }
      const previous = yield* checkout(["rev-parse", "--verify", ref], { allowNonZero: true });
      if (previous.trim() !== "" && !oid.test(previous.trim()))
        return yield* failure("The workflow branch changed while preparing the checkout.");
      yield* checkout(["read-tree", sha]);
      yield* checkout(["update-ref", "--no-deref", ref, sha, previous || zero]);
      yield* checkout(["symbolic-ref", "HEAD", ref]);
      for (const [key, value] of Object.entries(defaultIdentity)) {
        const variable = `user.${key}`;
        if (!(yield* checkout(["config", "--get", variable], { allowNonZero: true })))
          yield* checkout(["config", "--local", variable, value]);
      }
      if ((yield* checkout(["rev-parse", "--verify", "HEAD"])) !== sha)
        return yield* failure("The workflow branch could not be pinned.");
      yield* git.git(["update-ref", "--no-deref", baselineRef, sha, zero]);
      return { branch, sha, treeSha, baseSha: run.baseSha };
    }).pipe(
      Effect.scoped,
      Effect.mapError(() =>
        failure("The workflow's Git baseline could not be verified or prepared."),
      ),
    ),
  );

export const readWorkflowVmFollowUpGitBaseline = Effect.fnUntraced(function* (
  context: Effect.Success<ReturnType<typeof open>>,
) {
  const { git, checkout, run } = context;
  const ref = yield* checkout(["symbolic-ref", "--quiet", "HEAD"]);
  const branch = ref.slice("refs/heads/".length);
  const launchpad = jobBranchName(run.jobId, LAUNCHPAD_JOB_BRANCH_PREFIX);
  const published = jobBranchName(run.jobId, run.jobBranchPrefix);
  if (!ref.startsWith("refs/heads/") || (branch !== launchpad && branch !== published))
    return yield* failure("Switch back to the workflow's branch before pushing.");
  const sha = (yield* git.git(["rev-parse", "--verify", baselineRef])).stdout.trim();
  if (!oid.test(sha)) return yield* failure("The workflow's Git baseline is missing.");
  const treeSha = (yield* git.git(["rev-parse", "--verify", `${sha}^{tree}`])).stdout.trim();
  return { branch, sha, treeSha, baseSha: run.baseSha };
});

type Checkout = Effect.Success<ReturnType<typeof open>>;
export const exportWorkflowVmFollowUpBundle = Effect.fnUntraced(function* (
  { checkout, runner, worktreePath }: Pick<Checkout, "checkout" | "runner" | "worktreePath">,
  sha: string,
  baseline: string,
  oldRemoteSha: string | null,
) {
  const from = oldRemoteSha ?? baseline;
  if (!oid.test(sha) || !oid.test(from) || sha === from)
    return yield* failure("Make a local commit before pushing the workflow branch.");
  const ancestor = yield* checkout(["merge-base", from, sha], { allowNonZero: true });
  if (ancestor !== from)
    return yield* failure("The commit must descend from the approved workflow result.");
  yield* checkout(["update-ref", "--no-deref", pushRef, sha]);
  const result = yield* runner.run({
    command: "/bin/bash",
    args: [
      "--noprofile",
      "--norc",
      "-o",
      "pipefail",
      "-c",
      '/usr/bin/git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false bundle create - "$1" "^$2" | /usr/bin/base64',
      "--",
      pushRef,
      from,
    ],
    cwd: worktreePath,
    env: workflowGitEnvironment,
    timeout: "45 seconds",
    maxOutputBytes: Math.ceil(WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES / 3) * 4 + 100_000,
    outputMode: "truncate",
  });
  if (result.stdoutTruncated)
    return yield* failure("The workflow commits exceed the 4 MiB push limit.");
  if (result.code !== 0 || result.timedOut || !result.stdout || result.stdoutInvalidUtf8)
    return yield* failure("The workflow commits could not be packaged.");
  const bundle = result.stdout.replaceAll(/\r?\n/gu, "");
  if (Buffer.from(bundle, "base64").byteLength > WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES)
    return yield* failure("The workflow commits exceed the 4 MiB push limit.");
  return bundle;
});

export const verifyWorkflowVmFollowUpBundle = Effect.fnUntraced(
  function* (
    {
      git,
      worktreePath,
      run,
    }: Pick<Checkout, "git" | "worktreePath"> & {
      readonly run: Pick<Checkout["run"], "baseSha">;
    },
    input: {
      readonly bundle: string;
      readonly sha: string;
      readonly baseline: string;
      readonly oldRemoteSha: string | null;
    },
  ) {
    const bytes = Buffer.from(input.bundle, "base64");
    if (
      !oid.test(input.sha) ||
      !oid.test(input.baseline) ||
      (input.oldRemoteSha !== null && !oid.test(input.oldRemoteSha)) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES ||
      bytes.toString("base64") !== input.bundle
    )
      return yield* failure("The retained workflow commits could not be verified.");
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "follow-up-push-" });
    const bundle = (yield* Path.Path).join(directory, "push.bundle");
    yield* fs.writeFile(bundle, bytes, { mode: 0o600 });
    const { stdout: refs } = yield* git.git(["bundle", "list-heads", bundle]);
    if (refs.trim() !== `${input.sha} ${pushRef}`)
      return yield* failure("The retained workflow commits do not match the requested commit.");
    yield* git.git(["bundle", "verify", bundle]);
    // Unbundle into the private Git repository. It neither reads a workload-controlled
    // Git config nor installs any ref from the transfer.
    yield* git.git(["-c", "transfer.fsckObjects=true", "bundle", "unbundle", bundle]);
    const from = input.oldRemoteSha ?? input.baseline;
    yield* git.git(["merge-base", "--is-ancestor", from, input.sha]);
    const range = `${input.baseline}..${input.sha}`;
    const { stdout: all } = yield* git.git(["rev-list", "--count", range]);
    const { stdout: approved } = yield* git.git(["rev-list", "--count", "--ancestry-path", range]);
    if (all.trim() !== approved.trim() || approved.trim() === "0")
      return yield* failure("The push includes commits outside this workflow's approved history.");
    const needsLfs = yield* workflowPushNeedsLfsUpload(git, {
      cwd: worktreePath,
      commitSha: input.sha,
      baseSha: run.baseSha,
      publishedSha: input.oldRemoteSha,
    });
    if (needsLfs) return yield* failure("Workflow VM pushes cannot upload new Git LFS objects.");
    yield* git.git(["update-ref", "--no-deref", preparedPushRef, input.sha]);
  },
  (effect) => Effect.scoped(effect),
);
