import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-08-24T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-bootstrap");

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

const author = { userId: "alice", displayName: "Alice", imageUrl: null };
const editor = { userId: "bob", displayName: "Bob", imageUrl: null };
const enqueue = (id: string) => ({
  type: "thread.prompt.enqueue" as const,
  commandId: CommandId.make(`enqueue:${id}`),
  threadId,
  message: { messageId: MessageId.make(id), text: id, attachments: [] },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt,
  author,
});
const apply = Effect.fn(function* (state: OrchestrationReadModel, command: OrchestrationCommand) {
  const planned = yield* decideOrchestrationCommand({ readModel: state, command });
  for (const event of Array.isArray(planned) ? planned : [planned])
    state = yield* projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 });
  return state;
});
const queue = (state: OrchestrationReadModel) => state.threads[0]!.promptQueue!;
const claim = {
  type: "thread.prompt.claim" as const,
  threadId,
  commandId: CommandId.make("claim"),
  messageId: MessageId.make("first"),
  expectedRevision: 1,
  expectedControlRevision: 0,
  createdAt,
};

it.layer(NodeServices.layer)("shared prompt queue", (it) => {
  it.effect("rejects an edit authorized for a different queued runtime mode", () =>
    Effect.gen(function* () {
      const original = enqueue("personal");
      const state = yield* apply(yield* readModelWithThread, original);
      const edit = {
        type: "thread.prompt.edit" as const,
        commandId: CommandId.make("mode-mismatch-edit"),
        threadId,
        messageId: original.message.messageId,
        expectedRevision: 1,
        expectedRuntimeMode: "approval-required" as const,
        message: { text: "Changed", attachments: [] },
        createdAt,
      };
      expect(yield* apply(state, edit).pipe(Effect.flip)).toMatchObject({
        detail: "Prompt conflict: this entry's runtime mode changed. Review it before saving.",
      });
    }),
  );
  it.effect(
    "an edit replaces authorization and an unsigned edit clears the previous owner's grant",
    () =>
      Effect.gen(function* () {
        const original = enqueue("personal");
        let state = yield* apply(yield* readModelWithThread, {
          ...original,
          message: { ...original.message, issueTrackerAuthorizationId: "alice-grant" },
        });
        state = yield* apply(state, {
          type: "thread.prompt.edit",
          commandId: CommandId.make("bob-edit"),
          threadId,
          messageId: original.message.messageId,
          expectedRevision: 1,
          message: {
            text: "Bob's revision",
            attachments: [],
            issueTrackerAuthorizationId: "bob-grant",
          },
          author: editor,
          createdAt,
        });
        expect(queue(state).entries[0]?.issueTrackerAuthorizationId).toBe("bob-grant");
        state = yield* apply(state, {
          type: "thread.prompt.edit",
          commandId: CommandId.make("unsigned-edit"),
          threadId,
          messageId: original.message.messageId,
          expectedRevision: 2,
          message: { text: "No personal access", attachments: [] },
          createdAt,
        });
        expect(queue(state).entries[0]?.issueTrackerAuthorizationId).toBeUndefined();
      }),
  );
  it.effect(
    "orders accepted prompts by sequence and stages handoff without transcript bubbles",
    () =>
      Effect.gen(function* () {
        let state = yield* apply(yield* readModelWithThread, enqueue("first"));
        state = yield* apply(state, enqueue("second"));
        expect(queue(state).entries.map((entry) => entry.messageId)).toEqual(["first", "second"]);
        expect(state.threads[0]!.messages).toEqual([]);
        state = yield* apply(state, claim);
        expect(queue(state).handoff?.attemptId).toBe("claim");
        expect(state.threads[0]!.messages).toEqual([]);
        const edit = {
          type: "thread.prompt.edit" as const,
          commandId: CommandId.make("edit"),
          threadId,
          messageId: MessageId.make("first"),
          expectedRevision: 1,
          message: { text: "edited", attachments: [] },
          author: editor,
          createdAt,
        };
        expect((yield* Effect.flip(apply(state, edit)))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
        state = yield* apply(state, {
          type: "thread.prompt.release",
          commandId: CommandId.make("reject"),
          threadId,
          attemptId: claim.commandId,
          detail: "Steer rejected",
          createdAt,
        });
        expect(queue(state).entries[0]?.state).toBe("pending");
        expect(state.threads[0]!.messages).toEqual([]);
      }),
  );
  it.effect("keeps author and editor through admission and waits for matching finalization", () =>
    Effect.gen(function* () {
      let state = yield* apply(yield* readModelWithThread, enqueue("first"));
      state = yield* apply(state, {
        type: "thread.prompt.edit",
        commandId: CommandId.make("edit"),
        threadId,
        messageId: MessageId.make("first"),
        expectedRevision: 1,
        message: { text: "edited", attachments: [] },
        author: editor,
        createdAt,
      });
      state = yield* apply(state, { ...claim, expectedRevision: 2 });
      state = yield* apply(state, {
        type: "thread.prompt.admit",
        commandId: CommandId.make("admit"),
        threadId,
        attemptId: claim.commandId,
        turnId: TurnId.make("turn-1"),
        evidence: "provider-ack",
        createdAt,
      });
      expect(state.threads[0]!.messages[0]).toMatchObject({
        text: "edited",
        author,
        editedBy: editor,
      });
      expect(queue(state).awaitingTurnId).toBe("turn-1");
      state = yield* apply(state, enqueue("second"));
      const next = {
        ...claim,
        commandId: CommandId.make("next"),
        messageId: MessageId.make("second"),
      };
      expect((yield* Effect.flip(apply(state, next)))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
      state = yield* apply(state, {
        type: "thread.queue.finalize",
        commandId: CommandId.make("unrelated"),
        threadId,
        turnId: TurnId.make("old"),
        outcome: "failed",
        checkpoint: "error",
        createdAt,
      });
      expect(queue(state).enabled).toBe(true);
      state = yield* apply(state, {
        type: "thread.queue.finalize",
        commandId: CommandId.make("finalize"),
        threadId,
        turnId: TurnId.make("turn-1"),
        outcome: "completed",
        checkpoint: "skipped",
        createdAt,
      });
      state = yield* apply(state, next);
      expect(queue(state).handoff?.messageId).toBe("second");
    }),
  );
  it.effect.each(["completed", "failed"] as const)(
    "keeps the terminal boundary when a Steer ACK follows %s finalization",
    (outcome) =>
      Effect.gen(function* () {
        const turnId = TurnId.make("original-turn");
        let state = yield* apply(yield* readModelWithThread, {
          type: "thread.session.set",
          commandId: CommandId.make("running-session"),
          threadId,
          session: {
            threadId,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        state = yield* apply(state, enqueue("steer"));
        const attemptId = CommandId.make("steer-attempt");
        state = yield* apply(state, {
          type: "thread.prompt.steer",
          commandId: attemptId,
          threadId,
          messageId: MessageId.make("steer"),
          expectedRevision: 1,
          expectedTurnId: turnId,
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.queue.finalize",
          commandId: CommandId.make("finish-before-ack"),
          threadId,
          turnId,
          outcome,
          checkpoint: "skipped",
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.prompt.admit",
          commandId: CommandId.make("late-ack"),
          threadId,
          attemptId,
          turnId,
          evidence: "provider-ack",
          createdAt,
        });
        expect(queue(state).awaitingTurnId).toBe(null);
        expect(queue(state).finalizedTurnId).toBe(turnId);
        expect(queue(state).admissions).toEqual([]);
        expect(queue(state).handoff).toBe(null);
        expect(queue(state).enabled).toBe(outcome === "completed");
        expect(state.threads[0]!.messages).toHaveLength(1);
      }),
  );
  it.effect.each(["failed", "completed"] as const)(
    "finalization reconciles late %s evidence for an uncertain admitted turn",
    (outcome) =>
      Effect.gen(function* () {
        let state = yield* apply(yield* readModelWithThread, enqueue("first"));
        state = yield* apply(state, claim);
        const turnId = TurnId.make("confirmed-turn");
        state = yield* apply(state, {
          type: "thread.prompt.admit",
          commandId: CommandId.make("admit"),
          threadId,
          attemptId: claim.commandId,
          turnId,
          evidence: "provider-ack",
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.prompt.unknown",
          commandId: CommandId.make("unknown"),
          threadId,
          attemptId: claim.commandId,
          detail: "Transport failed before terminal processing",
          createdAt,
        });
        expect(queue(state).entries[0]?.state).toBe("unknown");
        state = yield* apply(state, {
          type: "thread.queue.finalize",
          commandId: CommandId.make("unrelated"),
          threadId,
          turnId: TurnId.make("unrelated"),
          outcome,
          checkpoint: "ready",
          createdAt,
        });
        expect(queue(state).pauseReason?.code).toBe("delivery-unknown");
        state = yield* apply(state, {
          type: "thread.queue.finalize",
          commandId: CommandId.make("finalize"),
          threadId,
          turnId,
          outcome,
          checkpoint: "ready",
          createdAt,
        });
        expect(queue(state).entries).toEqual([]);
        expect(queue(state).handoff).toBe(null);
        expect(queue(state).awaitingTurnId).toBe(null);
        expect(queue(state).pauseReason?.code).toBe(outcome === "failed" ? "failed" : "stopped");
        expect(queue(state).enabled).toBe(false);
        state = yield* apply(state, {
          type: "thread.queue.resume",
          commandId: CommandId.make("resume"),
          threadId,
          expectedRevision: queue(state).revision,
          createdAt,
        });
        expect(queue(state).enabled).toBe(true);
      }),
  );
  it.effect(
    "Stop fences admission, refuses premature Resume, and retains uncertainty until explicit recovery",
    () =>
      Effect.gen(function* () {
        let state = yield* apply(yield* readModelWithThread, enqueue("first"));
        state = yield* apply(state, claim);
        state = yield* apply(state, {
          type: "thread.queue.pause",
          commandId: CommandId.make("stop"),
          threadId,
          createdAt,
        });
        expect(queue(state).enabled).toBe(false);
        expect(
          (yield* Effect.flip(
            apply(state, {
              type: "thread.queue.resume",
              commandId: CommandId.make("resume-too-early"),
              threadId,
              expectedRevision: 1,
              createdAt,
            }),
          ))._tag,
        ).toBe("OrchestrationCommandInvariantError");
        state = yield* apply(state, {
          type: "thread.prompt.unknown",
          commandId: CommandId.make("unknown"),
          threadId,
          attemptId: claim.commandId,
          detail: "Transport ended",
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.queue.pause",
          commandId: CommandId.make("stop-again"),
          threadId,
          createdAt,
        });
        expect(queue(state).pauseReason?.code).toBe("delivery-unknown");
        state = yield* apply(state, {
          type: "thread.queue.resolve",
          commandId: CommandId.make("resolve"),
          threadId,
          expectedRevision: queue(state).revision,
          resolution: "retry",
          createdAt,
        });
        expect(queue(state).entries[0]?.state).toBe("pending");
        expect(queue(state).enabled).toBe(false);
        state = yield* apply(state, {
          type: "thread.queue.resume",
          commandId: CommandId.make("resume"),
          threadId,
          expectedRevision: queue(state).revision,
          createdAt,
        });
        expect(queue(state).enabled).toBe(true);
      }),
  );
  it.effect(
    "does not release a failed turn until Resume and rejects lifecycle changes with accepted work",
    () =>
      Effect.gen(function* () {
        let state = yield* apply(yield* readModelWithThread, enqueue("first"));
        expect(
          (yield* Effect.flip(
            apply(state, {
              type: "thread.archive",
              commandId: CommandId.make("archive"),
              threadId,
            }),
          ))._tag,
        ).toBe("OrchestrationCommandInvariantError");
        state = yield* apply(state, claim);
        state = yield* apply(state, {
          type: "thread.prompt.admit",
          commandId: CommandId.make("admit"),
          threadId,
          attemptId: claim.commandId,
          turnId: TurnId.make("failed-turn"),
          evidence: "harness-dispatch",
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.queue.finalize",
          commandId: CommandId.make("finalize"),
          threadId,
          turnId: TurnId.make("failed-turn"),
          outcome: "failed",
          checkpoint: "ready",
          createdAt,
        });
        expect(queue(state)).toMatchObject({
          enabled: false,
          pauseReason: { code: "failed" },
          awaitingTurnId: null,
        });
      }),
  );
  it.effect.each(["claimed", "admitted", "finalized"] as const)(
    "ignores a late session update after a successor is %s",
    (stage) =>
      Effect.gen(function* () {
        let state = yield* apply(yield* readModelWithThread, enqueue("first"));
        state = yield* apply(state, claim);
        const firstTurn = TurnId.make("first-turn");
        state = yield* apply(state, {
          type: "thread.prompt.admit",
          commandId: CommandId.make("first-admit"),
          threadId,
          attemptId: claim.commandId,
          turnId: firstTurn,
          evidence: "provider-ack",
          createdAt,
        });
        state = yield* apply(state, {
          type: "thread.queue.finalize",
          commandId: CommandId.make("first-finalize"),
          threadId,
          turnId: firstTurn,
          outcome: "completed",
          checkpoint: "ready",
          createdAt,
        });
        const session = {
          threadId,
          status: "ready" as const,
          activeTurnId: null,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access" as const,
          lastError: null,
          updatedAt: createdAt,
        };
        state = yield* apply(state, {
          type: "thread.session.set",
          commandId: CommandId.make("first-restore"),
          threadId,
          session,
          expectedPromptTurnId: firstTurn,
          createdAt,
        });
        expect(state.threads[0]!.session).toEqual(session);
        state = yield* apply(state, enqueue("second"));
        const secondClaim = {
          ...claim,
          commandId: CommandId.make("second-claim"),
          messageId: MessageId.make("second"),
        };
        state = yield* apply(state, secondClaim);
        const secondTurn = TurnId.make("second-turn");
        if (stage !== "claimed")
          state = yield* apply(state, {
            type: "thread.prompt.admit",
            commandId: CommandId.make("second-admit"),
            threadId,
            attemptId: secondClaim.commandId,
            turnId: secondTurn,
            evidence: "provider-ack",
            createdAt,
          });
        if (stage === "finalized")
          state = yield* apply(state, {
            type: "thread.queue.finalize",
            commandId: CommandId.make("second-finalize"),
            threadId,
            turnId: secondTurn,
            outcome: "completed",
            checkpoint: "ready",
            createdAt,
          });
        const expectedSession = {
          ...session,
          status:
            stage === "claimed"
              ? ("starting" as const)
              : stage === "admitted"
                ? ("running" as const)
                : ("ready" as const),
          activeTurnId: stage === "admitted" ? secondTurn : null,
        };
        state = yield* apply(state, {
          type: "thread.session.set",
          commandId: CommandId.make("successor-session"),
          threadId,
          session: expectedSession,
          createdAt,
        });
        for (const status of ["error", "ready"] as const) {
          const rejection = yield* apply(state, {
            type: "thread.session.set",
            commandId: CommandId.make(`late-${status}`),
            threadId,
            session: { ...session, status, lastError: "first turn" },
            expectedPromptTurnId: firstTurn,
            createdAt,
          }).pipe(Effect.flip);
          expect(rejection).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            detail: "The queued turn no longer owns this session.",
          });
          expect(state.threads[0]!.session).toEqual(expectedSession);
        }
      }),
  );
});

it.layer(NodeServices.layer)("shared preparation decisions", (it) => {
  const bootstrap = Effect.gen(function* () {
    const existing = yield* readModelWithThread;
    return yield* apply(
      { ...existing, threads: [] },
      {
        ...enqueue("first"),
        bootstrap: {
          createThread: {
            projectId,
            title: "Shared",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: { projectCwd: "/tmp/project", baseBranch: "main", branch: "feature" },
          runSetupScript: true,
        },
      },
    );
  });
  it.effect(
    "accepts creation, preparation and the first prompt together, ahead of a teammate",
    () =>
      Effect.gen(function* () {
        let state = yield* bootstrap;
        expect(state.threads).toHaveLength(1);
        expect(queue(state).preparation?.state).toBe("pending");
        expect(queue(state).entries.map((entry) => entry.messageId)).toEqual(["first"]);
        state = yield* apply(state, { ...enqueue("second"), author: editor });
        expect(queue(state).entries.map((entry) => entry.messageId)).toEqual(["first", "second"]);
        expect((yield* Effect.flip(apply(state, claim)))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
      }),
  );
  it.effect(
    "retains preparation when the first prompt is removed and guards lifecycle changes",
    () =>
      Effect.gen(function* () {
        let state = yield* bootstrap;
        state = yield* apply(state, {
          type: "thread.prompt.remove",
          commandId: CommandId.make("remove"),
          threadId,
          messageId: MessageId.make("first"),
          expectedRevision: 1,
          createdAt,
        });
        expect(queue(state).entries).toHaveLength(0);
        expect(queue(state).preparation?.state).toBe("pending");
        for (const command of [
          { type: "thread.archive" as const, commandId: CommandId.make("archive"), threadId },
          {
            type: "thread.meta.update" as const,
            commandId: CommandId.make("change-workspace"),
            threadId,
            worktreePath: "/elsewhere",
          },
        ])
          expect((yield* Effect.flip(apply(state, command)))._tag).toBe(
            "OrchestrationCommandInvariantError",
          );
      }),
  );
  it.effect("Stop fences completion; only a settled explicit retry can restart preparation", () =>
    Effect.gen(function* () {
      let state = yield* bootstrap;
      const initial = queue(state).preparation!;
      const running = { ...initial, revision: 1, state: "running" as const, settled: false };
      state = yield* apply(state, {
        type: "thread.preparation.update",
        commandId: CommandId.make("start"),
        threadId,
        createdAt,
        expectedRevision: 0,
        preparation: running,
      });
      state = yield* apply(state, {
        type: "thread.queue.pause",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt,
      });
      expect(queue(state).preparation?.failure?.reason).toBe("cancelled");
      expect(
        (yield* Effect.flip(
          apply(state, {
            type: "thread.preparation.update",
            commandId: CommandId.make("late"),
            threadId,
            createdAt,
            expectedRevision: 1,
            preparation: { ...running, revision: 2, state: "ready", settled: true },
          }),
        ))._tag,
      ).toBe("OrchestrationCommandInvariantError");
      expect(
        (yield* Effect.flip(
          apply(state, {
            type: "thread.queue.resume",
            commandId: CommandId.make("resume"),
            threadId,
            createdAt,
            expectedRevision: queue(state).revision,
          }),
        ))._tag,
      ).toBe("OrchestrationCommandInvariantError");
      const retry = {
        type: "thread.preparation.retry" as const,
        commandId: CommandId.make("retry"),
        threadId,
        createdAt,
        expectedRevision: queue(state).preparation!.revision,
        expectedControlRevision: queue(state).revision,
      };
      expect((yield* Effect.flip(apply(state, retry)))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
      const cancelled = queue(state).preparation!;
      state = yield* apply(state, {
        type: "thread.preparation.update",
        commandId: CommandId.make("settle"),
        threadId,
        createdAt,
        expectedRevision: cancelled.revision,
        preparation: { ...cancelled, revision: cancelled.revision + 1, settled: true },
      });
      state = yield* apply(state, {
        ...retry,
        expectedRevision: queue(state).preparation!.revision,
      });
      expect(queue(state).enabled).toBe(true);
      expect(queue(state).preparation?.attemptId).toBe("retry");
      expect(queue(state).entries[0]?.messageId).toBe("first");
      expect((yield* Effect.flip(apply(state, retry)))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
    }),
  );
  it.effect(
    "owns the worktree before readiness and keeps empty unfinished setup out of cleanup",
    () =>
      Effect.gen(function* () {
        let state = yield* bootstrap;
        const initial = queue(state).preparation!;
        state = yield* apply(state, {
          type: "thread.preparation.update",
          commandId: CommandId.make("preparing-target"),
          threadId,
          createdAt,
          expectedRevision: initial.revision,
          preparation: {
            ...initial,
            revision: initial.revision + 1,
            state: "running",
            settled: false,
            target: { branch: "feature", worktreePath: "/worktrees/feature" },
          },
        });
        expect(state.threads[0]).toMatchObject({
          branch: "feature",
          worktreePath: "/worktrees/feature",
        });
        expect((yield* Effect.flip(apply(state, claim)))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
        state = yield* apply(state, {
          type: "thread.prompt.remove",
          commandId: CommandId.make("remove-before-setup"),
          threadId,
          messageId: MessageId.make("first"),
          expectedRevision: 1,
          createdAt,
        });
        for (const stop of [false, true]) {
          if (stop)
            state = yield* apply(state, {
              type: "thread.queue.pause",
              commandId: CommandId.make("stop-empty-setup"),
              threadId,
              createdAt,
            });
          expect(queue(state).entries).toHaveLength(0);
          expect(state.threads[0]?.worktreePath).toBe("/worktrees/feature");
          for (const command of [
            { type: "thread.archive", commandId: CommandId.make("archive-empty"), threadId },
            { type: "thread.settle", commandId: CommandId.make("settle-empty"), threadId },
            {
              type: "thread.auto-settle",
              commandId: CommandId.make("auto-settle-empty"),
              threadId,
              snapshotSequence: state.snapshotSequence,
              settledAt: createdAt,
            },
            {
              type: "thread.snooze",
              commandId: CommandId.make("snooze-empty"),
              threadId,
              snoozedUntil: "2026-08-25T10:00:00.000Z",
            },
          ] satisfies ReadonlyArray<OrchestrationCommand>) {
            const rejection = yield* Effect.flip(apply(state, command));
            expect(rejection._tag).toBe("OrchestrationCommandInvariantError");
            if (rejection._tag === "OrchestrationCommandInvariantError")
              expect(rejection.detail).toContain("Finish or remove accepted prompts");
          }
        }
      }),
  );
  it.effect("Work locally replaces the worktree-only script without replacing accepted work", () =>
    Effect.gen(function* () {
      let state = yield* bootstrap;
      state = yield* apply(state, { ...enqueue("second"), author: editor });
      state = yield* apply(state, {
        type: "thread.queue.pause",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt,
      });
      state = yield* apply(state, {
        type: "thread.preparation.retry",
        commandId: CommandId.make("local"),
        threadId,
        createdAt,
        expectedRevision: queue(state).preparation!.revision,
        expectedControlRevision: queue(state).revision,
        target: "project",
      });
      const preparation = queue(state).preparation!;
      expect(preparation.recipe).toEqual({ projectCwd: "/tmp/project", runSetupScript: false });
      expect(preparation.script).toBe(null);
      expect(preparation.target?.worktreePath).toBe(null);
      expect(queue(state).entries.map((entry) => entry.messageId)).toEqual(["first", "second"]);
    }),
  );
  it.effect("readiness and final workspace metadata become visible in the same decision", () =>
    Effect.gen(function* () {
      let state = yield* bootstrap;
      const preparation = queue(state).preparation!;
      state = yield* apply(state, {
        type: "thread.preparation.update",
        commandId: CommandId.make("ready"),
        threadId,
        createdAt,
        expectedRevision: preparation.revision,
        preparation: {
          ...preparation,
          revision: 1,
          state: "ready",
          settled: true,
          target: { branch: "feature", worktreePath: "/worktrees/feature" },
        },
      });
      expect(state.threads[0]?.worktreePath).toBe("/worktrees/feature");
      state = yield* apply(state, claim);
      expect(queue(state).handoff?.attemptId).toBe("claim");
    }),
  );
});
