import { ThreadTransferNativeRuntime as NativeRuntime } from "../persistence/ThreadTransferRuntime.ts";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  IsoDateTime,
  OrchestrationEvent,
  ProjectId,
  ThreadId,
  ThreadPromptQueue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationProjectionPipelineShape } from "../orchestration/Services/ProjectionPipeline.ts";
import {
  OrchestrationCommandReceipt,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationEventStoreShape } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeThreadTransferAborts } from "./ThreadTransferAbort.ts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import { ThreadHistoryArchiveManifest } from "./ThreadHistoryArchive.ts";

const encodeNativeCursor = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      resumePolicy: Schema.Literal("require-existing"),
      portableStateId: Schema.String,
    }),
  ),
);
const decodeQueue = Schema.decodeEffect(Schema.fromJsonString(ThreadPromptQueue));
const encodeNative = Schema.encodeEffect(Schema.fromJsonString(Schema.NullOr(NativeRuntime)));
export const ThreadHistoryBaselineInput = Schema.Struct({
  version: Schema.Literal(1),
  manifestSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  source: ThreadHistoryArchiveManifest,
  destination: Schema.Struct({
    threadId: ThreadId,
    environmentId: Schema.NonEmptyString,
    projectId: ProjectId,
    relayUrl: Schema.NonEmptyString,
    generation: Schema.Int.check(Schema.isGreaterThan(0)),
    operationId: Schema.NonEmptyString,
    branch: Schema.NullOr(Schema.NonEmptyString),
    worktreePath: Schema.NullOr(Schema.NonEmptyString),
  }),
  events: Schema.Array(OrchestrationEvent),
  receipts: Schema.Array(OrchestrationCommandReceipt),
  importedAt: IsoDateTime,
  resetVm: Schema.optionalKey(Schema.Boolean),
  backupRecovery: Schema.optionalKey(Schema.Boolean),
  // Only the verified artifact installer supplies this. null explicitly means a
  // never-started conversation; omission supports history-only internal imports.
  nativeRuntime: Schema.optionalKey(Schema.NullOr(NativeRuntime)),
});
export type ThreadHistoryBaselineInput = typeof ThreadHistoryBaselineInput.Type;
export class ThreadHistoryBaselineError extends Schema.TaggedError<ThreadHistoryBaselineError>()(
  "ThreadHistoryBaselineError",
  { message: Schema.String },
) {}
export class ThreadHistoryBaselineImporter extends Context.Service<
  ThreadHistoryBaselineImporter,
  {
    readonly install: (
      input: ThreadHistoryBaselineInput,
    ) => Effect.Effect<{ sequence: number }, ThreadHistoryBaselineError>;
  }
>()("t3/relay/ThreadHistoryBaseline/ThreadHistoryBaselineImporter") {}
const fail = (message: string) => new ThreadHistoryBaselineError({ message });
const decode = Schema.decodeUnknownEffect(ThreadHistoryBaselineInput);
export const isThreadHistoryBaselineError = Schema.is(ThreadHistoryBaselineError);
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationEvent));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommandReceipt));
const withoutSequence = (event: OrchestrationEvent) => ({ ...event, sequence: 0 });

/** Called by the engine's serialized writer, after artifact verification and checkout reservation.
 * Imported events retain their IDs and payloads but acquire local sequence numbers. Only the
 * final placement event may be published to reactors; replaying old prompts would execute them.
 */
