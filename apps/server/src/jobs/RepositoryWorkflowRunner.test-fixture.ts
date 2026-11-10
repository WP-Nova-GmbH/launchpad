import { FetchHttpClient } from "effect/unstable/http";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TerminalManager } from "../terminal/Manager.ts";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationThread,
  OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  TextGenerationError,
  ThreadId,
  TurnId,
  CheckpointRef,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  type OrganizationRepositoryPolicy,
} from "@t3tools/contracts";
import { type RepositoryWorkflow, type WorkflowControl } from "@t3tools/contracts/workflows";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { SetupProcessJournal, SetupProcessError } from "../terminal/SetupProcessJournal.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type {
  ApprovalVerdictGenerationInput,
  ApprovalVerdictGenerationResult,
} from "../textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Store from "./WorkflowRunStore.ts";
import { make, type WorkflowRequest } from "./RepositoryWorkflowRunner.ts";
import { make as makeAccess } from "../auth/RepositoryAccess.ts";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import { CLOUD_MACHINE_IDENTITY, encodeCloudMachineIdentityJson } from "../cloud/config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
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

export const NOW = "2026-10-08T12:00:00.000Z";
export const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
export const PROJECT = ProjectId.make("project-workflow");
export const workflow: RepositoryWorkflow & {
  definition: RepositoryWorkflow["definition"] & {
    target: Extract<RepositoryWorkflow["definition"]["target"], { kind: "machine" }>;
  };
} = {
  workflowId: "workflow-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  revision: 1,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  definition: {
    name: "Implement and review",
    target: { kind: "machine", environmentId: EnvironmentId.make("env-1"), projectId: PROJECT },
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
export const request = (
  jobId = "job-1",
): WorkflowRequest & { control: Extract<WorkflowControl, { operation: "start" }> } => ({
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
    runtime: workflow.definition.target,
  },
});
export const control = (operation: "status" | "cancel", jobId = "job-1"): WorkflowRequest => ({
  ...request(jobId),
  control: { operation, organizationId: "org-1", repositoryId: "repo-1", projectId: PROJECT },
});
export const retryRequest = (expectedRevision: number): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "retry_preparation",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision,
  },
});
export const retryCancellation = (expectedRevision: number): WorkflowRequest => ({
  ...request(),
  control: {
    operation: "retry_cancellation",
    organizationId: "org-1",
    repositoryId: "repo-1",
    projectId: PROJECT,
    expectedRevision,
  },
});

