import type { PgClient } from "@effect/sql-pg/PgClient";
import { sha256 } from "@noble/hashes/sha2";
import {
  ChatAttachment,
  EnvironmentId,
  OrchestrationEvent,
  PortableThreadCommand,
} from "@t3tools/contracts";
import {
  OrchestrationCommandReceipt,
  ThreadHistoryArchiveManifest,
} from "@t3tools/contracts/threadTransfer";
import {
  RelayThreadVmIndependentHistory,
  RelayThreadPersistedReceipt,
  ThreadAttachmentCheckpointArchiveManifest,
  ThreadTransferChunkManifest,
} from "@t3tools/contracts/relay";
import { collectThreadAttachmentReferences } from "@t3tools/shared/threadAttachmentReferences";
import {
  applyThreadPromptQueueChange,
  emptyThreadPromptQueue,
} from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeThreadNativeCheckpointStore } from "./ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "./ThreadAttachmentCheckpointStore.ts";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";
import { makeThreadCheckpointObjects } from "./ThreadCheckpointObjects.ts";
import type { makeThreadArtifactObjects } from "./ThreadArtifactObjects.ts";

export class ThreadVmRecoveryHistoryConflict extends Schema.TaggedError<ThreadVmRecoveryHistoryConflict>()(
  "ThreadVmRecoveryHistoryConflict",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadVmRecoveryHistoryConflict({ message });
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));
const decodeReceiptJson = Schema.decodeEffect(Schema.fromJsonString(OrchestrationCommandReceipt));
const decodeCommand = Schema.decodeUnknownEffect(PortableThreadCommand);
const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(OrchestrationCommandReceipt));
const decodePersisted = Schema.decodeUnknownEffect(RelayThreadPersistedReceipt);
const decodeHistory = Schema.decodeEffect(Schema.fromJsonString(ThreadHistoryArchiveManifest));
const decodeReceipt = Schema.decodeUnknownEffect(OrchestrationCommandReceipt);
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(ThreadHistoryArchiveManifest));
const encodeIndex = Schema.encodeSync(Schema.fromJsonString(ThreadTransferChunkManifest));
const decodeHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadAttachmentCheckpointArchiveManifest),
);
const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (body: Uint8Array) =>
  Array.from(sha256(body), (b) => b.toString(16).padStart(2, "0")).join("");