export function makeThreadHistoryBaseline(
  sql: SqlClient.SqlClient,
  events: OrchestrationEventStoreShape,
  receipts: OrchestrationCommandReceiptRepositoryShape,
  projection: OrchestrationProjectionPipelineShape,
) {
  const fences = makeThreadExecutionFence(sql);
  const install = Effect.fn("ThreadHistoryBaseline.install")(
    function* (input: ThreadHistoryBaselineInput) {
      const value = yield* decode(input);
      const target = value.destination;
      if (value.resetVm && value.backupRecovery)
        return yield* fail("A baseline cannot combine reset and backup recovery.");
      const pauseQueue = value.resetVm || value.backupRecovery;
      const recoveryEventPrefix = value.backupRecovery ? "thread-vm-backup" : "thread-vm-reset";
      const nativeJson =
        value.nativeRuntime === undefined ? null : yield* encodeNative(value.nativeRuntime);
      if (
        value.source.threadId !== target.threadId ||
        value.source.operationId !== target.operationId ||
        (value.backupRecovery
          ? value.source.generation >= target.generation
          : value.source.generation + 1 !== target.generation) ||
        value.source.environmentId === target.environmentId
      )
        return yield* fail("The baseline does not match this move's source and destination.");
      if (
        value.events.length !== value.source.eventCount ||
        value.events.length === 0 ||
        value.receipts.length !== value.source.receiptCount
      )
        return yield* fail("The baseline is incomplete.");
      const eventHash = NodeCrypto.createHash("sha256"),
        receiptHash = NodeCrypto.createHash("sha256");
      let eventBytes = 0,
        receiptBytes = 0;
      for (const event of value.events) {
        const bytes = new TextEncoder().encode(`${yield* encodeEvent(event)}\n`);
        eventHash.update(bytes);
        eventBytes += bytes.length;
      }
      for (const receipt of value.receipts) {
        const bytes = new TextEncoder().encode(`${yield* encodeReceipt(receipt)}\n`);
        receiptHash.update(bytes);
        receiptBytes += bytes.length;
      }
      if (
        eventHash.digest("hex") !== value.source.events.sha256 ||
        eventBytes !== value.source.events.size ||
        receiptHash.digest("hex") !== value.source.receipts.sha256 ||
        receiptBytes !== value.source.receipts.size
      )
        return yield* fail("Baseline content does not match its verified history manifest.");
      let previous = 0;
      const ids = new Set<string>();
      for (const event of value.events) {
        if (
          event.aggregateKind !== "thread" ||
          event.aggregateId !== target.threadId ||
          !("threadId" in event.payload) ||
          event.payload.threadId !== target.threadId ||
          event.sequence <= previous ||
          ids.has(event.eventId)
        )
          return yield* fail(
            "The baseline crosses a thread, repeats an event, or is out of order.",
          );
        previous = event.sequence;
        ids.add(event.eventId);
      }
      if (value.events[0]!.type !== "thread.created" || previous !== value.source.sourceSequence)
        return yield* fail("The baseline does not cover the complete source history.");
      const commands = new Set<string>();
      for (const receipt of value.receipts) {
        if (
          receipt.aggregateKind !== "thread" ||
          receipt.aggregateId !== target.threadId ||
          commands.has(receipt.commandId)
        )
          return yield* fail("The baseline contains a foreign or repeated command receipt.");
        commands.add(receipt.commandId);
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const fence = yield* fences.get(target.threadId);
          if (
            !fence ||
            fence.environmentId !== target.environmentId ||
            fence.generation !== target.generation ||
            fence.projectId !== target.projectId ||
            fence.operationId !== target.operationId ||
            fence.relayUrl !== target.relayUrl ||
            fence.phase !== "frozen"
          )
            return yield* fail("The destination is not frozen for this move.");
          const [checkout] = yield* sql<{
            phase: string;
            projectId: string;
            branch: string | null;
            mode: string;
            checkoutPath: string;
            manifestSha256: string;
          }>`SELECT phase, project_id AS "projectId",
              branch, mode, checkout_path AS "checkoutPath", manifest_sha256 AS "manifestSha256"
              FROM thread_checkout_claims WHERE operation_id = ${target.operationId}`;
          if (
            checkout &&
            (checkout.phase !== "installed" ||
              checkout.projectId !== target.projectId ||
              checkout.branch !== target.branch ||
              checkout.manifestSha256 !== value.manifestSha256 ||
              (checkout.mode === "main"
                ? target.worktreePath !== null
                : target.worktreePath !== checkout.checkoutPath))
          )
            return yield* fail("History placement does not match its installed checkout.");
          const [prior] = yield* sql<{
            digest: string;
            sequence: number;
            historyHash: string;
            receiptsHash: string;
            sourceEnvironmentId: string;
            sourceSequence: number;
            nativeJson: string | null;
          }>`SELECT manifest_sha256 AS digest, history_sha256 AS "historyHash", receipts_sha256 AS "receiptsHash",
        source_environment_id AS "sourceEnvironmentId", source_sequence AS "sourceSequence",
        destination_sequence AS sequence, native_runtime_json AS "nativeJson" FROM thread_transfer_baselines WHERE operation_id = ${target.operationId}`;
          if (prior) {
            if (
              prior.digest !== value.manifestSha256 ||
              prior.nativeJson !== nativeJson ||
              prior.historyHash !== value.source.events.sha256 ||
              prior.receiptsHash !== value.source.receipts.sha256 ||
              prior.sourceEnvironmentId !== value.source.environmentId ||
              prior.sourceSequence !== value.source.sourceSequence
            )
              return yield* fail("The move already imported a different archive.");
            const stored = yield* Stream.runCollect(
              events.readAggregateRange({
                aggregateKind: "thread",
                aggregateId: target.threadId,
                fromSequenceExclusive: prior.sequence - 1,
                toSequenceInclusive: prior.sequence,
                limit: 1,
              }),
            );
            const event = stored[0];
            if (
              !event ||
              event.type !== "thread.placement-imported" ||
              event.payload.projectId !== target.projectId ||
              event.payload.branch !== target.branch ||
              event.payload.worktreePath !== target.worktreePath
            )
              return yield* fail("The move's destination changed after import.");
            const resetEvents = yield* sql<{
              eventId: string;
            }>`SELECT event_id AS "eventId" FROM orchestration_events
              WHERE stream_id=${target.threadId} AND event_id IN (${`thread-vm-reset:${target.operationId}:pause`},${`thread-vm-reset:${target.operationId}:notice`},${`thread-vm-backup:${target.operationId}:pause`},${`thread-vm-backup:${target.operationId}:notice`},${`thread-vm-backup:${target.operationId}:stopped`})`;
            const expectedRecoveryEvents = new Set(
              pauseQueue
                ? [
                    `${recoveryEventPrefix}:${target.operationId}:pause`,
                    `${recoveryEventPrefix}:${target.operationId}:notice`,
                  ]
                : [],
            );
            if (
              value.backupRecovery &&
              value.events.some((event) => event.type === "thread.session-set")
            )
              expectedRecoveryEvents.add(`thread-vm-backup:${target.operationId}:stopped`);
            if (
              resetEvents.length !== expectedRecoveryEvents.size ||
              resetEvents.some((event) => !expectedRecoveryEvents.has(event.eventId))
            )
              return yield* fail("The reset baseline changed its queue/history intent.");
            return { sequence: prior.sequence, event };
          }
          const project =
            yield* sql`SELECT 1 FROM projection_projects WHERE project_id = ${target.projectId} AND deleted_at IS NULL`;
          if (!project.length) return yield* fail("The destination project no longer exists.");
          const busy =
            yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id = ${target.threadId} AND completed = 0
        UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id = ${target.threadId} AND status != 'stopped'`;
          if (busy.length) return yield* fail("The destination still has live thread work.");
          const [head] = yield* sql<{
            sequence: number;
          }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${target.threadId}`;
          const abortedArrivals = yield* makeThreadTransferAborts(sql).eventIds(target.threadId);
          const inherited = yield* Stream.runCollect(
            events
              .readAggregateRange({
                aggregateKind: "thread",
                aggregateId: target.threadId,
                fromSequenceExclusive: 0,
                toSequenceInclusive: head!.sequence,
                limit: Number.MAX_SAFE_INTEGER,
              })
              .pipe(
                Stream.filter(
                  (event) =>
                    event.type !== "thread.placement-imported" ||
                    !abortedArrivals.has(event.eventId),
                ),
              ),
          );
          // A returning thread must extend exactly the history left on this machine.
          if (
            inherited.length > value.events.length ||
            inherited.some(
              (event, index) =>
                !NodeUtil.isDeepStrictEqual(
                  withoutSequence(event),
                  withoutSequence(value.events[index]!),
                ),
            )
          )
            return yield* fail("Destination history diverged from the incoming thread.");
          const previousReceipts = yield* sql<{
            commandId: string;
          }>`SELECT command_id AS "commandId" FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id = ${target.threadId}`;
          if (previousReceipts.some((receipt) => !commands.has(receipt.commandId)))
            return yield* fail("The baseline omits a command already handled at the destination.");
          for (const receipt of value.receipts) {
            const existing = yield* receipts.getByCommandId({ commandId: receipt.commandId });
            if (
              Option.isSome(existing) &&
              (existing.value.aggregateKind !== "thread" ||
                existing.value.aggregateId !== target.threadId ||
                existing.value.status !== receipt.status ||
                existing.value.error !== receipt.error ||
                existing.value.acceptedAt !== receipt.acceptedAt)
            )
              return yield* fail("An imported command conflicts with an existing receipt.");
          }
          for (const source of value.events.slice(inherited.length)) {
            // Projection identifiers are global. Never let an archive overwrite another thread.
            let collision = false;
            if (source.type === "thread.message-sent")
              collision =
                (yield* sql`SELECT 1 FROM projection_thread_messages
          WHERE message_id = ${source.payload.messageId} AND thread_id != ${target.threadId}`)
                  .length > 0;
            if (source.type === "thread.activity-appended")
              collision =
                (yield* sql`SELECT 1 FROM projection_thread_activities
          WHERE activity_id = ${source.payload.activity.id} AND thread_id != ${target.threadId}`)
                  .length > 0;
            if (source.type === "thread.proposed-plan-upserted")
              collision =
                (yield* sql`SELECT 1 FROM projection_thread_proposed_plans
          WHERE plan_id = ${source.payload.proposedPlan.id} AND thread_id != ${target.threadId}`)
                  .length > 0;
            if (
              source.type === "thread.activity-appended" &&
              Predicate.hasProperty(source.payload.activity.payload, "requestId") &&
              Predicate.isString(source.payload.activity.payload.requestId)
            ) {
              collision ||=
                (yield* sql`SELECT 1 FROM projection_pending_approvals
            WHERE request_id = ${source.payload.activity.payload.requestId} AND thread_id != ${target.threadId}`)
                  .length > 0;
            }
            if (source.type === "thread.approval-response-requested")
              collision ||=
                (yield* sql`SELECT 1 FROM projection_pending_approvals
          WHERE request_id = ${source.payload.requestId} AND thread_id != ${target.threadId}`)
                  .length > 0;
            if (source.type === "thread.deleted")
              return yield* fail("A deleted thread cannot be moved.");
            if (collision)
              return yield* fail("An imported item belongs to another destination thread.");
            const stored = yield* events.append(source);
            // History is restored without executing attachment pruning or provider effects.
            yield* projection.projectEventDeferred(stored).pipe(Effect.asVoid);
          }
          if (value.backupRecovery) {
            const liveTurns =
              yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${target.threadId} AND state IN ('pending','running') LIMIT 1`;
            if (liveTurns.length)
              return yield* fail("The retained history contains unfinished provider work.");
            const currentSession = value.events
              .toReversed()
              .find((event) => event.type === "thread.session-set");
            if (currentSession?.type === "thread.session-set") {
              if (
                !["ready", "stopped", "error"].includes(currentSession.payload.session.status) ||
                currentSession.payload.session.activeTurnId !== null
              )
                return yield* fail("The retained conversation has an active provider session.");
              const stopped = yield* events.append({
                eventId: EventId.make(`thread-vm-backup:${target.operationId}:stopped`),
                type: "thread.session-set",
                aggregateKind: "thread",
                aggregateId: target.threadId,
                occurredAt: value.importedAt,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId: target.threadId,
                  session: {
                    ...currentSession.payload.session,
                    status: "stopped",
                    activeTurnId: null,
                    updatedAt: value.importedAt,
                  },
                },
              });
              yield* projection.projectEventDeferred(stopped).pipe(Effect.asVoid);
            }
          }
          const unfinished =
            yield* sql`SELECT 1 FROM projection_thread_sessions WHERE thread_id = ${target.threadId}
        AND status NOT IN ('stopped', 'error')
        UNION ALL SELECT 1 FROM projection_turns WHERE thread_id = ${target.threadId} AND state IN ('pending', 'running')`;
          if (unfinished.length)
            return yield* fail("The imported history still contains unfinished execution.");
          if (pauseQueue) {
            const [queue] = yield* sql<{
              state: string;
            }>`SELECT state_json AS state FROM projection_thread_prompt_queues WHERE thread_id=${target.threadId}`;
            const current = queue ? yield* decodeQueue(queue.state) : emptyThreadPromptQueue();
            const base = {
              aggregateKind: "thread" as const,
              aggregateId: target.threadId,
              occurredAt: value.importedAt,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
            };
            const paused = yield* events.append({
              ...base,
              eventId: EventId.make(`${recoveryEventPrefix}:${target.operationId}:pause`),
              type: "thread.prompt-queue-changed",
              payload: {
                threadId: target.threadId,
                updatedAt: value.importedAt,
                control: {
                  enabled: false,
                  revision: current.revision + 1,
                  pauseReason: {
                    code: "stopped",
                    detail: value.backupRecovery
                      ? "Workspace restored from backup. Resume the queue when you are ready."
                      : "VM reset. Resume the queue when you are ready.",
                  },
                },
              },
            });
            yield* projection.projectEventDeferred(paused).pipe(Effect.asVoid);
            const notice = yield* events.append({
              ...base,
              eventId: EventId.make(`${recoveryEventPrefix}:${target.operationId}:notice`),
              type: "thread.activity-appended",
              payload: {
                threadId: target.threadId,
                activity: {
                  id: EventId.make(`${recoveryEventPrefix}:${target.operationId}:notice`),
                  kind: value.backupRecovery ? "vm.backup-restored" : "vm.reset",
                  tone: "info",
                  turnId: null,
                  summary: value.backupRecovery
                    ? "Workspace restored from an older backup. Your retained conversation and queued messages were kept; the queue is paused."
                    : "VM reset. Your conversation and queued messages were kept; the queue is paused.",
                  payload: { operationId: target.operationId, branch: target.branch },
                  createdAt: value.importedAt,
                },
              },
            });
            yield* projection.projectEventDeferred(notice).pipe(Effect.asVoid);
          }
          const event = yield* events.append({
            eventId: EventId.make(`thread-transfer:${target.operationId}`),
            type: "thread.placement-imported",
            aggregateKind: "thread",
            aggregateId: target.threadId,
            occurredAt: value.importedAt,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId: target.threadId,
              projectId: target.projectId,
              branch: target.branch,
              worktreePath: target.worktreePath,
              updatedAt: value.importedAt,
            },
          });
          yield* projection.projectEventDeferred(event).pipe(Effect.asVoid);
          for (const receipt of value.receipts)
            yield* receipts.upsert({
              ...receipt,
              projectId: target.projectId,
              resultSequence: event.sequence,
            });
          if (value.nativeRuntime !== undefined) {
            if (value.nativeRuntime === null) {
              yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${target.threadId}`;
            } else {
              const native = value.nativeRuntime;
              const cursor = yield* encodeNativeCursor(native);
              yield* sql`INSERT INTO provider_session_runtime
                (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
                SELECT ${target.threadId}, 'codex', ${native.providerInstanceId}, 'codex', runtime_mode, 'stopped', ${value.importedAt}, ${cursor}, NULL
                FROM projection_threads WHERE thread_id = ${target.threadId}
                ON CONFLICT(thread_id) DO UPDATE SET provider_name = excluded.provider_name,
                  provider_instance_id = excluded.provider_instance_id, adapter_key = excluded.adapter_key,
                  runtime_mode = excluded.runtime_mode, status = excluded.status, last_seen_at = excluded.last_seen_at,
                  resume_cursor_json = excluded.resume_cursor_json, runtime_payload_json = NULL`;
            }
          }
          yield* sql`INSERT INTO thread_transfer_baselines (operation_id, thread_id, generation, manifest_sha256,
        history_sha256, receipts_sha256, source_environment_id, source_sequence, destination_sequence, native_runtime_json) VALUES (${target.operationId}, ${target.threadId},
        ${target.generation}, ${value.manifestSha256}, ${value.source.events.sha256}, ${value.source.receipts.sha256},
        ${value.source.environmentId}, ${value.source.sourceSequence}, ${event.sequence}, ${nativeJson})`;
          // The relay already owns inherited history, but the destination's arrival event is new.
          // It must be mirrored after cutover alongside subsequent destination events.
          yield* sql`INSERT INTO thread_relay_history_cursors (thread_id, generation, source_sequence)
        VALUES (${target.threadId}, ${target.generation}, ${event.sequence - (pauseQueue ? 3 : 1) - (value.backupRecovery && value.events.some((e) => e.type === "thread.session-set") ? 1 : 0)}) ON CONFLICT(thread_id) DO UPDATE
        SET generation = excluded.generation, source_sequence = excluded.source_sequence`;
          return { sequence: event.sequence, event };
        }),
      );
    },
    Effect.mapError((error) =>
      isThreadHistoryBaselineError(error)
        ? error
        : fail("Thread baseline import failed; the destination remains frozen."),
    ),
  );
  return { install };
}
