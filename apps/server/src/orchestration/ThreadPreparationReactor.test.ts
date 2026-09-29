import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  worktreeSetupActivityId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadPreparation,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { PtySpawnError, type PtyProcess, type PtyExitEvent } from "../terminal/PtyAdapter.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import * as ThreadPreparationReactor from "./ThreadPreparationReactor.ts";

const projectId = ProjectId.make("preparation-project");
const threadId = ThreadId.make("preparation-thread");
const createdAt = "2026-09-28T12:00:00.000Z";

const makeHarness = Effect.fn("ThreadPreparationTest.makeHarness")(function* (options?: {
  readonly async?: boolean;
  readonly launchFailure?: boolean;
  readonly beforeWorkspace?: Effect.Effect<void>;
  readonly beforeDeletionDrain?: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preparation-project-" });
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const updates = yield* Queue.unbounded<ThreadPreparation>();
  const writes = yield* Queue.unbounded<string>();
  const signals = yield* Queue.unbounded<string | undefined>();
  const dispatchLock = yield* Semaphore.make(1);
  const commands: OrchestrationCommand[] = [];
  const receipts = new Map<CommandId, { sequence: number }>();
  let state: OrchestrationReadModel = createEmptyReadModel(createdAt);
  let worktreeCreates = 0;
  let claimedPath: string | undefined;
  let closeCount = 0;
  const controls = {
    launchFailure: options?.launchFailure ?? false,
    signalFailure: false,
    exitOnSignal: true,
  };
  const outputs = new Set<(data: string) => void>();
  const exits = new Set<(event: PtyExitEvent) => void>();
  const process: PtyProcess = {
    pid: 9_999_999,
    write: (data) => {
      Queue.offerUnsafe(writes, data);
    },
    resize: () => {},
    kill: (signal) => {
      Queue.offerUnsafe(signals, signal);
      if (controls.signalFailure) throw new Error("Signal denied");
      if (signal !== "SIGKILL") closeCount++;
      if (controls.exitOnSignal)
        for (const listener of exits) listener({ exitCode: 0, signal: null });
    },
    onData: (listener) => {
      outputs.add(listener);
      return () => {
        outputs.delete(listener);
      };
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => {
        exits.delete(listener);
      };
    },
  };
  // The real manager acquires the same workspace lease as preparation. Only the PTY is fake.
  const terminal = yield* TerminalManager.makeWithOptions({
    logsDir: path.join(config.baseDir, "preparation-terminal-logs"),
    ptyAdapter: {
      spawn: (input) =>
        controls.launchFailure
          ? Effect.fail(
              new PtySpawnError({ adapter: "test", shell: input.shell, cause: "launch failed" }),
            )
          : Effect.succeed(process),
    },
    shellResolver: () => "/bin/sh",
    env: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
    processTable: Effect.succeed([]),
    processKillGraceMs: 1,
  }).pipe(Effect.provide(ProcessRunner.layer));
  const dispatch: OrchestrationEngineService["Service"]["dispatch"] = (command) =>
    dispatchLock.withPermit(
      Effect.gen(function* () {
        const receipt = receipts.get(command.commandId);
        if (receipt) return receipt;
        const planned = yield* decideOrchestrationCommand({ command, readModel: state }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.catch((cause) =>
            isOrchestrationCommandRejection(cause) ? Effect.fail(cause) : Effect.die(cause),
          ),
        );
        const committed: OrchestrationEvent[] = [];
        let next = state;
        for (const item of Array.isArray(planned) ? planned : [planned]) {
          const event = { ...item, sequence: next.snapshotSequence + 1 };
          next = yield* projectEvent(next, event).pipe(Effect.orDie);
          committed.push(event);
        }
        state = next;
        commands.push(command);
        const result = { sequence: state.snapshotSequence };
        receipts.set(command.commandId, result);
        for (const event of committed) {
          yield* PubSub.publish(events, event);
          if (event.type === "thread.prompt-queue-changed" && event.payload.preparation)
            yield* Queue.offer(updates, event.payload.preparation);
        }
        return result;
      }),
    );
  const engine = Layer.mock(OrchestrationEngineService, {
    dispatch,
    latestSequence: Effect.sync(() => state.snapshotSequence),
    subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    streamDomainEvents: Stream.fromPubSub(events),
  });
  const query = Layer.mock(ProjectionSnapshotQuery, {
    getThreadSubscriptionAnchor: () =>
      Effect.sync(() =>
        Option.some({
          projectId,
          creationSequence: 2,
          snapshotSequence: state.snapshotSequence,
        }),
      ),
    getThreadDetailById: () =>
      Effect.sync(() =>
        Option.fromNullishOr(
          state.threads.find((thread) => thread.id === threadId && !thread.deletedAt),
        ),
      ),
    getProjectShellById: () => Effect.sync(() => Option.fromNullishOr(state.projects[0])),
    getShellSnapshot: () =>
      Effect.sync(() => ({
        ...state,
        threads: state.threads
          .filter((thread) => !thread.deletedAt)
          .map((thread) => ({
            ...thread,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            ...(thread.promptQueue
              ? {
                  promptQueueSummary: {
                    count: thread.promptQueue.entries.length,
                    enabled: thread.promptQueue.enabled,
                    pauseReason: thread.promptQueue.pauseReason,
                    ...(thread.promptQueue.preparation
                      ? { preparation: thread.promptQueue.preparation }
                      : {}),
                  },
                }
              : {}),
          })),
      })),
    listActivitiesByKind: (kind) =>
      Effect.sync(() =>
        state.threads.flatMap((thread) =>
          thread.activities.filter((activity) => activity.kind === kind),
        ),
      ),
  });
  const settings = ServerSettingsService.layerTest();
  const terminalLayer = Layer.succeed(TerminalManager.TerminalManager, terminal);
  const runner = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(Layer.mergeAll(query, settings, terminalLayer)),
  );
  const services = Layer.mergeAll(
    engine,
    query,
    settings,
    terminalLayer,
    runner,
    WorktreeSetupTracker.layer,
    Layer.mock(ThreadDeletionReactor, {
      drainThrough: () => options?.beforeDeletionDrain ?? Effect.void,
    }),
    Layer.mock(GitWorkflowService, {
      isRepository: () => Effect.succeed(true),
      hasCommit: () => Effect.succeed(true),
      listRefs: () =>
        Effect.succeed({
          refs: claimedPath
            ? [
                {
                  name: "t3code/preparation",
                  worktreePath: claimedPath,
                  current: false,
                  isDefault: false,
                },
              ]
            : [],
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: claimedPath ? 1 : 0,
        }),
      createWorktree: (input) =>
        Effect.gen(function* () {
          yield* options?.beforeWorkspace ?? Effect.void;
          worktreeCreates++;
          claimedPath = input.path!;
          yield* fs.makeDirectory(claimedPath, { recursive: true }).pipe(Effect.orDie);
          return { worktree: { path: claimedPath, refName: input.newRefName ?? input.refName } };
        }),
    }),
  );
  const script = {
    id: "setup",
    name: "Setup",
    command: "echo setup",
    icon: "configure" as const,
    runOnWorktreeCreate: true,
    ...(options?.async === undefined ? {} : { async: options.async }),
  };
  yield* dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Project",
    workspaceRoot: projectCwd,
    createdAt,
  });
  yield* dispatch({
    type: "project.meta.update",
    commandId: CommandId.make("setup-script"),
    projectId,
    scripts: [script],
  });
  const enqueue = (id: string, bootstrap = false) =>
    dispatch({
      type: "thread.prompt.enqueue",
      commandId: CommandId.make(`enqueue:${id}`),
      threadId,
      message: { messageId: MessageId.make(id), text: id, attachments: [] },
      author: { userId: id, displayName: id, imageUrl: null },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
      ...(bootstrap
        ? {
            bootstrap: {
              createThread: {
                projectId,
                title: "Shared preparation",
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd,
                baseBranch: "main",
                branch: "t3code/preparation",
                requireWorktree: true,
              },
              runSetupScript: true,
            },
          }
        : {}),
    });
  const awaitPreparation = Effect.fn("awaitPreparation")(function* (
    predicate: (preparation: ThreadPreparation) => boolean,
  ) {
    while (true) {
      const preparation = yield* Queue.take(updates);
      if (predicate(preparation)) return preparation;
    }
  });
  return {
    layer: ThreadPreparationReactor.layer.pipe(Layer.provideMerge(services)),
    dispatch,
    enqueue,
    awaitPreparation,
    commands,
    controls,
    state: () => state,
    restore: (snapshot: OrchestrationReadModel) => {
      state = snapshot;
    },
    get worktreeCreates() {
      return worktreeCreates;
    },
    get closeCount() {
      return closeCount;
    },
    nextScript: Queue.take(writes),
    nextSignal: Queue.take(signals),
    closeFromUI: terminal.close({ threadId }),
    closeTerminal: Effect.sync(() => {
      for (const listener of exits) listener({ exitCode: 0, signal: null });
    }),
    complete: (command: string, exitCode: number) =>
      Effect.sync(() => {
        const sentinel = /__T3_SETUP_DONE___[a-f0-9]+:/.exec(command)?.[0];
        if (!sentinel) throw new Error("Missing setup completion sentinel");
        for (const listener of outputs) listener(`${sentinel}${exitCode}\n`);
      }),
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-preparation-tests-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer, { excludeTestServices: true })("ThreadPreparationReactor", (it) => {
  it.effect(
    "accepts teammates before setup and waits for deletion cleanup and successful script completion",
    () =>
      Effect.gen(function* () {
        const draining = yield* Deferred.make<void>();
        const releaseDeletion = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseDeletion, undefined));
        const h = yield* makeHarness({
          async: false,
          beforeDeletionDrain: Deferred.succeed(draining, undefined).pipe(
            Effect.andThen(Deferred.await(releaseDeletion)),
          ),
        });
        yield* h.enqueue("alice", true);
        yield* h.enqueue("bob");
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          yield* reactor.start();
          yield* Deferred.await(draining);
          expect(h.worktreeCreates).toBe(0);
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          expect(yield* tracker.get(threadId)).toBeNull();
          expect(
            h.state().threads[0]?.promptQueue?.entries.map((entry) => entry.author?.userId),
          ).toEqual(["alice", "bob"]);
          yield* Deferred.succeed(releaseDeletion, undefined);
          const command = yield* h.nextScript;
          expect(h.state().threads[0]?.promptQueue?.preparation?.state).toBe("running");
          const runningQueue = h.state().threads[0]!.promptQueue!;
          expect(h.state().threads[0]?.worktreePath).toBe(
            runningQueue.preparation?.target?.worktreePath,
          );
          const delivery = yield* h
            .dispatch({
              type: "thread.prompt.claim",
              commandId: CommandId.make("premature-claim"),
              threadId,
              messageId: MessageId.make("alice"),
              expectedRevision: runningQueue.entries[0]!.revision,
              expectedControlRevision: runningQueue.revision,
              createdAt,
            })
            .pipe(Effect.result);
          expect(delivery._tag).toBe("Failure");
          yield* h.complete(command, 0);
          const ready = yield* h.awaitPreparation((preparation) => preparation.state === "ready");
          yield* reactor.drain;
          expect(h.state().threads[0]?.worktreePath).toBe(ready.target?.worktreePath);
          expect(h.state().threads[0]?.messages).toEqual([]);
          expect(h.worktreeCreates).toBe(1);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["exit", "launch", "closed"] as const)(
    "wait-script %s failure retains prompts and retries the same workspace",
    (failure) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ async: false, launchFailure: failure === "launch" });
        yield* h.enqueue("alice", true);
        yield* h.enqueue("bob");
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          yield* reactor.start();
          if (failure === "exit") yield* h.complete(yield* h.nextScript, 7);
          if (failure === "closed") {
            yield* h.nextScript;
            yield* h.closeTerminal;
          }
          const failed = yield* h.awaitPreparation(
            (preparation) => preparation.state === "failed" && preparation.settled,
          );
          yield* reactor.drain;
          expect(h.state().threads[0]?.promptQueue?.enabled).toBe(false);
          expect(
            h.state().threads[0]?.promptQueue?.entries.map((entry) => entry.messageId),
          ).toEqual(["alice", "bob"]);
          h.controls.launchFailure = false;
          yield* h.dispatch({
            type: "thread.preparation.retry",
            commandId: CommandId.make("retry-setup"),
            threadId,
            expectedRevision: failed.revision,
            expectedControlRevision: h.state().threads[0]!.promptQueue!.revision,
            createdAt,
          });
          yield* h.complete(yield* h.nextScript, 0);
          yield* h.awaitPreparation((preparation) => preparation.state === "ready");
          yield* reactor.drain;
          expect(h.worktreeCreates).toBe(1);
          expect(h.state().threads[0]?.promptQueue?.enabled).toBe(true);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect(
    "background setup is ready before script completion and a failed exit does not pause the queue",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.enqueue("alice", true);
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          yield* reactor.start();
          const command = yield* h.nextScript;
          yield* h.awaitPreparation((preparation) => preparation.state === "ready");
          yield* h.complete(command, 9);
          yield* reactor.drain;
          expect(h.state().threads[0]?.promptQueue?.enabled).toBe(true);
          expect(h.state().threads[0]?.promptQueue?.preparation?.state).toBe("ready");
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("Stop settles the setup terminal and retains both accepted prompts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ async: false });
      yield* h.enqueue("alice", true);
      yield* h.enqueue("bob");
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
        yield* reactor.start();
        yield* h.nextScript;
        yield* h.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("stop-setup"),
          threadId,
          createdAt,
        });
        yield* h.awaitPreparation(
          (preparation) => preparation.state === "failed" && preparation.settled,
        );
        yield* reactor.drain;
        expect(h.closeCount).toBe(1);
        expect(h.state().threads[0]?.promptQueue?.enabled).toBe(false);
        expect(h.state().threads[0]?.promptQueue?.entries.map((entry) => entry.messageId)).toEqual([
          "alice",
          "bob",
        ]);
        expect(h.commands.some((command) => command.type === "thread.delete")).toBe(false);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "Stop while deletion cleanup is pending never registers setup or acquires its workspace",
    () =>
      Effect.gen(function* () {
        const draining = yield* Deferred.make<void>();
        const releaseDeletion = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseDeletion, undefined));
        const h = yield* makeHarness({
          beforeDeletionDrain: Deferred.succeed(draining, undefined).pipe(
            Effect.andThen(Deferred.await(releaseDeletion)),
          ),
        });
        yield* h.enqueue("alice", true);
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
          yield* reactor.start();
          yield* Deferred.await(draining);
          yield* h.dispatch({
            type: "thread.queue.pause",
            commandId: CommandId.make("stop-before-setup"),
            threadId,
            createdAt,
          });
          yield* h.awaitPreparation(
            (preparation) => preparation.state === "failed" && preparation.settled,
          );
          yield* reactor.drain;
          expect(yield* tracker.get(threadId)).toBeNull();
          expect(h.worktreeCreates).toBe(0);
          expect(h.closeCount).toBe(0);
          expect(h.state().threads[0]?.promptQueue?.entries[0]?.messageId).toBe("alice");
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["pending", "running", "ready"] as const)(
    "restart reconciliation preserves safe %s preparation boundaries",
    (state) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.enqueue("alice", true);
        const previous = h.state().threads[0]!.promptQueue!.preparation!;
        if (state !== "pending")
          yield* h.dispatch({
            type: "thread.preparation.update",
            commandId: CommandId.make(`seed-${state}`),
            threadId,
            expectedRevision: previous.revision,
            preparation: {
              ...previous,
              revision: previous.revision + 1,
              state,
              settled: state === "ready",
              script: {
                id: "setup",
                name: "Setup",
                command: "echo setup",
                async: state === "ready",
              },
            },
            createdAt,
          });
        yield* ThreadPreparationReactor.reconcileSharedPreparations.pipe(Effect.provide(h.layer));
        const queue = h.state().threads[0]!.promptQueue!;
        expect(queue.preparation?.state).toBe(state === "running" ? "failed" : state);
        expect(queue.preparation?.settled).toBe(true);
        expect(queue.enabled).toBe(state !== "running");
        if (state === "running") expect(queue.preparation?.failure?.reason).toBe("interrupted");
        expect(queue.entries[0]?.messageId).toBe("alice");
        expect(h.worktreeCreates).toBe(0);
      }),
  );

  it.effect("Stop cancels a running checkout before script launch and settles before retry", () =>
    Effect.gen(function* () {
      const creating = yield* Deferred.make<void>();
      const releaseWorkspace = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseWorkspace, undefined));
      const h = yield* makeHarness({
        async: false,
        beforeWorkspace: Deferred.succeed(creating, undefined).pipe(
          Effect.andThen(Deferred.await(releaseWorkspace)),
        ),
      });
      yield* h.enqueue("alice", true);
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
        yield* reactor.start();
        yield* Deferred.await(creating);
        yield* h.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("stop-checkout"),
          threadId,
          createdAt,
        });
        const failed = yield* h.awaitPreparation(
          (preparation) => preparation.state === "failed" && preparation.settled,
        );
        yield* reactor.drain;
        expect(h.worktreeCreates).toBe(0);
        expect(h.closeCount).toBe(0);
        yield* Deferred.succeed(releaseWorkspace, undefined);
        yield* h.dispatch({
          type: "thread.preparation.retry",
          commandId: CommandId.make("retry-checkout"),
          threadId,
          expectedRevision: failed.revision,
          expectedControlRevision: h.state().threads[0]!.promptQueue!.revision,
          createdAt,
        });
        yield* h.complete(yield* h.nextScript, 0);
        yield* h.awaitPreparation((preparation) => preparation.state === "ready");
        yield* reactor.drain;
        expect(h.worktreeCreates).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect.each([false, true])(
    "Retry waits for observed old-process exit after Stop (initial signal failure: %s)",
    (signalFailure) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ async: false });
        yield* h.enqueue("alice", true);
        yield* h.enqueue("bob");
        h.controls.exitOnSignal = false;
        h.controls.signalFailure = signalFailure;
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          yield* reactor.start();
          yield* h.nextScript;
          yield* h.dispatch({
            type: "thread.queue.pause",
            commandId: CommandId.make("stop-script"),
            threadId,
            createdAt,
          });
          yield* h.nextSignal;
          if (signalFailure) {
            yield* h.awaitPreparation(
              (preparation) =>
                preparation.failure?.detail.includes("could not be stopped") === true,
            );
            yield* reactor.drain;
          }
          const stopped = h.state().threads[0]!.promptQueue!;
          expect(stopped.preparation?.settled).toBe(false);
          const premature = yield* h
            .dispatch({
              type: "thread.preparation.retry",
              commandId: CommandId.make("retry-too-soon"),
              threadId,
              expectedRevision: stopped.preparation!.revision,
              expectedControlRevision: stopped.revision,
              createdAt,
            })
            .pipe(Effect.result);
          expect(premature._tag).toBe("Failure");
          if (signalFailure) {
            h.controls.signalFailure = false;
            yield* h.dispatch({
              type: "thread.queue.pause",
              commandId: CommandId.make("stop-script-again"),
              threadId,
              createdAt,
            });
            yield* h.nextSignal;
            expect(h.state().threads[0]?.promptQueue?.preparation?.settled).toBe(false);
          }
          yield* h.closeTerminal;
          const settled = yield* h.awaitPreparation(
            (preparation) => preparation.state === "failed" && preparation.settled,
          );
          yield* reactor.drain;
          h.controls.exitOnSignal = true;
          yield* h.dispatch({
            type: "thread.preparation.retry",
            commandId: CommandId.make("retry-after-exit"),
            threadId,
            expectedRevision: settled.revision,
            expectedControlRevision: h.state().threads[0]!.promptQueue!.revision,
            createdAt,
          });
          yield* h.complete(yield* h.nextScript, 0);
          yield* h.awaitPreparation((preparation) => preparation.state === "ready");
          yield* reactor.drain;
          expect(
            h.state().threads[0]?.promptQueue?.entries.map((entry) => entry.messageId),
          ).toEqual(["alice", "bob"]);
          expect(h.worktreeCreates).toBe(1);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("ordinary UI close cannot mark required setup settled before its process exits", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ async: false });
      yield* h.enqueue("alice", true);
      h.controls.exitOnSignal = false;
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
        yield* reactor.start();
        yield* h.nextScript;
        const closing = yield* h.closeFromUI.pipe(Effect.forkScoped);
        yield* h.nextSignal;
        expect(closing.pollUnsafe()).toBeUndefined();
        expect(h.state().threads[0]?.promptQueue?.preparation?.settled).toBe(false);
        yield* h.closeTerminal;
        yield* Fiber.join(closing);
        yield* h.awaitPreparation(
          (preparation) => preparation.state === "failed" && preparation.settled,
        );
        yield* reactor.drain;
        expect(h.state().threads[0]?.promptQueue?.entries[0]?.messageId).toBe("alice");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("late setup progress cannot write into a recreated thread with the same id", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ async: false });
      yield* h.enqueue("alice", true);
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
        yield* reactor.start();
        yield* h.complete(yield* h.nextScript, 0);
        yield* h.awaitPreparation((preparation) => preparation.state === "ready");
        yield* reactor.drain;
      }).pipe(Effect.provide(h.layer));
      const progress = h.commands.find(
        (command) => command.type === "thread.activity.append" && command.preparationAttemptId,
      );
      if (!progress || progress.type !== "thread.activity.append")
        throw new Error("Missing setup progress");
      yield* h.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-old-thread"),
        threadId,
      });
      yield* h.enqueue("new-thread-author", true);
      const result = yield* h
        .dispatch({ ...progress, commandId: CommandId.make("delayed-old-progress") })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(h.state().threads.find((thread) => !thread.deletedAt)?.activities).toEqual([]);
      expect(
        h.state().threads.find((thread) => !thread.deletedAt)?.promptQueue?.entries[0]?.messageId,
      ).toBe("new-thread-author");
    }),
  );

  it.effect(
    "legacy interrupted setup blocks ordinary Resume and Work locally keeps the accepted prompts",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.enqueue("alice", true);
        yield* h.enqueue("bob");
        const snapshot = h.state();
        const old = snapshot.threads[0]!;
        const { preparation: _preparation, ...queue } = old.promptQueue!;
        h.restore({
          ...snapshot,
          threads: [
            {
              ...old,
              promptQueue: queue,
              activities: [
                {
                  id: EventId.make("unrelated-setup"),
                  kind: "worktree-setup",
                  summary: "Preparing",
                  tone: "info",
                  turnId: null,
                  createdAt,
                  payload: {
                    threadId,
                    phase: "running",
                    startedAt: createdAt,
                    endedAt: null,
                    branch: "old",
                    baseRef: "main",
                    worktreePath: null,
                    setupScript: null,
                    stages: [
                      {
                        id: "agent",
                        status: "pending",
                        startedAt: null,
                        endedAt: null,
                        percent: null,
                        detail: null,
                        tail: [],
                      },
                    ],
                    error: null,
                    sequence: 0,
                  },
                },
              ],
            },
          ],
        });
        yield* Effect.gen(function* () {
          yield* ThreadPreparationReactor.reconcileSharedPreparations;
          expect(h.state().threads[0]!.promptQueue?.preparation).toBeUndefined();
          expect(h.state().threads[0]!.promptQueue?.enabled).toBe(true);
          h.restore({
            ...h.state(),
            threads: h.state().threads.map((thread) => ({
              ...thread,
              activities: thread.activities.map((activity) => ({
                ...activity,
                id: EventId.make(worktreeSetupActivityId(thread.id)),
              })),
            })),
          });
          yield* ThreadPreparationReactor.reconcileSharedPreparations;
          const blocked = h.state().threads[0]!.promptQueue!;
          expect(blocked.preparation?.failure?.reason).toBe("legacy-needs-review");
          const resumed = yield* h
            .dispatch({
              type: "thread.queue.resume",
              commandId: CommandId.make("unsafe-resume"),
              threadId,
              expectedRevision: blocked.revision,
              createdAt,
            })
            .pipe(Effect.result);
          expect(resumed._tag).toBe("Failure");
          yield* h.dispatch({
            type: "thread.preparation.retry",
            commandId: CommandId.make("work-locally"),
            threadId,
            target: "project",
            expectedRevision: blocked.preparation!.revision,
            expectedControlRevision: blocked.revision,
            createdAt,
          });
          const reactor = yield* ThreadPreparationReactor.ThreadPreparationReactor;
          yield* reactor.start();
          yield* h.awaitPreparation((preparation) => preparation.state === "ready");
          yield* reactor.drain;
          expect(h.state().threads[0]?.worktreePath).toBeNull();
          expect(
            h.state().threads[0]?.promptQueue?.entries.map((entry) => entry.messageId),
          ).toEqual(["alice", "bob"]);
          expect(h.worktreeCreates).toBe(0);
          expect(
            h.commands.filter((command) => command.type === "thread.prompt.enqueue"),
          ).toHaveLength(2);
        }).pipe(Effect.provide(h.layer));
      }),
  );
});