export function thread(jobId = "job-1"): OrchestrationThread {
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
export function completed(previous: OrchestrationThread, messageId?: string): OrchestrationThread {
  const jobId = previous.id.split(":")[1]!;
  const count = messageId ? previous.checkpoints.length + 1 : 1;
  const turnId = TurnId.make(messageId ? `${jobId}-turn-${count}` : `${jobId}-turn`);
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
      ...(messageId ? previous.checkpoints : []),
      {
        turnId,
        checkpointTurnCount: count,
        checkpointRef: CheckpointRef.make(`refs/t3/${jobId}/turn/${count}`),
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
        ...(messageId ? previous.promptQueue!.admissions : []),
        {
          attemptId: CommandId.make(`admit-${jobId}`),
          messageId: MessageId.make(messageId ?? `workflow:${jobId}:prompt`),
          turnId,
          evidence: "provider-ack",
        },
      ],
      finalizedTurnId: turnId,
      finalization: { turnId, outcome: "completed", checkpoint: "ready" },
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

export const persistence = Store.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
export const harness = Effect.gen(function* () {
  const currentThread = yield* Ref.make<OrchestrationThread | null>(null);
  const nextThreadRead = yield* Ref.make<OrchestrationThread | null>(null);
  const otherThreads = new Map<string, OrchestrationThread>();
  const prompts =
    yield* Queue.unbounded<Extract<OrchestrationCommand, { type: "thread.prompt.enqueue" }>>();
  const fetches = yield* Ref.make(0);
  const runs = yield* Queue.unbounded<Store.WorkflowRun>();
  const cleanups = yield* Queue.unbounded<string>();
  const cleanupOutcomes = yield* Queue.unbounded<string | null>();
  const confirmedCleanup = yield* Ref.make(false);
  const providerProof = yield* Ref.make<boolean | null>(null);
  const settlementMode = yield* Ref.make<"normal" | "reject" | "race">("normal");
  const promptOutage = yield* Ref.make<"none" | "before" | "after" | "reject">("none");
  const finalWriteFailures = yield* Ref.make(0);
  const failedFinalWrites = yield* Queue.unbounded<void>();
  const stored = yield* Store.WorkflowRunStore;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const modelCalls = yield* Queue.unbounded<ApprovalVerdictGenerationInput>();
  const approvalVerdict = yield* Ref.make<ApprovalVerdictGenerationResult | null>({
    verdict: "approve",
    reasoning: "Within the task",
  });
  const receipts = new Map<string, OrchestrationCommandInvariantError | null>();
  const retryMode = yield* Ref.make<"normal" | "before_retry" | "after_retry" | "reject_retry">(
    "normal",
  );
  const dismissalMode = yield* Ref.make<
    "normal" | "before_dismiss" | "after_dismiss" | "reject_dismiss" | "change_revision"
  >("normal");
  const workspaceTree = yield* Ref.make("prepared-tree");
  const headAfterCapture = yield* Ref.make<string | null>(null);
  const captureGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const captureStarted = yield* Queue.unbounded<void>();
  const captureCount = yield* Ref.make(0);
  const checkpointTrees = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
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
  const projectState = yield* Ref.make(project);
  const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
    { ...provider, continuation: { groupKey: "codex:test-home" } },
  ]);
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
      save: (run, captured) =>
        Effect.gen(function* () {
          const failures = yield* Ref.get(finalWriteFailures);
          if (failures > 0 && (run.progress.status === "done" || run.progress.retryableApproval)) {
            yield* Ref.update(finalWriteFailures, (n) => n - 1);
            yield* Queue.offer(failedFinalWrites, undefined);
            return yield* Effect.die("Injected final-state write outage");
          }
          return yield* stored.save(run, captured).pipe(Effect.tap(() => Queue.offer(runs, run)));
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
          const promptFailure =
            command.type === "thread.prompt.enqueue" ? yield* Ref.get(promptOutage) : "none";
          if (promptFailure !== "none") yield* Ref.set(promptOutage, "none");
          if (promptFailure === "reject") {
            const rejection = new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Injected durable enqueue rejection",
            });
            receipts.set(command.commandId, rejection);
            return yield* rejection;
          }
          if (promptFailure === "before")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Prompt acknowledgement unavailable before acceptance",
            });
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
          yield* Queue.offer(dispatched, command);
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
          if (command.type === "thread.prompt.enqueue") {
            if (command.bootstrap?.createThread) {
              const previous = yield* Ref.get(currentThread);
              if (previous) otherThreads.set(previous.id, previous);
              yield* Ref.set(currentThread, thread(command.threadId.split(":")[1]!));
            }
            yield* Queue.offer(prompts, command);
          }
          if (promptFailure === "after")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Prompt acknowledgement lost after acceptance",
            });
          if (command.type === "thread.preparation.retry" && mode === "after_retry")
            return yield* new OrchestrationProjectorDecodeError({
              eventType: "thread.prompt-queue-changed",
              issue: "Lost retry acknowledgement after acceptance",
            });
          return { sequence: 1 };
        }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Ref.get(projectState).pipe(Effect.map(Option.some)),
      getThreadDetailById: (id) =>
        Effect.gen(function* () {
          const preview = yield* Ref.modify(nextThreadRead, (preview) =>
            preview?.id === id ? [preview, null] : [null, preview],
          );
          if (preview) return Option.some(preview);
          const current = yield* Ref.get(currentThread);
          return Option.fromNullishOr(current?.id === id ? current : otherThreads.get(id));
        }),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
    Layer.mock(ProviderService)({
      isWorkflowSessionStopConfirmed: () =>
        Ref.get(providerProof).pipe(
          Effect.flatMap((proof) =>
            proof === null
              ? Ref.get(currentThread).pipe(
                  Effect.map(
                    (current) =>
                      current === null ||
                      current.session === null ||
                      current.session.status === "stopped",
                  ),
                )
              : Effect.succeed(proof),
          ),
        ),
      getInstanceInfo: (instanceId) =>
        Effect.gen(function* () {
          const selected = (yield* Ref.get(providers)).find(
            (entry) => entry.instanceId === instanceId,
          );
          if (!selected) return yield* new ProviderUnsupportedError({ provider: instanceId });
          return {
            instanceId,
            driverKind: selected.driver,
            displayName: instanceId,
            enabled: selected.enabled,
            continuationIdentity: {
              driverKind: selected.driver,
              continuationKey:
                selected.continuation?.groupKey ?? `${selected.driver}:instance:${instanceId}`,
            },
          };
        }),
    }),
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
      execute: ({ args }) =>
        Effect.gen(function* () {
          const revision = args.at(-1);
          const alias = args[1] === "symbolic-ref" && revision !== "HEAD";
          let stdout = "";
          if (args[1] === "symbolic-ref") {
            if (!alias) stdout = `refs/heads/${yield* Ref.get(branch)}`;
          } else if (revision === "HEAD^{commit}") {
            stdout = yield* Ref.get(head);
          } else {
            stdout = (yield* Ref.get(checkpointTrees)).get(revision ?? "") ?? "prepared-tree";
          }
          return {
            exitCode: ChildProcessSpawner.ExitCode(alias ? 1 : 0),
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
      fetchRemote: () => Ref.update(fetches, (count) => count + 1),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "base-sha", remoteRefName: "origin/main" }),
    }),
    Layer.mock(CheckpointStore)({
      captureCheckpoint: () =>
        Effect.gen(function* () {
          yield* Ref.update(captureCount, (count) => count + 1);
          yield* Queue.offer(captureStarted, undefined);
          const gate = yield* Ref.get(captureGate);
          if (gate) yield* Deferred.await(gate);
          const changedHead = yield* Ref.get(headAfterCapture);
          if (changedHead !== null) yield* Ref.set(head, changedHead);
          return { commitId: "capture-commit", treeId: yield* Ref.get(workspaceTree) };
        }),
      resolvePinnedTree: ({ checkpointRef }) =>
        Ref.get(checkpointTrees).pipe(
          Effect.map((trees) => trees.get(`${checkpointRef}^{tree}`) ?? "prepared-tree"),
        ),
      deleteCheckpointRefs: () => Effect.void,
    }),
    Layer.mock(TextGeneration)({
      generateApprovalVerdict: (input) =>
        Effect.gen(function* () {
          yield* Queue.offer(modelCalls, input);
          const verdict = yield* Ref.get(approvalVerdict);
          if (!verdict)
            return yield* new TextGenerationError({
              operation: "generateApprovalVerdict",
              detail: "Supervisor model unavailable",
            });
          return verdict;
        }),
    }),
  );
  return {
    mocks,
    cleanups,
    confirmedCleanup,
    providerProof,
    settlementMode,
    finalWriteFailures,
    failedFinalWrites,
    promptOutage,
    cleanupOutcomes,
    awaitRun: (predicate: (run: Store.WorkflowRun) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const run = yield* Queue.take(runs);
          if (predicate(run)) return run;
        }
      }),
    currentThread,
    nextThreadRead,
    otherThreads,
    projectState,
    awaitPrompt: Queue.take(prompts),
    fetches,
    providers,
    repositoryKey,
    commands,
    awaitCommand: (predicate: (command: OrchestrationCommand) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const command = yield* Queue.take(dispatched);
          if (predicate(command)) return command;
        }
      }),
    workspaceTree,
    headAfterCapture,
    captureGate,
    captureStarted,
    captureCount,
    checkpointTrees,
    head,
    branch,
    retryMode,
    dismissalMode,
    modelCalls,
    approvalVerdict,
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
    completeCurrent: Effect.gen(function* () {
      const start = (yield* Ref.get(commands)).findLast(
        (command) => command.type === "thread.prompt.enqueue",
      );
      if (start?.type !== "thread.prompt.enqueue") return yield* Effect.die("No dispatched prompt");
      yield* Ref.update(currentThread, (value) => completed(value!, start.message.messageId));
    }),
    complete: Ref.update(currentThread, (value) => completed(value!)),
    starts: Ref.get(commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === "thread.prompt.enqueue")),
    ),
  };
});
export const test = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provide(persistence), Effect.scoped);

