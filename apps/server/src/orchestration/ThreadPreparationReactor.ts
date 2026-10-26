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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerConfig } from "../config.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { WorktreeSetupTracker } from "../project/WorktreeSetupTracker.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
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
  const snapshot = yield* query.getShellSnapshot();
  const activities = yield* query.listActivitiesByKind(WORKTREE_SETUP_ACTIVITY_KIND);
  const interruptedLegacyThreads = new Set(
    activities.flatMap((activity) => {
      const setup = decodeSetup(activity.payload);
      return Option.isSome(setup) &&
        activity.id === worktreeSetupActivityId(setup.value.threadId) &&
        setup.value.phase !== "done" &&
        !setup.value.stages.some((stage) => stage.id === "agent" && stage.status === "done")
        ? [setup.value.threadId]
        : [];
    }),
  );
  const createdAt = yield* now;
  for (const shell of snapshot.threads) {
    const summary = shell.promptQueueSummary;
    if (!summary) continue;
    if (
      summary.preparation
        ? summary.preparation.state !== "running" && summary.preparation.settled
        : !interruptedLegacyThreads.has(shell.id)
    )
      continue;
    const detailed = yield* query.getThreadDetailById(shell.id);
    if (Option.isNone(detailed)) continue;
    const previous = detailed.value.promptQueue?.preparation;
    if (previous && previous.state !== "running" && previous.settled) continue;
    if (!previous && !interruptedLegacyThreads.has(shell.id)) continue;
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
            state: "failed",
            settled: true,
            revision: previous.revision + 1,
            failure: {
              reason: "interrupted",
              detail: "The server restarted during setup. Retry setup and resume when ready.",
            },
          }
        : {
            originalCommandId: commandId,
            attemptId: commandId,
            revision: 0,
            state: "failed",
            settled: true,
            recipe: null,
            failure: {
              reason: "legacy-needs-review",
              detail:
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
  const terminal = yield* TerminalManager;
  const settingsService = yield* ServerSettingsService;
  const deletion = yield* ThreadDeletionReactor;
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const workers = new Map<ThreadId, { fiber: Fiber.Fiber<void>; attemptId: CommandId }>();
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
  ) {
    const closed = terminalId
      ? yield* terminal
          .close({ threadId, terminalId, waitForProcessExit: true })
          .pipe(Effect.result)
      : undefined;
    const closeFailure =
      closed?._tag === "Failure"
        ? `Setup could not be stopped. Choose Stop setup again before retrying. ${closed.failure.message}`
        : undefined;
    const current = (yield* read(threadId))?.promptQueue?.preparation;
    if (!current || current.attemptId !== accepted.attemptId || current.state === "ready") return;
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
      if (!latest || latest.attemptId !== accepted.attemptId || latest.state === "ready") return;
      const saved = yield* update(threadId, latest, {
        ...latest,
        revision: latest.revision + 1,
        state: "failed",
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
      let running: ThreadPreparation = {
        ...preparation,
        target,
        script,
        state: "running",
        settled: false,
        revision: preparation.revision + 1,
      };
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
        );
      }
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
            observeCompletion: {
              onOutputLine: (line) => tracker.appendTail(threadId, "setup-script", line),
            },
          })
          .pipe(Effect.result);
        if (launched._tag === "Failure") {
          yield* tracker.stageStatus(threadId, "setup-script", "failed", launched.failure.message);
          if (!script.async) return yield* launched.failure;
        } else if (launched.success.status === "started" && launched.success.completion) {
          const completion = launched.success.completion.pipe(
            Effect.flatMap((result) =>
              Effect.gen(function* () {
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
        } else if (!script.async)
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
        settled: true,
      });
      yield* tracker.stageStatus(threadId, "agent", "done");
      if (backgroundCompletion) {
        const progress = yield* tracker.get(threadId);
        if (progress) yield* record(progress, accepted.attemptId);
        yield* backgroundCompletion;
      }
      // Background progress is still owned here, while ready already permits delivery.
      yield* finish(threadId, accepted.attemptId, "done");
    });
    yield* program.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (exit._tag === "Success") return;
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
          );
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.ignoreCause({ log: true }),
    );
  });

  const schedule = Effect.fn("ThreadPreparationReactor.schedule")(function* (
    threadId: ThreadId,
    retryCancellation = false,
  ) {
    const thread = yield* read(threadId);
    const preparation = thread?.promptQueue?.preparation;
    const active = workers.get(threadId);
    if (active) {
      if (
        !preparation ||
        preparation.state === "failed" ||
        preparation.attemptId !== active.attemptId
      )
        yield* Fiber.interrupt(active.fiber);
      if (!preparation || preparation.attemptId === active.attemptId) return;
    }
    if (!preparation) return;
    const retryStop = retryCancellation && preparation.state === "failed" && !preparation.settled;
    if (
      !retryStop &&
      (thread?.archivedAt !== null ||
        preparation.state !== "pending" ||
        !thread?.promptQueue?.enabled)
    )
      return;
    const gate = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(gate).pipe(
      Effect.andThen(
        retryStop
          ? settleAttempt(
              threadId,
              preparation,
              `setup-${preparation.attemptId}`,
              "Setup stopped. Retry setup and resume when ready.",
              "cancelled",
              false,
              false,
            ).pipe(Effect.uninterruptible, Effect.ignoreCause({ log: true }))
          : run(threadId, preparation),
      ),
      Effect.ensuring(Effect.sync(() => workers.delete(threadId))),
      Effect.forkIn(scope),
    );
    workers.set(threadId, { fiber, attemptId: preparation.attemptId });
    yield* Deferred.succeed(gate, undefined);
  });

  return ThreadPreparationReactor.of({
    start: () =>
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* forkParked(
          Effect.gen(function* () {
            const snapshot = yield* query.getShellSnapshot();
            for (const thread of snapshot.threads)
              if (thread.promptQueueSummary?.preparation?.state === "pending")
                yield* schedule(thread.id);
            yield* noteSeen(snapshot.snapshotSequence);
            yield* Stream.runForEach(events, (event) =>
              (event.type === "thread.prompt-queue-changed" || event.type === "thread.deleted"
                ? schedule(
                    event.payload.threadId,
                    event.type === "thread.prompt-queue-changed" &&
                      event.payload.control?.pauseReason?.code === "stopped",
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
