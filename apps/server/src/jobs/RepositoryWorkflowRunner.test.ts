import { TerminalManager } from "../terminal/Manager.ts";
import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationThread,
  OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  TurnId,
  CheckpointRef,
  EventId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { type RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { SetupProcessJournal, SetupProcessError } from "../terminal/SetupProcessJournal.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { ApprovalVerdictGenerationInput } from "../textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Store from "./WorkflowRunStore.ts";
import { make, type WorkflowRequest } from "./RepositoryWorkflowRunner.ts";
import { decidePromptQueueCommand } from "../orchestration/promptQueueDecider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationProjectorDecodeError,
} from "../orchestration/Errors.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const decodeProject = Schema.decodeUnknownEffect(OrchestrationProjectShell);
const decodeProvider = Schema.decodeUnknownEffect(ServerProvider);

const NOW = "2026-10-08T12:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const PROJECT = ProjectId.make("project-workflow");
const workflow: RepositoryWorkflow = {
  workflowId: "workflow-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  revision: 1,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  definition: {
    name: "Implement and review",
    environmentId: EnvironmentId.make("env-1"),
    projectId: PROJECT,
    steps: [
      {
        id: "agent",
        kind: "agent",
        title: "Implement",
        instruction: "Implement the change",
        modelSelection: null,
      },
      { id: "review", kind: "review", title: "Review", role: "maintainer" },
    ],
  },
};
const request = (jobId = "job-1"): WorkflowRequest => ({
  jobId,
  userId: "user-1",
  repositoryCanonicalKey: "github.com/acme/repo",
  instruction: "Fix the requested issue",
  control: {
    operation: "start",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    workflow,
  },
});
const control = (operation: "status" | "cancel", jobId = "job-1"): WorkflowRequest => ({
  ...request(jobId),
  control: { operation, organizationId: "org-1", repositoryId: "repo-1", projectId: PROJECT },
});
const retryRequest = (expectedRevision: number): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "retry_preparation",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision,
  },
});
const retryCancellation = (expectedRevision: number): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "retry_cancellation",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision,
  },
});

