import { TerminalManager } from "../terminal/Manager.ts";
import {
  CommandId,
  EventId,
  worktreeSetupActivityId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  type ThreadId,
  type ThreadPreparation,
} from "@t3tools/contracts";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckoutAdmission, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerConfig } from "../config.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { WorktreeSetupTracker } from "../project/WorktreeSetupTracker.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { SetupProcessJournal } from "../terminal/SetupProcessJournal.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { resolveCheckoutPath } from "../workspace/CheckoutAccess.ts";
import { checkoutCaptureReleases } from "../workspace/CheckoutCaptureSignals.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

class PreparationError extends Schema.TaggedError<PreparationError>()("PreparationError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class ThreadPreparationReactor extends Context.Service<
  ThreadPreparationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly drainAttemptThrough: (
      threadId: ThreadId,
      attemptId: CommandId,
      sequence: number,
    ) => Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadPreparationReactor") {}

const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const decodeSetup = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

/** Runs before queue activation. A process boundary never repeats a started script. */
export const reconcileSharedPreparations = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const journal = yield* SetupProcessJournal;
  const terminal = yield* TerminalManager;
  const snapshot = yield* query.getShellSnapshot();
  const activities = yield* query.listActivitiesByKind(WORKTREE_SETUP_ACTIVITY_KIND);
  const runningLegacyScripts = new Set<ThreadId>();
  const interruptedLegacyThreads = new Set(
    activities.flatMap((activity) => {
      const setup = decodeSetup(activity.payload);
      if (Option.isNone(setup) || activity.id !== worktreeSetupActivityId(setup.value.threadId))
        return [];
      if (
        setup.value.stages.some(
          (stage) => stage.id === "setup-script" && stage.status === "running",
        )
      )
        runningLegacyScripts.add(setup.value.threadId);
      return setup.value.phase !== "done" &&
        !setup.value.stages.some((stage) => stage.id === "agent" && stage.status === "done")
        ? [setup.value.threadId]
        : [];
    }),
  );
  const createdAt = yield* now;
  for (const shell of snapshot.threads) {
    if (
      !shell.promptQueueSummary?.preparation &&
      !interruptedLegacyThreads.has(shell.id) &&
      !runningLegacyScripts.has(shell.id)
    )
      continue;
    const detailed = yield* query.getThreadDetailById(shell.id);
    if (Option.isNone(detailed)) continue;
    const previous = detailed.value.promptQueue?.preparation;
    if (previous?.state === "pending") continue; // No work started; the saved recipe can still run.
    const legacy = interruptedLegacyThreads.has(shell.id) || runningLegacyScripts.has(shell.id);
    if (!previous && !legacy) continue;
    if (previous && previous.state !== "running" && previous.settled && !previous.script && !legacy)
      continue;
    const ownsScript = previous?.script || runningLegacyScripts.has(shell.id);
    const cleanup = ownsScript
      ? yield* journal
          .recover({ threadId: shell.id, attemptId: previous?.attemptId ?? `legacy:${shell.id}` })
          .pipe(
            Effect.flatMap((receipt) =>
              terminal.closeOwned({
                threadId: receipt.threadId,
                terminalId: receipt.terminalId,
                receipt,
              }),
            ),
            Effect.result,
          )
      : undefined;
    const failure = cleanup?._tag === "Failure" ? cleanup.failure.message : undefined;
    // A completed command can leave its shell alive. Reconciliation closes that
    // captured owner too, without turning a saved ready workspace into a new attempt.
    const ready = previous?.state === "ready" && failure === undefined;
    const commandId = CommandId.make(
      `preparation-restart:${shell.id}:${snapshot.snapshotSequence}`,
    );
    yield* engine.dispatch({
      type: "thread.preparation.update",
      commandId,
      threadId: shell.id,
      createdAt,
      expectedRevision: previous?.revision ?? null,
      preparation: previous
        ? {
            ...previous,
            state: ready ? "ready" : "failed",
            settled: failure === undefined,
            revision: previous.revision + 1,
            failure: {
              reason: failure ? "failed" : "interrupted",
              detail:
                failure ??
                (ready
                  ? "The server restarted and stopped the setup preview. The prepared result is retained."
                  : "The server restarted during setup. Retry setup and resume when ready."),
            },
          }
        : {
            originalCommandId: commandId,
            attemptId: commandId,
            revision: 0,
            state: "failed",
            settled: failure === undefined,
            recipe: null,
            failure: {
              reason: "legacy-needs-review",
              detail:
                failure ??
                "An earlier setup did not finish and its recipe was not saved. Review the workspace or choose Work locally.",
            },
          },
    });
  }
});

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const git = yield* GitWorkflowService;
  const runner = yield* ProjectSetupScriptRunner;
  const tracker = yield* WorktreeSetupTracker;
  const journal = yield* SetupProcessJournal;
  const terminal = yield* TerminalManager;
  const settingsService = yield* ServerSettingsService;
  const deletion = yield* ThreadDeletionReactor;
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const captures = makeCheckoutCapture(sql);
  const fences = makeThreadExecutionFence(sql);
  const scope = yield* Scope.Scope;
  const workers = new Map<
    ThreadId,
    { fiber: Fiber.Fiber<void>; attemptId: CommandId; stopCommandId?: CommandId }
  >();
  const waitingForCapture = new Map<ThreadId, number>();
  let captureReleaseVersion = 0;
  const scheduleLock = yield* Semaphore.make(1);
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const record = (snapshot: WorktreeSetupSnapshot, preparationAttemptId: CommandId) =>
    engine.dispatch({
      type: "thread.activity.append",
      threadId: snapshot.threadId,
      preparationAttemptId,
      commandId: CommandId.make(
        `preparation-progress:${snapshot.threadId}:${snapshot.startedAt}:${snapshot.sequence}`,
      ),
      createdAt: snapshot.endedAt ?? snapshot.startedAt,
      activity: {
        id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
        kind: WORKTREE_SETUP_ACTIVITY_KIND,
        summary:
          snapshot.phase === "failed" ? "Workspace preparation failed" : "Preparing workspace",
        tone: snapshot.phase === "failed" ? "error" : "info",
        payload: snapshot,
        turnId: null,
        createdAt: snapshot.startedAt,
      },
    });
  const finish = (
    threadId: ThreadId,
    attemptId: CommandId,
    phase: "done" | "failed",
    detail?: string,
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* tracker.finish(threadId, phase, detail);
      if (snapshot) yield* record(snapshot, attemptId);
    });
  const read = (threadId: ThreadId) =>
    query
      .getThreadDetailById(threadId, { includeArchived: true })
      .pipe(Effect.map(Option.getOrUndefined));
  const update = (threadId: ThreadId, previous: ThreadPreparation, next: ThreadPreparation) =>
    engine.dispatch({
      type: "thread.preparation.update",
      threadId,
      commandId: CommandId.make(`${previous.attemptId}:preparation:${next.revision}:${next.state}`),
      expectedRevision: previous.revision,
      preparation: next,
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    });

  const settleAttempt = Effect.fn("ThreadPreparationReactor.settleAttempt")(function* (
    threadId: ThreadId,
    accepted: ThreadPreparation,
    terminalId: string | undefined,
    detail: string,
    reason: "cancelled" | "failed",
    finishTracked: boolean,
    preserveFailure = true,
    stopCommandId?: CommandId,
  ) {
    const closed = terminalId
      ? yield* journal
          .cleanup({
            threadId,
            attemptId: accepted.attemptId,
            commandId: stopCommandId ?? `${accepted.attemptId}:cleanup`,
          })
          .pipe(
            Effect.flatMap((receipt) =>
              terminal.closeOwned({
                threadId: receipt.threadId,
                terminalId: receipt.terminalId,
                receipt,
              }),
            ),
            Effect.result,
          )
      : undefined;
    const closeFailure =
      closed?._tag === "Failure"
        ? `Setup could not be stopped. Choose Stop setup again before retrying. ${closed.failure.message}`
        : undefined;
    const current = (yield* read(threadId))?.promptQueue?.preparation;
    if (!current || current.attemptId !== accepted.attemptId) return;
    if (finishTracked)
      yield* finish(
        threadId,
        accepted.attemptId,
        "failed",
        closeFailure ?? current.failure?.detail ?? detail,
      ).pipe(Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void));
    // Stop can advance the revision while cleanup settles. A retry starts only
    // after the captured process exited, not merely after sending its signal.
    while (true) {
      const latest = (yield* read(threadId))?.promptQueue?.preparation;
      if (!latest || latest.attemptId !== accepted.attemptId) return;
      const saved = yield* update(threadId, latest, {
        ...latest,
        revision: latest.revision + 1,
        state: latest.state === "ready" && !closeFailure ? "ready" : "failed",
        settled: closeFailure === undefined,
        failure: closeFailure
          ? { reason: "failed", detail: closeFailure }
          : ((preserveFailure ? latest.failure : undefined) ?? { reason, detail }),
      }).pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
      );
      if (saved) return;
    }
  });

  const run = Effect.fn("ThreadPreparationReactor.run")(function* (
    threadId: ThreadId,
    accepted: ThreadPreparation,
  ) {
    let terminalId: string | undefined;
    let didBeginTracking = false;
    let backgroundCompletion: Effect.Effect<void> | undefined;
    const admissions: string[] = [];
    let admissionReleaseVersion = captureReleaseVersion;
    const program = Effect.gen(function* () {
      // Every deletion before this accepted incarnation must finish before it owns resources.
      yield* deletion.drainThrough(yield* engine.latestSequence, threadId);
      const anchor = yield* query.getThreadSubscriptionAnchor(threadId);
      if (Option.isNone(anchor)) return;
      const thread = yield* read(threadId);
      const preparation = thread?.promptQueue?.preparation;
      if (
        !thread ||
        thread.archivedAt !== null ||
        preparation?.attemptId !== accepted.attemptId ||
        preparation.state !== "pending"
      )
        return;
      const project = yield* query.getProjectShellById(thread.projectId);
      if (Option.isNone(project) || !preparation.recipe)
        return yield* new PreparationError({
          detail: "The preparation recipe or project is unavailable. Review the workspace.",
        });
      const recipe = preparation.recipe;
      const settings = yield* settingsService.getSettings;
      const requested = recipe.prepareWorktree;
      const branch = requested?.branch ?? `t3code/${thread.id}`;
      let target =
        preparation.target ??
        (requested
          ? {
              branch,
              worktreePath: path.join(
                config.worktreesDir,
                path.basename(recipe.projectCwd),
                branch.replaceAll("/", "-"),
              ),
              baseRef: requested.baseBranch,
              submodules: resolveProjectSettings(settings, thread.projectId, project.value).settings
                .worktreeSubmodules,
            }
          : { branch: thread.branch, worktreePath: thread.worktreePath });
      const selected =
        preparation.script === undefined
          ? recipe.runSetupScript && target.worktreePath
            ? setupProjectScript(resolveProjectScripts(settings, project.value))
            : null
          : preparation.script;
      const script = selected
        ? {
            id: selected.id,
            name: selected.name,
            command: selected.command,
            async: selected.async !== false,
          }
        : null;
      const sourceRoot = yield* resolveCheckoutPath(
        requested ? recipe.projectCwd : (target.worktreePath ?? recipe.projectCwd),
        fs,
        path,
      );
      const targetRoot = yield* resolveCheckoutPath(
        target.worktreePath ?? recipe.projectCwd,
        fs,
        path,
      );
      admissionReleaseVersion = captureReleaseVersion;
      const committedAdmissions = yield* sql.withTransaction(
        Effect.gen(function* () {
          const reserved: string[] = [];
          const fence = yield* fences.get(threadId);
          if (fence && fence.phase !== "active")
            return yield* new PreparationError({
              detail: "This thread is moving and cannot start setup.",
            });
          for (const checkoutRoot of new Set([sourceRoot, targetRoot])) {
            const admitted = yield* captures.admit({
              threadId,
              workId: `preparation:${accepted.attemptId}:${checkoutRoot}`,
              kind: "setup",
              checkoutRoot,
            });
            if (admitted.decision !== "start")
              return yield* new PreparationError({
                detail: "This setup attempt needs reconciliation before it can run again.",
              });
            reserved.push(admitted.admissionId);
          }
          return reserved;
        }),
      );
      admissions.push(...committedAdmissions);
      waitingForCapture.delete(threadId);
      const sourceAdmission = admissions[0]!;
      const targetAdmission = admissions[sourceRoot === targetRoot ? 0 : 1]!;
      // Register cancellation only after cleanup for the previous incarnation drained.
      yield* tracker
        .begin({
          threadId,
          creationSequence: anchor.value.creationSequence,
          branch: preparation.recipe?.prepareWorktree?.branch ?? null,
          baseRef: preparation.recipe?.prepareWorktree?.baseBranch ?? null,
          stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
          fiber: workers.get(threadId)?.fiber ?? null,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              didBeginTracking = true;
            }),
          ),
          Effect.uninterruptible,
        );
      let running: ThreadPreparation = {
        ...preparation,
        target,
        script,
        state: "running",
        settled: false,
        revision: preparation.revision + 1,
      };
      if (script && target.worktreePath) {
        terminalId = `setup-${running.attemptId}`;
        yield* journal.begin({ threadId, attemptId: running.attemptId, terminalId });
      }
      yield* update(threadId, preparation, running);
      const initialProgress = yield* tracker.get(threadId);
      if (initialProgress) yield* record(initialProgress, accepted.attemptId);
      const assertCurrent = Effect.gen(function* () {
        const current = (yield* read(threadId))?.promptQueue?.preparation;
        if (current?.attemptId !== running.attemptId || current.state !== "running")
          return yield* new PreparationError({ detail: "Preparation was stopped." });
      });
      if (requested && target.worktreePath) {
        yield* withWorkspaceLease(
          target.worktreePath,
          Effect.gen(function* () {
            yield* assertCurrent;
            const isRepo = yield* git.isRepository(recipe.projectCwd);
            let baseRef = target.baseRef ?? requested.baseBranch;
            if (
              isRepo &&
              requested.startFromOrigin &&
              (yield* git.remoteExists({ cwd: recipe.projectCwd, remoteName: "origin" }))
            ) {
              yield* tracker.stageStatus(threadId, "fetch", "running");
              yield* git.fetchRemote({
                cwd: recipe.projectCwd,
                remoteName: "origin",
                refName: requested.baseBranch,
              });
              if (
                yield* git.remoteBranchExists({
                  cwd: recipe.projectCwd,
                  remoteName: "origin",
                  refName: requested.baseBranch,
                })
              )
                baseRef = (yield* git.resolveRemoteTrackingCommit({
                  cwd: recipe.projectCwd,
                  refName: requested.baseBranch,
                  fallbackRemoteName: "origin",
                })).commitSha;
              yield* tracker.stageStatus(threadId, "fetch", "done");
            } else yield* tracker.stageStatus(threadId, "fetch", "skipped");
            if (!isRepo || !(yield* git.hasCommit({ cwd: recipe.projectCwd, refName: baseRef }))) {
              if (requested.requireWorktree)
                return yield* new PreparationError({
                  detail:
                    "A separate worktree requires a Git repository and a base branch with a commit.",
                });
              target = { branch: thread.branch, worktreePath: null };
              yield* tracker.stageStatus(threadId, "checkout", "skipped", "using project checkout");
            } else {
              target = { ...target, baseRef };
              const next = { ...running, target, revision: running.revision + 1 };
              yield* update(threadId, running, next);
              running = next;
              const refs = yield* git.listRefs({
                cwd: recipe.projectCwd,
                query: target.branch!,
                refKind: "local",
                refresh: true,
              });
              const existing = refs.refs.find((ref) => ref.name === target.branch);
              if (
                existing?.worktreePath &&
                path.resolve(existing.worktreePath) !== path.resolve(target.worktreePath!)
              )
                return yield* new PreparationError({
                  detail:
                    "The selected branch belongs to another worktree. Review the target before retrying.",
                });
              yield* assertCurrent;
              yield* tracker.stageStatus(threadId, "checkout", "running");
              if (!existing?.worktreePath) {
                yield* git.createWorktree(
                  {
                    cwd: recipe.projectCwd,
                    refName: existing ? target.branch! : baseRef,
                    ...(existing ? {} : { newRefName: target.branch! }),
                    baseRefName: requested.baseBranch,
                    path: target.worktreePath!,
                  },
                  {
                    submodules: target.submodules ?? null,
                    progress: {
                      onCheckoutProgress: ({ percent }) =>
                        tracker.stage(threadId, "checkout", { percent }),
                      onSubmodulesStarted: () =>
                        tracker.stageStatus(threadId, "submodules", "running"),
                      onSubmodulesFinished: ({ ok, detail }) =>
                        tracker.stageStatus(
                          threadId,
                          "submodules",
                          ok ? "done" : "warning",
                          detail,
                        ),
                      onSubmodulesDisabled: () =>
                        tracker.stageStatus(threadId, "submodules", "skipped"),
                    },
                  },
                );
              }
              yield* tracker.stageStatus(threadId, "checkout", "done");
            }
          }),
        ).pipe(Effect.provideService(CheckoutAdmission, sourceAdmission));
      }
      if (sourceRoot !== targetRoot) yield* captures.complete(sourceAdmission);
      // TerminalManager.open takes the workspace lease itself. Never hold it across this call.
      yield* assertCurrent;
      if (script && target.worktreePath) {
        terminalId = `setup-${running.attemptId}`;
        yield* tracker.stageStatus(threadId, "setup-script", "running");
        const launched = yield* runner
          .runForThread({
            threadId,
            projectId: thread.projectId,
            projectCwd: recipe.projectCwd,
            worktreePath: target.worktreePath,
            resolvedScript: script,
            preferredTerminalId: terminalId,
            preparationAttemptId: running.attemptId,
            observeCompletion: {
              onOutputLine: (line) => tracker.appendTail(threadId, "setup-script", line),
            },
          })
          .pipe(Effect.provideService(CheckoutAdmission, targetAdmission), Effect.result);
        if (launched._tag === "Failure") {
          yield* tracker.stageStatus(threadId, "setup-script", "failed", launched.failure.message);
          return yield* launched.failure;
        } else if (launched.success.status === "started" && launched.success.completion) {
          const completion = launched.success.completion.pipe(
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                yield* journal.complete({ threadId, attemptId: accepted.attemptId });
                const detail =
                  result.exitCode === null
                    ? "The setup terminal closed before successful completion."
                    : `Setup exited with code ${result.exitCode}.`;
                yield* tracker.stageStatus(
                  threadId,
                  "setup-script",
                  result.exitCode === 0 ? "done" : "failed",
                  result.exitCode === 0 ? undefined : detail,
                );
                if (result.exitCode !== 0 && !script.async)
                  return yield* new PreparationError({ detail });
              }),
            ),
          );
          if (script.async)
            backgroundCompletion = completion.pipe(Effect.ignoreCause({ log: true }));
          else yield* completion;
        } else
          return yield* new PreparationError({
            detail:
              "Setup did not report a completion handle. Required setup cannot be considered successful.",
          });
      } else yield* tracker.stageStatus(threadId, "setup-script", "skipped");
      yield* assertCurrent;
      yield* update(threadId, running, {
        ...running,
        target,
        revision: running.revision + 1,
        state: "ready",
        settled: backgroundCompletion === undefined,
      });
      yield* tracker.stageStatus(threadId, "agent", "done");
      if (backgroundCompletion) {
        const progress = yield* tracker.get(threadId);
        if (progress) yield* record(progress, accepted.attemptId);
        yield* backgroundCompletion;
        // Queue admission can advance revisions. Stop owns settlement once it lands.
        while (true) {
          const current = (yield* read(threadId))?.promptQueue?.preparation;
          if (
            current?.attemptId !== accepted.attemptId ||
            current.state !== "ready" ||
            current.settled
          )
            break;
          const saved = yield* update(threadId, current, {
            ...current,
            settled: true,
            revision: current.revision + 1,
          }).pipe(
            Effect.as(true),
            Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
          );
          if (saved) break;
        }
      }
      // Background progress is still owned here, while ready already permits delivery.
      yield* finish(threadId, accepted.attemptId, "done");
    });
    yield* program.pipe(
      Effect.catchTag("CheckoutCaptureError", (error) => {
        if (!error.waitingForCheckout) return Effect.fail(error);
        waitingForCapture.set(threadId, admissionReleaseVersion);
        return Effect.void;
      }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (exit._tag === "Success") {
            yield* Effect.forEach(admissions, captures.complete, { discard: true });
            return;
          }
          const detail = Cause.hasInterrupts(exit.cause)
            ? "Setup was interrupted. Retry setup and resume when ready."
            : String(Cause.squash(exit.cause));
          yield* settleAttempt(
            threadId,
            accepted,
            terminalId,
            detail,
            Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
            didBeginTracking,
            true,
            workers.get(threadId)?.stopCommandId,
          );
          const current = (yield* read(threadId))?.promptQueue?.preparation;
          if (current?.attemptId === accepted.attemptId && current.settled)
            yield* Effect.forEach(admissions, captures.complete, { discard: true });
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.ignoreCause({ log: true }),
    );
  });

  const recordStop = Effect.fn("ThreadPreparationReactor.recordStop")(function* (
    threadId: ThreadId,
    stopCommandId: CommandId,
  ) {
    const preparation = (yield* read(threadId))?.promptQueue?.preparation;
    if (!preparation) return;
    const failed = !preparation.settled;
    const createdAt = yield* now;
    const kind = failed ? "preparation.stop.failed" : "preparation.stop.completed";
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`${stopCommandId}:${kind}`),
      threadId,
      createdAt,
      activity: {
        id: EventId.make(`${stopCommandId}:${kind}`),
        kind,
        tone: failed ? "error" : "info",
        summary: failed ? "Setup stop failed" : "Setup stopped",
        payload: {
          stopCommandId,
          detail: failed
            ? (preparation.failure?.detail ?? "Setup could not be stopped.")
            : "Setup cleanup confirmed.",
        },
        turnId: null,
        createdAt,
      },
    });
  });
  const schedule = Effect.fn("ThreadPreparationReactor.schedule")(function* (
    threadId: ThreadId,
    stopCommandId?: CommandId,
  ) {
    const thread = yield* read(threadId);
    const preparation = thread?.promptQueue?.preparation;
    let active = workers.get(threadId);
    if (active && waitingForCapture.has(threadId)) {
      yield* Fiber.await(active.fiber);
      active = workers.get(threadId);
    }
    if (active) {
      // The queue and session events share a Stop identity. The second event must
      // neither interrupt its cleanup worker before it starts nor retry a failure.
      if (stopCommandId && active.stopCommandId === stopCommandId) return;
      const previousStop = active.stopCommandId;
      if (stopCommandId) active.stopCommandId = stopCommandId;
      if (
        !preparation ||
        preparation.state === "failed" ||
        preparation.attemptId !== active.attemptId ||
        stopCommandId
      ) {
        if (previousStop) yield* Fiber.await(active.fiber);
        else yield* Fiber.interrupt(active.fiber);
      }
      if (!preparation || (preparation.attemptId === active.attemptId && !previousStop)) {
        if (stopCommandId) yield* recordStop(threadId, stopCommandId);
        return;
      }
    }
    if (!preparation) {
      waitingForCapture.delete(threadId);
      return;
    }
    const stop = stopCommandId !== undefined;
    if (
      !stop &&
      (thread?.archivedAt !== null ||
        preparation.state !== "pending" ||
        !thread?.promptQueue?.enabled)
    ) {
      waitingForCapture.delete(threadId);
      return;
    }
    waitingForCapture.delete(threadId);
    const gate = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(gate).pipe(
      Effect.andThen(
        stop
          ? settleAttempt(
              threadId,
              preparation,
              preparation.script ? `setup-${preparation.attemptId}` : undefined,
              "Setup stopped. Retry setup and resume when ready.",
              "cancelled",
              false,
              false,
              stopCommandId,
            ).pipe(
              Effect.andThen(recordStop(threadId, stopCommandId!)),
              Effect.uninterruptible,
              Effect.ignoreCause({ log: true }),
            )
          : run(threadId, preparation),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          workers.delete(threadId);
          const deniedAt = waitingForCapture.get(threadId);
          if (deniedAt !== undefined && deniedAt < captureReleaseVersion)
            yield* scheduleSafely(threadId).pipe(Effect.forkIn(scope));
        }),
      ),
      Effect.forkIn(scope),
    );
    workers.set(threadId, {
      fiber,
      attemptId: preparation.attemptId,
      ...(stopCommandId ? { stopCommandId } : {}),
    });
    yield* Deferred.succeed(gate, undefined);
  }, scheduleLock.withPermit);
  const scheduleSafely = (threadId: ThreadId): Effect.Effect<void> =>
    schedule(threadId).pipe(Effect.ignoreCause({ log: true }));

  return ThreadPreparationReactor.of({
    start: () =>
      Effect.gen(function* () {
        yield* checkoutCaptureReleases(sql).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              captureReleaseVersion++;
            }).pipe(
              Effect.andThen(
                forkParked(
                  Effect.forEach([...waitingForCapture.keys()], scheduleSafely, { discard: true }),
                ),
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const events = yield* engine.subscribeDomainEvents;
        yield* forkParked(
          Effect.gen(function* () {
            const snapshot = yield* query.getShellSnapshot();
            for (const thread of snapshot.threads)
              if (thread.promptQueueSummary?.preparation?.state === "pending")
                yield* schedule(thread.id);
            yield* noteSeen(snapshot.snapshotSequence);
            yield* Stream.runForEach(events, (event) =>
              (event.type === "thread.prompt-queue-changed" ||
              event.type === "thread.deleted" ||
              event.type === "thread.session-stop-requested"
                ? schedule(
                    event.payload.threadId,
                    event.type === "thread.prompt-queue-changed"
                      ? event.payload.stopCommandId
                      : event.type === "thread.session-stop-requested"
                        ? (event.commandId ?? undefined)
                        : undefined,
                  ).pipe(Effect.ignoreCause({ log: true }))
                : Effect.void
              ).pipe(Effect.andThen(noteSeen(event.sequence))),
            );
          }).pipe(Effect.ignoreCause({ log: true })),
        );
      }),
    drain: Effect.gen(function* () {
      const target = yield* engine.latestSequence;
      yield* SubscriptionRef.changes(seenSequence).pipe(
        Stream.filter((seen) => seen >= target),
        Stream.runHead,
      );
      yield* Effect.forEach([...workers.values()], ({ fiber }) => Fiber.await(fiber), {
        discard: true,
      });
    }),
    drainAttemptThrough: (threadId, attemptId, sequence) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.changes(seenSequence).pipe(
          Stream.filter((seen) => seen >= sequence),
          Stream.runHead,
        );
        const worker = workers.get(threadId);
        if (worker?.attemptId === attemptId) yield* Fiber.await(worker.fiber);
      }),
  });
});

export const layer = Layer.effect(ThreadPreparationReactor, make);
