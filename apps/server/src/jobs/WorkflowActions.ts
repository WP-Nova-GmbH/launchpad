import { CheckpointRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { WorkflowRunStore, workflowRunOrigin } from "./WorkflowRunStore.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import type * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Schema from "effect/Schema";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitVcsDriver, isGitHubHttpsRemote, workflowGitEnvironment } from "../vcs/GitVcsDriver.ts";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { SetupProcessAdapter } from "../terminal/SetupProcessAdapter.ts";
import {
  CurrentWorkflowCommand,
  ProcessOwnershipError,
  ProcessRunner,
  layer as processRunnerLayer,
  type OwnedCommand,
} from "../processRunner.ts";
import type { WorkflowRun, WorkflowActionRecord } from "./WorkflowRunStore.ts";
import { jobBranchName } from "./Layers/JobRunner.ts";
import { workflowPushNeedsLfsUpload } from "./WorkflowPushLfs.ts";
import { WorkflowReviewGitDirectory } from "../vcs/WorkflowReviewGitDirectory.ts";
import {
  stopWorkflowPublishingWorkload,
  WorkflowPublishingWorkloads,
} from "../vmWorkloadCommand.ts";
import { workflowVmPublishingGit, type WorkflowVmPullRequest } from "./WorkflowVmPublishingGit.ts";

/** Publishing records a target, never credentials embedded in a remote URL. */
export function workflowPublishingRemote(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.password ||
      url.search ||
      url.hash ||
      ((url.protocol === "http:" || url.protocol === "https:") && url.username)
    )
      return null;
  } catch {
    // Git's scp-style SSH syntax is not a URL.
    if (raw.includes("://")) return null;
  }
  return raw;
}

export class WorkflowActionError extends Schema.TaggedError<WorkflowActionError>()(
  "WorkflowActionError",
  { message: Schema.String },
) {}
export interface WorkflowVmPublishingIO {
  readonly credential: (
    actionId: string,
    access: "read" | "push" | "open_pull_request",
  ) => Effect.Effect<
    {
      readonly token: Redacted.Redacted<string>;
      readonly bot: { readonly name: string; readonly email: string };
    },
    WorkflowActionError
  >;
  readonly retain: (
    actionId: string,
    commit: { readonly sha: string; readonly object: Uint8Array },
  ) => Effect.Effect<void, WorkflowActionError>;
  readonly recoverCommit: (
    actionId: string,
    sha: string,
  ) => Effect.Effect<Uint8Array | null, WorkflowActionError>;
  readonly arm: (
    actionId: string,
    command: WorkflowActionRecord["commands"][number],
  ) => Effect.Effect<void, WorkflowActionError>;
  readonly stop: (actionId: string, commandId: string) => Effect.Effect<void, WorkflowActionError>;
  readonly canCreatePull?: (actionId: string) => Effect.Effect<boolean, WorkflowActionError>;
  readonly recordPull?: (actionId: string, url: string) => Effect.Effect<void, WorkflowActionError>;
  readonly rejectPullAuthorization?: (
    actionId: string,
    commandId: string,
  ) => Effect.Effect<void, WorkflowActionError>;
  readonly settle: (
    actionId: string,
    outcome: { readonly commitSha: string; readonly pullRequestUrl: string | null },
  ) => Effect.Effect<void, WorkflowActionError>;
}

export interface WorkflowActionIO {
  readonly vmPublishing?: WorkflowVmPublishingIO;
  readonly read: Effect.Effect<WorkflowRun, WorkflowActionError>;
  readonly update: (
    change: (run: WorkflowRun) => WorkflowRun,
  ) => Effect.Effect<WorkflowRun, WorkflowActionError>;
}
export function workflowPublishingStopNeedsAcknowledgement(
  command: WorkflowActionRecord["commands"][number],
) {
  return command.identity !== null && command.relayStopAcknowledged !== true;
}
export const changeWorkflowAction = (
  run: WorkflowRun,
  id: string,
  update: (action: WorkflowActionRecord) => WorkflowActionRecord,
): WorkflowRun => ({
  ...run,
  actions: run.actions?.map((action) => (action.actionId === id ? update(action) : action)),
});
const error = (cause: unknown) =>
  new WorkflowActionError({
    message: cause instanceof Error ? cause.message : "Workflow publishing could not be confirmed.",
  });