function thread(jobId = "job-1"): OrchestrationThread {
  return decodeThread({
    id: `workflow:${jobId}:agent`,
    projectId: PROJECT,
    title: "Implement",
    modelSelection: MODEL,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
    promptQueue: {
      enabled: true,
      revision: 0,
      pauseReason: null,
      entries: [],
      handoff: null,
      awaitingTurnId: null,
      admissions: [],
      finalizedTurnId: null,
      preparation: {
        originalCommandId: `workflow:${jobId}:start`,
        attemptId: `workflow:${jobId}:start`,
        revision: 0,
        state: "pending",
        settled: true,
        recipe: { projectCwd: "/repo", runSetupScript: true },
      },
    },
  });
}
function completed(previous: OrchestrationThread): OrchestrationThread {
  const jobId = previous.id.split(":")[1]!;
  const turnId = TurnId.make(`${jobId}-turn`);
  return {
    ...previous,
    branch: `t3-job/${jobId}`,
    worktreePath: `/jobs/${jobId}`,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    checkpoints: [
      {
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make(`refs/t3/${jobId}/turn/1`),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: NOW,
      },
    ],
    promptQueue: {
      ...previous.promptQueue!,
      preparation: {
        ...previous.promptQueue!.preparation!,
        state: "ready",
        settled: true,
        target: { branch: `t3-job/${jobId}`, worktreePath: `/jobs/${jobId}` },
      },
      admissions: [
        {
          attemptId: CommandId.make(`admit-${jobId}`),
          messageId: MessageId.make(`workflow:${jobId}:prompt`),
          turnId,
          evidence: "provider-ack",
        },
      ],
      finalizedTurnId: turnId,
    },
    session: {
      threadId: previous.id,
      status: "ready",
      runtimeMode: "approval-required",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
  };
}

const persistence = Store.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.gen(function* () {
  const currentThread = yield* Ref.make<OrchestrationThread | null>(null);
  const runs = yield* Queue.unbounded<Store.WorkflowRun>();
  const cleanups = yield* Queue.unbounded<string>();
  const cleanupOutcomes = yield* Queue.unbounded<string | null>();
  const confirmedCleanup = yield* Ref.make(false);
  const settlementMode = yield* Ref.make<"normal" | "reject" | "race">("normal");
  const finalWriteFailures = yield* Ref.make(0);
  const stored = yield* Store.WorkflowRunStore;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const modelCalls = yield* Queue.unbounded<ApprovalVerdictGenerationInput>();
  const receipts = new Map<string, OrchestrationCommandInvariantError | null>();
  const retryMode = yield* Ref.make<"normal" | "before_retry" | "after_retry" | "reject_retry">(
    "normal",
  );
  const dismissalMode = yield* Ref.make<
    "normal" | "before_dismiss" | "after_dismiss" | "reject_dismiss" | "change_revision"
  >("normal");
  const difference = yield* Ref.make("");
  const head = yield* Ref.make("base-sha");
  const branch = yield* Ref.make("t3-job/job-1");
  const project = yield* decodeProject({
    id: PROJECT,
    title: "Repo",
    workspaceRoot: "/repo",
    defaultModelSelection: MODEL,
    createdAt: NOW,
    updatedAt: NOW,
    scripts: [],
  });
  const provider = yield* decodeProvider({
    instanceId: MODEL.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
  });
  const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider]);
  const repositoryKey = yield* Ref.make("github.com/acme/repo");
  const cleanupReceipt = (input: { threadId: string; attemptId: string }) => ({
    ...input,
    terminalId: "setup-" + input.attemptId,
    pid: null,
    identity: null,
    source: "not-delivered" as const,
  });
  const mocks = Layer.mergeAll(
    Layer.mock(TerminalManager, { closeOwned: () => Effect.succeed(false) }),
    Layer.succeed(Store.WorkflowRunStore, {
      ...stored,
      save: (run) =>
        Effect.gen(function* () {
          const failures = yield* Ref.get(finalWriteFailures);
          if (failures > 0 && (run.progress.status === "done" || run.progress.retryableApproval)) {
            yield* Ref.update(finalWriteFailures, (n) => n - 1);
            return yield* Effect.die("Injected final-state write outage");
          }
          return yield* stored.save(run).pipe(Effect.tap(() => Queue.offer(runs, run)));
        }),
    }),
    Layer.succeed(SetupProcessJournal, {
      owners: () => Effect.succeed([]),
      launcher: Effect.succeed("/native/helper"),
      confirmed: () => Ref.get(confirmedCleanup),
      begin: () => Effect.void,
      capture: () => Effect.succeed("/bin/sh"),
      complete: () => Effect.void,
      recover: (input) => Effect.succeed(cleanupReceipt(input)),
      cleanup: (input) =>
        Effect.gen(function* () {
          yield* Queue.offer(cleanups, input.commandId);
          const detail = yield* Queue.take(cleanupOutcomes);
          if (detail) return yield* new SetupProcessError({ message: detail });
          yield* Ref.set(confirmedCleanup, true);
          return cleanupReceipt(input);
        }),
    }),
    Layer.mock(OrchestrationCommandReceiptRepository)({
      getByCommandId: ({ commandId }) =>
        Effect.succeed(
          receipts.has(commandId)
            ? Option.some({
                commandId,
                aggregateKind: "thread" as const,
                aggregateId: ThreadId.make("workflow:job-1:agent"),
                acceptedAt: NOW,
                resultSequence: 1,
                status: receipts.get(commandId) ? ("rejected" as const) : ("accepted" as const),
                error: receipts.get(commandId)?.message ?? null,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      latestSequence: Effect.succeed(0),
      streamDomainEvents: Stream.never,
      subscribeDomainEvents: Effect.gen(function* () {
        return Stream.fromSubscription(yield* PubSub.subscribe(events));
      }),
      readThreadEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.gen(function* () {
          if (receipts.has(command.commandId)) {
            const rejection = receipts.get(command.commandId);
            if (rejection)
              return yield* new OrchestrationCommandPreviouslyRejectedError({
                commandId: command.commandId,
                detail: rejection.message,
              });
            return { sequence: 1 };
          }
          const mode = yield* Ref.get(retryMode);
          const dismiss = yield* Ref.get(dismissalMode);
          if (command.type === "thread.queue.resolve" && dismiss === "before_dismiss")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Lost dismissal acknowledgement before acceptance",
            });
          if (command.type === "thread.preparation.retry" && mode === "before_retry")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Lost retry acknowledgement before acceptance",
            });
          yield* Ref.update(commands, (previous) => [...previous, command]);
          if (command.type === "thread.preparation.update") {
            const settlement = yield* Ref.get(settlementMode);
            if (settlement === "reject")
              return yield* new OrchestrationProjectorDecodeError({
                eventType: "thread.prompt-queue-changed",
                issue: "Settlement projection unavailable",
              });
            if (settlement === "race") {
              yield* Ref.set(settlementMode, "normal");
              yield* Ref.update(currentThread, (current) => ({
                ...current!,
                promptQueue: {
                  ...current!.promptQueue!,
                  preparation: {
                    ...current!.promptQueue!.preparation!,
                    revision: current!.promptQueue!.preparation!.revision + 1,
                  },
                },
              }));
            }
          }
          if (
            command.type === "thread.preparation.update" ||
            command.type === "thread.preparation.retry" ||
            command.type === "thread.queue.resolve"
          ) {
            if (
              mode === "reject_retry" ||
              (command.type === "thread.queue.resolve" && dismiss === "reject_dismiss")
            ) {
              const rejection = new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail:
                  command.type === "thread.queue.resolve"
                    ? "Delivery recovery was rejected"
                    : "Preparation changed before acceptance",
              });
              receipts.set(command.commandId, rejection);
              return yield* rejection;
            }
            if (command.type === "thread.queue.resolve" && dismiss === "change_revision") {
              yield* Ref.update(currentThread, (current) => ({
                ...current!,
                promptQueue: {
                  ...current!.promptQueue!,
                  revision: current!.promptQueue!.revision + 1,
                },
              }));
              yield* Ref.set(dismissalMode, "normal");
            }
            const current = (yield* Ref.get(currentThread))!;
            const decision = yield* decidePromptQueueCommand(current, command, false).pipe(
              Effect.result,
            );
            if (decision._tag === "Failure") {
              receipts.set(command.commandId, decision.failure);
              return yield* decision.failure;
            }
            const planned = decision.success;
            let state: OrchestrationReadModel = {
              ...createEmptyReadModel(NOW),
              threads: [current],
            };
            for (const event of planned)
              state = yield* projectEvent(state, {
                ...event,
                sequence: state.snapshotSequence + 1,
              });
            yield* Ref.set(currentThread, state.threads[0]!);
          }
          receipts.set(command.commandId, null);
          if (command.type === "thread.queue.resolve" && dismiss === "after_dismiss")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Lost dismissal acknowledgement after acceptance",
            });
          if (command.type === "thread.prompt.enqueue")
            yield* Ref.set(currentThread, thread(command.threadId.split(":")[1]!));
          if (command.type === "thread.preparation.retry" && mode === "after_retry")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Lost retry acknowledgement after acceptance",
            });
          return { sequence: 1 };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeedSome(project),
      getThreadDetailById: () => Ref.get(currentThread).pipe(Effect.map(Option.fromNullishOr)),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
    Layer.mock(RepositoryIdentityResolver)({
      resolve: () =>
        Ref.get(repositoryKey).pipe(
          Effect.map((canonicalKey) => ({
            canonicalKey,
            rootPath: "/repo",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/repo.git",
            },
          })),
        ),
    }),
    Layer.mock(GitVcsDriver)({
      fetchRemote: () => Effect.void,
      resolveDefaultBranchName: () => Effect.succeed("main"),
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "base-sha", remoteRefName: "origin/main" }),
      resolveCommit: () => Ref.get(head).pipe(Effect.map((commitSha) => ({ commitSha }))),
      statusDetailsLocal: () =>
        Ref.get(branch).pipe(
          Effect.map((value) => ({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: false,
            branch: value,
            upstreamRef: null,
            hasWorkingTreeChanges: true,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          })),
        ),
    }),
    Layer.mock(CheckpointStore)({
      captureCheckpoint: () => Effect.void,
      diffCheckpoints: () => Ref.get(difference),
      deleteCheckpointRefs: () => Effect.void,
    }),
    Layer.mock(TextGeneration)({
      generateApprovalVerdict: (input) =>
        Queue.offer(modelCalls, input).pipe(
          Effect.as({ verdict: "approve" as const, reasoning: "Within the task" }),
        ),
    }),
  );
  return {
    cleanups,
    confirmedCleanup,
    settlementMode,
    finalWriteFailures,
    cleanupOutcomes,
    awaitRun: (predicate: (run: Store.WorkflowRun) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const run = yield* Queue.take(runs);
          if (predicate(run)) return run;
        }
      }),
    currentThread,
    providers,
    repositoryKey,
    commands,
    difference,
    head,
    branch,
    retryMode,
    dismissalMode,
    modelCalls,
    emit: (event: OrchestrationEvent) => PubSub.publish(events, event),
    failPreparation: Ref.update(currentThread, (value) => ({
      ...value!,
      worktreePath: "/jobs/job-1",
      promptQueue: {
        ...value!.promptQueue!,
        preparation: {
          ...value!.promptQueue!.preparation!,
          revision: value!.promptQueue!.preparation!.revision + 1,
          state: "failed" as const,
          settled: true,
          failure: { reason: "interrupted" as const, detail: "Setup failed" },
        },
      },
    })),
    newRunner: make.pipe(Effect.provide(mocks)),
    complete: Ref.update(currentThread, (value) => completed(value!)),
    starts: Ref.get(commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === "thread.prompt.enqueue")),
    ),
  };
});
const test = <A, E>(program: Effect.Effect<A, E, Scope.Scope | Crypto.Crypto>) =>
  program.pipe(Effect.provide(persistence), Effect.scoped);
