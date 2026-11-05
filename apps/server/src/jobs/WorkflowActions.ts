import { CheckpointRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { WorkflowRunStore, workflowRunOrigin } from "./WorkflowRunStore.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Schema from "effect/Schema";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitVcsDriver, workflowGitEnvironment } from "../vcs/GitVcsDriver.ts";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { SetupProcessAdapter } from "../terminal/SetupProcessAdapter.ts";
import {
  CurrentWorkflowCommand,
  ProcessOwnershipError,
  type OwnedCommand,
} from "../processRunner.ts";
import type { WorkflowRun, WorkflowActionRecord } from "./WorkflowRunStore.ts";
import { jobBranchName } from "./Layers/JobRunner.ts";

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
export interface WorkflowActionIO {
  readonly read: Effect.Effect<WorkflowRun, WorkflowActionError>;
  readonly update: (
    change: (run: WorkflowRun) => WorkflowRun,
  ) => Effect.Effect<WorkflowRun, WorkflowActionError>;
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
  const commandFactory = (
    id: string,
    io: WorkflowActionIO,
    phase: "prepare" | "commit" | "push" | "pull_request",
  ) =>
    Effect.gen(function* () {
      const run = yield* requireRun(io);
      const executable = yield* launcher.pipe(Effect.mapError(error));
      const commandId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(error));
      const boot = yield* native.host.pipe(Effect.mapError(error));
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
      ) =>
        edit(io, id, (action) => ({
          ...action,
          commands: action.commands.map((command) =>
            command.id === commandId ? update(command) : command,
          ),
        }));
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
            const state = yield* native.inspect(actualPid);
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
              yield* native.arm(pid, identity);
            }),
          )
          .pipe(Effect.mapError(ownError)),
        completed: (code) =>
          patch((command) => ({ ...command, code })).pipe(Effect.asVoid, Effect.mapError(ownError)),
        stop: Effect.gen(function* () {
          if (
            stopped ||
            get(yield* io.read, id)?.commands.find((command) => command.id === commandId)?.stopped
          )
            return;
          if (pid !== null && identity !== null) yield* native.stop(pid, identity);
          else if (pid !== null) {
            // No arm is permitted until capture was saved; this owner cannot have delivered work.
            const captured = yield* native.inspect(pid);
            if (captured.owned && captured.identity) yield* native.stop(pid, captured.identity);
          }
          yield* patch((command) => ({ ...command, stopped: true }));
          stopped = true;
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

  const recover = Effect.fn("WorkflowActions.recover")(function* (io: WorkflowActionIO) {
    const run = yield* io.read;
    for (const action of run.actions ?? [])
      for (const command of action.commands) {
        if (command.stopped) continue;
        if (command.pid !== null && command.identity !== null) {
          const stopped = yield* native.stop(command.pid, command.identity).pipe(Effect.result);
          if (stopped._tag === "Failure") {
            const boot = yield* native.host.pipe(Effect.mapError(error));
            if (
              !boot ||
              !command.boot ||
              boot.host !== command.boot.host ||
              boot.session === command.boot.session
            )
              return false;
          }
        }
        yield* edit(io, action.actionId, (entry) => ({
          ...entry,
          commands: entry.commands.map((value) =>
            value.id === command.id ? { ...value, stopped: true } : value,
          ),
        }));
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
      const executeGit = (
        args: ReadonlyArray<string>,
        options?: { readonly allowNonZeroExit?: boolean; readonly env?: NodeJS.ProcessEnv },
      ) =>
        git
          .execute({ operation: "WorkflowActions", cwd, args, ...options })
          .pipe(Effect.mapError(error));
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
      const readHead = () =>
        readWorkflowHead(git, cwd, jobBranchName(run.jobId)).pipe(Effect.mapError(error));
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
        const { treeId: currentTree } = yield* owned(
          id,
          io,
          checkpoints.captureCheckpoint({
            cwd,
            checkpointRef: verificationRef,
            strictWorkflowCapture: run.runtime.kind === "vm",
            ...(workflowIgnoreRules === undefined ? {} : { workflowIgnoreRules }),
          }),
        ).pipe(
          Effect.tap(() =>
            owned(
              id,
              io,
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
        const branch = jobBranchName(run.jobId);
        const observed = yield* text([
          "ls-remote",
          "--refs",
          "--",
          publication.remoteUrl,
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
      const ref = `refs/heads/${jobBranchName(run.jobId)}`;
      const remoteHead = () =>
        text(["ls-remote", "--refs", "--", run.publication!.remoteUrl, ref]).pipe(
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
        // The lease guards the exact old ref; ancestry above forbids a history rewrite.
        yield* owned(
          id,
          io,
          executeGit([
            "push",
            "--porcelain",
            `--force-with-lease=${ref}:${observed ?? ""}`,
            run.publication!.remoteUrl,
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
    available: launcher.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    execute,
    recover,
  });
});
export const layer = Layer.effect(WorkflowActions, make);
