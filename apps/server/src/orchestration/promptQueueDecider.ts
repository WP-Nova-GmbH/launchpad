import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  ThreadPromptQueueChangedPayload,
  ThreadPromptPauseReason,
} from "@t3tools/contracts";
import { EventId, isImportedAgentSessionMessageId } from "@t3tools/contracts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type QueueCommand = Extract<
  OrchestrationCommand,
  { type: `thread.prompt.${string}` | `thread.queue.${string}` | `thread.preparation.${string}` }
>;
type PlannedEvent = OrchestrationEvent extends infer T
  ? T extends OrchestrationEvent
    ? Omit<T, "sequence">
    : never
  : never;

/** Queue decisions run inside the engine's ordered transaction, never in a client scheduler. */
export const decidePromptQueueCommand = Effect.fn("decidePromptQueueCommand")(function* (
  thread: OrchestrationThread,
  command: QueueCommand,
  blocked: boolean,
): Effect.fn.Return<ReadonlyArray<PlannedEvent>, OrchestrationCommandInvariantError> {
  const queue = thread.promptQueue ?? emptyThreadPromptQueue();
  let eventIndex = 0;
  const base = () => ({
    eventId: EventId.make(`${command.commandId}:${command.type}:queue:${eventIndex++}`),
    aggregateKind: "thread" as const,
    aggregateId: thread.id,
    occurredAt: command.createdAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  });
  const change = (
    payload: Omit<ThreadPromptQueueChangedPayload, "threadId" | "updatedAt">,
  ): PlannedEvent => ({
    ...base(),
    type: "thread.prompt-queue-changed",
    payload: { ...payload, threadId: thread.id, updatedAt: command.createdAt },
  });
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const pause = (reason: ThreadPromptPauseReason) => ({
    enabled: false,
    revision: queue.revision + 1,
    pauseReason: reason,
  });
  const entry =
    "messageId" in command
      ? queue.entries.find((item) => item.messageId === command.messageId)
      : undefined;
  const validEntry = () =>
    entry !== undefined &&
    entry.state === "pending" &&
    "expectedRevision" in command &&
    entry.revision === command.expectedRevision;
  const busy = thread.session?.status === "running" || thread.session?.status === "starting";
  const preparation = queue.preparation;
  switch (command.type) {
    case "thread.preparation.update": {
      if ((preparation?.revision ?? null) !== command.expectedRevision)
        return yield* fail("Preparation changed before this attempt completed.");
      const next = command.preparation;
      if (
        preparation &&
        (next.attemptId !== preparation.attemptId ||
          next.revision !== preparation.revision + 1 ||
          (preparation.state === "failed" && next.state !== "failed"))
      )
        return yield* fail("Preparation attempt is no longer current.");
      const events: PlannedEvent[] = [];
      if ((next.state === "running" || next.state === "ready") && next.target)
        events.push({
          ...base(),
          type: "thread.meta-updated",
          payload: {
            threadId: thread.id,
            branch: next.target.branch,
            worktreePath: next.target.worktreePath,
            updatedAt: command.createdAt,
          },
        });
      events.push(
        change({
          preparation: next,
          ...(next.state === "failed" && queue.enabled
            ? {
                control: pause({
                  code: "failed",
                  detail: next.failure?.detail ?? "Preparation failed.",
                }),
              }
            : {}),
        }),
      );
      return events;
    }
    case "thread.preparation.retry": {
      if (
        !preparation ||
        preparation.revision !== command.expectedRevision ||
        queue.revision !== command.expectedControlRevision ||
        !preparation.settled ||
        preparation.state !== "failed" ||
        queue.handoff ||
        queue.awaitingTurnId ||
        busy ||
        queue.pauseReason?.code === "delivery-unknown" ||
        thread.latestTurn ||
        thread.messages.length > 0
      )
        return yield* fail(
          "Preparation recovery conflict. Stop and wait for setup to settle first.",
        );
      if (!preparation.recipe && command.target !== "project")
        return yield* fail("The original setup recipe is unavailable. Review the workspace first.");
      const { failure: _failure, ...previous } = preparation;
      return [
        change({
          preparation: {
            ...previous,
            attemptId: command.commandId,
            revision: preparation.revision + 1,
            state: "pending",
            settled: true,
            ...(command.target === "project"
              ? {
                  recipe: preparation.recipe
                    ? { projectCwd: preparation.recipe.projectCwd, runSetupScript: false }
                    : null,
                  target: { branch: null, worktreePath: null },
                  script: null,
                }
              : {}),
          },
          control: { enabled: true, revision: queue.revision + 1, pauseReason: null },
        }),
      ];
    }

    case "thread.prompt.enqueue": {
      if (isImportedAgentSessionMessageId(command.message.messageId))
        return yield* fail("This message id is reserved for imported history.");
      if (thread.archivedAt !== null)
        return yield* fail("Unarchive this thread before adding a prompt.");
      if (!command.message.text.trim() && command.message.attachments.length === 0)
        return yield* fail("A prompt needs text or an attachment.");
      if (
        queue.entries.some((item) => item.messageId === command.message.messageId) ||
        thread.messages.some((item) => item.id === command.message.messageId)
      )
        return yield* fail("This prompt was already accepted. Check its command receipt.");
      const resets: PlannedEvent[] = [];
      if (thread.settledOverride !== null)
        resets.push({
          ...base(),
          type: "thread.unsettled",
          payload: { threadId: thread.id, reason: "activity", updatedAt: command.createdAt },
        });
      if (thread.snoozedUntil !== null)
        resets.push({
          ...base(),
          type: "thread.unsnoozed",
          payload: { threadId: thread.id, reason: "activity", updatedAt: command.createdAt },
        });
      return [
        ...resets,
        change({
          ...(!thread.promptQueue
            ? {
                control:
                  thread.session?.status === "error"
                    ? pause({
                        code: "failed",
                        detail:
                          thread.session.lastError ?? "The last turn failed. Resume to continue.",
                      })
                    : !busy && thread.latestTurn
                      ? pause({
                          code: "stopped",
                          detail:
                            "This conversation predates the shared queue. Review its previous turn, then Resume to begin queued work.",
                        })
                      : { enabled: true, revision: 0, pauseReason: null },
                awaitingTurnId: busy ? (thread.session?.activeTurnId ?? null) : null,
              }
            : {}),
          entry: {
            ...command.message,
            modelSelection: command.modelSelection ?? thread.modelSelection,
            ...(command.titleSeed ? { titleSeed: command.titleSeed } : {}),
            ...(command.sourceProposedPlan
              ? { sourceProposedPlan: command.sourceProposedPlan }
              : {}),
            ...(command.author ? { author: command.author } : {}),
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            revision: 1,
            acceptedSequence: 0,
            createdAt: command.createdAt,
            state: "pending",
          },
        }),
      ];
    }
    case "thread.prompt.edit":
      if (!validEntry() || !entry)
        return yield* fail(
          "Prompt conflict: this entry changed or began delivery. Review it before saving.",
        );
      if (!command.message.text.trim() && command.message.attachments.length === 0)
        return yield* fail("A prompt needs text or an attachment.");
      return [
        change({
          entry: {
            ...entry,
            ...command.message,
            // Editing replaces authorization, including an edit by a signed-out
            // participant. Never retain the previous revision's grant.
            issueTrackerAuthorizationId: command.message.issueTrackerAuthorizationId,
            revision: entry.revision + 1,
            ...(command.author ? { editedBy: command.author } : {}),
          },
        }),
      ];
    case "thread.prompt.remove":
      if (!validEntry())
        return yield* fail("Prompt conflict: this entry changed or began delivery.");
      return [change({ removedMessageId: command.messageId })];
    case "thread.prompt.claim":
    case "thread.prompt.steer": {
      if (preparation && preparation.state !== "ready")
        return yield* fail("Required preparation has not succeeded.");
      if (!validEntry() || !entry || queue.handoff)
        return yield* fail("Prompt conflict: another delivery or edit already won.");
      const steering = command.type === "thread.prompt.steer";
      if (steering) {
        if (
          thread.session?.status !== "running" ||
          thread.session.activeTurnId !== command.expectedTurnId ||
          blocked
        )
          return yield* fail("Steer conflict: the target turn is no longer accepting input.");
        if (
          entry.runtimeMode !== thread.runtimeMode ||
          entry.interactionMode !== thread.interactionMode ||
          (entry.modelSelection &&
            entry.modelSelection.instanceId !==
              (thread.session.providerInstanceId ?? thread.modelSelection.instanceId))
        )
          return yield* fail(
            "Steer cannot replace the running provider session. Leave this prompt queued for a new turn.",
          );
      } else if (
        !queue.enabled ||
        queue.revision !== command.expectedControlRevision ||
        queue.entries[0]?.messageId !== entry.messageId ||
        busy ||
        blocked ||
        queue.awaitingTurnId !== null
      ) {
        return yield* fail("Queue delivery is no longer eligible.");
      }
      return [
        change({
          entry: { ...entry, state: "delivering" },
          handoff: {
            attemptId: command.commandId,
            messageId: entry.messageId,
            revision: entry.revision,
            controlRevision: queue.revision,
            mode: steering ? "steer" : "next-turn",
            ...(steering
              ? {
                  expectedTurnId: command.expectedTurnId,
                  ...(command.author ? { steeredBy: command.author } : {}),
                }
              : {}),
          },
        }),
      ];
    }
    case "thread.prompt.admit": {
      const handoff = queue.handoff;
      if (!handoff || handoff.attemptId !== command.attemptId)
        return yield* fail("The provider admission no longer matches a pending delivery.");
      const prompt = queue.entries.find((item) => item.messageId === handoff.messageId);
      if (!prompt) return yield* fail("The pending delivery was removed.");
      // A selected turn can finish before its steer RPC acknowledges admission.
      // Its terminal checkpoint already owns the boundary; do not await it twice.
      const alreadyFinalized = handoff.mode === "steer" && queue.finalizedTurnId === command.turnId;
      const admittedEvents: PlannedEvent[] = [
        {
          ...base(),
          type: "thread.message-sent",
          payload: {
            threadId: thread.id,
            messageId: prompt.messageId,
            role: "user",
            text: prompt.text,
            attachments: prompt.attachments,
            ...(prompt.context ? { context: prompt.context } : {}),
            ...(prompt.author ? { author: prompt.author } : {}),
            ...(prompt.editedBy ? { editedBy: prompt.editedBy } : {}),
            ...(handoff.steeredBy ? { steeredBy: handoff.steeredBy } : {}),
            turnId: command.evidence === "local-command" ? null : command.turnId,
            streaming: false,
            createdAt: prompt.createdAt,
            updatedAt: command.createdAt,
          },
        },
      ];
      if (handoff.mode === "next-turn" && command.evidence !== "local-command")
        admittedEvents.push({
          ...base(),
          metadata: { queueAdmission: true },
          type: "thread.turn-start-requested",
          payload: {
            threadId: thread.id,
            messageId: prompt.messageId,
            ...(prompt.modelSelection ? { modelSelection: prompt.modelSelection } : {}),
            runtimeMode: prompt.runtimeMode,
            interactionMode: prompt.interactionMode,
            ...(prompt.titleSeed ? { titleSeed: prompt.titleSeed } : {}),
            ...(prompt.sourceProposedPlan ? { sourceProposedPlan: prompt.sourceProposedPlan } : {}),
            createdAt: prompt.createdAt,
          },
        });
      admittedEvents.push(
        change({
          removedMessageId: prompt.messageId,
          handoff: null,
          awaitingTurnId: alreadyFinalized ? null : command.turnId,
          ...(!alreadyFinalized
            ? {
                admission: {
                  attemptId: command.attemptId,
                  messageId: prompt.messageId,
                  turnId: command.turnId,
                  evidence: command.evidence,
                  prompt,
                  handoff,
                },
              }
            : {}),
        }),
      );
      return admittedEvents;
    }
    case "thread.prompt.release": {
      if (queue.handoff?.attemptId !== command.attemptId) return [];
      const prompt = queue.entries.find((item) => item.messageId === queue.handoff?.messageId);
      return [
        change({
          handoff: null,
          ...(command.pause ? { control: pause({ code: "failed", detail: command.detail }) } : {}),
          ...(prompt ? { entry: { ...prompt, state: "pending" } } : {}),
        }),
      ];
    }
    case "thread.prompt.unknown": {
      const handoff = queue.handoff?.attemptId === command.attemptId ? queue.handoff : null;
      const admission = queue.admissions.find((item) => item.attemptId === command.attemptId);
      if (!handoff && !admission) return [];
      const prompt = handoff
        ? queue.entries.find((item) => item.messageId === handoff.messageId)
        : admission?.prompt;
      return [
        change({
          control: pause({ code: "delivery-unknown", detail: command.detail }),
          ...(prompt ? { entry: { ...prompt, state: "unknown" } } : {}),
          ...(!handoff && admission?.handoff ? { handoff: admission.handoff } : {}),
        }),
      ];
    }
    case "thread.queue.pause":
      return [
        change({
          ...(preparation && (preparation.state === "pending" || preparation.state === "running")
            ? {
                preparation: {
                  ...preparation,
                  revision: preparation.revision + 1,
                  state: "failed",
                  failure: {
                    reason: "cancelled",
                    detail: "Setup was stopped. Retry setup and resume when ready.",
                  },
                },
              }
            : {}),
          control: pause(
            queue.pauseReason?.code === "delivery-unknown"
              ? queue.pauseReason
              : { code: "stopped", detail: "Stopped by a teammate. Resume the queue to continue." },
          ),
        }),
        {
          ...base(),
          type: "thread.turn-interrupt-requested",
          payload: {
            threadId: thread.id,
            ...(thread.session?.activeTurnId ? { turnId: thread.session.activeTurnId } : {}),
            createdAt: command.createdAt,
          },
        },
      ];
    case "thread.queue.resume":
      if (preparation && preparation.state !== "ready")
        return yield* fail("Required preparation is incomplete. Use Retry setup and resume.");
      if (queue.revision !== command.expectedRevision)
        return yield* fail("Queue conflict: its pause state changed. Review it before resuming.");
      if (
        queue.handoff ||
        busy ||
        queue.awaitingTurnId !== null ||
        queue.pauseReason?.code === "delivery-unknown"
      )
        return yield* fail(
          "Delivery or interruption is still unresolved. Resolve it before resuming.",
        );
      return [
        change({
          control: { enabled: true, revision: queue.revision + 1, pauseReason: null },
          awaitingTurnId: null,
          ...(queue.awaitingTurnId ? { finalizedTurnId: queue.awaitingTurnId } : {}),
        }),
      ];
    case "thread.queue.resolve": {
      if (
        queue.revision !== command.expectedRevision ||
        queue.pauseReason?.code !== "delivery-unknown" ||
        busy
      )
        return yield* fail(
          "Queue recovery conflict: stop the provider and review the current state first.",
        );
      const uncertain = queue.entries.filter(
        (item) => item.state === "unknown" || item.messageId === queue.handoff?.messageId,
      );
      const resolved: PlannedEvent[] = uncertain.map((prompt) =>
        change(
          command.resolution === "retry"
            ? { entry: { ...prompt, state: "pending" } }
            : { removedMessageId: prompt.messageId },
        ),
      );
      resolved.push(
        change({
          handoff: null,
          awaitingTurnId: null,
          ...(queue.awaitingTurnId ? { finalizedTurnId: queue.awaitingTurnId } : {}),
          control: pause({
            code: "stopped",
            detail: "Delivery uncertainty acknowledged. Resume to continue.",
          }),
        }),
      );
      return resolved;
    }
    case "thread.queue.finalize": {
      if (
        !thread.promptQueue ||
        queue.finalizedTurnId === command.turnId ||
        queue.awaitingTurnId !== command.turnId
      )
        return [];
      const failure = command.outcome !== "completed" || command.checkpoint === "error";
      const confirmed = queue.admissions.filter((admission) => admission.turnId === command.turnId);
      const confirmedIds = new Set(confirmed.map((admission) => admission.messageId));
      const uncertain = queue.entries.filter(
        (entry) => entry.state === "unknown" && confirmedIds.has(entry.messageId),
      );
      const confirmedHandoff =
        queue.handoff !== null &&
        confirmed.some((admission) => admission.attemptId === queue.handoff?.attemptId);
      const resolvedUnknown =
        queue.pauseReason?.code === "delivery-unknown" &&
        (uncertain.length > 0 || confirmedHandoff) &&
        !queue.entries.some(
          (entry) => entry.state === "unknown" && !confirmedIds.has(entry.messageId),
        );
      return [
        ...uncertain.map((entry) => change({ removedMessageId: entry.messageId })),
        change({
          ...(confirmedHandoff ? { handoff: null } : {}),
          ...(resolvedUnknown && !failure
            ? {
                control: pause({
                  code: "stopped",
                  detail: "Turn delivery confirmed. Resume the queue to continue.",
                }),
              }
            : {}),
          awaitingTurnId: null,
          finalizedTurnId: command.turnId,
          ...(failure && (queue.enabled || resolvedUnknown)
            ? {
                control: pause({
                  code:
                    command.checkpoint === "error"
                      ? "checkpoint-error"
                      : /usage.?limit|rate.?limit|quota|capacity/i.test(command.detail ?? "")
                        ? "usage-limit"
                        : "failed",
                  detail:
                    command.detail ??
                    (command.outcome === "interrupted"
                      ? "The turn was interrupted. Resume to continue."
                      : "The turn failed. Resume after addressing the problem."),
                }),
              }
            : {}),
        }),
      ];
    }
  }
});