const recoverDelivery = Effect.fn(function* (h: Effect.Success<typeof harness>) {
  yield* h.complete;
  let current = (yield* Ref.get(h.currentThread))!;
  const apply = Effect.fn(function* (command: Parameters<typeof decidePromptQueueCommand>[1]) {
    const planned = yield* decidePromptQueueCommand(current, command, false);
    let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), threads: [current] };
    for (const event of planned)
      state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
    current = state.threads[0]!;
  });
  const queued = (yield* h.starts)[0]!;
  yield* apply({ ...queued, commandId: CommandId.make("queue-fixture"), threadId: current.id });
  current = {
    ...current,
    promptQueue: {
      ...current.promptQueue!,
      preparation: { ...current.promptQueue!.preparation!, state: "ready", settled: true },
      awaitingTurnId: null,
      admissions: [],
    },
  };
  yield* apply({
    type: "thread.prompt.claim",
    commandId: CommandId.make("uncertain-handoff"),
    threadId: current.id,
    messageId: MessageId.make("workflow:job-1:prompt"),
    expectedRevision: current.promptQueue!.entries[0]!.revision,
    expectedControlRevision: current.promptQueue!.revision,
    createdAt: NOW,
  });
  yield* apply({
    type: "thread.prompt.unknown",
    commandId: CommandId.make("restart-unknown"),
    threadId: current.id,
    attemptId: CommandId.make("uncertain-handoff"),
    detail: "Server restarted during delivery",
    createdAt: NOW,
  });
  current = { ...current, session: { ...current.session!, status: "stopped" } };
  yield* Ref.set(h.currentThread, current);
});

it.effect("durably cancels before acceptance and refuses a delayed Start after restart", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const scope = yield* Scope.make();
      const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
      assert.strictEqual((yield* runner.handle(control("cancel"))).outcome, "cancelled");
      yield* Scope.close(scope, Exit.void);
      const recovered = yield* h.newRunner;
      assert.strictEqual((yield* recovered.handle(request())).outcome, "cancelled");
      assert.strictEqual((yield* recovered.handle(control("status"))).outcome, "cancelled");
      assert.strictEqual((yield* h.starts).length, 0);
      assert.isNull(yield* (yield* Store.WorkflowRunStore).get("job-1"));
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      const mismatch = {
        ...control("cancel"),
        control: { ...control("cancel").control, repositoryId: "another-repo" },
      };
      assert.strictEqual((yield* recovered.handle(mismatch)).outcome, "conflict");
      assert.strictEqual((yield* recovered.handle(request())).outcome, "cancelled");
    }),
  ),
);

it.effect("retries a confirmed stop failure once and ignores old failure evidence", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.complete;
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        session: { ...current!.session!, status: "running" as const },
      }));
      const initial = (yield* runner.handle(control("cancel"))).progress!;
      const stop = (yield* Ref.get(h.commands)).find(
        (command) => command.type === "thread.session.stop",
      )!;
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        activities: [
          ...current!.activities,
          {
            id: EventId.make("failed-stop"),
            kind: "provider.session.stop.failed",
            tone: "error" as const,
            summary: "Stop failed",
            turnId: null,
            createdAt: NOW,
            payload: { stopCommandId: stop.commandId, detail: "Provider could not stop" },
          },
        ],
      }));
      const failed = (yield* runner.handle(control("status"))).progress!;
      assert.isTrue(failed.retryableCancellation);
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual(
        (yield* runner.handle(retryCancellation(initial.revision))).outcome,
        "conflict",
      );
      const response = retryCancellation(failed.revision);
      const retry = (yield* runner.handle(response)).progress!;
      assert.isFalse(retry.retryableCancellation);
      yield* runner.handle(response);
      yield* runner.handle(control("status"));
      const stops = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.session.stop",
      );
      assert.strictEqual(stops.length, 2);
      assert.notStrictEqual(stops[0]!.commandId, stops[1]!.commandId);
      yield* Ref.update(h.currentThread, (current) => ({
        ...current!,
        session: { ...current!.session!, status: "stopped" as const },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
    }),
  ),
);

it.effect(
  "offers an explicit cancellation retry after an accepted stop loses its worker on restart",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* runner.handle(control("cancel"));
        yield* Scope.close(scope, Exit.void);
        const recovered = yield* h.newRunner;
        const progress = (yield* recovered.handle(control("status"))).progress!;
        assert.isTrue(progress.retryableCancellation);
        assert.include(progress.detail!, "restart");
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
            .length,
          1,
        );
        yield* recovered.handle(retryCancellation(progress.revision));
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
            .length,
          2,
        );
      }),
    ),
);

it.effect(
  "dismisses a recovered delivery handoff after stopping without another provider delivery",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        assert.isNotNull((yield* Ref.get(h.currentThread))!.promptQueue!.handoff);
        assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelled");
        const savedThread = (yield* Ref.get(h.currentThread))!;
        assert.isNull(savedThread.promptQueue!.handoff);
        assert.isNull(savedThread.promptQueue!.awaitingTurnId);
        assert.isFalse(savedThread.promptQueue!.enabled);
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      }),
    ),
);

