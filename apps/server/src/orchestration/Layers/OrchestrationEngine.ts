import { make as makeCheckoutAccess, resolveCheckoutPath } from "../../workspace/CheckoutAccess.ts";
import { makeCheckoutCapture } from "../../persistence/CheckoutCapture.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { applyThreadPromptQueueChange } from "@t3tools/shared/threadPromptQueue";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { VmWorkloadTracking } from "../../vmWorkloadCommand.ts";
import { changesQueueProviders, validateThreadQueueProviders } from "../ThreadQueueProviders.ts";
import { SetupProcessJournal } from "../../terminal/SetupProcessJournal.ts";
import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import {
  makeThreadExecutionFence,
  ThreadExecutionFenceError,
} from "../../persistence/ThreadExecutionFence.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
  type OrchestrationDispatchOptions,
} from "../Services/OrchestrationEngine.ts";
import {
  makeThreadHistoryBaseline,
  isThreadHistoryBaselineError,
  ThreadHistoryBaselineImporter,
  ThreadHistoryBaselineError,
  type ThreadHistoryBaselineInput,
} from "../../relay/ThreadHistoryBaseline.ts";

interface BaselineEnvelope {
  baseline: ThreadHistoryBaselineInput;
  result: Deferred.Deferred<{ sequence: number }, ThreadHistoryBaselineError>;
}
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

const encodeDeliveryCommand = Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommand));

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  options: OrchestrationDispatchOptions | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

