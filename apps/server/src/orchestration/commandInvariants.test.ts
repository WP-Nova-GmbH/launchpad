import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
  type ThreadPreparation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";

import { listThreadsByProjectId, requireThread, requireThreadAbsent } from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("lists threads by project", () => {
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  effectIt.effect("lets a draft retry reuse a deleted id only after setup has settled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const firstAttempt = readModel.threads.find((thread) => thread.id === threadId)!;
      const afterRollback: OrchestrationReadModel = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === threadId ? { ...thread, deletedAt: now, updatedAt: now } : thread,
        ),
      };
      const retry: OrchestrationCommand = {
        type: "thread.create",
        commandId: CommandId.make("cmd-retry"),
        threadId,
        projectId: firstAttempt.projectId,
        title: firstAttempt.title,
        modelSelection: firstAttempt.modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      };

      yield* requireThreadAbsent({ readModel: afterRollback, command: retry, threadId });

      const preparation: ThreadPreparation = {
        originalCommandId: CommandId.make("old-setup"),
        attemptId: CommandId.make("old-setup"),
        revision: 1,
        state: "failed",
        settled: false,
        recipe: null,
      };
      const withUnconfirmedSetup = {
        ...afterRollback,
        threads: afterRollback.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, promptQueue: { ...emptyThreadPromptQueue(), preparation } }
            : thread,
        ),
      };
      const blocked = yield* requireThreadAbsent({
        readModel: withUnconfirmedSetup,
        command: retry,
        threadId,
      }).pipe(Effect.flip);
      expect(blocked.message).toContain("unconfirmed setup process");
      yield* requireThreadAbsent({
        readModel: {
          ...withUnconfirmedSetup,
          threads: withUnconfirmedSetup.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  promptQueue: {
                    ...emptyThreadPromptQueue(),
                    preparation: { ...preparation, settled: true },
                  },
                }
              : thread,
          ),
        },
        command: retry,
        threadId,
      });
    }),
  );
});