for (const boundary of ["before_dismiss", "after_dismiss"] as const) {
  it.effect(`recovers queue dismissal ${boundary} without repeating delivery or dismissal`, () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        yield* Ref.set(h.dismissalMode, boundary);
        yield* runner.handle(control("cancel")).pipe(Effect.flip);
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        assert.isNotNull(saved.pendingQueueDismissal);
        assert.isTrue(yield* store.isExecuting());
        yield* Scope.close(scope, Exit.void);
        yield* Ref.set(h.dismissalMode, "normal");
        const recovered = yield* h.newRunner;
        assert.strictEqual(
          (yield* recovered.handle(control("status"))).progress?.status,
          "cancelled",
        );
        const dismissals = (yield* Ref.get(h.commands)).filter(
          (command) => command.type === "thread.queue.resolve",
        );
        assert.strictEqual(dismissals.length, 1);
        assert.strictEqual(dismissals[0]!.commandId, saved.pendingQueueDismissal!.commandId);
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* store.isExecuting());
        assert.isNull((yield* store.get("job-1"))!.pendingQueueDismissal);
      }),
    ),
  );
}

it.effect("rechecks a changed queue revision before dismissing recovered delivery", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* recoverDelivery(h);
      yield* Ref.set(h.dismissalMode, "change_revision");
      const pending = (yield* runner.handle(control("cancel"))).progress!;
      assert.strictEqual(pending.status, "cancelling");
      assert.isFalse(pending.retryableCancellation);
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      const dismissals = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.queue.resolve",
      );
      assert.strictEqual(dismissals.length, 2);
      assert.notStrictEqual(dismissals[0]!.commandId, dismissals[1]!.commandId);
      assert.strictEqual((yield* h.starts).length, 1);
      assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
    }),
  ),
);

it.effect("requires explicit retry after dismissal rejection at the same queue revision", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* recoverDelivery(h);
      yield* Ref.set(h.dismissalMode, "reject_dismiss");
      const rejected = (yield* runner.handle(control("cancel"))).progress!;
      assert.isTrue(rejected.retryableCancellation);
      yield* Ref.set(h.dismissalMode, "normal");
      yield* runner.handle(control("status"));
      yield* runner.handle(control("cancel"));
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.queue.resolve")
          .length,
        1,
      );
      assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
      assert.strictEqual(
        (yield* runner.handle(retryCancellation(rejected.revision))).progress?.status,
        "cancelled",
      );
      const dismissals = (yield* Ref.get(h.commands)).filter(
        (command) => command.type === "thread.queue.resolve",
      );
      assert.strictEqual(dismissals.length, 2);
      assert.notStrictEqual(dismissals[0]!.commandId, dismissals[1]!.commandId);
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "does not dismiss uncertain delivery while provider or setup stopping is unconfirmed",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* recoverDelivery(h);
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: { ...current!.session!, status: "running" as const },
        }));
        assert.strictEqual(
          (yield* runner.handle(control("cancel"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(
          (yield* Ref.get(h.commands)).some((command) => command.type === "thread.queue.resolve"),
        );
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          session: { ...current!.session!, status: "stopped" as const },
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: false,
            },
          },
        }));
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(
          (yield* Ref.get(h.commands)).some((command) => command.type === "thread.queue.resolve"),
        );
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: { ...current!.promptQueue!.preparation!, settled: true },
          },
        }));
        assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isFalse(yield* (yield* Store.WorkflowRunStore).isExecuting());
      }),
    ),
);

it.effect("atomically chooses acceptance or a cancellation fence and preserves accepted runs", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const accepted = (yield* store.get("job-1"))!;
      const [acceptance, cancellation] = yield* Effect.all(
        [
          store.tryAccept({
            ...accepted,
            jobId: "raced-job",
            executionReserved: false,
            progress: { ...accepted.progress, threadId: ThreadId.make("workflow:raced-job:agent") },
          }),
          store.cancelBeforeAcceptance({
            jobId: "raced-job",
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: PROJECT,
            repositoryCanonicalKey: request().repositoryCanonicalKey,
            createdAt: NOW,
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(acceptance, cancellation.run !== null);
      assert.strictEqual(acceptance, cancellation.cancellation === null);
      assert.strictEqual((yield* store.get("raced-job")) !== null, acceptance);
      assert.strictEqual((yield* store.getCancellation("raced-job")) === null, acceptance);
      const existing = yield* store.cancelBeforeAcceptance({
        jobId: "job-1",
        organizationId: "org-1",
        repositoryId: "repo-1",
        projectId: PROJECT,
        repositoryCanonicalKey: request().repositoryCanonicalKey,
        createdAt: NOW,
      });
      assert.isNotNull(existing.run);
      assert.isNull(existing.cancellation);
    }),
  ),
);

it.effect(
  "consults with the frozen job context in the worktree prepared after supervisor attachment",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        const current = (yield* Ref.get(h.currentThread))!;
        yield* Ref.set(h.currentThread, { ...current, worktreePath: "/jobs/job-1" });
        const event: OrchestrationEvent = {
          type: "thread.activity-appended",
          sequence: 1,
          eventId: EventId.make("approval-event"),
          aggregateKind: "thread",
          aggregateId: current.id,
          occurredAt: NOW,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: current.id,
            activity: {
              id: EventId.make("approval"),
              kind: "approval.requested",
              tone: "approval",
              summary: "Run tests",
              turnId: null,
              createdAt: NOW,
              payload: {
                requestId: "approval-1",
                requestType: "command_execution_approval",
                detail: "pnpm test",
              },
            },
          },
        };
        yield* h.emit(event);
        const consultation = yield* Queue.take(h.modelCalls);
        assert.strictEqual(consultation.cwd, "/jobs/job-1");
        assert.strictEqual(consultation.stepInstruction, workflow.definition.steps[0].instruction);
        assert.strictEqual(consultation.jobContext, request().instruction);
        assert.include(consultation.reviewConstraint!, "human review");
      }),
    ),
);

it.effect("accepts a job once, bounds bursts, and freezes its definition", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      const first = yield* runner.handle(request());
      assert.strictEqual(first.progress?.status, "preparing");
      const changed = {
        ...request(),
        control: {
          ...request().control,
          operation: "start" as const,
          workflow: {
            ...workflow,
            revision: 2,
            definition: { ...workflow.definition, name: "Edited after offer" },
          },
        },
      };
      yield* runner.handle(changed);
      const burst = yield* Effect.forEach(
        ["job-2", "job-3", "job-4"],
        (id) => runner.handle(request(id)),
        { concurrency: "unbounded" },
      );
      assert.isTrue(burst.every((result) => result.outcome === "busy"));
      assert.strictEqual((yield* h.starts).length, 1);
      assert.strictEqual(
        (yield* (yield* Store.WorkflowRunStore).get("job-1"))?.workflow.definition.name,
        workflow.definition.name,
      );
    }),
  ),
);

