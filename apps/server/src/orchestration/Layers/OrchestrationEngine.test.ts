// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

function makeOrchestrationLayer(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  rejectProjection?: (event: OrchestrationEvent) => boolean,
) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const pipeline = rejectProjection
    ? Layer.effect(
        OrchestrationProjectionPipeline,
        Effect.gen(function* () {
          const inner = yield* OrchestrationProjectionPipeline;
          return {
            ...inner,
            projectEventDeferred: (event: OrchestrationEvent) =>
              rejectProjection(event)
                ? Effect.fail(
                    new PersistenceSqlError({
                      operation: "test.preparation",
                      detail: "Injected preparation projection failure",
                    }),
                  )
                : inner.projectEventDeferred(event),
          };
        }),
      ).pipe(Layer.provide(OrchestrationProjectionPipelineLive))
    : OrchestrationProjectionPipelineLive;
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(pipeline),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(
      repositoryIdentityResolver
        ? Layer.succeed(
            RepositoryIdentityResolver.RepositoryIdentityResolver,
            repositoryIdentityResolver,
          )
        : RepositoryIdentityResolver.layer,
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem(
  databasePath?: string,
  repositoryIdentityResolver?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  rejectProjection?: (event: OrchestrationEvent) => boolean,
) {
  const runtime = ManagedRuntime.make(
    makeOrchestrationLayer(databasePath, repositoryIdentityResolver, rejectProjection),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    readShell: () => runtime.runPromise(snapshotQuery.getShellSnapshot()),
    readThread: (threadId: ThreadId) =>
      runtime.runPromise(snapshotQuery.getThreadDetailById(threadId)),
    receipt: (commandId: CommandId) =>
      runtime.runPromise(
        Effect.flatMap(
          OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository,
          (receipts) => receipts.getByCommandId({ commandId }),
        ),
      ),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    confirmDeletedThreadCleanup: (threadId: ThreadId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM thread_cleanup_fences WHERE thread_id = ${threadId}`;
        }),
      ),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("accepts one native answer while preserving the shared queue pause", async () => {
    const system = await createOrchestrationSystem();
    const projectId = ProjectId.make("native-question-project");
    const threadId = ThreadId.make("native-question-thread");
    const requestId = ApprovalRequestId.make("native-question");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("native-project"),
          projectId,
          title: "Questions",
          workspaceRoot: "/tmp/native-questions",
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("native-thread"),
          threadId,
          projectId,
          title: "Questions",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("native-pause"),
          threadId,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("native-request"),
          threadId,
          createdAt: now(),
          activity: {
            id: EventId.make("native-request"),
            kind: "user-input.requested",
            summary: "Question",
            tone: "info",
            turnId: null,
            createdAt: now(),
            payload: {
              requestId,
              questions: [{ id: "q", header: "Name", question: "What name?", options: [] }],
            },
          },
        }),
      );
      const answers = ["Alice", "Bob"].map((name) => ({
        type: "thread.user-input.respond" as const,
        commandId: CommandId.make(`native-answer-${name}`),
        threadId,
        requestId,
        answers: { q: name },
        author: { userId: name, displayName: name, imageUrl: null },
        createdAt: now(),
      }));
      const results = await Promise.allSettled(
        answers.map((answer) => system.run(system.engine.dispatch(answer))),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.promptQueue?.enabled).toBe(false);
      expect(thread.promptQueue?.pauseReason?.code).toBe("stopped");
      expect(thread.messages).toHaveLength(0);
      const claims = thread.activities.filter(
        (activity) => activity.kind === "user-input.answer-submitted",
      );
      expect(claims).toHaveLength(1);
      const winner = answers[results.findIndex((result) => result.status === "fulfilled")]!;
      expect(claims[0]?.payload).toMatchObject({ answers: winner.answers, author: winner.author });
      const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
      expect(
        events.filter((event) => event.type === "thread.user-input-response-requested"),
      ).toHaveLength(1);
      await expect(system.run(system.engine.dispatch(winner))).resolves.toBeDefined();
    } finally {
      await system.dispose();
    }
  });

  it("persists shared queue order, receipts, staged delivery and provenance across restart", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shared-queue-"));
    const databasePath = NodePath.join(directory, "state.sqlite");
    let system = await createOrchestrationSystem(databasePath);
    const projectId = ProjectId.make("shared-project");
    const threadId = ThreadId.make("shared-thread");
    const author = { userId: "alice", displayName: "Alice", imageUrl: null };
    const editor = { userId: "bob", displayName: "Bob", imageUrl: null };
    const enqueue = {
      type: "thread.prompt.enqueue" as const,
      commandId: CommandId.make("shared-enqueue"),
      threadId,
      message: { messageId: MessageId.make("shared-message"), text: "accepted", attachments: [] },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      author,
      createdAt: now(),
    };
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("shared-project"),
          projectId,
          title: "Shared",
          workspaceRoot: directory,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("shared-thread"),
          threadId,
          projectId,
          title: "Shared",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const accepted = await system.run(system.engine.dispatch(enqueue));
      await system.run(
        system.engine.dispatch({
          ...enqueue,
          type: "thread.prompt.edit",
          commandId: CommandId.make("shared-edit"),
          messageId: enqueue.message.messageId,
          expectedRevision: 1,
          message: { text: "edited", attachments: [] },
          author: editor,
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      expect(await system.run(system.engine.dispatch(enqueue))).toEqual(accepted);
      let thread = (await system.readModel()).threads[0]!;
      expect(thread.messages).toHaveLength(0);
      expect(thread.promptQueue?.entries).toHaveLength(1);
      expect(thread.promptQueue?.entries[0]).toMatchObject({
        author,
        editedBy: editor,
        text: "edited",
        revision: 2,
        acceptedSequence: accepted.sequence,
      });
      const attemptId = CommandId.make("shared-claim");
      await system.run(
        system.engine.dispatch({
          type: "thread.prompt.claim",
          commandId: attemptId,
          threadId,
          messageId: enqueue.message.messageId,
          expectedRevision: 2,
          expectedControlRevision: 0,
          createdAt: now(),
        }),
      );
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      thread = (await system.readModel()).threads[0]!;
      expect(thread.promptQueue?.handoff?.attemptId).toBe(attemptId);
      expect(thread.messages).toHaveLength(0);
      await system.run(
        system.engine.dispatch({
          type: "thread.prompt.admit",
          commandId: CommandId.make("shared-admit"),
          threadId,
          attemptId,
          turnId: TurnId.make("shared-turn"),
          evidence: "provider-ack",
          createdAt: now(),
        }),
      );
      const detail = await system.readThread(threadId);
      expect(Option.getOrThrow(detail).messages[0]).toMatchObject({
        author,
        editedBy: editor,
        text: "edited",
      });
      await system.dispose();
      system = await createOrchestrationSystem(databasePath);
      thread = (await system.readModel()).threads[0]!;
      expect(thread.promptQueue?.awaitingTurnId).toBe("shared-turn");
      expect(thread.messages[0]).toMatchObject({ author, editedBy: editor, text: "edited" });
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["running", "stopped"] as const)(
    "sends async answers with a %s session and rejects old duplicate replies",
    async (status) => {
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-async-questions-"),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      let system = await createOrchestrationSystem(databasePath);
      const threadId = ThreadId.make("async-thread");
      const projectId = ProjectId.make("async-project");
      const requestId = ApprovalRequestId.make("codex-async:question-1");
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("async-project"),
            projectId,
            title: "Async questions",
            workspaceRoot: "/tmp/async-questions",
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("async-thread"),
            threadId,
            projectId,
            title: "Async questions",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("async-session"),
            threadId,
            createdAt: now(),
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
              lastError: null,
              updatedAt: now(),
            },
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("async-question"),
            threadId,
            createdAt: now(),
            activity: {
              id: EventId.make("async-question"),
              kind: "user-input.requested",
              summary: "User input requested",
              tone: "info",
              turnId: TurnId.make("turn-1"),
              createdAt: now(),
              payload: {
                requestId,
                responseMode: "message",
                questions: [
                  {
                    id: "0",
                    header: "Question",
                    question: "Which package manager?",
                    options: [{ label: "pnpm", description: "" }],
                  },
                  {
                    id: "1",
                    header: "Question",
                    question: "What should it be named?",
                    options: [],
                  },
                ],
              },
            },
          }),
        );
        const appendWork = async (prefix: string, createdAt: string) => {
          for (let index = 0; index < 501; index += 1) {
            await system.run(
              system.engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`${prefix}-${index}`),
                threadId,
                createdAt,
                activity: {
                  id: EventId.make(`${prefix}-${index}`),
                  kind: "tool.completed",
                  summary: "Work continued",
                  payload: {},
                  tone: "info",
                  turnId: TurnId.make("turn-1"),
                  createdAt,
                },
              }),
            );
          }
        };
        await appendWork("work", "2026-01-01T00:00:01.000Z");
        const before = await system.readModel();
        expect(
          before.threads[0]?.activities.some((activity) => activity.id === "async-question"),
        ).toBe(true);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        const response = {
          type: "thread.user-input.respond" as const,
          commandId: CommandId.make("async-response"),
          threadId,
          requestId,
          answers: { "0": "pnpm", "1": "Example" },
          attachmentsByQuestionId: {
            "1": [
              {
                type: "file" as const,
                id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        };
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("incomplete-answer"),
              answers: { "0": "pnpm" },
            }),
          ),
        ).rejects.toThrow("Answer each question before sending.");
        await system.run(system.engine.dispatch(response));
        const after = await system.readModel();
        const userMessages = after.threads[0]?.messages.filter(
          (message) => message.role === "user",
        );
        expect(userMessages).toHaveLength(1);
        expect(userMessages?.[0]?.attachments).toEqual(response.attachmentsByQuestionId["1"]);
        expect(userMessages?.[0]?.text).toBe(
          "Which package manager?\npnpm\n\nWhat should it be named?\nExample\nAttached file: spec.txt (thread-1-00000000-0000-4000-8000-0000000000aa-txt)",
        );
        expect(
          after.threads[0]?.activities.find((activity) => activity.kind === "user-input.resolved")
            ?.payload,
        ).toMatchObject({ requestId, responseMode: "message", answers: response.answers });
        const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
        expect(
          Array.from(events)
            .filter((event) => event.commandId === response.commandId)
            .map((event) => event.type),
        ).toEqual([
          "thread.activity-appended",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("second-client-reply"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
        await appendWork("later-work", "2026-01-01T00:00:03.000Z");
        const afterEviction = Option.getOrThrow(await system.readThread(threadId));
        expect(
          afterEviction.activities.some((activity) => activity.kind === "user-input.resolved"),
        ).toBe(false);
        if (status === "stopped") {
          await system.dispose();
          system = await createOrchestrationSystem(databasePath);
        }
        await expect(
          system.run(
            system.engine.dispatch({
              ...response,
              commandId: CommandId.make("reply-after-eviction"),
            }),
          ),
        ).rejects.toThrow("This question has already been answered.");
      } finally {
        await system.dispose();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadSubscriptionAnchor: () => Effect.succeedNone,
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getDeletedWorktreeThreads: () => Effect.die("unused"),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getProjectShellById: () => Effect.succeedNone,
          getProjectShells: () => Effect.succeed([]),
          getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeedNone,
          getFullThreadDiffContext: () => Effect.succeedNone,
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeedNone,
          getThreadDetailById: () => Effect.succeedNone,
          getThreadDetailSnapshot: () => Effect.succeedNone,
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
          projectEventDeferred: () => Effect.succeed(Effect.void),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  effectIt.effect("preserves the blocked-settle error and persists its rejected receipt", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const projectId = ProjectId.make("project-blocked-settle");
      const threadId = ThreadId.make("thread-blocked-settle");
      const commandId = CommandId.make("cmd-blocked-settle");
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-blocked-settle-project-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-blocked-settle",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-blocked-settle-thread-create"),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-blocked-settle-session-set"),
        threadId,
        createdAt,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
      });

      const sequence = yield* engine.latestSequence;
      const error = yield* engine
        .dispatch({ type: "thread.settle", commandId, threadId })
        .pipe(Effect.flip);
      const message =
        "This thread still needs attention. Resolve or interrupt it first, then try again.";
      expect(error).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId,
        message,
      });
      expect(Option.getOrNull(yield* receipts.getByCommandId({ commandId }))).toMatchObject({
        commandId,
        aggregateKind: "thread",
        aggregateId: threadId,
        status: "rejected",
        projectId,
        error: message,
        resultSequence: sequence,
      });
      expect(yield* engine.latestSequence).toBe(sequence);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  effectIt.effect(
    "rejects persisted changes and live background work without blocking unrelated threads",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now()));
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const backgroundLiveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
        const projectId = ProjectId.make("project-auto-settle-guard");
        const guardedThreadId = ThreadId.make("thread-auto-settle-guarded");
        const unrelatedThreadId = ThreadId.make("thread-auto-settle-unrelated");
        const liveThreadId = ThreadId.make("thread-auto-settle-live");

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-auto-settle-guard-project"),
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project-auto-settle-guard",
          createdAt: now(),
        });
        for (const threadId of [guardedThreadId, unrelatedThreadId, liveThreadId]) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${threadId}`),
            threadId,
            projectId,
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now(),
          });
        }

        const beforeUpdate = yield* snapshots.getSnapshot();
        const snapshotSequence = beforeUpdate.snapshotSequence;
        const originalUpdatedAt = beforeUpdate.threads.find(
          (thread) => thread.id === guardedThreadId,
        )?.updatedAt;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-guard-meta"),
          threadId: guardedThreadId,
          branch: "new-branch",
        });
        const afterUpdate = yield* snapshots.getSnapshot();
        expect(afterUpdate.threads.find((thread) => thread.id === guardedThreadId)?.updatedAt).toBe(
          originalUpdatedAt,
        );

        // Automatic settlement stamps the last activity, never the sweep time.
        const lastActivityAt = "2025-12-20T00:00:00.000Z";
        const staleError = yield* engine
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("cmd-auto-settle-stale-snapshot"),
            threadId: guardedThreadId,
            snapshotSequence,
            settledAt: lastActivityAt,
          })
          .pipe(Effect.flip);
        expect(staleError._tag).toBe("OrchestrationCommandInvariantError");

        const livenessSnapshotSequence = yield* engine.latestSequence;
        for (const [taskType, expectedLiveness] of [
          ["subagent", "working"],
          ["local_bash", "monitoring"],
        ] as const) {
          backgroundLiveness.recordTaskLiveness({
            threadId: liveThreadId,
            taskId: `task-${expectedLiveness}`,
            taskType,
            status: undefined,
            kind: "started",
          });
          expect(backgroundLiveness.getThreadBackgroundLiveness(liveThreadId)).toBe(
            expectedLiveness,
          );
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);

          const livenessError = yield* engine
            .dispatch({
              type: "thread.auto-settle",
              commandId: CommandId.make(`cmd-auto-settle-${expectedLiveness}`),
              threadId: liveThreadId,
              snapshotSequence: livenessSnapshotSequence,
              settledAt: lastActivityAt,
            })
            .pipe(Effect.flip);
          expect(livenessError._tag).toBe("OrchestrationCommandInvariantError");
          expect(yield* engine.latestSequence).toBe(livenessSnapshotSequence);
          backgroundLiveness.clearThreadLiveness(liveThreadId);
        }

        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-liveness-cleared"),
          threadId: liveThreadId,
          snapshotSequence: livenessSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const freshSnapshotSequence = yield* engine.latestSequence;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-auto-settle-unrelated-meta"),
          threadId: unrelatedThreadId,
          title: "Unrelated update",
        });
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-after-unrelated-update"),
          threadId: guardedThreadId,
          snapshotSequence: freshSnapshotSequence,
          settledAt: lastActivityAt,
        });

        const settled = yield* snapshots.getSnapshot();
        for (const threadId of [guardedThreadId, liveThreadId]) {
          const thread = settled.threads.find((candidate) => candidate.id === threadId);
          expect(thread?.settledOverride).toBe("settled");
          expect(thread?.settledAt).toBe(lastActivityAt);
          expect(thread?.updatedAt).toBe(now());
        }
      }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("keeps the author of a user message from the command to the read model", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const author = { userId: "user_alice", displayName: "Alice", imageUrl: null };

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-author"),
        projectId: asProjectId("project-author"),
        title: "Project Author",
        workspaceRoot: "/tmp/project-author",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-author"),
        threadId: ThreadId.make("thread-author"),
        projectId: asProjectId("project-author"),
        title: "Who wrote this",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-author"),
        threadId: ThreadId.make("thread-author"),
        message: {
          messageId: asMessageId("msg-author"),
          role: "user",
          text: "hello from Alice",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        author,
        createdAt,
      }),
    );

    const readModel = await system.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-author"));
    expect(thread?.messages.map((message) => [message.text, message.author])).toEqual([
      ["hello from Alice", author],
    ]);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it.each(["unlink", "relink", "branch", "worktree", "project", "delete"] as const)(
    "rejects PR discovery completed after a newer %s command",
    async (change) => {
      const system = await createOrchestrationSystem(undefined, {
        resolve: (workspaceRoot) =>
          Effect.succeed({
            canonicalKey: "example.test/owner/repository",
            provider: "github",
            displayName: "owner/repository",
            rootPath: workspaceRoot,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://example.test/owner/repository.git",
            },
          }),
      });
      // Same-tick links must replace the old PR, not rely on timestamp ordering.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(now()));
      try {
        const projectId = ProjectId.make("pr-race-project");
        const threadId = ThreadId.make("pr-race-thread");
        const previous = {
          projectId,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const replacement = {
          ...previous,
          number: 2,
          url: "https://example.test/owner/repository/pull/2",
        };
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("pr-race-project-create"),
            projectId,
            title: "PR race project",
            workspaceRoot: "/tmp/pr-race-project",
            defaultModelSelection: null,
            createdAt: now(),
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("pr-race-thread-create"),
            threadId,
            projectId,
            title: "PR race thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            createdAt: now(),
          }),
        );
        const observed = await system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("pr-race-link"),
            threadId,
            linkedPullRequest: previous,
          }),
        );
        expect((await system.readModel()).threads[0]?.linkedPullRequest).toEqual(previous);
        const metadataChanges = {
          unlink: { linkedPullRequest: null },
          relink: {
            linkedPullRequest: {
              ...previous,
              number: 3,
              url: "https://example.test/owner/repository/pull/3",
            },
          },
          branch: { branch: "another-feature" },
          worktree: { worktreePath: "/tmp/another-worktree" },
          project: {},
        };
        await system.run(
          system.engine.dispatch(
            change === "project"
              ? {
                  type: "project.meta.update",
                  commandId: CommandId.make("pr-race-project-move"),
                  projectId,
                  workspaceRoot: "/tmp/another-project-root",
                }
              : change === "delete"
                ? { type: "thread.delete", commandId: CommandId.make("pr-race-delete"), threadId }
                : {
                    type: "thread.meta.update",
                    commandId: CommandId.make(`pr-race-${change}`),
                    threadId,
                    ...metadataChanges[change],
                  },
          ),
        );
        const command = {
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-race-stale-sync"),
          threadId,
          projectId,
          snapshotSequence: observed.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-race-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: previous,
            branchPullRequest: null,
          },
          branchPullRequest: replacement,
          linkedPullRequest: replacement,
        } satisfies OrchestrationCommand;
        const error = await system.run(system.engine.dispatch(command).pipe(Effect.flip));
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        if (change === "delete") return;
        const current = (await system.readModel()).threads[0];
        expect(current?.branchPullRequest ?? null).toBeNull();
        expect(current?.pullRequests.map((link) => link.number)).toEqual(
          change === "unlink" ? [] : change === "relink" ? [3] : [1],
        );
        expect(current?.linkedPullRequest ?? null).toEqual(
          change === "unlink"
            ? null
            : change === "relink"
              ? metadataChanges.relink.linkedPullRequest
              : previous,
        );
      } finally {
        clock.mockRestore();
        await system.dispose();
      }
    },
  );

  it("saves PR associations through streaming and unrelated metadata edits", async () => {
    const system = await createOrchestrationSystem();
    try {
      const projectId = ProjectId.make("pr-sync-project");
      const threadId = ThreadId.make("pr-sync-thread");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("pr-sync-project-create"),
          projectId,
          title: "PR sync project",
          workspaceRoot: "/tmp/pr-sync-project",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const created = await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("pr-sync-thread-create"),
          threadId,
          projectId,
          title: "PR sync thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: null,
          createdAt: now(),
        }),
      );
      const reference = {
        projectId,
        repository: "owner/repository",
        number: 42,
        url: "https://example.test/owner/repository/pull/42",
      };
      const activityAt = "2026-01-01T01:00:00.000Z";
      await system.run(
        system.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("pr-sync-streaming-message"),
          threadId,
          messageId: MessageId.make("pr-sync-message"),
          delta: "The PR is ready.",
          createdAt: activityAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("pr-sync-title-and-model"),
          threadId,
          title: "Renamed thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("pr-sync-project-title"),
          projectId,
          title: "Renamed project",
        }),
      );
      const beforeSync = (await system.readModel()).threads[0];
      await system.run(
        system.engine.dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("pr-sync-discovery"),
          projectId,
          threadId,
          snapshotSequence: created.sequence,
          expected: {
            workspaceRoot: "/tmp/pr-sync-project",
            branch: "feature",
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: reference,
        }),
      );
      const current = (await system.readModel()).threads[0];
      expect(current?.branchPullRequest).toEqual(reference);
      expect(current?.linkedPullRequest ?? null).toBeNull();
      expect(current?.updatedAt).toBe(beforeSync?.updatedAt);
    } finally {
      await system.dispose();
    }
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
      hasEventAfter: () => Effect.succeed(false),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
      projectEventDeferred: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.succeed(Effect.void);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("replays the accepted receipt for a genuine retry of the same command", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-retry-project-create"),
        projectId: asProjectId("project-retry"),
        title: "Retry Project",
        workspaceRoot: "/tmp/project-retry",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-retry-thread-create"),
        threadId: ThreadId.make("thread-retry"),
        projectId: asProjectId("project-retry"),
        title: "retry",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStart = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-retry-turn-start"),
      threadId: ThreadId.make("thread-retry"),
      message: {
        messageId: asMessageId("msg-retry"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    } as const;

    const first = await system.run(engine.dispatch(turnStart));
    const second = await system.run(engine.dispatch(turnStart));
    expect(second.sequence).toBe(first.sequence);

    const readModel = await system.readModel();
    const thread = readModel.threads.find((candidate) => candidate.id === "thread-retry");
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);

    await system.dispose();
  });

  it("rejects reusing an accepted command id for a different aggregate", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-conflict-project-create"),
        projectId: asProjectId("project-conflict"),
        title: "Conflict Project",
        workspaceRoot: "/tmp/project-conflict",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    for (const threadId of ["thread-conflict-a", "thread-conflict-b"]) {
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${threadId}-create`),
          threadId: ThreadId.make(threadId),
          projectId: asProjectId("project-conflict"),
          title: threadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
    }

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-conflict-turn-start"),
        threadId: ThreadId.make("thread-conflict-a"),
        message: {
          messageId: asMessageId("msg-conflict-a"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-conflict-turn-start"),
          threadId: ThreadId.make("thread-conflict-b"),
          message: {
            messageId: asMessageId("msg-conflict-b"),
            role: "user",
            text: "hello again",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toThrow("already used for thread 'thread-conflict-a'");

    const readModel = await system.readModel();
    const targetThread = readModel.threads.find(
      (candidate) => candidate.id === "thread-conflict-b",
    );
    expect(targetThread?.messages.filter((message) => message.role === "user")).toHaveLength(0);

    await system.dispose();
  });

  it("stamps the dispatching client's origin onto persisted event metadata", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-origin-project-create"),
          projectId: asProjectId("project-origin"),
          title: "Origin Project",
          workspaceRoot: "/tmp/project-origin",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        },
        { origin: { surface: "mobile", appVersion: "1.2.3" } },
      ),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-no-origin-project-create"),
        projectId: asProjectId("project-no-origin"),
        title: "No Origin Project",
        workspaceRoot: "/tmp/project-no-origin",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    const withOrigin = events.find((event) => event.commandId === "cmd-origin-project-create");
    const withoutOrigin = events.find(
      (event) => event.commandId === "cmd-no-origin-project-create",
    );

    expect(withOrigin?.metadata.origin).toEqual({ surface: "mobile", appVersion: "1.2.3" });
    expect(withoutOrigin?.metadata.origin).toBeUndefined();

    await system.dispose();
  });
});

describe("atomic shared preparation acceptance", () => {
  const projectId = ProjectId.make("shared-preparation-project");
  const threadId = ThreadId.make("shared-preparation-thread");
  const first = {
    type: "thread.prompt.enqueue" as const,
    commandId: CommandId.make("shared-first"),
    threadId,
    createdAt: now(),
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    message: { messageId: MessageId.make("shared-first-message"), text: "First", attachments: [] },
    bootstrap: {
      createThread: {
        projectId,
        title: "Shared setup",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt: now(),
      },
      prepareWorktree: {
        projectCwd: "/tmp/shared-preparation",
        baseBranch: "main",
        branch: "feature/shared",
      },
      runSetupScript: true,
    },
  };
  const createProject = {
    type: "project.create" as const,
    commandId: CommandId.make("shared-project"),
    projectId,
    title: "Shared",
    workspaceRoot: "/tmp/shared-preparation",
    createdAt: now(),
  };
  it("rejects deletion atomically until required preparation has stopped", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      const before = await system.run(system.engine.latestSequence);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.delete",
            projectId,
            force: true,
            commandId: CommandId.make("delete-project-pending"),
          }),
        ),
      ).rejects.toThrow("Setup must finish stopping");
      expect(await system.run(system.engine.latestSequence)).toBe(before);
      expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      const setup = Option.getOrThrow(await system.readThread(threadId)).promptQueue!.preparation!;
      await system.run(
        system.engine.dispatch({
          type: "thread.preparation.update",
          commandId: CommandId.make("running-for-delete"),
          threadId,
          createdAt: now(),
          expectedRevision: setup.revision,
          preparation: { ...setup, revision: setup.revision + 1, state: "running", settled: false },
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("pause-for-delete"),
          threadId,
          createdAt: now(),
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.delete",
            threadId,
            commandId: CommandId.make("delete-unsettled"),
          }),
        ),
      ).rejects.toThrow("Setup must finish stopping");
    } finally {
      await system.dispose();
    }
  });
  it("orders preflight rejection with duplicate deletes and keeps the original project scope", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          commandId: CommandId.make("stop-pending"),
          threadId,
          createdAt: now(),
        }),
      );
      const command = {
        type: "thread.delete" as const,
        threadId,
        commandId: CommandId.make("rejected-delete"),
      };
      await expect(
        system.run(
          system.engine.dispatch(command, {
            rejection: { projectId, detail: "Process exit was not confirmed" },
          }),
        ),
      ).rejects.toThrow("Process exit was not confirmed");
      await expect(system.run(system.engine.dispatch(command))).rejects.toThrow(
        "Process exit was not confirmed",
      );
      expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      expect(Option.getOrThrow(await system.receipt(command.commandId)).projectId).toBe(projectId);
      const acceptedCommand = { ...command, commandId: CommandId.make("fresh-delete") };
      const accepted = await system.run(system.engine.dispatch(acceptedCommand));
      expect(
        await system.run(
          system.engine.dispatch(acceptedCommand, {
            rejection: { projectId, detail: "A late duplicate failed" },
          }),
        ),
      ).toEqual(accepted);
    } finally {
      await system.dispose();
    }
  });
  it("fences both preparatory Stop and final Delete from a retried preparation", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      await system.run(system.engine.dispatch(first));
      const options = {
        deletionPreconditions: {
          projectId,
          snapshotSequence: await system.run(system.engine.latestSequence),
          threads: [{ threadId, preparationAttemptId: first.commandId }],
        },
      };
      await system.run(
        system.engine.dispatch({
          type: "thread.queue.pause",
          threadId,
          commandId: CommandId.make("pause-retry"),
          createdAt: now(),
        }),
      );
      const queue = Option.getOrThrow(await system.readThread(threadId)).promptQueue!;
      await system.run(
        system.engine.dispatch({
          type: "thread.preparation.retry",
          threadId,
          commandId: CommandId.make("retry-before-delete"),
          createdAt: now(),
          expectedRevision: queue.preparation!.revision,
          expectedControlRevision: queue.revision,
        }),
      );
      for (const command of [
        {
          type: "thread.queue.pause" as const,
          threadId,
          commandId: CommandId.make("late-delete-stop"),
          createdAt: now(),
        },
        {
          type: "thread.delete" as const,
          threadId,
          commandId: CommandId.make("late-final-delete"),
        },
      ])
        await expect(system.run(system.engine.dispatch(command, options))).rejects.toThrow(
          "changed during deletion",
        );
      expect(
        Option.getOrThrow(await system.readThread(threadId)).promptQueue!.preparation!.state,
      ).toBe("pending");
    } finally {
      await system.dispose();
    }
  });
  it.each([false, true])(
    "does not retarget a recreated thread or its rejected receipt (different project: %s)",
    async (differentProject) => {
      const system = await createOrchestrationSystem();
      try {
        await system.run(system.engine.dispatch(createProject));
        const create = {
          type: "thread.create" as const,
          ...first.bootstrap.createThread,
          threadId,
          commandId: CommandId.make("old-create"),
        };
        await system.run(system.engine.dispatch(create));
        const options = {
          deletionPreconditions: {
            projectId,
            snapshotSequence: await system.run(system.engine.latestSequence),
            threads: [{ threadId, preparationAttemptId: null }],
          },
        };
        await system.run(
          system.engine.dispatch({
            type: "thread.delete",
            threadId,
            commandId: CommandId.make("other-delete"),
          }),
        );
        const replacementProject = differentProject
          ? ProjectId.make("replacement-project")
          : projectId;
        if (differentProject)
          await system.run(
            system.engine.dispatch({
              ...createProject,
              projectId: replacementProject,
              commandId: CommandId.make("replacement-project-create"),
              workspaceRoot: "/tmp/replacement-project",
            }),
          );
        const blockedCreate = {
          ...create,
          projectId: replacementProject,
          commandId: CommandId.make("blocked-replacement-create"),
        };
        await expect(system.run(system.engine.dispatch(blockedCreate))).rejects.toThrow(
          "not been confirmed stopped",
        );
        await system.run(
          system.engine.dispatch({
            ...create,
            threadId: ThreadId.make("unrelated-replacement"),
            commandId: CommandId.make("unrelated-replacement-create"),
          }),
        );
        await system.confirmDeletedThreadCleanup(threadId);
        await expect(system.run(system.engine.dispatch(blockedCreate))).rejects.toThrow(
          "not been confirmed stopped",
        );
        await system.run(
          system.engine.dispatch({
            ...create,
            projectId: replacementProject,
            commandId: CommandId.make("replacement-create"),
          }),
        );
        const stale = {
          type: "thread.delete" as const,
          threadId,
          commandId: CommandId.make("stale-delete"),
        };
        await expect(system.run(system.engine.dispatch(stale, options))).rejects.toThrow(
          "changed during deletion",
        );
        expect(Option.getOrThrow(await system.receipt(stale.commandId)).projectId).toBe(projectId);
        expect(Option.isSome(await system.readThread(threadId))).toBe(true);
      } finally {
        await system.dispose();
      }
    },
  );
  it("saves one receipt for creation, first prompt and setup, and replay cannot reorder teammate work", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      const accepted = await system.run(system.engine.dispatch(first));
      await system.run(
        system.engine.dispatch({
          ...first,
          commandId: CommandId.make("teammate"),
          bootstrap: undefined,
          message: {
            ...first.message,
            messageId: MessageId.make("teammate-message"),
            text: "Second",
          },
        }),
      );
      expect(await system.run(system.engine.dispatch(first))).toEqual(accepted);
      const thread = Option.getOrThrow(await system.readThread(threadId));
      expect(thread.messages).toHaveLength(0);
      expect(thread.promptQueue?.preparation?.state).toBe("pending");
      expect((await system.readShell()).threads[0]?.promptQueueSummary?.preparation).toEqual({
        state: "pending",
        revision: 0,
        settled: true,
      });
      expect(thread.promptQueue?.entries.map((entry) => entry.messageId)).toEqual([
        "shared-first-message",
        "teammate-message",
      ]);
      const receipt = Option.getOrThrow(await system.receipt(first.commandId));
      expect(receipt.status).toBe("accepted");
      expect(receipt.projectId).toBe(projectId);
      expect(receipt.aggregateId).toBe(threadId);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      expect(
        events.filter((event) => event.commandId === first.commandId).map((event) => event.type),
      ).toEqual(["thread.created", "thread.prompt-queue-changed", "thread.prompt-queue-changed"]);
    } finally {
      await system.dispose();
    }
  });
  it("rolls back the thread, intent and queue together if the first prompt projection fails", async () => {
    let failed = false;
    const system = await createOrchestrationSystem(undefined, undefined, (event) => {
      if (
        !failed &&
        event.commandId === first.commandId &&
        event.type === "thread.prompt-queue-changed" &&
        event.payload.entry
      ) {
        failed = true;
        return true;
      }
      return false;
    });
    try {
      await system.run(system.engine.dispatch(createProject));
      await expect(system.run(system.engine.dispatch(first))).rejects.toThrow(
        "Injected preparation projection failure",
      );
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
      expect(Option.isNone(await system.receipt(first.commandId))).toBe(true);
      expect(
        (await system.run(Stream.runCollect(system.engine.readEvents(0)))).map(
          (event) => event.type,
        ),
      ).toEqual(["project.created"]);
      await system.run(system.engine.dispatch(first));
      expect(
        Option.getOrThrow(await system.readThread(threadId)).promptQueue?.entries,
      ).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });
  it("rejects invalid first prompts without creating a thread and retains an authorized receipt scope", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(system.engine.dispatch(createProject));
      const rejected = { ...first, message: { ...first.message, text: "" } };
      await expect(system.run(system.engine.dispatch(rejected))).rejects.toThrow("A prompt needs");
      expect(Option.isNone(await system.readThread(threadId))).toBe(true);
      const receipt = Option.getOrThrow(await system.receipt(first.commandId));
      expect(receipt.status).toBe("rejected");
      expect(receipt.projectId).toBe(projectId);
    } finally {
      await system.dispose();
    }
  });
});