const idFor = (operationId: string, name: string) => {
  const b = sha256(bytes(`launchpad-recovery-history-v1:${operationId}:${name}`)).slice(0, 16);
  b[6] = (b[6]! & 15) | 80;
  b[8] = (b[8]! & 63) | 128;
  const h = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export interface ThreadVmRecoveryHistoryInput {
  readonly threadId: string;
  readonly sourceEnvironmentId: string;
  readonly generation: number;
  readonly nativeCheckpointOperationId: string;
}
export interface ThreadVmRecoveryHistorySelection {
  readonly nativeRelayCursor: number;
  readonly throughRelayCursor: number;
  readonly throughCommandPosition: number;
}
type SelectedInput = ThreadVmRecoveryHistoryInput &
  ThreadVmRecoveryHistorySelection & { readonly operationId: string };

/** A backup restores workspace bytes; this independent archive restores the authentic
 * conversation. Relay cursors deliberately do not masquerade as native source sequences. */
export function makeThreadVmRecoveryHistory(
  sql: PgClient,
  objects: ReturnType<typeof makeThreadArtifactObjects>,
) {
  const natives = makeThreadNativeCheckpointStore(sql, objects),
    attachments = makeThreadAttachmentCheckpointStore(sql, objects),
    catalog = makeThreadArtifactStore(sql),
    checkpointObjects = makeThreadCheckpointObjects(sql, objects, fail);
  const load = Effect.fn("relay.vm.recovery_history.load")(function* (
    input: ThreadVmRecoveryHistoryInput &
      Partial<ThreadVmRecoveryHistorySelection> & { operationId?: string },
  ) {
    const native =
      (yield* natives.get(input.nativeCheckpointOperationId)) ??
      (input.operationId
        ? yield* natives.getForOperation({
            threadId: input.threadId,
            operationId: input.operationId,
          })
        : null);
    const chat =
      (yield* attachments.get(input.nativeCheckpointOperationId)) ??
      (input.operationId
        ? yield* attachments.getForOperation({
            threadId: input.threadId,
            operationId: input.operationId,
          })
        : null);
    if (
      !native ||
      !chat ||
      native.threadId !== input.threadId ||
      native.operationId !== input.nativeCheckpointOperationId ||
      chat.nativeArchiveSha256 !== native.archiveSha256 ||
      chat.generation !== native.generation ||
      chat.sourceEnvironmentId !== native.sourceEnvironmentId ||
      chat.sourceSequence !== native.sourceSequence
    )
      return yield* fail("Independent native conversation and attachments are incomplete.");
    const [watermark] = yield* sql<{
      sequence: number;
    }>`SELECT source_sequence::float8 AS sequence FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId} AND environment_id=${native.sourceEnvironmentId} AND generation=${native.generation}`;
    if ((watermark?.sequence ?? -1) < native.sourceSequence)
      return yield* fail("The native checkpoint history is not independently mirrored.");
    const [boundary] = yield* sql<{
      cursor: number;
    }>`SELECT cursor FROM relay_thread_history WHERE thread_id=${input.threadId} AND environment_id=${native.sourceEnvironmentId} AND source_sequence=${native.sourceSequence}`;
    if (
      !boundary ||
      (input.nativeRelayCursor !== undefined && boundary.cursor !== input.nativeRelayCursor)
    )
      return yield* fail("The native checkpoint cursor is unavailable or changed.");
    const arrivals = new Map<string, string>(),
      importNotices = new Map<string, string>();
    if (
      native.generation !== input.generation ||
      native.sourceEnvironmentId !== input.sourceEnvironmentId
    ) {
      if (input.generation <= native.generation || input.generation - native.generation > 64)
        return yield* fail("The retained native import chain is unavailable or exceeds its bound.");
      const lineage = yield* sql<{
        operationId: string;
        sourceEnvironmentId: string;
        generation: number;
        destinationEnvironmentId: string;
        destinationGeneration: number;
      }>`SELECT m.operation_id AS "operationId",m.source_environment_id AS "sourceEnvironmentId",m.expected_generation AS generation,m.destination_environment_id AS "destinationEnvironmentId",m.expected_generation+1 AS "destinationGeneration" FROM relay_thread_moves m JOIN relay_thread_move_checkpoints c USING(operation_id) WHERE m.thread_id=${input.threadId} AND m.phase='completed' AND c.native_checkpoint_operation_id=${native.operationId}
      UNION ALL SELECT r.operation_id,COALESCE(k.environment_id,f.environment_id),r.generation,r.import_receipt->>'environmentId',(r.import_receipt->'scope'->>'generation')::int FROM relay_thread_vm_restores r LEFT JOIN relay_thread_vm_backup_recoveries k ON k.operation_id=r.backup_recovery_operation_id LEFT JOIN relay_thread_vm_final_saves f ON f.operation_id=r.saved_disk_operation_id WHERE r.thread_id=${input.threadId} AND r.phase='completed' AND r.native_checkpoint_operation_id=${native.operationId}
      UNION ALL SELECT r.operation_id,r.source_environment_id,r.expected_generation,r.import_receipt->>'environmentId',(r.import_receipt->'scope'->>'generation')::int FROM relay_thread_vm_resets r WHERE r.thread_id=${input.threadId} AND r.phase='completed' AND r.native_checkpoint_operation_id=${native.operationId} LIMIT 129`;
      if (lineage.length > 128)
        return yield* fail("The completed native import lineage exceeds its bound.");
      let generation = native.generation,
        environment = native.sourceEnvironmentId;
      while (generation < input.generation) {
        const edges = lineage.filter(
          (edge) => edge.generation === generation && edge.sourceEnvironmentId === environment,
        );
        const edge = edges[0];
        if (
          edges.length !== 1 ||
          !edge ||
          edge.destinationGeneration !== generation + 1 ||
          !edge.destinationEnvironmentId ||
          edge.destinationEnvironmentId === environment
        )
          return yield* fail(
            "The native point has an ambiguous or incomplete completed import chain.",
          );
        arrivals.set(`thread-transfer:${edge.operationId}`, edge.destinationEnvironmentId);
        for (const prefix of ["thread-vm-reset", "thread-vm-backup"]) {
          importNotices.set(`${prefix}:${edge.operationId}:notice`, edge.destinationEnvironmentId);
          importNotices.set(`${prefix}:${edge.operationId}:stopped`, edge.destinationEnvironmentId);
        }
        generation++;
        environment = edge.destinationEnvironmentId;
      }
      if (environment !== input.sourceEnvironmentId)
        return yield* fail("The completed import chain does not reach this owner.");
    }
    const [historyHead] = yield* sql<{
      cursor: number;
    }>`SELECT COALESCE(MAX(cursor),0)::int AS cursor FROM relay_thread_history WHERE thread_id=${input.threadId}`;
    const throughRelayCursor = input.throughRelayCursor ?? historyHead?.cursor ?? 0;
    const [historySize] = yield* sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*)::int AS count,COALESCE(sum(octet_length(event_json::text)),0)::float8 AS bytes FROM relay_thread_history WHERE thread_id=${input.threadId} AND cursor<=${throughRelayCursor}`;
    if (!historySize || historySize.count > 100000 || historySize.bytes > 256 * 1024 * 1024)
      return yield* fail("Recovery history exceeds its retained size bound.");
    const rows = yield* sql<{
      cursor: number;
      environmentId: string;
      sourceSequence: number;
      event: unknown;
    }>`SELECT cursor,environment_id AS "environmentId",source_sequence::float8 AS "sourceSequence",event_json AS event FROM relay_thread_history WHERE thread_id=${input.threadId} AND cursor<=${throughRelayCursor} ORDER BY cursor LIMIT 100001`;
    if (!rows.length || rows.length > 100000 || rows.at(-1)!.cursor !== throughRelayCursor)
      return yield* fail("Retained recovery history is missing or exceeds its bound.");
    const events: OrchestrationEvent[] = [],
      eventIds = new Set<string>(),
      streamingMessages = new Set<string>();
    let size = 0,
      queue = emptyThreadPromptQueue(),
      sessionStopped = true,
      idleSessionStarting = false,
      pendingTurn = false,
      arrivalsSeen = new Set<string>();
    const idlePauses = new Map<string, string>();
    const queueSettled = () =>
      !queue.handoff &&
      !queue.awaitingTurnId &&
      queue.admissions.length === 0 &&
      (!queue.preparation || queue.preparation.settled) &&
      queue.entries.every((entry) => entry.state === "pending");
    for (const row of rows) {
      const event = yield* decodeEvent(row.event);
      if (
        row.cursor !== events.length + 1 ||
        event.sequence !== row.sourceSequence ||
        eventIds.has(event.eventId) ||
        event.type === "thread.deleted" ||
        event.aggregateKind !== "thread" ||
        event.aggregateId !== input.threadId ||
        !("threadId" in event.payload) ||
        event.payload.threadId !== input.threadId ||
        (events.length === 0 && event.type !== "thread.created")
      )
        return yield* fail("Mirrored recovery history crossed a thread or has a gap.");
      eventIds.add(event.eventId);
      if (event.type === "thread.message-sent" && event.payload.role === "assistant") {
        if (event.payload.streaming) streamingMessages.add(event.payload.messageId);
        else streamingMessages.delete(event.payload.messageId);
      }
      if (row.cursor > boundary.cursor) {
        const idle = !pendingTurn && streamingMessages.size === 0 && queueSettled();
        let allowed = false;
        if (event.type === "thread.prompt-queue-changed") {
          const p = event.payload;
          allowed =
            !p.admission &&
            (p.handoff === undefined || p.handoff === null) &&
            (p.awaitingTurnId === undefined || p.awaitingTurnId === null) &&
            (!p.entry || p.entry.state === "pending") &&
            (p.finalizedTurnId === undefined ||
              p.finalizedTurnId === null ||
              p.finalizedTurnId === native.turnId);
          if (allowed && idle && sessionStopped && p.control?.enabled === false && event.commandId)
            idlePauses.set(event.commandId, row.environmentId);
        }
        if (event.type === "thread.turn-interrupt-requested") {
          // Queue pause always emits an interrupt, even for an idle session.
          allowed =
            idle &&
            sessionStopped &&
            !queue.enabled &&
            event.payload.turnId === undefined &&
            event.commandId !== null &&
            idlePauses.get(event.commandId) === row.environmentId;
          if (event.commandId) idlePauses.delete(event.commandId);
        }
        if (event.type === "thread.session-set") {
          allowed =
            event.payload.session.activeTurnId === null &&
            (event.payload.session.status === "stopped" ||
              (idle &&
                (sessionStopped || idleSessionStarting) &&
                ["starting", "ready", "error"].includes(event.payload.session.status)));
          idleSessionStarting = allowed && event.payload.session.status === "starting";
        }
        if (event.type === "thread.turn-diff-completed")
          allowed = event.payload.turnId === native.turnId;
        if (event.type === "thread.activity-appended")
          allowed =
            (event.payload.activity.kind === "checkpoint.captured" &&
              event.payload.activity.turnId === native.turnId) ||
            (idle &&
              sessionStopped &&
              event.payload.activity.kind === "context-window.updated" &&
              event.payload.activity.turnId === null);
        if (
          event.type === "thread.placement-imported" &&
          arrivals.get(event.eventId) === row.environmentId
        ) {
          allowed = true;
          arrivalsSeen.add(event.eventId);
        }
        if (
          event.type === "thread.activity-appended" &&
          importNotices.get(event.eventId) === row.environmentId &&
          ["vm.reset", "vm.backup-restored"].includes(event.payload.activity.kind)
        )
          allowed = true;
        if (!allowed)
          return yield* fail(
            "Provider work after the saved native conversation is not checkpointed.",
          );
      }
      if (event.type === "thread.session-set")
        sessionStopped =
          ["ready", "stopped", "error"].includes(event.payload.session.status) &&
          event.payload.session.activeTurnId === null;
      if (event.type === "thread.turn-start-requested") pendingTurn = true;
      if (
        event.type === "thread.session-set" &&
        (event.payload.session.status === "running" ||
          ["stopped", "error", "interrupted"].includes(event.payload.session.status) ||
          (event.payload.session.status === "ready" &&
            event.commandId?.startsWith("server:provider-session-set:")))
      )
        pendingTurn = false;
      if (event.type === "thread.prompt-queue-changed")
        queue = applyThreadPromptQueueChange(queue, event.payload, row.cursor);
      const normalized = { ...event, sequence: row.cursor };
      size += bytes(encodeEvent(normalized) + "\n").length;
      if (size > 256 * 1024 * 1024) return yield* fail("Recovery history exceeds its byte limit.");
      events.push(normalized);
    }
    if (
      arrivalsSeen.size !== arrivals.size ||
      !sessionStopped ||
      pendingTurn ||
      streamingMessages.size > 0 ||
      !queueSettled()
    )
      return yield* fail("Recovery history still contains unsettled execution.");
    const [head] = yield* sql<{
      position: number;
    }>`SELECT COALESCE(MAX(position),0)::int AS position FROM relay_thread_commands WHERE thread_id=${input.threadId}`;
    const throughCommandPosition = input.throughCommandPosition ?? head?.position ?? 0;
    if (throughCommandPosition > (head?.position ?? 0))
      return yield* fail("Recovery command cursor is unavailable.");
    const [commandSize] = yield* sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*)::int AS count,COALESCE(sum(octet_length(payload_json::text)+COALESCE(octet_length(archive_receipt_json::text),0)),0)::float8 AS bytes FROM relay_thread_commands WHERE thread_id=${input.threadId} AND position<=${throughCommandPosition}`;
    const [localSize] = yield* sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*)::int AS count,COALESCE(sum(octet_length(receipt_json::text)),0)::float8 AS bytes FROM relay_thread_local_receipts WHERE thread_id=${input.threadId}`;
    if (
      !commandSize ||
      !localSize ||
      commandSize.count > 100000 ||
      localSize.count > 100000 ||
      commandSize.bytes + localSize.bytes > 64 * 1024 * 1024
    )
      return yield* fail("Recovery command history exceeds its retained size bound.");
    const commands = yield* sql<{
      commandId: string;
      acceptedGeneration: number;
      receipt: unknown;
      archive: unknown;
      command: unknown;
    }>`SELECT command_id AS "commandId",accepted_generation AS "acceptedGeneration",receipt_json AS receipt,archive_receipt_json AS archive,payload_json AS command FROM relay_thread_commands WHERE thread_id=${input.threadId} AND position<=${throughCommandPosition} ORDER BY position LIMIT 100001`;
    if (commands.length > 100000) return yield* fail("Recovery command journal exceeds its bound.");
    for (const command of commands.filter((v) => v.receipt !== null)) {
      const ack = yield* decodePersisted(command.receipt),
        receipt = yield* decodeReceipt(command.archive);
      if (
        receipt.commandId !== command.commandId ||
        receipt.status !== ack.status ||
        (ack.status === "accepted" && receipt.resultSequence !== ack.sequence) ||
        (ack.status === "rejected" && receipt.error !== (ack.detail ?? null))
      )
        return yield* fail("A command acknowledgement contradicts its archived receipt.");
    }
    const local = yield* sql<{
      receipt: unknown;
    }>`SELECT receipt_json AS receipt FROM relay_thread_local_receipts WHERE thread_id=${input.threadId} ORDER BY command_id LIMIT 100001`;
    if (local.length > 100000)
      return yield* fail("Recovery local receipt journal exceeds its bound.");
    const receipts = new Map<string, OrchestrationCommandReceipt>();
    const originals = new Map<string, string>();
    const [enrollment] = yield* sql<{
      sourceSequence: number | null;
      phase: string;
      receiptCount: number | null;
    }>`SELECT source_sequence::float8 AS "sourceSequence",phase,receipt_count AS "receiptCount" FROM relay_thread_local_enrollments WHERE thread_id=${input.threadId}`;
    if (enrollment && (enrollment.phase !== "active" || enrollment.receiptCount !== local.length))
      return yield* fail("The independent local command baseline is incomplete.");
    const origins = yield* sql<{
      environmentId: string;
      generation: number;
      sourceSequence: number;
    }>`SELECT environment_id AS "environmentId",generation,source_sequence::float8 AS "sourceSequence" FROM relay_thread_history_watermarks WHERE thread_id=${input.threadId} LIMIT 100001`;
    if (origins.length > 100000) return yield* fail("Recovery source history exceeds its bound.");
    const environments = new Map<number, string | null>(),
      scannedSources = new Map<string, number>();
    for (const origin of origins) {
      environments.set(
        origin.generation,
        environments.has(origin.generation) ? null : origin.environmentId,
      );
      scannedSources.set(
        origin.environmentId,
        Math.max(scannedSources.get(origin.environmentId) ?? 0, origin.sourceSequence),
      );
    }
    for (const row of rows)
      if ((scannedSources.get(row.environmentId) ?? -1) < row.sourceSequence)
        return yield* fail("Recovery history has an unconfirmed source scan.");
    const covered = new Map<string, number>(),
      eventOrigins = new Map<string, Set<string>>();
    for (const row of rows) {
      covered.set(
        row.environmentId,
        Math.max(covered.get(row.environmentId) ?? 0, row.sourceSequence),
      );
      const command = events[row.cursor - 1]!.commandId;
      if (command) {
        const set = eventOrigins.get(command) ?? new Set<string>();
        set.add(row.environmentId);
        eventOrigins.set(command, set);
      }
    }
    const localOrigin =
      environments.get(1) === rows[0]!.environmentId ? rows[0]!.environmentId : null;
    if (enrollment) {
      if (
        enrollment.sourceSequence === null ||
        localOrigin === null ||
        !origins.some(
          (origin) =>
            origin.generation === 1 &&
            origin.environmentId === localOrigin &&
            origin.sourceSequence >= enrollment.sourceSequence!,
        )
      )
        return yield* fail("The original local history scan is incomplete.");
      covered.set(localOrigin, Math.max(covered.get(localOrigin) ?? 0, enrollment.sourceSequence));
    }
    const frozenReceipts = new Set<string>();
    if (native.recoveryHistory && native.captureOperationId)
      yield* checkpointObjects.withPinned(
        {
          threadId: input.threadId,
          operationId: native.operationId,
          manifestArtifactId: native.manifestArtifactId,
          kind: "native",
          maxBytes: 770 * 1024 * 1024,
        },
        (view) =>
          Effect.gen(function* () {
            const file = view.byName.get("history/receipts.jsonl");
            if (
              !file ||
              file.sha256 !== native.recoveryHistory!.receipts.sha256 ||
              file.sizeBytes !== native.recoveryHistory!.receipts.size
            )
              return yield* fail("The predecessor receipt archive changed.");
            const raw = yield* view.readMetadata("history/receipts.jsonl", 32 * 1024 * 1024);
            for (const line of raw.split("\n")) {
              if (line) frozenReceipts.add(encodeReceipt(yield* decodeReceiptJson(line)));
            }
          }),
      );
    const rawReceipts = [
      ...local.map((v) => ({
        raw: v.receipt,
        origin: enrollment?.phase === "active" ? localOrigin : null,
      })),
      ...commands
        .filter((v) => v.receipt !== null)
        .map((v) => ({
          raw: v.archive,
          origin:
            v.acceptedGeneration === input.generation
              ? (environments.get(v.acceptedGeneration) ?? null)
              : null,
        })),
    ];
    let receiptBytes = 0;
    for (const { raw, origin: admissionOrigin } of rawReceipts) {
      if (!raw) return yield* fail("A persisted command lacks its independently archived receipt.");
      const receipt = yield* decodeReceipt(raw);
      if (receipt.aggregateKind !== "thread" || receipt.aggregateId !== input.threadId)
        return yield* fail("Recovery receipt belongs to another thread.");
      receiptBytes += bytes(encodeReceipt(receipt) + "\n").length;
      if (receiptBytes > 64 * 1024 * 1024)
        return yield* fail("Recovery command receipts exceed their byte bound.");
      const prior = originals.get(receipt.commandId);
      if (prior && prior !== encodeReceipt(receipt))
        return yield* fail("Recovery command receipts contradict each other.");
      const emitted = eventOrigins.get(receipt.commandId),
        origin =
          emitted?.size === 1
            ? [...emitted][0]!
            : (admissionOrigin ??
              (frozenReceipts.has(encodeReceipt(receipt)) ? native.sourceEnvironmentId : null));
      // No-op receipts can witness another command's source head, but only in
      // their authenticated environment. Sequence collisions across machines
      // never confer coverage, and an unknown receipt origin fails closed.
      if (
        receipt.status === "accepted" &&
        (!origin ||
          (covered.get(origin) ?? -1) < receipt.resultSequence ||
          (scannedSources.get(origin) ?? -1) < receipt.resultSequence)
      )
        return yield* fail("An accepted command result is outside the retained source history.");
      originals.set(receipt.commandId, encodeReceipt(receipt));
      // The import rebases deduplication witnesses to its terminal event; these
      // cursors are transport witnesses, never original execution timestamps.
      receipts.set(receipt.commandId, {
        ...receipt,
        resultSequence:
          receipt.status === "accepted" ? rows.at(-1)!.cursor : receipt.resultSequence,
      });
    }
    const references = yield* collectThreadAttachmentReferences(
      input.threadId,
      Stream.fromIterable(events),
    );
    for (const pending of commands.filter((v) => v.receipt === null)) {
      if (eventOrigins.has(pending.commandId))
        return yield* fail("A previously applied command has no independently retained receipt.");
      const command = yield* decodeCommand(pending.command);
      if (
        command.type === "thread.turn.start" ||
        command.type === "thread.prompt.enqueue" ||
        command.type === "thread.prompt.edit"
      ) {
        for (const attachment of command.message.attachments ?? []) {
          if (!("id" in attachment))
            return yield* fail("A pending upload has no independently retained attachment.");
          references.push(yield* decodeAttachment(attachment));
        }
      }
      if (command.type === "thread.user-input.respond")
        references.push(...Object.values(command.attachmentsByQuestionId ?? {}).flat());
    }
    yield* checkpointObjects.withPinned(
      {
        threadId: input.threadId,
        operationId: chat.operationId,
        manifestArtifactId: chat.manifestArtifactId,
        kind: "attachment",
        maxBytes: 576 * 1024 * 1024,
      },
      (view) =>
        Effect.gen(function* () {
          const header = yield* decodeHeader(yield* view.readMetadata("manifest.json"));
          if (
            header.attachmentManifestSha256 !== chat.attachmentManifestSha256 ||
            header.nativeArchiveSha256 !== native.archiveSha256
          )
            return yield* fail("Independent chat attachment header changed.");
          const retainedAttachments = new Set(
            header.attachments.files.map((file) => encodeAttachment(file.attachment)),
          );
          for (const reference of references)
            if (!retainedAttachments.has(encodeAttachment(reference)))
              return yield* fail(
                "A queued or historical attachment is not independently retained.",
              );
        }),
    );
    return {
      native,
      attachments: chat,
      nativeRelayCursor: boundary.cursor,
      throughRelayCursor: rows.at(-1)!.cursor,
      throughCommandPosition,
      events,
      receipts: [...receipts.values()].sort((a, b) => a.commandId.localeCompare(b.commandId)),
    };
  });
  const inspect = Effect.fn("relay.vm.recovery_history.inspect")(function* (
    input: ThreadVmRecoveryHistoryInput,
  ) {
    const { events: _events, receipts: _receipts, ...selection } = yield* load(input);
    return selection;
  });
  const retain = Effect.fn("relay.vm.recovery_history.retain")(function* (input: SelectedInput) {
    const selected = yield* load(input);
    const pin = `recovery-history:${input.operationId}`;
    const eventBytes = bytes(selected.events.map((e) => encodeEvent(e) + "\n").join("")),
      receiptBytes = bytes(selected.receipts.map((r) => encodeReceipt(r) + "\n").join(""));
    const manifest: ThreadHistoryArchiveManifest = {
      format: "launchpad-history-v1",
      threadId: input.threadId,
      operationId: input.operationId,
      environmentId: selected.native.sourceEnvironmentId,
      generation: selected.native.generation,
      sourceSequence: selected.throughRelayCursor,
      eventCount: selected.events.length,
      events: { sha256: digest(eventBytes), size: eventBytes.length },
      receiptCount: selected.receipts.length,
      receipts: { sha256: digest(receiptBytes), size: receiptBytes.length },
    };
    const files: ThreadTransferChunkManifest["files"][number][] = [];
    const allIds: string[] = [];
    const put = Effect.fnUntraced(function* (
      name: string,
      body: Uint8Array,
      kind: "history" | "manifest",
    ) {
      const artifactId = idFor(input.operationId, name),
        sha = digest(body),
        artifact = yield* catalog.begin({
          artifactId,
          threadId: input.threadId,
          operationId: input.operationId,
          kind,
          sha256: sha,
          sizeBytes: body.length,
        });
      const [existingPin] =
        yield* sql`SELECT 1 FROM relay_thread_artifact_pins WHERE artifact_id=${artifactId} AND operation_id=${pin}`;
      if (!existingPin)
        yield* catalog.pinUpload({ artifactId, threadId: input.threadId, operationId: pin });
      yield* objects.put({
        key: artifact.storageKey,
        sizeBytes: body.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
      });
      yield* objects.verify({ key: artifact.storageKey, sha256: sha, sizeBytes: body.length });
      yield* catalog.complete({
        artifactId,
        sha256: sha,
        sizeBytes: body.length,
        retentionDays: 1,
      });
      allIds.push(artifactId);
      return { artifactId, sha256: sha, sizeBytes: body.length };
    });
    for (const [name, body] of [
      ["history/manifest.json", bytes(encodeHistory(manifest))],
      ["history/events.jsonl", eventBytes],
      ["history/receipts.jsonl", receiptBytes],
    ] as const) {
      const chunks = [];
      for (let offset = 0; offset < body.length; offset += 32 * 1024 * 1024)
        chunks.push(
          yield* put(
            `${name}:${offset}`,
            body.subarray(offset, offset + 32 * 1024 * 1024),
            "history",
          ),
        );
      files.push({ path: name, sha256: digest(body), sizeBytes: body.length, chunks });
    }
    const header = bytes(encodeHistory(manifest));
    const index: ThreadTransferChunkManifest = {
      format: "launchpad-thread-chunks-v1",
      threadId: input.threadId,
      operationId: input.operationId,
      sourceEnvironmentId: selected.native.sourceEnvironmentId,
      generation: selected.native.generation,
      transferManifestSha256: digest(header),
      files,
    };
    const artifact = yield* put("index", bytes(encodeIndex(index)), "manifest");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [held] =
          yield* sql`SELECT 1 FROM relay_thread_placements WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} FOR UPDATE`;
        if (!held) return yield* fail("Recovery no longer owns its source selection.");
        for (const artifactId of allIds)
          yield* catalog.pin({ artifactId, threadId: input.threadId, operationId: pin });
      }),
    );
    return {
      manifestArtifactId: artifact.artifactId,
      manifestSha256: artifact.sha256,
      sequenceSpace: "relay-cursor-v1" as const,
      nativeBoundary: {
        checkpointOperationId: selected.native.operationId,
        sourceEnvironmentId: EnvironmentId.make(selected.native.sourceEnvironmentId),
        generation: selected.native.generation,
        sourceSequence: selected.native.sourceSequence,
        relayCursor: selected.nativeRelayCursor,
      },
      throughRelayCursor: selected.throughRelayCursor,
      throughCommandPosition: selected.throughCommandPosition,
    } satisfies RelayThreadVmIndependentHistory;
  });
  const verify = Effect.fn("relay.vm.recovery_history.verify")(function* (
    input: SelectedInput & { independentHistory: RelayThreadVmIndependentHistory },
  ) {
    const h = input.independentHistory;
    if (
      h.nativeBoundary.checkpointOperationId !== input.nativeCheckpointOperationId ||
      h.nativeBoundary.relayCursor !== input.nativeRelayCursor ||
      h.throughRelayCursor !== input.throughRelayCursor ||
      h.throughCommandPosition !== input.throughCommandPosition
    )
      return yield* fail("Recovery history selection changed.");
    const artifact = yield* catalog.get(h.manifestArtifactId);
    if (
      !artifact ||
      artifact.threadId !== input.threadId ||
      artifact.operationId !== input.operationId ||
      artifact.sha256 !== h.manifestSha256 ||
      artifact.state !== "complete"
    )
      return yield* fail("Recovery history manifest is missing or changed.");
    const native =
      (yield* natives.getForOperation(input)) ??
      (yield* natives.get(input.nativeCheckpointOperationId));
    if (
      !native ||
      native.operationId !== input.nativeCheckpointOperationId ||
      h.sequenceSpace !== "relay-cursor-v1" ||
      h.nativeBoundary.sourceEnvironmentId !== native.sourceEnvironmentId ||
      h.nativeBoundary.generation !== native.generation ||
      h.nativeBoundary.sourceSequence !== native.sourceSequence
    )
      return yield* fail("Recovery archive owner changed.");
    yield* checkpointObjects.withPinned(
      {
        threadId: input.threadId,
        operationId: input.operationId,
        manifestArtifactId: h.manifestArtifactId,
        kind: "move",
        maxBytes: 320 * 1024 * 1024,
      },
      (view) =>
        Effect.gen(function* () {
          const index = view.manifest,
            names = new Set([
              "history/manifest.json",
              "history/events.jsonl",
              "history/receipts.jsonl",
            ]);
          if (
            view.artifact.sha256 !== h.manifestSha256 ||
            index.sourceEnvironmentId !== native.sourceEnvironmentId ||
            index.generation !== native.generation ||
            index.files.length !== 3 ||
            index.files.some((file) => !names.delete(file.path))
          )
            return yield* fail("Recovery archive file set changed.");
          const raw = yield* view.readMetadata("history/manifest.json", 64 * 1024);
          if (digest(bytes(raw)) !== index.transferManifestSha256)
            return yield* fail("Recovery archive header changed.");
          const header = yield* decodeHistory(raw);
          if (
            header.threadId !== input.threadId ||
            header.operationId !== input.operationId ||
            header.environmentId !== native.sourceEnvironmentId ||
            header.generation !== native.generation ||
            header.sourceSequence !== h.throughRelayCursor ||
            header.eventCount !== h.throughRelayCursor ||
            h.nativeBoundary.relayCursor > header.sourceSequence
          )
            return yield* fail("Recovery header does not cover its native boundary.");
          for (const [name, proof] of [
            ["history/events.jsonl", header.events],
            ["history/receipts.jsonl", header.receipts],
          ] as const) {
            const file = view.byName.get(name)!;
            if (file.sha256 !== proof.sha256 || file.sizeBytes !== proof.size)
              return yield* fail("Recovery file digest changed.");
          }
          const [pins] = yield* sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins WHERE operation_id=${`recovery-history:${input.operationId}`} AND expires_at IS NULL AND artifact_id IN ${sql.in(view.entries.map((entry) => entry.artifactId))}`;
          if (pins?.count !== view.entries.length)
            return yield* fail("Recovery history pins are incomplete.");
        }),
    );
    return h;
  });
  const release = Effect.fn("relay.vm.recovery_history.release")(function* (input: {
    threadId: string;
    operationId: string;
  }) {
    yield* sql`DELETE FROM relay_thread_artifact_pins p USING relay_thread_artifacts a WHERE p.artifact_id=a.artifact_id AND a.thread_id=${input.threadId} AND a.operation_id=${input.operationId} AND p.operation_id=${`recovery-history:${input.operationId}`}`;
  });
  const ownsArtifact = Effect.fn("relay.vm.recovery_history.owns_artifact")(function* (input: {
    threadId: string;
    operationId: string;
    artifactId: string;
  }) {
    const rows =
      yield* sql`SELECT 1 FROM relay_thread_artifacts a JOIN relay_thread_artifact_pins p USING(artifact_id) WHERE a.artifact_id=${input.artifactId} AND a.thread_id=${input.threadId} AND a.operation_id=${input.operationId} AND a.state='complete' AND p.operation_id=${`recovery-history:${input.operationId}`} AND p.expires_at IS NULL`;
    return rows.length === 1;
  });
  const openForOperation = Effect.fn("relay.vm.recovery_history.open")(function* (input: {
    threadId: string;
    operationId: string;
    artifactId: string;
  }) {
    const lease = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const artifact = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        if (!(yield* ownsArtifact(input)))
          return yield* fail("Recovery artifact is not pinned for this operation.");
        return yield* catalog.pin({
          artifactId: input.artifactId,
          threadId: input.threadId,
          operationId: lease,
          leaseMinutes: 60,
        });
      }),
    );
    yield* objects.verify({
      key: artifact.storageKey,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    });
    return (yield* objects.read(artifact.storageKey)).pipe(
      Stream.interruptWhen(Effect.sleep("55 minutes")),
      Stream.ensuring(
        catalog
          .releasePin({ artifactId: input.artifactId, operationId: lease })
          .pipe(Effect.ignore),
      ),
    );
  });
  return { inspect, retain, verify, release, ownsArtifact, openForOperation };
}