it.effect("recovers accepted work without another prompt and waits for a finalized result", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const scope = yield* Scope.make();
      const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.handle(request());
      yield* Scope.close(scope, Exit.void);
      const restarted = yield* h.newRunner;
      yield* h.complete;
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: { ...value!.promptQueue!, finalizedTurnId: null },
      }));
      assert.strictEqual((yield* restarted.handle(control("status"))).progress?.status, "running");
      yield* h.complete;
      assert.strictEqual(
        (yield* restarted.handle(control("status"))).progress?.status,
        "awaiting_review",
      );
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "requires the current checkpoint and unchanged files/head before idempotent approval",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        const review = (yield* runner.handle(control("status"))).progress!;
        const approve: WorkflowRequest = {
          ...request(),
          control: {
            operation: "approve",
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: PROJECT,
            expectedRevision: review.revision,
            checkpointId: review.checkpoint!.checkpointId,
          },
        };
        const stale = {
          ...approve,
          control: {
            ...approve.control,
            operation: "approve" as const,
            expectedRevision: 0,
            checkpointId: "old",
          },
        };
        assert.strictEqual((yield* runner.handle(stale)).outcome, "conflict");
        yield* Ref.set(h.difference, "changed files");
        assert.strictEqual((yield* runner.handle(approve)).outcome, "conflict");
        yield* Ref.set(h.difference, "");
        yield* Ref.set(h.head, "changed-head");
        assert.strictEqual((yield* runner.handle(approve)).outcome, "conflict");
        yield* Ref.set(h.head, "base-sha");
        assert.strictEqual((yield* runner.handle(approve)).progress?.status, "done");
        assert.strictEqual((yield* runner.handle(approve)).progress?.status, "done");
        assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "done");
      }),
    ),
);

it.effect("keeps cancellation pending until setup and provider stop are acknowledged", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelling");
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: {
            ...value!.promptQueue!.preparation!,
            state: "failed" as const,
            settled: false,
          },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelling");
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: { ...value!.promptQueue!.preparation!, settled: true },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      yield* h.complete;
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect(
  "pauses failed preparation, retries explicitly, and protects the owned thread/worktree",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* Ref.update(h.currentThread, (value) => ({
          ...value!,
          worktreePath: "/jobs/job-1",
          promptQueue: {
            ...value!.promptQueue!,
            preparation: {
              ...value!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: true,
              failure: { reason: "interrupted" as const, detail: "Setup was interrupted" },
            },
          },
        }));
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.status, "paused");
        const store = yield* Store.WorkflowRunStore;
        assert.isTrue(
          Option.isSome(
            yield* store
              .requireCommand({
                type: "thread.session.stop",
                commandId: CommandId.make("external-stop"),
                threadId: ThreadId.make("workflow:job-1:agent"),
                createdAt: NOW,
              })
              .pipe(Effect.flip, Effect.option),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* store.requireWorkspace("/jobs/job-1").pipe(Effect.flip, Effect.option),
          ),
        );
        assert.strictEqual(
          (yield* runner.handle(retryRequest(paused.revision))).progress?.status,
          "preparing",
        );
        assert.strictEqual((yield* h.starts).length, 1);
        assert.strictEqual(
          (yield* Ref.get(h.commands)).filter(
            (command) => command.type === "thread.preparation.retry",
          ).length,
          1,
        );
      }),
    ),
);

for (const boundary of ["before_retry", "after_retry"] as const) {
  it.effect(`recovers preparation retry ${boundary} without duplicate delivery`, () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const runner = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runner.handle(request());
        yield* h.failPreparation;
        const paused = (yield* runner.handle(control("status"))).progress!;
        yield* Ref.set(h.retryMode, boundary);
        yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
        const store = yield* Store.WorkflowRunStore;
        const saved = (yield* store.get("job-1"))!;
        assert.strictEqual(saved.progress.status, "preparing");
        assert.isNotNull(saved.pendingPreparationRetry);
        assert.isTrue(yield* store.isExecuting());
        yield* Scope.close(scope, Exit.void);
        yield* Ref.set(h.retryMode, "normal");
        if (boundary === "after_retry") yield* h.complete;
        const restarted = yield* h.newRunner;
        const recovered = (yield* restarted.handle(control("status"))).progress!;
        assert.strictEqual(
          recovered.status,
          boundary === "after_retry" ? "awaiting_review" : "preparing",
        );
        assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
        const retries = (yield* Ref.get(h.commands)).filter(
          (cmd) => cmd.type === "thread.preparation.retry",
        );
        assert.strictEqual(retries.length, 1);
        assert.strictEqual(retries[0]!.commandId, saved.pendingPreparationRetry!.commandId);
        assert.strictEqual((yield* h.starts).length, 1);
        if (boundary === "after_retry") assert.isFalse(yield* store.isExecuting());
      }),
    ),
  );
}

it.effect("uses a fresh retry identity after durable rejection", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "reject_retry");
      const rejected = (yield* runner.handle(retryRequest(paused.revision))).progress!;
      assert.strictEqual(rejected.status, "paused");
      assert.include(rejected.detail!, "Preparation changed");
      assert.isTrue(rejected.retryablePreparation);
      assert.isNull((yield* (yield* Store.WorkflowRunStore).get("job-1"))!.pendingPreparationRetry);
      yield* Ref.set(h.retryMode, "normal");
      assert.strictEqual(
        (yield* runner.handle(retryRequest(rejected.revision))).progress?.status,
        "preparing",
      );
      const retries = (yield* Ref.get(h.commands)).filter(
        (cmd) => cmd.type === "thread.preparation.retry",
      );
      assert.strictEqual(retries.length, 2);
      assert.notStrictEqual(retries[0]!.commandId, retries[1]!.commandId);
    }),
  ),
);

it.effect("fences redelivered retry after the accepted preparation fails again", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      const response = retryRequest(paused.revision);
      yield* Ref.set(h.retryMode, "after_retry");
      yield* runner.handle(response).pipe(Effect.flip);
      yield* h.failPreparation;
      yield* Ref.set(h.retryMode, "normal");
      const repeated = yield* runner.handle(response);
      assert.strictEqual(repeated.outcome, "conflict");
      assert.strictEqual(repeated.progress?.status, "paused");
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        1,
      );
      assert.strictEqual(
        (yield* runner.handle(retryRequest(repeated.progress!.revision))).progress?.status,
        "preparing",
      );
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        2,
      );
    }),
  ),
);