export const workflowAccess = (
  h: Effect.Success<typeof harness>,
  organizationId = "org-1",
  repositoryId = "repo-1",
) =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>();
    const bytes = (value: string) => new TextEncoder().encode(value);
    values.set(
      CLOUD_MACHINE_IDENTITY,
      bytes(
        yield* encodeCloudMachineIdentityJson({
          machineId: "machine",
          organizationId,
          role: "agent_executor",
        }),
      ),
    );
    const secrets: ServerSecretStore["Service"] = {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: (name, value) =>
        Effect.suspend(() =>
          values.has(name)
            ? Effect.fail(new SecretStorePersistError({ resource: name, cause: "AlreadyExists" }))
            : Effect.sync(() => {
                values.set(name, value);
              }),
        ),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      getOrCreateRandom: () => Effect.die("unused"),
    };
    const query = yield* ProjectionSnapshotQuery.pipe(Effect.provide(h.mocks));
    const identities = yield* RepositoryIdentityResolver.pipe(Effect.provide(h.mocks));
    const identity = (yield* identities.resolve("/repo"))!;
    yield* Ref.update(h.projectState, (project) => ({ ...project, repositoryIdentity: identity }));
    const construct = makeAccess.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed("env-1"),
      }),
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ProjectionSnapshotQuery, {
        ...query,
        getProjectShells: () => Ref.get(h.projectState).pipe(Effect.map((project) => [project])),
      }),
      Effect.provideService(RepositoryIdentityResolver, identities),
      Effect.provide(Layer.mock(ProjectionProjectRepository)({})),
    );
    const access = yield* construct;
    const policy: OrganizationRepositoryPolicy = {
      organizationId,
      revision: 1,
      members: [
        { userId: "bob", role: "admin" },
        { userId: "user-1", role: "admin" },
      ],
      repositories: [
        {
          repositoryId,
          canonicalKeys: [identity.canonicalKey],
          userIds: ["bob", "user-1"],
        },
      ],
    };
    yield* access.apply(policy, true);
    return { access, construct, policy, secrets, query, identities };
  });