function commandProjectScope(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  if ("projectId" in command) return command.projectId;
  const thread = readModel.threads.find((thread) => thread.id === command.threadId);
  if (thread?.deletedAt === null) return thread.projectId;
  if (command.type === "thread.prompt.enqueue" && command.bootstrap?.createThread)
    return command.bootstrap.createThread.projectId;
  return thread?.projectId ?? null;
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const executionFence = makeThreadExecutionFence(sql);
  const captures = makeCheckoutCapture(sql);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutAccess = yield* makeCheckoutAccess;
  const vmMode = yield* VmWorkloadTracking;
  // The event engine also serves offline tools without provider runtimes. Those
  // tools may edit ordinary queues, but cannot approve a VM provider selection.
  const providers = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const setupJournal = yield* SetupProcessJournal;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope | BaselineEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const checkDeliveryIdentity = (generation: boolean) =>
      Effect.gen(function* () {
        const [delivery] = yield* sql<{
          threadId: string;
          generation: number;
          normalized: string | null;
        }>`
        SELECT thread_id AS "threadId", generation, normalized_json AS normalized
        FROM thread_relay_command_deliveries WHERE command_id = ${envelope.command.commandId}`;
        if (!delivery) return;
        const invalid = () =>
          new ThreadExecutionFenceError({
            threadId: delivery.threadId,
            detail: "This command ID belongs to a different relay delivery.",
          });
        const encoded = yield* encodeDeliveryCommand(envelope.command).pipe(
          Effect.mapError(invalid),
        );
        if (
          aggregateRef.aggregateKind !== "thread" ||
          aggregateRef.aggregateId !== delivery.threadId ||
          delivery.normalized !== encoded
        )
          return yield* invalid();
        if (generation) {
          const owner = yield* executionFence.get(delivery.threadId);
          if (!owner || owner.generation !== delivery.generation) return yield* invalid();
        }
      }).pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("OrchestrationEngine.deliveryIdentity")(cause)),
        ),
      );
    const checkExecutionFence = Effect.gen(function* () {
      const workspaceRoot =
        envelope.command.type === "project.create"
          ? yield* checkoutAccess
              .projectRegistrationPath(envelope.command.workspaceRoot)
              .pipe(
                Effect.mapError(
                  (cause) => new ThreadExecutionFenceError({ threadId: "", detail: cause.message }),
                ),
              )
          : undefined;
      yield* (
        aggregateRef.aggregateKind === "thread"
          ? executionFence
              .assertMutable(aggregateRef.aggregateId, envelope.options?.expectedThreadOwnership)
              .pipe(
                Effect.andThen(
                  envelope.options?.directClientCommand
                    ? executionFence.assertDirectClientAllowed(
                        aggregateRef.aggregateId,
                        envelope.command.type,
                      )
                    : Effect.void,
                ),
              )
          : executionFence.assertProjectMutable(aggregateRef.aggregateId, workspaceRoot)
      ).pipe(
        Effect.andThen(
          envelope.command.type === "project.delete" && envelope.command.force
            ? Effect.forEach(
                commandReadModel.threads.filter(
                  (thread) =>
                    thread.deletedAt === null && thread.projectId === aggregateRef.aggregateId,
                ),
                (thread) =>
                  executionFence.assertMutable(thread.id).pipe(
                    Effect.andThen(
                      envelope.options?.directClientCommand
                        ? executionFence.assertDirectClientAllowed(thread.id).pipe(
                            Effect.mapError((error) =>
                              error._tag === "ThreadExecutionFenceError"
                                ? new ThreadExecutionFenceError({
                                    threadId: thread.id,
                                    detail:
                                      "Delete this project's managed threads through Launchpad Connect before deleting the project.",
                                  })
                                : error,
                            ),
                          )
                        : Effect.void,
                    ),
                  ),
                { discard: true },
              )
            : Effect.void,
        ),
        Effect.andThen(
          envelope.command.type === "thread.create"
            ? executionFence.assertCheckoutAvailable({ projectId: envelope.command.projectId })
            : Effect.void,
        ),
        Effect.andThen(
          envelope.command.type === "project.create" ||
            (envelope.command.type === "project.meta.update" &&
              envelope.command.workspaceRoot !== undefined)
            ? executionFence.assertProjectPathMutable(workspaceRoot)
            : Effect.void,
        ),
        Effect.andThen(checkDeliveryIdentity(true)),
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("OrchestrationEngine.executionFence")(cause)),
        ),
      );
    });
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        yield* checkDeliveryIdentity(false);
        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if (envelope.options?.rejection) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: envelope.options.rejection.detail,
          });
        }
        yield* checkExecutionFence;
        if (
          envelope.command.type === "thread.create" ||
          (envelope.command.type === "thread.prompt.enqueue" &&
            envelope.command.bootstrap?.createThread)
        ) {
          const fences = yield* sql`SELECT 1 FROM thread_cleanup_fences
            WHERE thread_id = ${envelope.command.threadId} LIMIT 1`.pipe(
            Effect.mapError(toPersistenceSqlError("OrchestrationEngine.threadCleanupFence")),
          );
          if (fences.length > 0)
            return yield* new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail:
                "Previous task processes have not been confirmed stopped. Retry after they exit.",
            });
        }
        const deletion = envelope.options?.deletionPreconditions;
        if (deletion) {
          const changed = () =>
            new OrchestrationCommandInvariantError({
              commandType: envelope.command.type,
              detail:
                "The task or its setup changed during cleanup. Review it and retry the action.",
            });
          if (
            yield* eventStore.hasEventAfter({
              aggregateKind: "project",
              aggregateId: deletion.projectId,
              type: "project.created",
              sequenceExclusive: deletion.snapshotSequence,
            })
          )
            return yield* changed();
          for (const captured of deletion.threads) {
            const thread = commandReadModel.threads.find((t) => t.id === captured.threadId);
            if (
              !thread ||
              thread.deletedAt !== null ||
              thread.projectId !== deletion.projectId ||
              (captured.worktreePath !== undefined &&
                thread.worktreePath !== captured.worktreePath) ||
              (thread.promptQueue?.preparation?.attemptId ?? null) !==
                captured.preparationAttemptId ||
              (yield* eventStore.hasEventAfter({
                aggregateKind: "thread",
                aggregateId: captured.threadId,
                type: "thread.created",
                sequenceExclusive: deletion.snapshotSequence,
              }))
            )
              return yield* changed();
            if (envelope.options?.requireSetupCleanup) {
              const owners = yield* setupJournal
                .owners(captured.threadId)
                .pipe(Effect.mapError(() => changed()));
              const attempts = new Set([
                ...(captured.cleanupAttemptIds ?? []),
                ...owners.map((owner) => owner.attemptId),
              ]);
              for (const attemptId of attempts)
                if (
                  !(yield* setupJournal
                    .confirmed({ threadId: captured.threadId, attemptId })
                    .pipe(Effect.mapError(() => changed())))
                )
                  return yield* changed();
            }
          }
          if (
            envelope.command.type === "project.delete" &&
            commandReadModel.threads.some(
              (thread) =>
                thread.deletedAt === null &&
                thread.projectId === deletion.projectId &&
                !deletion.threads.some((captured) => captured.threadId === thread.id),
            )
          )
            return yield* changed();
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} changed before automatic settlement`,
          });
        }

        // The decider compares the lookup inputs. Only recreation needs an
        // event check, since it can reset a thread to the same field values.
        if (
          envelope.command.type === "thread.pull-request.sync" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
            type: "thread.created",
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} was recreated before pull request discovery`,
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          threadBackgroundLiveness.getThreadBackgroundLiveness(envelope.command.threadId) !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} has live background work`,
          });
        }

        // New and moved projects do not carry a resolved identity in the event-derived
        // command model. Legacy PR edits need it to identify the link they replace.
        if (
          envelope.command.type === "thread.meta.update" &&
          envelope.command.linkedPullRequest !== undefined
        ) {
          const threadId = envelope.command.threadId;
          const thread = commandReadModel.threads.find((thread) => thread.id === threadId);
          if (thread !== undefined) {
            const project = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId);
            if (Option.isSome(project)) {
              commandReadModel = {
                ...commandReadModel,
                projects: commandReadModel.projects.map((entry) =>
                  entry.id === thread.projectId
                    ? { ...entry, repositoryIdentity: project.value.repositoryIdentity }
                    : entry,
                ),
              };
            }
          }
        }

        // Shared admission depends on durable request state, including after restart.
        if (
          envelope.command.type === "thread.move.claim" ||
          envelope.command.type === "thread.prompt.claim" ||
          envelope.command.type === "thread.prompt.steer"
        ) {
          const detailed = yield* projectionSnapshotQuery.getThreadDetailById(
            envelope.command.threadId,
          );
          if (Option.isSome(detailed))
            commandReadModel = {
              ...commandReadModel,
              threads: commandReadModel.threads.map((thread) =>
                thread.id === detailed.value.id ? detailed.value : thread,
              ),
            };
        }

        // Command snapshots omit activities at startup and cap them while running.
        // Read this request's durable state before deciding how to send the answer.
        const userInputActivity =
          envelope.command.type === "thread.user-input.respond" ||
          envelope.command.type === "thread.user-input.dismiss"
            ? yield* projectionSnapshotQuery.getUserInputActivity(envelope.command)
            : Option.none();
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
          ...(envelope.command.type === "thread.archive" &&
          deletion &&
          envelope.options?.requireSetupCleanup
            ? { allowFailedPreparationArchive: true }
            : {}),
          ...(Option.isSome(userInputActivity)
            ? { userInputActivity: userInputActivity.value }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        if ("threadId" in envelope.command && changesQueueProviders(envelope.command)) {
          const thread = commandReadModel.threads.find(
            (entry) => entry.id === aggregateRef.aggregateId,
          );
          if (thread) {
            let proposedQueue = thread.promptQueue;
            let proposedModelSelection = thread.modelSelection;
            for (const event of plannedEvents) {
              if (event.type === "thread.prompt-queue-changed")
                proposedQueue = applyThreadPromptQueueChange(proposedQueue, event.payload, 0);
              else if (event.type === "thread.meta-updated" && event.payload.modelSelection)
                proposedModelSelection = event.payload.modelSelection;
            }
            const cancelling =
              envelope.command.type === "thread.move.cancel" &&
              proposedQueue?.entries.some(
                (entry) =>
                  entry.kind === "move" &&
                  entry.messageId ===
                    ("messageId" in envelope.command ? envelope.command.messageId : undefined) &&
                  entry.state === "cancelling",
              );
            if (!cancelling)
              yield* validateThreadQueueProviders(
                { modelSelection: proposedModelSelection, promptQueue: proposedQueue },
                vmMode,
                envelope.command.type,
                (id) =>
                  Option.isSome(providers)
                    ? providers.value
                        .getInstance(id)
                        .pipe(
                          Effect.map(
                            (instance) =>
                              instance?.enabled === true && instance.driverKind === "codex",
                          ),
                        )
                    : Effect.succeed(false),
              );
          }
        }
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        const startsWork =
          envelope.command.type === "thread.turn.start" ||
          envelope.command.type === "thread.prompt.claim" ||
          envelope.command.type === "thread.prompt.steer";
        const startingThread = startsWork
          ? commandReadModel.threads.find((thread) => thread.id === aggregateRef.aggregateId)
          : undefined;
        const startingProject = startingThread
          ? commandReadModel.projects.find((project) => project.id === startingThread.projectId)
          : undefined;
        const checkoutRoot =
          startingThread && startingProject
            ? yield* resolveCheckoutPath(
                startingThread.worktreePath ?? startingProject.workspaceRoot,
                fs,
                path,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ThreadExecutionFenceError({
                      threadId: startingThread.id,
                      detail: `The checkout could not be prepared: ${cause.message}`,
                    }),
                ),
              )
            : undefined;
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Recheck in the write transaction so a concurrent freeze cannot
              // acknowledge a watermark and then receive another mutation.
              yield* checkExecutionFence;
              // Reserve accepted starts before publishing their events. A capture
              // can then drain an accepted-but-not-yet-spawned turn safely.
              if (checkoutRoot && startingThread) {
                const [current] = yield* sql<{
                  projectId: string;
                  workspaceRoot: string;
                  worktreePath: string | null;
                }>`SELECT t.project_id AS "projectId", p.workspace_root AS "workspaceRoot",
                  t.worktree_path AS "worktreePath"
                  FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
                  WHERE t.thread_id=${startingThread.id} AND t.deleted_at IS NULL`;
                if (
                  !current ||
                  current.projectId !== startingThread.projectId ||
                  current.workspaceRoot !== startingProject?.workspaceRoot ||
                  current.worktreePath !== startingThread.worktreePath
                )
                  return yield* new ThreadExecutionFenceError({
                    threadId: startingThread.id,
                    detail: "The thread checkout changed while preparing this request. Retry it.",
                  });
                yield* captures
                  .admit({
                    threadId: startingThread.id,
                    kind: "provider",
                    workId: `request:${envelope.command.commandId}`,
                    checkoutRoot,
                    ...(envelope.options?.parentCheckoutAdmissionId
                      ? { parentAdmissionId: envelope.options.parentCheckoutAdmissionId }
                      : {}),
                  })
                  .pipe(
                    Effect.catchTag("CheckoutCaptureError", (error) =>
                      Effect.fail(
                        new ThreadExecutionFenceError({
                          threadId: startingThread.id,
                          detail: error.message,
                        }),
                      ),
                    ),
                  );
              }
              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Effect.Effect<void>[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
                attachmentCleanups.push(cleanup);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                projectId: commandProjectScope(envelope.command, nextCommandReadModel),
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          let error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandRejection(error)) {
              const saved = yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  projectId:
                    envelope.options?.rejection?.projectId ??
                    envelope.options?.deletionPreconditions?.projectId ??
                    commandProjectScope(envelope.command, commandReadModel),
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(
                  Effect.andThen((receipt) => Effect.as(checkExecutionFence, receipt)),
                  sql.withTransaction,
                  Effect.catchTag("SqlError", (cause) =>
                    Effect.fail(toPersistenceSqlError("OrchestrationEngine.rejectionFence")(cause)),
                  ),
                  Effect.result,
                );
              // A failed receipt write is unresolved, not a durable rejection.
              if (saved._tag === "Failure") error = saved.failure;
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const baseline = makeThreadHistoryBaseline(
    sql,
    eventStore,
    commandReceiptRepository,
    projectionPipeline,
  );
  const processBaseline = (envelope: BaselineEnvelope) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const result = yield* baseline.install(envelope.baseline);
          // A failed refresh rolls back the import too, so the in-memory writer cannot lag a committed baseline.
          const model = yield* projectionSnapshotQuery.getCommandReadModel();
          return { result, model };
        }),
      )
      .pipe(
        Effect.flatMap(({ result, model }) =>
          Effect.gen(function* () {
            commandReadModel = model;
            if (result.event) yield* PubSub.publish(eventPubSub, result.event);
            return { sequence: result.sequence };
          }),
        ),
        Effect.mapError((error) =>
          isThreadHistoryBaselineError(error)
            ? error
            : new ThreadHistoryBaselineError({
                message: "Imported history requires read-model recovery before activation.",
              }),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(envelope.result, exit)),
      );
  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        "baseline" in envelope ? processBaseline(envelope) : processEnvelope(envelope),
      ),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: "thread", aggregateId: threadId });

  const getThreadReplayStats: OrchestrationEngineShape["getThreadReplayStats"] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: "thread",
      aggregateId: threadId,
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        options,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  const engine = {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(Effect.map(Stream.fromSubscription)),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
  const importer = ThreadHistoryBaselineImporter.of({
    install: (baseline) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<{ sequence: number }, ThreadHistoryBaselineError>();
        yield* Queue.offer(commandQueue, { baseline, result });
        return yield* Deferred.await(result);
      }),
  });
  return Context.make(OrchestrationEngineService, engine).pipe(
    Context.add(ThreadHistoryBaselineImporter, importer),
  );
});

export const OrchestrationEngineLive = Layer.effectContext(makeOrchestrationEngine);