it.effect("cancels an undispatched retry before reconciliation can deliver it", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "before_retry");
      yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
      yield* Ref.set(h.retryMode, "normal");
      assert.strictEqual((yield* runner.handle(control("cancel"))).progress?.status, "cancelled");
      const store = yield* Store.WorkflowRunStore;
      assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        0,
      );
      assert.strictEqual((yield* runner.handle(request("job-2"))).outcome, "accepted");
    }),
  ),
);

it.effect("keeps cancellation reserved until an accepted retry acknowledges setup settlement", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      yield* h.failPreparation;
      const paused = (yield* runner.handle(control("status"))).progress!;
      yield* Ref.set(h.retryMode, "after_retry");
      yield* runner.handle(retryRequest(paused.revision)).pipe(Effect.flip);
      const store = yield* Store.WorkflowRunStore;
      const cancelling = yield* runner.handle(control("cancel"));
      assert.strictEqual(cancelling.progress?.status, "cancelling");
      assert.strictEqual(
        (yield* runner.handle(control("cancel"))).progress?.revision,
        cancelling.progress!.revision,
      );
      assert.isTrue(yield* store.isExecuting());
      assert.isNull((yield* store.get("job-1"))!.pendingPreparationRetry);
      yield* Ref.update(h.currentThread, (value) => ({
        ...value!,
        promptQueue: {
          ...value!.promptQueue!,
          preparation: {
            ...value!.promptQueue!.preparation!,
            state: "failed" as const,
            settled: true,
          },
        },
      }));
      assert.strictEqual((yield* runner.handle(control("status"))).progress?.status, "cancelled");
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((cmd) => cmd.type === "thread.preparation.retry")
          .length,
        1,
      );
      assert.strictEqual((yield* runner.handle(retryRequest(paused.revision))).outcome, "conflict");
    }),
  ),
);

it.effect(
  "releases automatic capacity at review and rejects aliased workspace/thread creation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.status,
          "awaiting_review",
        );
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse(yield* store.isExecuting());
        assert.isTrue(
          Option.isSome(
            yield* store
              .requireWorkspace("/jobs/job-1/../job-1/subdir")
              .pipe(Effect.flip, Effect.option),
          ),
        );
        const create: OrchestrationCommand = {
          type: "thread.create",
          commandId: CommandId.make("external-create"),
          threadId: ThreadId.make("other-thread"),
          projectId: PROJECT,
          title: "Bypass",
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "t3-job/job-1",
          worktreePath: "/jobs/job-1",
          createdAt: NOW,
        };
        assert.isTrue(
          Option.isSome(yield* store.requireCommand(create).pipe(Effect.flip, Effect.option)),
        );
        assert.strictEqual(
          (yield* runner.handle(control("cancel"))).progress?.status,
          "cancelling",
        );
        assert.isFalse(yield* store.isExecuting());
        assert.strictEqual((yield* runner.handle(request("job-2"))).outcome, "accepted");
      }),
    ),
);

it.effect("recovers a persisted cancellation intent before its stop command was sent", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* h.newRunner;
      yield* first.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const saved = (yield* store.get("job-1"))!;
      yield* store.save({ ...saved, progress: { ...saved.progress, status: "cancelling" } });
      const recovered = yield* h.newRunner;
      yield* recovered.handle(control("status"));
      assert.strictEqual(
        (yield* Ref.get(h.commands)).filter((command) => command.type === "thread.session.stop")
          .length,
        1,
      );
      assert.strictEqual((yield* h.starts).length, 1);
    }),
  ),
);

it.effect("cancels a reserved job before its thread was created without dispatching work", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const saved = (yield* store.get("job-1"))!;
      yield* store.save({ ...saved, promptDispatched: false });
      yield* Ref.set(h.currentThread, null);
      const count = (yield* Ref.get(h.commands)).length;
      const cancelled = yield* runner.handle(control("cancel"));
      assert.strictEqual(cancelled.progress?.status, "cancelled");
      assert.include(cancelled.progress!.detail!, "before the agent started");
      assert.isFalse(yield* store.isExecuting());
      assert.strictEqual((yield* Ref.get(h.commands)).length, count);
    }),
  ),
);

it.effect("persists one execution reservation per environment and frees it at review", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const first = (yield* store.get("job-1"))!;
      const another = {
        ...first,
        jobId: "job-reservation",
        progress: { ...first.progress, threadId: ThreadId.make("workflow:job-reservation:agent") },
      };
      assert.isFalse(yield* store.tryAccept(another));
      const otherEnvironment = {
        ...another,
        jobId: "other-env-job",
        progress: { ...another.progress, threadId: ThreadId.make("workflow:other-env-job:agent") },
        workflow: {
          ...another.workflow,
          definition: {
            ...another.workflow.definition,
            environmentId: EnvironmentId.make("env-2"),
          },
        },
      };
      assert.isTrue(yield* store.tryAccept(otherEnvironment));
      yield* h.complete;
      yield* runner.handle(control("status"));
      assert.isTrue(yield* store.tryAccept(another));
      assert.isFalse(yield* store.tryAccept(another));
    }),
  ),
);

it.effect(
  "refuses unsupported/disabled providers and a checkout whose repository changed before acceptance",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        const provider = (yield* Ref.get(h.providers))[0]!;
        for (const driver of ["cursor", "grok", "opencode", "antigravity"]) {
          yield* Ref.set(h.providers, [{ ...provider, driver: ProviderDriverKind.make(driver) }]);
          assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        }
        yield* Ref.set(h.providers, [{ ...provider, enabled: false }]);
        assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        yield* Ref.set(h.providers, [provider]);
        yield* Ref.set(h.repositoryKey, "github.com/acme/different-repo");
        assert.strictEqual((yield* runner.handle(request())).outcome, "unavailable");
        assert.isNull(yield* (yield* Store.WorkflowRunStore).get("job-1"));
        assert.strictEqual((yield* h.starts).length, 0);
      }),
    ),
);