export const readWorkflowTree = (git: GitVcsDriver["Service"], cwd: string, revision: string) =>
  git
    .execute({
      operation: "WorkflowCheckpoint.tree",
      cwd,
      args: [
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{tree}`,
      ],
      env: workflowGitEnvironment,
    })
    .pipe(Effect.map((result) => result.stdout.trim()));

/** Verify the job branch without reading worktree files or invoking clean filters. */
export const readWorkflowHead = Effect.fn("WorkflowCheckout.head")(function* (
  git: GitVcsDriver["Service"],
  cwd: string,
  branch: string,
) {
  const read = (args: ReadonlyArray<string>) =>
    git.execute({
      operation: "WorkflowCheckout.head",
      cwd,
      args: ["--no-replace-objects", ...args],
      allowNonZeroExit: true,
      env: workflowGitEnvironment,
    });
  const expectedRef = `refs/heads/${branch}`;
  const ref = yield* read(["symbolic-ref", "--quiet", "--no-recurse", "HEAD"]);
  if (ref.exitCode !== 0 || ref.stdout.trim() !== expectedRef) return null;
  const alias = yield* read(["symbolic-ref", "--quiet", "--no-recurse", expectedRef]);
  if (alias.exitCode !== 1) return null;
  const head = yield* read(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  return head.exitCode === 0 ? head.stdout.trim() || null : null;
});

export class WorkflowActions extends Context.Reference<{
  readonly available: Effect.Effect<boolean>;
  readonly vmAvailable?: Effect.Effect<boolean>;
  readonly canOpenPullRequest?: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly remoteUrl: string;
  }) => Effect.Effect<boolean>;
  readonly execute: (id: string, io: WorkflowActionIO) => Effect.Effect<void, WorkflowActionError>;
  readonly recover: (io: WorkflowActionIO) => Effect.Effect<boolean, WorkflowActionError>;
}>("t3/jobs/WorkflowActions", {
  defaultValue: () => ({
    available: Effect.succeed(false),
    execute: () =>
      Effect.fail(
        new WorkflowActionError({
          message: "Update this environment to support publishing steps.",
        }),
      ),
    recover: (io) =>
      io.read.pipe(
        Effect.map(
          (run) =>
            !(
              run.actions?.some((action) => action.commands.some((command) => !command.stopped)) ??
              false
            ),
        ),
      ),
  }),
}) {}

export const make = Effect.gen(function* () {
  const native = yield* SetupProcessAdapter;
  const processRunner = Option.getOrUndefined(yield* Effect.serviceOption(ProcessRunner));
  const git = yield* GitVcsDriver;
  const manager = yield* GitManager;
  const checkpoints = yield* CheckpointStore;
  const workflowRuns = yield* WorkflowRunStore;
  const access = yield* RepositoryAccess;
  const crypto = yield* Crypto.Crypto;
  const providers = yield* Effect.serviceOption(SourceControlProviderRegistry);
  const fs = yield* FileSystem.FileSystem;
  const prProvider = (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly remoteUrl: string;
  }) =>
    Effect.gen(function* () {
      const provider = detectSourceControlProviderFromRemoteUrl(input.remoteUrl);
      const repository = normalizeGitRemoteUrl(input.remoteUrl);
      if (Option.isNone(providers) || !provider || !repository)
        return yield* new WorkflowActionError({
          message: "This repository does not support workflow PR publishing.",
        });
      const handle = yield* providers.value
        .resolveHandle({
          cwd: input.cwd,
          context: {
            provider,
            repository,
            remoteName: input.remoteName,
            remoteUrl: input.remoteUrl,
          },
        })
        .pipe(Effect.mapError(error));
      if (!handle.provider.workflowPublishingTargeted || !handle.provider.getChangeRequestDetails)
        return yield* new WorkflowActionError({
          message: "This forge does not support explicit workflow PR targeting and recovery.",
        });
      return handle.provider;
    });
  const launcher =
    native.commandLauncher?.pipe(Effect.mapError(error)) ??
    Effect.fail(new WorkflowActionError({ message: "Owned commands are unavailable." }));
  const get = (run: WorkflowRun, id: string) =>
    run.actions?.find((action) => action.actionId === id);
  const requireRun = Effect.fn("WorkflowActions.requireRun")(function* (io: WorkflowActionIO) {
    const run = yield* io.read;
    if (run.progress.status === "cancelling" || run.manualPause?.state === "paused")
      return yield* new WorkflowActionError({
        message: "Publishing stopped before the next command.",
      });
    if (run.runtime.kind === "vm") {
      if (!io.vmPublishing || !(yield* workflowRuns.isVmFenceActive(run.runtime)))
        return yield* new WorkflowActionError({ message: "This workflow no longer owns its VM." });
    } else {
      yield* (
        workflowRunOrigin(run).kind === "automation"
          ? access.requireWorkflowProject({
              organizationId: run.workflow.organizationId,
              repositoryId: run.workflow.repositoryId,
              projectId: run.runtime.projectId,
              repositoryCanonicalKey: run.repositoryCanonicalKey,
            })
          : access.requireProject(
              { user: { userId: run.userId!, displayName: null, imageUrl: null } },
              run.runtime.projectId,
            )
      ).pipe(Effect.mapError(error));
    }
    if (
      !run.worktreePath ||
      !run.publication ||
      !workflowPublishingRemote(run.publication.remoteUrl) ||
      normalizeGitRemoteUrl(run.publication.remoteUrl) !== run.repositoryCanonicalKey
    )
      return yield* new WorkflowActionError({
        message: "The publishing repository binding is unavailable.",
      });
    return run;
  });
  const edit = (
    io: WorkflowActionIO,
    id: string,
    update: (action: WorkflowActionRecord) => WorkflowActionRecord,
  ) => io.update((run) => changeWorkflowAction(run, id, update));
  const editCommand = (
    io: WorkflowActionIO,
    actionId: string,
    commandId: string,
    update: (
      command: WorkflowActionRecord["commands"][number],
    ) => WorkflowActionRecord["commands"][number],
  ) =>
    edit(io, actionId, (action) => ({
      ...action,
      commands: action.commands.map((command) =>
        command.id === commandId ? update(command) : command,
      ),
    }));
  const acknowledgeStop = (
    io: WorkflowActionIO,
    vm: WorkflowVmPublishingIO,
    actionId: string,
    commandId: string,
  ) =>
    vm.stop(actionId, commandId).pipe(
      Effect.andThen(
        editCommand(io, actionId, commandId, (command) => ({
          ...command,
          relayStopAcknowledged: true,
        })),
      ),
    );
  const commandFactory = (
    id: string,
    io: WorkflowActionIO,
    phase: "prepare" | "commit" | "push" | "pull_request",
  ) =>
    Effect.gen(function* () {
      const run = yield* requireRun(io);
      const vm = run.runtime.kind === "vm" ? io.vmPublishing : undefined;
      if (
        vm &&
        run.actions?.some((action) =>
          action.commands.some(
            (command) =>
              !command.stopped && (command.phase === "prepare" || command.phase === "commit"),
          ),
        )
      )
        return yield* new WorkflowActionError({
          message: "Stop the previous publishing workload before writing to GitHub.",
        });
      const owner = vm ? native.vmPublishing : native;
      if (!owner?.commandLauncher)
        return yield* new WorkflowActionError({ message: "Owned commands are unavailable." });
      const executable = yield* owner.commandLauncher.pipe(Effect.mapError(error));
      const commandId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(error));
      const boot = yield* owner.host.pipe(Effect.mapError(error));
      yield* edit(io, id, (action) => ({
        ...action,
        commands: [
          ...action.commands,
          { id: commandId, phase, pid: null, identity: null, boot, stopped: false, code: null },
        ],
      }));
      let pid: number | null = null;
      let identity: string | null = null;
      let stopped = false;
      const patch = (
        update: (
          command: WorkflowActionRecord["commands"][number],
        ) => WorkflowActionRecord["commands"][number],
      ) => editCommand(io, id, commandId, update);
      const ownError = (cause: unknown) =>
        new ProcessOwnershipError({
          command: "workflow",
          argumentCount: 0,
          cwd: run.worktreePath!,
          cause,
        });
      return {
        executable,
        capture: (actualPid) =>
          Effect.gen(function* () {
            pid = actualPid;
            const state = yield* owner.inspect(actualPid);
            if (!state.owned || !state.identity)
              return yield* new WorkflowActionError({
                message: "The command owner could not be captured.",
              });
            identity = state.identity;
            yield* patch((command) => ({ ...command, pid: actualPid, identity, boot: state.boot }));
          }).pipe(Effect.mapError(ownError)),
        arm: access
          .withFence(
            Effect.gen(function* () {
              yield* requireRun(io);
              if (pid === null || identity === null)
                return yield* new WorkflowActionError({
                  message: "Command capture is required before delivery.",
                });
              if (vm) {
                const command = get(yield* io.read, id)?.commands.find(
                  (entry) => entry.id === commandId,
                );
                if (!command || command.pid !== pid || command.identity !== identity)
                  return yield* new WorkflowActionError({
                    message: "The publishing command changed.",
                  });
                yield* vm.arm(id, command);
              }
              yield* owner.arm(pid, identity);
            }),
          )
          .pipe(Effect.mapError(ownError)),
        completed: (code) =>
          patch((command) => ({ ...command, code })).pipe(Effect.asVoid, Effect.mapError(ownError)),
        stop: Effect.gen(function* () {
          const command = get(yield* io.read, id)?.commands.find((entry) => entry.id === commandId);
          if (!stopped && !command?.stopped) {
            if (pid !== null && identity !== null) yield* owner.stop(pid, identity);
            else if (pid !== null) {
              // No arm is permitted until capture was saved; this owner cannot have delivered work.
              const captured = yield* owner.inspect(pid);
              if (captured.owned && captured.identity) yield* owner.stop(pid, captured.identity);
            }
            yield* patch((command) => ({ ...command, stopped: true }));
            stopped = true;
          }
          if (vm && command && workflowPublishingStopNeedsAcknowledgement(command))
            yield* acknowledgeStop(io, vm, id, commandId);
        }).pipe(Effect.mapError(ownError)),
      } satisfies OwnedCommand;
    }).pipe(
      Effect.mapError(
        (cause) => new ProcessOwnershipError({ command: "workflow", argumentCount: 0, cause }),
      ),
    );
  const owned = <A, E>(
    id: string,
    io: WorkflowActionIO,
    effect: Effect.Effect<A, E>,
    phase: "prepare" | "commit" | "push" | "pull_request" = "prepare",
  ) =>
    effect.pipe(
      Effect.provideService(CurrentWorkflowCommand, commandFactory(id, io, phase)),
      Effect.mapError(error),
    );

  const vmWorkloadTracking = (
    id: string,
    io: WorkflowActionIO,
    bootEvidence: SetupProcessAdapter["Service"]["host"],
  ): NonNullable<typeof WorkflowPublishingWorkloads.Service> => {
    const trackingFailure = () =>
      PlatformError.badArgument({
        module: "WorkflowPublishing",
        method: "track",
        description: "The VM publishing workload ownership is unconfirmed.",
      });
    return {
      register: (workloadId) =>
        Effect.gen(function* () {
          const current = yield* requireRun(io);
          const boot = yield* bootEvidence;
          if (!boot || get(current, id)?.state !== "running") return yield* trackingFailure();
          const saved = yield* io.update((run) =>
            run.progress.status === "cancelling" ||
            run.manualPause?.state === "paused" ||
            get(run, id)?.state !== "running"
              ? run
              : changeWorkflowAction(run, id, (action) => ({
                  ...action,
                  commands: [
                    ...action.commands,
                    {
                      id: workloadId,
                      phase: action.phase === "commit" ? "commit" : "prepare",
                      pid: null,
                      identity: null,
                      boot,
                      stopped: false,
                      code: null,
                    },
                  ],
                })),
          );
          if (!get(saved, id)?.commands.some((command) => command.id === workloadId))
            return yield* trackingFailure();
        }).pipe(Effect.mapError(trackingFailure)),
      complete: (workloadId) =>
        edit(io, id, (action) => ({
          ...action,
          commands: action.commands.filter((command) => command.id !== workloadId),
        })).pipe(Effect.asVoid, Effect.mapError(trackingFailure)),
    };
  };

  const recover = Effect.fn("WorkflowActions.recover")(function* (io: WorkflowActionIO) {
    const run = yield* io.read;
    const vm = run.runtime.kind === "vm" ? io.vmPublishing : undefined;
    const owner = run.runtime.kind === "vm" ? native.vmPublishing : native;
    for (const action of run.actions ?? [])
      for (const command of action.commands) {
        if (command.stopped) {
          if (run.runtime.kind === "vm" && workflowPublishingStopNeedsAcknowledgement(command)) {
            if (!vm) return false;
            yield* acknowledgeStop(io, vm, action.actionId, command.id);
          }
          continue;
        }
        if (!owner || (run.runtime.kind === "vm" && !vm)) return false;
        if (vm && (command.phase === "prepare" || command.phase === "commit")) {
          const boot = yield* owner.host.pipe(Effect.mapError(error));
          if (
            !boot ||
            !command.boot ||
            boot.host !== command.boot.host ||
            boot.session !== command.boot.session
          )
            return false;
          const stopped = yield* stopWorkflowPublishingWorkload(command.id).pipe(Effect.result);
          if (stopped._tag === "Failure") return false;
          yield* edit(io, action.actionId, (entry) => ({
            ...entry,
            commands: entry.commands.filter((entry) => entry.id !== command.id),
          }));
          continue;
        } else if (command.pid !== null && command.identity !== null) {
          const stopped = yield* owner.stop(command.pid, command.identity).pipe(Effect.result);
          if (stopped._tag === "Failure") {
            if (vm) return false;
            const boot = yield* owner.host.pipe(Effect.mapError(error));
            if (
              !boot ||
              !command.boot ||
              boot.host !== command.boot.host ||
              boot.session === command.boot.session
            )
              return false;
          }
        }
        yield* editCommand(io, action.actionId, command.id, (value) => ({
          ...value,
          stopped: true,
        }));
        if (vm && workflowPublishingStopNeedsAcknowledgement(command))
          yield* acknowledgeStop(io, vm, action.actionId, command.id);
      }
    return true;
  });
  const execute = Effect.fn("WorkflowActions.execute")(
    function* (id: string, io: WorkflowActionIO) {
      if (!(yield* recover(io)))
        return yield* new WorkflowActionError({
          message:
            "Publishing cleanup is unconfirmed. The job stays blocked until stopping can be proven; restarting Launchpad alone is insufficient.",
        });
      let run = yield* requireRun(io);
      let action = get(run, id);
      if (!action)
        return yield* new WorkflowActionError({ message: "The publishing action changed." });
      const cwd = run.worktreePath!;
      const { remoteName, remoteUrl } = run.publication!;
      const branch = jobBranchName(run.jobId, run.jobBranchPrefix);
      const vm = run.runtime.kind === "vm" ? io.vmPublishing : undefined;
      const github = !vm && isGitHubHttpsRemote(remoteUrl);
      const verifyCommand = <A, E>(effect: Effect.Effect<A, E>) =>
        vm ? effect.pipe(Effect.mapError(error)) : owned(id, io, effect);
      const executeGit = (
        args: ReadonlyArray<string>,
        options?: { readonly allowNonZeroExit?: boolean; readonly env?: NodeJS.ProcessEnv },
      ) =>
        Effect.gen(function* () {
          const pushing = args[0] === "push";
          const githubTransfer = github && (args[0] === "ls-remote" || pushing);
          if (githubTransfer && pushing) {
            const destination = yield* git
              .execute({
                operation: "WorkflowActions.verifyRemote",
                cwd,
                args: ["remote", "get-url", "--push", "--all", "--", remoteName],
              })
              .pipe(Effect.mapError(error));
            if (
              destination.stdoutTruncated ||
              destination.stdout.replace(/\r?\n$/, "") !== remoteUrl
            ) {
              return yield* new WorkflowActionError({
                message: "The Git remote no longer resolves to the reviewed repository.",
              });
            }
          }
          return yield* git
            .execute({
              operation: "WorkflowActions",
              cwd,
              args,
              ...(githubTransfer ? { githubRemoteUrl: remoteUrl } : {}),
              ...options,
            })
            .pipe(Effect.mapError(error));
        });
      const text = (args: ReadonlyArray<string>) =>
        executeGit(args).pipe(Effect.map((result) => result.stdout.trim()));
      const originalHistory = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
        executeGit(["--no-replace-objects", ...args], {
          allowNonZeroExit,
          env: workflowGitEnvironment,
        });
      const readCommitField = (revision: string, format: "%P" | "%B") =>
        originalHistory(["show", "-s", "--no-show-signature", `--format=${format}`, revision]).pipe(
          Effect.map((result) => result.stdout.trim()),
        );
      const readTree = (revision: string) =>
        readWorkflowTree(git, cwd, revision).pipe(Effect.mapError(error));
      const readHead = () => readWorkflowHead(git, cwd, branch).pipe(Effect.mapError(error));
      const verify = Effect.fn("WorkflowActions.verify")(function* () {
        run = yield* requireRun(io);
        action = get(run, id)!;
        let workflowIgnoreRules: Uint8Array | undefined;
        if (run.runtime.kind === "vm") {
          const pin = action.checkpointTurnId
            ? yield* workflowRuns.getCheckpointPinForRun(
                run.runtime,
                action.checkpointTurnId,
                action.checkpointRef,
              )
            : null;
          if (
            !pin ||
            pin.treeId !== action.tree ||
            (yield* checkpoints
              .resolvePinnedTree({ cwd, checkpointRef: CheckpointRef.make(pin.commitId) })
              .pipe(Effect.orElseSucceed(() => null))) !== pin.treeId
          )
            return yield* new WorkflowActionError({
              message:
                "The saved workflow VM result is unavailable. Cancel the job and run it again.",
            });
          const ignoreRules = yield* workflowRuns.getWorkflowIgnoreRules(run.runtime);
          if (ignoreRules === null)
            return yield* new WorkflowActionError({
              message: "The saved workflow Git ignore rules are unavailable. Start a new job.",
            });
          workflowIgnoreRules = ignoreRules;
        }
        const head = yield* readHead();
        if (head === null)
          return yield* new WorkflowActionError({ message: "The prepared job branch changed." });
        const verificationRef = CheckpointRef.make(`refs/t3/workflow-publishing/${run.jobId}`);
        const { treeId: currentTree } = yield* verifyCommand(
          checkpoints.captureCheckpoint({
            cwd,
            checkpointRef: verificationRef,
            strictWorkflowCapture: run.runtime.kind === "vm",
            ...(workflowIgnoreRules === undefined ? {} : { workflowIgnoreRules }),
          }),
        ).pipe(
          Effect.tap(() =>
            verifyCommand(
              checkpoints.deleteCheckpointRefs({
                cwd,
                checkpointRefs: [verificationRef],
                pinned: run.runtime.kind === "vm",
              }),
            ),
          ),
        );
        if ((yield* readHead()) !== head)
          return yield* new WorkflowActionError({ message: "The prepared job branch changed." });
        if (currentTree !== action.tree)
          return yield* new WorkflowActionError({
            message:
              "Prepared files changed after the saved result. Cancel this job before running again.",
          });
        return head;
      });
      if (vm) {
        const bootEvidence = yield* Effect.cached(
          native.vmPublishing?.host ?? Effect.succeed(null),
        );
        return yield* Effect.gen(function* () {
          const directory = yield* WorkflowReviewGitDirectory;
          const canonicalKey = run.repositoryCanonicalKey;
          if (
            !processRunner ||
            !directory ||
            !native.vmPublishing ||
            !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/iu.test(canonicalKey) ||
            [".", ".."].includes(canonicalKey.split("/")[2] ?? "") ||
            remoteUrl !== `https://${canonicalKey}.git`
          )
            return yield* new WorkflowActionError({
              message: "Protected GitHub publishing is unavailable.",
            });
          const repository = canonicalKey.slice("github.com/".length);
          const protectedGit = workflowVmPublishingGit(processRunner, directory, repository);
          const ref = `refs/heads/${branch}`;
          const readToken = yield* vm.credential(id, "read");
          const verifiedHead = yield* verify();
          action = get(run, id)!;
          const protectedText = (args: ReadonlyArray<string>) =>
            protectedGit.git(args).pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.mapError(error),
            );
          const checkoutGit = (
            args: ReadonlyArray<string>,
            options: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
          ) =>
            git
              .execute({
                operation: "WorkflowActions.checkoutGit",
                cwd,
                args: ["--no-replace-objects", ...args],
                env: { ...workflowGitEnvironment, ...options.env },
                ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new WorkflowActionError({
                      message:
                        "Git could not prepare the saved workflow result. Check the VM's commit hooks and retry.",
                    }),
                ),
                Effect.map((result) => result.stdout.trim()),
              );
          const expectedIdentity = [
            readToken.bot.name,
            readToken.bot.email,
            readToken.bot.name,
            readToken.bot.email,
          ].join("\0");
          const approvedObject = Effect.fnUntraced(function* (
            push: WorkflowActionRecord,
            sha: string,
          ) {
            if (!/^[a-f0-9]{40}$/u.test(sha))
              return yield* new WorkflowActionError({
                message: "The workflow commit ID is invalid.",
              });
            let object: Uint8Array | null = yield* protectedGit
              .commitObject(sha)
              .pipe(Effect.mapError(error));
            if (!object) object = yield* vm.recoverCommit(push.actionId, sha);
            if (!object)
              return yield* new WorkflowActionError({
                message: "The saved publishing commit is unavailable.",
              });
            const raw = yield* protectedGit.restoreObject(sha, object).pipe(Effect.mapError(error));
            const transferParent = push.oldRemoteSha ?? run.baseSha;
            const tree = yield* protectedText([
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${sha}^{tree}`,
            ]);
            const parents = yield* protectedText([
              "show",
              "-s",
              "--no-show-signature",
              "--format=%P",
              sha,
            ]);
            if (
              !transferParent ||
              tree !== push.tree ||
              (sha !== push.oldRemoteSha && parents !== transferParent)
            )
              return yield* new WorkflowActionError({
                message: "The saved publishing commit differs from the approved result.",
              });
            return { object, raw };
          });
          const stagingTree = Effect.fnUntraced(function* (expectedTree: string) {
            yield* checkoutGit(["add", "-A", "--", "."]);
            if ((yield* checkoutGit(["write-tree"])) !== expectedTree)
              return yield* new WorkflowActionError({
                message: "The staged files do not match the saved result.",
              });
          });
          const hookHeadMatches = Effect.fnUntraced(function* (
            push: WorkflowActionRecord,
            head: string,
            requireMessage = true,
          ) {
            return (
              (yield* readCommitField(head, "%P")) === push.parent &&
              (yield* readTree(head)) === push.tree &&
              (yield* checkoutGit([
                "show",
                "-s",
                "--no-show-signature",
                "--format=%an%x00%ae%x00%cn%x00%ce",
                head,
              ])) === expectedIdentity &&
              (!requireMessage ||
                (yield* readCommitField(head, "%B")) === push.commitMessage?.trim())
            );
          });
          const catchUp = Effect.fnUntraced(function* (
            push: WorkflowActionRecord,
            sha: string,
            raw: string,
          ) {
            const localHead = yield* readHead();
            if (
              !localHead ||
              (localHead !== sha &&
                localHead !== push.parent &&
                !(yield* hookHeadMatches(push, localHead)))
            )
              return yield* new WorkflowActionError({
                message: "The VM branch no longer matches this saved result.",
              });
            if (localHead !== sha) {
              // Stage the verified checkout again so its Git object store has the saved tree.
              // No worktree files are overwritten. The exact branch ref update is compare-and-swap.
              yield* stagingTree(push.tree);
              const stored = yield* checkoutGit(
                ["hash-object", "-w", "-t", "commit", "--stdin", "--"],
                { stdin: raw },
              );
              if (stored !== sha)
                return yield* new WorkflowActionError({
                  message: "The restored publishing commit differs from GitHub.",
                });
              yield* checkoutGit(["-c", "core.hooksPath=/dev/null", "read-tree", sha]);
              yield* checkoutGit([
                "-c",
                "core.hooksPath=/dev/null",
                "update-ref",
                "--no-deref",
                ref,
                sha,
                localHead,
              ]);
            }
            if ((yield* verify()) !== sha)
              return yield* new WorkflowActionError({
                message: "The VM checkout could not be updated to the published result.",
              });
          });
          const remoteHead = () =>
            protectedGit.remoteHead(readToken.token, ref).pipe(Effect.mapError(error));
          if (action.operation === "push") {
            const head = verifiedHead;
            const { oldRemoteSha, checkpointTurnId, checkpointRef, tree } = action;
            const parent = oldRemoteSha ?? run.baseSha;
            if (!parent || !/^[a-f0-9]{40}$/u.test(parent))
              return yield* new WorkflowActionError({
                message: "The publishing parent is unavailable.",
              });
            const previousResultPush =
              oldRemoteSha &&
              checkpointTurnId &&
              (action.commitSha === null || action.commitSha === parent)
                ? run.actions?.find(
                    (entry) =>
                      entry.operation === "push" &&
                      entry.state === "completed" &&
                      entry.commitSha === parent &&
                      entry.checkpointTurnId === checkpointTurnId &&
                      entry.checkpointRef === checkpointRef &&
                      entry.tree === tree,
                  )
                : undefined;
            let sha = action.commitSha;
            if (!sha) {
              if (
                previousResultPush ||
                action.tree ===
                  (yield* protectedText([
                    "rev-parse",
                    "--verify",
                    "--end-of-options",
                    `${parent}^{tree}`,
                  ]))
              ) {
                if (!action.oldRemoteSha)
                  return yield* new WorkflowActionError({ message: "No changes to publish." });
                sha = parent;
              } else {
                if (!action.commitMessage) {
                  if (head !== action.parent)
                    return yield* new WorkflowActionError({
                      message: "The prepared job branch changed.",
                    });
                  const suggestion = yield* (
                    manager.prepareWorkflowCommit?.({ cwd, threadId: run.progress.threadId }) ??
                    Effect.succeed(null)
                  ).pipe(Effect.orElseSucceed(() => null));
                  const message = suggestion
                    ? [suggestion.subject, suggestion.body].filter(Boolean).join("\n\n")
                    : `Update ${run.workflow.definition.name.replace(/\s+/gu, " ").trim().slice(0, 120)}`;
                  run = yield* edit(io, id, (entry) => ({
                    ...entry,
                    commitMessage: message,
                    phase: "commit",
                  }));
                  action = get(run, id)!;
                }
                yield* requireRun(io);
                let checkedHead = yield* readHead();
                if (!checkedHead)
                  return yield* new WorkflowActionError({
                    message: "The prepared job branch changed.",
                  });
                const ranHooks = checkedHead === action.parent;
                if (ranHooks) {
                  yield* stagingTree(action.tree);
                  yield* checkoutGit(
                    [
                      "-c",
                      "commit.gpgsign=false",
                      "commit",
                      "--allow-empty",
                      "--cleanup=verbatim",
                      "-m",
                      action.commitMessage!,
                    ],
                    {
                      env: {
                        GIT_AUTHOR_NAME: readToken.bot.name,
                        GIT_AUTHOR_EMAIL: readToken.bot.email,
                        GIT_COMMITTER_NAME: readToken.bot.name,
                        GIT_COMMITTER_EMAIL: readToken.bot.email,
                      },
                    },
                  );
                  checkedHead = yield* verify();
                }
                if (!(yield* hookHeadMatches(action, checkedHead, !ranHooks)))
                  return yield* new WorkflowActionError({
                    message:
                      "Commit hooks changed the saved result, commit parent or bot identity.",
                  });
                const message = yield* readCommitField(checkedHead, "%B");
                if (message !== action.commitMessage) {
                  run = yield* edit(io, id, (entry) => ({ ...entry, commitMessage: message }));
                  action = get(run, id)!;
                }
                // Local Agent commits can contain intermediate contents that were never saved for review.
                // Publish the reviewed tree as one runner commit on the pinned publishing history.
                const [authorDate, committerDate] = (yield* checkoutGit([
                  "show",
                  "-s",
                  "--no-show-signature",
                  "--format=%aI%x00%cI",
                  checkedHead,
                ])).split("\0");
                if (!authorDate || !committerDate)
                  return yield* new WorkflowActionError({
                    message: "Git did not report a stable commit date.",
                  });
                const commit = yield* protectedGit
                  .git(["commit-tree", action.tree, "-p", parent, "--no-gpg-sign", "-F", "-"], {
                    stdin: message + "\n",
                    identity: {
                      ...readToken.bot,
                      dates: [authorDate, committerDate],
                    },
                  })
                  .pipe(Effect.mapError(error));
                sha = commit.stdout.trim();
              }
              run = yield* edit(io, id, (entry) => ({ ...entry, commitSha: sha, phase: "push" }));
              action = get(run, id)!;
            }
            if (!sha)
              return yield* new WorkflowActionError({
                message: "The publishing commit is unavailable.",
              });
            const sourcePush = previousResultPush ?? action;
            const { object, raw } = yield* approvedObject(sourcePush, sha);
            yield* vm.retain(id, { sha, object });
            const observed = yield* remoteHead();
            if (observed !== sha) {
              if (observed !== action.oldRemoteSha || sha === parent)
                return yield* new WorkflowActionError({
                  message: "The remote job branch changed; no update was attempted.",
                });
              if (
                yield* workflowPushNeedsLfsUpload(protectedGit, {
                  cwd: directory,
                  commitSha: sha,
                  baseSha: run.baseSha!,
                  publishedSha: observed,
                }).pipe(Effect.mapError(error))
              )
                return yield* new WorkflowActionError({
                  message:
                    "This change requires a Git LFS upload, which workflow Push does not support.",
                });
              const { token } = yield* vm.credential(id, "push");
              yield* owned(id, io, protectedGit.push(token, ref, observed, sha), "push");
              if ((yield* remoteHead()) !== sha)
                return yield* new WorkflowActionError({
                  message: "The published commit could not be confirmed.",
                });
            }
            yield* catchUp(sourcePush, sha, raw);
            yield* vm.settle(id, { commitSha: sha, pullRequestUrl: null });
            yield* io.update((current) => ({
              ...changeWorkflowAction(current, id, (entry) => ({
                ...entry,
                state: "completed",
                phase: "done",
                detail: null,
              })),
              preparedHead: sha,
              publication: { ...current.publication!, publishedHead: sha },
            }));
            return;
          }
          const head = run.publication!.publishedHead;
          const tree = action.tree;
          const pushed = run.actions?.findLast(
            (entry) =>
              entry.operation === "push" && entry.commitSha === head && entry.tree === tree,
          );
          if (!head || !pushed || (yield* remoteHead()) !== head)
            return yield* new WorkflowActionError({
              message: "Push the current saved result before opening its PR.",
            });
          const { raw } = yield* approvedObject(pushed, head);
          yield* catchUp(pushed, head, raw);
          const marker = `<!-- launchpad-workflow-job:${run.jobId} -->`;
          const pullNumber = (url: string) => {
            const match =
              /^https:\/\/github\.com\/([a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u.exec(
                url,
              );
            if (!match || match[1]?.toLowerCase() !== repository.toLowerCase()) return null;
            const number = Number(match[2]);
            return Number.isSafeInteger(number) ? number : null;
          };
          const checkedPull = (pr: WorkflowVmPullRequest) =>
            pullNumber(pr.html_url) === pr.number &&
            pr.base.ref === run.baseBranch &&
            pr.head.ref === branch &&
            pr.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
            pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase();
          const lookup = Effect.fnUntraced(function* () {
            const known = (yield* io.read).publication?.pullRequestUrl;
            if (known) {
              const number = pullNumber(known);
              if (number !== null) {
                const pr = yield* protectedGit
                  .getPull(readToken.token, number)
                  .pipe(Effect.mapError(error));
                if (pr.number === number && checkedPull(pr)) return pr;
              }
              return yield* new WorkflowActionError({
                message: "The recorded PR no longer matches this job.",
              });
            }
            const candidates = yield* protectedGit
              .listPulls(readToken.token, branch)
              .pipe(Effect.mapError(error));
            if (
              candidates.length > 1 ||
              candidates.some((pr) => !checkedPull(pr) || !pr.body?.includes(marker))
            )
              return yield* new WorkflowActionError({
                message: "Existing pull requests for this branch need attention before retrying.",
              });
            return candidates[0] ?? null;
          });
          let pull = yield* lookup();
          if (!pull) {
            const mayCreate = vm.canCreatePull
              ? yield* vm.canCreatePull(id)
              : !action.commands.some(
                  (entry) => entry.phase === "pull_request" && entry.pid !== null,
                );
            if (!mayCreate)
              return yield* new WorkflowActionError({
                message: "PR creation is unresolved. Retry will only look for the existing PR.",
              });
            if (!action.prTitle || !action.prBody) {
              const proposal = yield* (
                manager.prepareWorkflowPullRequest?.({
                  cwd,
                  threadId: run.progress.threadId,
                  baseBranch: run.baseBranch,
                  baseRef: run.baseSha!,
                  headBranch: branch,
                }) ?? Effect.succeed(null)
              ).pipe(Effect.orElseSucceed(() => null));
              run = yield* edit(io, id, (entry) => ({
                ...entry,
                prTitle: proposal?.title ?? run.workflow.definition.name.slice(0, 120),
                prBody: `${proposal?.body ?? "Changes from a Launchpad workflow."}\n\n${marker}`,
              }));
              action = get(run, id)!;
            }
            if ((yield* verify()) !== head || (yield* remoteHead()) !== head)
              return yield* new WorkflowActionError({
                message: "The published branch changed before Open PR.",
              });
            yield* edit(io, id, (entry) => ({ ...entry, phase: "pull_request", commitSha: head }));
            const body = {
              base: run.baseBranch,
              head: branch,
              title: action.prTitle!,
              body: action.prBody!,
            };
            const createPull = Effect.fnUntraced(function* () {
              const { token } = yield* vm.credential(id, "open_pull_request");
              const receipt = yield* owned(
                id,
                io,
                protectedGit
                  .openPull(token, body)
                  .pipe(
                    Effect.catchTag("WorkflowVmGitError", (failure) =>
                      failure.status === 401 ? Effect.succeed(null) : Effect.fail(failure),
                    ),
                  ),
                "pull_request",
              );
              if (receipt) return receipt;
              const command = get(yield* io.read, id)?.commands.at(-1);
              if (
                !command?.stopped ||
                command.phase !== "pull_request" ||
                !command.identity ||
                command.code !== 0 ||
                !vm.rejectPullAuthorization
              )
                return yield* new WorkflowActionError({
                  message: "GitHub rejected the publishing credential.",
                });
              yield* vm.rejectPullAuthorization(id, command.id);
              return null;
            });
            let created = yield* createPull();
            if (!created) {
              if ((yield* remoteHead()) !== head)
                return yield* new WorkflowActionError({
                  message: "The published branch changed before Open PR.",
                });
              created = yield* createPull();
            }
            if (!created)
              return yield* new WorkflowActionError({
                message: "GitHub rejected the publishing credential. Retry to use a fresh one.",
              });
            if (!checkedPull(created))
              return yield* new WorkflowActionError({
                message: "The created PR belongs to a different repository, base, or branch.",
              });
            yield* io.update((current) => ({
              ...changeWorkflowAction(current, id, (entry) => ({
                ...entry,
                pullRequestUrl: created.html_url,
              })),
              publication: { ...current.publication!, pullRequestUrl: created.html_url },
            }));
            if (vm.recordPull) yield* vm.recordPull(id, created.html_url);
            pull = yield* lookup();
          }
          if (!pull)
            return yield* new WorkflowActionError({
              message: "GitHub could not confirm the workflow PR.",
            });
          const url = pull.html_url;
          yield* io.update((current) => ({
            ...changeWorkflowAction(current, id, (entry) => ({
              ...entry,
              pullRequestUrl: url,
              commitSha: head,
            })),
            publication: { ...current.publication!, pullRequestUrl: url },
          }));
          if (vm.recordPull) yield* vm.recordPull(id, url);
          if (pull.state !== "open")
            return yield* new WorkflowActionError({
              message: `The job's PR is ${pull.merged_at ? "merged" : "closed"}; no replacement was created.`,
            });
          if (pull.head.sha !== head || (yield* remoteHead()) !== head)
            return yield* new WorkflowActionError({
              message:
                "The pull request head changed after Push. Verify the GitHub branch before retrying.",
            });
          yield* vm.settle(id, { commitSha: head, pullRequestUrl: url });
          yield* io.update((current) => ({
            ...changeWorkflowAction(current, id, (entry) => ({
              ...entry,
              state: "completed",
              phase: "done",
              detail: null,
            })),
            preparedHead: head,
          }));
        }).pipe(
          Effect.provideService(
            WorkflowPublishingWorkloads,
            vmWorkloadTracking(id, io, bootEvidence),
          ),
        );
      }
      const verifiedHead = yield* verify();
      if (action.operation === "open_pull_request") {
        const publication = run.publication!;
        const head = run.preparedHead;
        if (
          !head ||
          publication.publishedHead !== head ||
          verifiedHead !== head ||
          (yield* readTree(head)) !== action.tree
        )
          return yield* new WorkflowActionError({
            message: "Push the current saved result before opening its PR.",
          });
        const observed = yield* text([
          "ls-remote",
          "--refs",
          "--",
          remoteUrl,
          `refs/heads/${branch}`,
        ]);
        if (observed.split(/\s/)[0] !== head)
          return yield* new WorkflowActionError({ message: "The published job branch changed." });
        const provider = yield* prProvider({ cwd, ...publication });
        const marker = `<!-- launchpad-workflow-job:${run.jobId} -->`;
        const matches = (request: import("@t3tools/contracts").ChangeRequest) => {
          try {
            const url = new URL(request.url);
            const [host, ...repository] = run.repositoryCanonicalKey.split("/");
            return (
              url.protocol === "https:" &&
              url.host.toLowerCase() === host &&
              url.pathname.toLowerCase() === `/${repository.join("/")}/pull/${request.number}` &&
              request.baseRefName === run.baseBranch &&
              request.headRefName === branch &&
              request.isCrossRepository !== true &&
              (!request.headRepositoryNameWithOwner ||
                request.headRepositoryNameWithOwner.toLowerCase() === repository.join("/"))
            );
          } catch {
            return false;
          }
        };
        const lookup = Effect.fn("WorkflowActions.lookupPR")(function* () {
          const latest = yield* io.read;
          const known = latest.publication?.pullRequestUrl;
          if (known) {
            const request = yield* provider
              .getChangeRequest({ cwd, reference: known })
              .pipe(Effect.mapError(error));
            if (!matches(request) || request.url !== known)
              return yield* new WorkflowActionError({
                message: "The recorded PR no longer matches this job.",
              });
            return request;
          }
          const candidates = yield* provider
            .listChangeRequests({ cwd, headSelector: branch, state: "all", limit: 20 })
            .pipe(Effect.mapError(error));
          if (candidates.length >= 20)
            return yield* new WorkflowActionError({
              message: "PR recovery exceeded its bounded search; no new PR was created.",
            });
          const marked: import("@t3tools/contracts").ChangeRequest[] = [];
          for (const candidate of candidates) {
            const detail = yield* provider.getChangeRequestDetails!({
              cwd,
              reference: String(candidate.number),
            }).pipe(Effect.mapError(error));
            if (!detail.complete)
              return yield* new WorkflowActionError({
                message: "PR recovery data is incomplete; no new PR was created.",
              });
            if (!matches(detail.request))
              return yield* new WorkflowActionError({
                message: "A PR with this head has a conflicting repository or base.",
              });
            if (detail.body.includes(marker)) marked.push(detail.request);
            else
              return yield* new WorkflowActionError({
                message:
                  "A PR with this head has no matching job marker; resolve it before retrying.",
              });
          }
          if (marked.length > 1)
            return yield* new WorkflowActionError({
              message: "Multiple PRs match this job; no new PR was created.",
            });
          return marked[0] ?? null;
        });
        let request = yield* lookup();
        if (!request) {
          // A captured owner may have delivered creation even when no reply or local receipt survived.
          if (
            action.phase === "pull_request" &&
            action.commands.some(
              (command) =>
                command.pid !== null &&
                (command.phase === "pull_request" || command.phase === undefined),
            )
          )
            return yield* new WorkflowActionError({
              message:
                "PR creation is unresolved. Retry will only look for the existing PR; it will not create another.",
            });
          if (!action.prTitle || !action.prBody) {
            if (!manager.prepareWorkflowPullRequest)
              return yield* new WorkflowActionError({
                message: "Workflow PR preparation is unavailable.",
              });
            const prepared = yield* manager
              .prepareWorkflowPullRequest({
                cwd,
                threadId: run.progress.threadId,
                baseBranch: run.baseBranch,
                baseRef: run.baseSha!,
                headBranch: branch,
              })
              .pipe(Effect.mapError(error));
            run = yield* edit(io, id, (entry) => ({
              ...entry,
              prTitle: prepared.title,
              prBody: `${prepared.body}\n\n${marker}`,
            }));
            action = get(run, id)!;
          }
          if ((yield* verify()) !== head)
            return yield* new WorkflowActionError({
              message: "The prepared commit changed before PR creation.",
            });
          yield* edit(io, id, (entry) => ({ ...entry, phase: "pull_request", commitSha: head }));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const bodyFile = yield* fs
                .makeTempFileScoped({ prefix: "t3-workflow-pr-" })
                .pipe(Effect.mapError(error));
              yield* fs.writeFileString(bodyFile, action!.prBody!).pipe(Effect.mapError(error));
              const receipt = yield* owned(
                id,
                io,
                provider.createChangeRequest({
                  cwd,
                  baseRefName: run.baseBranch,
                  headSelector: branch,
                  title: action!.prTitle!,
                  bodyFile,
                }),
                "pull_request",
              );
              if (receipt?.url) {
                const url = new URL(receipt.url);
                const expected = new URL(`https://${run.repositoryCanonicalKey}`);
                if (
                  url.origin !== expected.origin ||
                  !url.pathname.startsWith(`${expected.pathname}/pull/`) ||
                  !/\/pull\/[1-9]\d*$/.test(url.pathname)
                )
                  return yield* new WorkflowActionError({
                    message: "The returned PR belongs to a different repository.",
                  });
                yield* io.update((current) => ({
                  ...changeWorkflowAction(current, id, (entry) => ({
                    ...entry,
                    pullRequestUrl: receipt.url,
                  })),
                  publication: { ...current.publication!, pullRequestUrl: receipt.url },
                }));
              }
            }),
          );
          request = yield* lookup();
          if (!request)
            return yield* new WorkflowActionError({
              message:
                "PR creation returned without a confirmed PR. Retry will only reconcile the existing intent.",
            });
        }
        if ((yield* io.read).publication?.pullRequestUrl !== request.url) {
          const url = request.url;
          yield* io.update((current) => ({
            ...changeWorkflowAction(current, id, (entry) => ({ ...entry, pullRequestUrl: url })),
            publication: { ...current.publication!, pullRequestUrl: url },
          }));
        }
        if (request.state !== "open")
          return yield* new WorkflowActionError({
            message: `The job's PR is ${request.state}; no replacement was created.`,
          });
        const url = request.url;
        yield* io.update((current) => ({
          ...changeWorkflowAction(current, id, (entry) => ({
            ...entry,
            state: "completed",
            phase: "done",
            commitSha: head,
            pullRequestUrl: url,
            detail: null,
          })),
          publication: { ...current.publication!, pullRequestUrl: url },
        }));
        return;
      }
      let head = verifiedHead;
      if (head !== action.parent && head !== action.commitSha) {
        const parent = yield* readCommitField(head, "%P");
        const message = yield* readCommitField(head, "%B");
        const tree = yield* readTree(head);
        if (
          action.phase !== "commit" ||
          parent !== action.parent ||
          tree !== action.tree ||
          message !== action.commitMessage?.trim()
        )
          return yield* new WorkflowActionError({
            message: "The prepared commit changed outside this action.",
          });
      }
      if (!action.commitSha) {
        const hasWorkingTreeChanges =
          head === action.parent &&
          (run.runtime.kind === "vm"
            ? (yield* readTree(head)) !== action.tree
            : (yield* git.statusDetailsLocal(cwd).pipe(Effect.mapError(error)))
                .hasWorkingTreeChanges);
        if (hasWorkingTreeChanges) {
          if (!action.commitMessage) {
            if (!manager.prepareWorkflowCommit)
              return yield* new WorkflowActionError({
                message: "Workflow commit preparation is unavailable.",
              });
            const prepared = yield* owned(
              id,
              io,
              manager.prepareWorkflowCommit({ cwd, threadId: run.progress.threadId }),
            );
            if (!prepared)
              return yield* new WorkflowActionError({
                message: "Prepared changes are unavailable.",
              });
            run = yield* edit(io, id, (entry) => ({
              ...entry,
              commitMessage: [prepared.subject, prepared.body].filter(Boolean).join("\n\n"),
              phase: "commit",
            }));
            action = get(run, id)!;
          }
          if ((yield* verify()) !== head)
            return yield* new WorkflowActionError({
              message: "The prepared commit changed before committing the result.",
            });
          if ((yield* text(["write-tree"])) !== action.tree)
            return yield* new WorkflowActionError({
              message: "Staged files do not match the saved result.",
            });
          yield* owned(id, io, git.commit(cwd, action.commitMessage!, ""), "commit");
          const committedHead = yield* readHead();
          if (!committedHead || (yield* readCommitField(committedHead, "%P")) !== action.parent)
            return yield* new WorkflowActionError({
              message: "Commit hooks changed the prepared commit's parent; nothing was pushed.",
            });
          head = committedHead;
        }
        if ((yield* readTree(head)) !== action.tree)
          return yield* new WorkflowActionError({
            message: "Commit hooks changed the saved result; nothing was pushed.",
          });
        run = yield* io.update((current) => ({
          ...changeWorkflowAction(current, id, (entry) => ({
            ...entry,
            commitSha: head,
            phase: "push",
          })),
          preparedHead: head,
        }));
        action = get(run, id)!;
      } else if (
        action.commitSha !== action.parent &&
        (yield* readCommitField(action.commitSha, "%P")) !== action.parent
      ) {
        return yield* new WorkflowActionError({
          message:
            "The recorded commit's parent does not match the prepared job; nothing was pushed.",
        });
      }
      const currentHead = yield* verify();
      const commitSha = action.commitSha;
      if (!commitSha || currentHead !== commitSha || (yield* readTree(commitSha)) !== action.tree)
        return yield* new WorkflowActionError({
          message: "The prepared commit changed before Push.",
        });
      if ((yield* readTree(run.baseSha!)) === action.tree && !run.publication!.publishedHead)
        return yield* new WorkflowActionError({ message: "No changes to publish." });
      const ref = `refs/heads/${branch}`;
      const remoteHead = () =>
        text(["ls-remote", "--refs", "--", remoteUrl, ref]).pipe(
          Effect.map((value) => value.split(/\s/)[0] || null),
        );
      const observed = yield* remoteHead();
      if (observed !== action.commitSha) {
        if (observed !== action.oldRemoteSha)
          return yield* new WorkflowActionError({
            message: "The remote job branch changed; no update was attempted.",
          });
        if (observed) {
          const ancestor = yield* originalHistory(
            ["merge-base", "--is-ancestor", observed, action.commitSha!],
            true,
          );
          if (ancestor.exitCode !== 0)
            return yield* new WorkflowActionError({
              message: "The job branch cannot be fast-forwarded safely.",
            });
        }
        if (
          github &&
          (yield* workflowPushNeedsLfsUpload(git, {
            cwd,
            commitSha,
            baseSha: run.baseSha!,
            publishedSha: observed,
          }).pipe(Effect.mapError(error)))
        ) {
          return yield* new WorkflowActionError({
            message: "This change requires a Git LFS upload, which workflow Push does not support.",
          });
        }
        // The lease guards the exact old ref; ancestry above forbids a history rewrite.
        yield* owned(
          id,
          io,
          executeGit([
            "push",
            "--porcelain",
            "--no-mirror",
            "--no-follow-tags",
            `--force-with-lease=${ref}:${observed ?? ""}`,
            "--",
            remoteUrl,
            `${action.commitSha}:${ref}`,
          ]),
          "push",
        );
        if ((yield* remoteHead()) !== action.commitSha)
          return yield* new WorkflowActionError({
            message: "The published commit could not be confirmed.",
          });
      }
      yield* io.update((current) => ({
        ...changeWorkflowAction(current, id, (entry) => ({
          ...entry,
          state: "completed",
          phase: "done",
          detail: null,
        })),
        publication: { ...current.publication!, publishedHead: action!.commitSha },
      }));
    },
    (effect) => effect.pipe(Effect.catchCause((cause) => Effect.fail(error(Cause.squash(cause))))),
  );
  return WorkflowActions.of({
    canOpenPullRequest: (input) =>
      prProvider(input).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    vmAvailable: Effect.gen(function* () {
      const reviewRepo = yield* WorkflowReviewGitDirectory;
      const commandLauncher = native.vmPublishing?.commandLauncher;
      if (!processRunner || !commandLauncher || !reviewRepo || !(yield* fs.exists(reviewRepo)))
        return false;
      yield* commandLauncher;
      return true;
    }).pipe(Effect.orElseSucceed(() => false)),
    available: launcher.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    execute,
    recover,
  });
});
export const layer = Layer.effect(WorkflowActions, make).pipe(Layer.provide(processRunnerLayer));