it.effect("keeps individual approval responses available while refusing session-wide trust", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const runner = yield* h.newRunner;
      yield* runner.handle(request());
      const store = yield* Store.WorkflowRunStore;
      const approval: OrchestrationCommand = {
        type: "thread.approval.respond",
        commandId: CommandId.make("external-trust"),
        threadId: ThreadId.make("workflow:job-1:agent"),
        requestId: ApprovalRequestId.make("request-1"),
        decision: "acceptAlways",
        createdAt: NOW,
      };
      assert.isTrue(
        Option.isSome(yield* store.requireCommand(approval).pipe(Effect.flip, Effect.option)),
      );
      yield* store.requireCommand({ ...approval, decision: "decline" });
    }),
  ),
);

const approve = (progress: Store.WorkflowRun["progress"]): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "approve",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision: progress.revision,
    checkpointId: progress.checkpoint!.checkpointId,
  },
});
const backgroundScript = {
  id: "preview",
  name: "Preview",
  command: "preview",
  async: true,
};
const withBackground = (h: Effect.Success<typeof harness>, settled = false) =>
  Ref.update(h.currentThread, (current) => ({
    ...current!,
    promptQueue: {
      ...current!.promptQueue!,
      preparation: {
        ...current!.promptQueue!.preparation!,
        script: backgroundScript,
        settled,
      },
    },
  }));

it.effect.each(["approve", "changed", "cancel"] as const)(
  "review retains the preview and ownership until cleanup: %s",
  (action) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(review.status, "awaiting_review");
        const store = yield* Store.WorkflowRunStore;
        assert.isFalse(yield* store.isExecuting());
        assert.isNotNull(yield* store.getByThread(review.threadId));
        const response = approve(review);
        const pending = (yield* runner.handle(response)).progress!;
        assert.isTrue(pending.approvalPending);
        const approvalId = yield* Queue.take(h.cleanups);
        yield* runner.handle(response);
        yield* runner.handle(control("status"));
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.isNotNull(yield* store.getByThread(review.threadId));
        if (action === "changed") yield* Ref.set(h.difference, "changed during cleanup");
        if (action === "cancel") {
          yield* Ref.update(h.currentThread, (current) => ({
            ...current!,
            session: { ...current!.session!, status: "stopped" as const },
            promptQueue: {
              ...current!.promptQueue!,
              preparation: {
                ...current!.promptQueue!.preparation!,
                state: "failed" as const,
                settled: true,
              },
            },
          }));
          assert.strictEqual(
            (yield* runner.handle(control("cancel"))).progress?.status,
            "cancelling",
          );
          const cancelId = yield* Queue.take(h.cleanups);
          assert.notStrictEqual(approvalId, cancelId);
          yield* Queue.offer(h.cleanupOutcomes, null);
          yield* Queue.offer(h.cleanupOutcomes, null);
          const cancelled = yield* h.awaitRun((run) => run.progress.status === "cancelled");
          assert.isNull(cancelled.approvalAttempt);
          assert.isNull(cancelled.approvedBy);
          assert.isNull(yield* store.getByThread(review.threadId));
        } else {
          yield* Queue.offer(h.cleanupOutcomes, null);
          const finished = yield* h.awaitRun(
            (run) =>
              run.progress.approvalPending === false && run.progress.revision > pending.revision,
          );
          assert.strictEqual(
            finished.progress.status,
            action === "changed" ? "awaiting_review" : "done",
          );
          assert.strictEqual(finished.approvedBy, action === "changed" ? null : "user-1");
          assert.strictEqual(
            (yield* store.getByThread(review.threadId)) !== null,
            action === "changed",
          );
          if (action === "changed") assert.include(finished.progress.detail!, "files changed");
        }
      }),
    ),
);
it.effect(
  "approval cleanup failure requires an explicit retry and retains the first approver",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h, true);
        const review = (yield* runner.handle(control("status"))).progress!;
        const first = approve(review);
        yield* runner.handle(first);
        const firstId = yield* Queue.take(h.cleanups);
        yield* Queue.offer(h.cleanupOutcomes, "Termination denied");
        const failed = yield* h.awaitRun((run) => run.progress.retryableApproval === true);
        assert.strictEqual(failed.progress.status, "awaiting_review");
        assert.isFalse(failed.progress.approvalPending);
        yield* runner.handle(first);
        yield* runner.handle(control("status"));
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        const retry = { ...approve(failed.progress), userId: "another-maintainer" };
        yield* runner.handle(retry);
        assert.notStrictEqual(yield* Queue.take(h.cleanups), firstId);
        yield* Queue.offer(h.cleanupOutcomes, null);
        const done = yield* h.awaitRun((run) => run.progress.status === "done");
        assert.strictEqual(done.approvedBy, "user-1");
      }),
    ),
);
it.effect.each(["status", "restart"] as const)(
  "unknown delivery before admission stays visibly paused and never retries: %s",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* first.handle(request());
        yield* h.complete;
        let current = (yield* Ref.get(h.currentThread))!;
        current = {
          ...current,
          latestTurn: null,
          checkpoints: [],
          session: null,
          promptQueue: {
            ...current.promptQueue!,
            admissions: [],
            finalizedTurnId: null,
            awaitingTurnId: null,
            preparation: { ...current.promptQueue!.preparation!, state: "ready", settled: true },
          },
        };
        const apply = Effect.fn(function* (
          command: Parameters<typeof decidePromptQueueCommand>[1],
        ) {
          const events = yield* decidePromptQueueCommand(current, command, false);
          let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), threads: [current] };
          for (const event of events)
            state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
          current = state.threads[0]!;
        });
        yield* apply({
          type: "thread.prompt.enqueue",
          threadId: current.id,
          commandId: CommandId.make("unknown-enqueue"),
          message: {
            messageId: MessageId.make("workflow:job-1:prompt"),
            text: "work",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: NOW,
        });
        yield* apply({
          type: "thread.prompt.claim",
          commandId: CommandId.make("claim-before-crash"),
          threadId: current.id,
          messageId: MessageId.make("workflow:job-1:prompt"),
          expectedRevision: current.promptQueue!.entries[0]!.revision,
          expectedControlRevision: current.promptQueue!.revision,
          createdAt: NOW,
        });
        yield* apply({
          type: "thread.prompt.unknown",
          commandId: CommandId.make("crashed-delivery"),
          threadId: current.id,
          attemptId: CommandId.make("claim-before-crash"),
          detail: "Lost delivery acknowledgement",
          createdAt: NOW,
        });
        current = {
          ...current,
          promptQueue: {
            ...current.promptQueue!,
            preparation: {
              ...current.promptQueue!.preparation!,
              state: "failed",
              settled: true,
              failure: { reason: "interrupted", detail: "Setup also failed" },
            },
          },
        };
        yield* Ref.set(h.currentThread, current);
        if (boundary === "restart") yield* Scope.close(scope, Exit.void);
        const runner = boundary === "restart" ? yield* h.newRunner : first;
        const paused = (yield* runner.handle(control("status"))).progress!;
        assert.strictEqual(paused.status, "paused");
        assert.isFalse(paused.retryablePreparation);
        assert.include(paused.detail!, "delivery could not be confirmed");
        assert.strictEqual(
          (yield* runner.handle(control("status"))).progress?.revision,
          paused.revision,
        );
        assert.strictEqual(
          (yield* runner.handle(retryRequest(paused.revision))).outcome,
          "conflict",
        );
        assert.strictEqual((yield* h.starts).length, 1);
        assert.isTrue(yield* (yield* Store.WorkflowRunStore).isExecuting());
        assert.isNotNull(yield* (yield* Store.WorkflowRunStore).getByThread(current.id));
        assert.isNotNull((yield* Ref.get(h.currentThread))?.promptQueue?.handoff);
        const cancelled = (yield* runner.handle(control("cancel"))).progress!;
        assert.strictEqual(cancelled.status, "cancelled");
      }),
    ),
);

it.effect.each(["pending", "confirmed"] as const)(
  "recovers approval %s without changing the approved result",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const scope = yield* Scope.make();
        const first = yield* h.newRunner.pipe(Effect.provideService(Scope.Scope, scope));
        yield* first.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* first.handle(control("status"))).progress!;
        const response = approve(review);
        yield* first.handle(response);
        const commandId = yield* Queue.take(h.cleanups);
        yield* Scope.close(scope, Exit.void);
        const store = yield* Store.WorkflowRunStore;
        if (boundary === "confirmed") {
          yield* Ref.set(h.confirmedCleanup, true);
          const saved = (yield* store.get("job-1"))!;
          yield* store.save({
            ...saved,
            approvalAttempt: {
              ...saved.approvalAttempt!,
              setupCleanup: { ...saved.approvalAttempt!.setupCleanup!, state: "done" },
            },
          });
        }
        const recovered = yield* h.newRunner;
        const state = (yield* recovered.handle(response)).progress!;
        if (boundary === "pending") {
          assert.isTrue(state.approvalPending);
          assert.strictEqual(yield* Queue.take(h.cleanups), commandId);
          yield* Queue.offer(h.cleanupOutcomes, null);
          yield* h.awaitRun((run) => run.progress.status === "done");
        } else {
          assert.strictEqual(state.status, "done");
          assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        }
        const done = (yield* store.get("job-1"))!;
        assert.strictEqual(done.approvedBy, "user-1");
        assert.strictEqual(done.progress.checkpoint?.checkpointId, review.checkpoint?.checkpointId);
        assert.strictEqual((yield* h.starts).length, 1);
      }),
    ),
);

it.effect.each(["projection", "final-write", "race", "replacement"] as const)(
  "cleanup proof survives approval settlement recovery: %s",
  (boundary) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* Ref.update(h.currentThread, (current) => ({
          ...current!,
          promptQueue: {
            ...current!.promptQueue!,
            preparation: {
              ...current!.promptQueue!.preparation!,
              state: "failed" as const,
              settled: false,
              failure: { reason: "interrupted" as const, detail: "Setup failed before restart" },
            },
          },
        }));
        if (boundary === "projection") yield* Ref.set(h.settlementMode, "reject");
        if (boundary === "race") yield* Ref.set(h.settlementMode, "race");
        if (boundary === "final-write") yield* Ref.set(h.finalWriteFailures, 1);
        yield* runner.handle(approve(review));
        yield* Queue.take(h.cleanups);
        if (boundary === "replacement")
          yield* Ref.update(h.currentThread, (current) => ({
            ...current!,
            promptQueue: {
              ...current!.promptQueue!,
              preparation: {
                ...current!.promptQueue!.preparation!,
                attemptId: CommandId.make("replacement"),
              },
            },
          }));
        yield* Queue.offer(h.cleanupOutcomes, null);
        const finished = yield* h.awaitRun(
          (run) =>
            run.progress.approvalPending === false && run.progress.revision > review.revision + 1,
        );
        const preparation = (yield* Ref.get(h.currentThread))!.promptQueue!.preparation!;
        if (boundary === "replacement") {
          assert.strictEqual(finished.progress.status, "awaiting_review");
          assert.isFalse(finished.progress.retryableApproval);
          assert.isNull(finished.approvalAttempt);
          assert.isFalse(preparation.settled);
          assert.include(finished.progress.detail!, "Cancel the job");
          return;
        }
        if (boundary !== "race") {
          assert.isTrue(finished.progress.retryableApproval);
          assert.strictEqual(finished.progress.status, "awaiting_review");
          yield* Ref.set(h.settlementMode, "normal");
          const retried = yield* runner.handle({
            ...approve(finished.progress),
            userId: "another-maintainer",
          });
          assert.strictEqual(retried.progress?.status, "done");
        } else assert.strictEqual(finished.progress.status, "done");
        const done = (yield* (yield* Store.WorkflowRunStore).get("job-1"))!;
        assert.strictEqual(done.approvedBy, "user-1");
        const settled = (yield* Ref.get(h.currentThread))!.promptQueue!.preparation!;
        assert.strictEqual(settled.state, "failed");
        assert.isTrue(settled.settled);
        assert.strictEqual(settled.failure?.detail, "Setup failed before restart");
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.strictEqual((yield* h.starts).length, 1);
      }),
    ),
);
it.effect(
  "a persistence outage retains accepted approval and reuses cleanup on reconciliation",
  () =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const runner = yield* h.newRunner;
        yield* runner.handle(request());
        yield* h.complete;
        yield* withBackground(h);
        const review = (yield* runner.handle(control("status"))).progress!;
        yield* runner.handle(approve(review));
        yield* Queue.take(h.cleanups);
        yield* Ref.set(h.finalWriteFailures, 2);
        yield* Queue.offer(h.cleanupOutcomes, null);
        yield* h.awaitRun((run) => run.approvalAttempt?.setupCleanup?.state === "done");
        // The serialized status call drains pending worker finalization before its own reconciliation.
        const result = yield* runner.handle(control("status"));
        assert.strictEqual(result.progress?.status, "done");
        assert.strictEqual(yield* Queue.size(h.cleanups), 0);
        assert.isTrue((yield* Ref.get(h.currentThread))!.promptQueue!.preparation!.settled);
      }),
    ),
);
