import {
  CommandId,
  OrchestrationEvent,
  ThreadId,
  type PortableThreadCommand,
} from "@t3tools/contracts";
import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict } from "./tenancyErrors.ts";
import { makeThreadCurrentQueueStore } from "../threads/ThreadCurrentQueueStore.ts";
import { threadMoveClientStatus } from "../threads/ThreadMoveClientStatus.ts";

const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

type CancelMoveIdentity = {
  readonly threadId: string;
  readonly operationId: string;
  readonly sourceGeneration: number;
};

const cancellationFailures = {
  ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  ThreadVmResumeConflict: () => tenancyConflict("thread_placement_changed"),
  ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
};

export const cancelPortableThreadMove = Effect.fn("relay.api.thread_commands.cancel_move")(
  function* (input: CancelMoveIdentity) {
    const sql = (yield* RelayDb).$client;
    const store = makeThreadPlacementStore(sql);
    return yield* withPrivateThreadAccess(input.threadId, "write", (placement) =>
      Effect.gen(function* () {
        const move = yield* store.getMove(input);
        if (move.expectedGeneration !== input.sourceGeneration)
          return yield* tenancyConflict("thread_placement_changed");
        let retryLegacy = false;
        if (move.phase === "aborting" || move.phase === "aborted") {
          const status = yield* threadMoveClientStatus(sql, move);
          retryLegacy = status.cancellationBlocker === "legacy_cancel_rejected";
          if (!retryLegacy) return status;
        }
        if (
          placement.generation !== input.sourceGeneration ||
          placement.environmentId !== move.sourceEnvironmentId ||
          (retryLegacy
            ? placement.operationId !== null
            : placement.operationId !== input.operationId ||
              !["preparing", "frozen", "ready"].includes(move.phase))
        )
          return yield* tenancyConflict("thread_placement_changed");
        if (move.cancellationProtocol === "available")
          return yield* threadMoveClientStatus(sql, yield* store.requestAbort(input));

        // Older workers need their existing revision-based inbox command to
        // mark the queue row cancelling after cleanup. Pick the exact row from
        // the authoritative queue under this same placement lock.
        const { queue } = yield* makeThreadCurrentQueueStore(sql).read(input.threadId);
        const head = queue.entries[0];
        if (
          head?.kind !== "move" ||
          head.operationId !== input.operationId ||
          head.state === "pending"
        )
          return yield* tenancyConflict("thread_placement_changed");
        const commandId = CommandId.make(
          yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
            Effect.catch(() => relayInternalErrorResponse("persistence_failed")),
          ),
        );
        if (retryLegacy) {
          // Persist the exact retry before admission so a paused source can wake.
          yield* sql`UPDATE relay_thread_moves SET legacy_cancel_command_id=${commandId}
            WHERE thread_id=${input.threadId} AND operation_id=${input.operationId}`;
        }
        const entry = yield* makeThreadJournalStore(sql).stage({
          threadId: input.threadId,
          actor: { userId: placement.ownerUserId, displayName: null, imageUrl: null },
          command: {
            type: "thread.move.cancel",
            commandId,
            threadId: ThreadId.make(input.threadId),
            messageId: head.messageId,
            expectedRevision: head.revision,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          },
        });
        if (!entry || entry.receipt !== null)
          return yield* relayInternalErrorResponse("persistence_failed");
        if (retryLegacy) return yield* threadMoveClientStatus(sql, yield* store.getMove(input));
        return yield* threadMoveClientStatus(
          sql,
          yield* store.requestAbort({ ...input, legacyCancelCommandId: commandId }),
        );
      }),
    );
  },
  Effect.catchTags(cancellationFailures),
);

export const getPortableThreadMoveCancellation = Effect.fn(
  "relay.api.thread_commands.move_cancellation",
)(
  function* (input: CancelMoveIdentity) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(input.threadId, "read", () =>
      Effect.gen(function* () {
        const move = yield* makeThreadPlacementStore(sql).getMove(input);
        if (move.expectedGeneration !== input.sourceGeneration)
          return yield* tenancyConflict("thread_placement_changed");
        return yield* threadMoveClientStatus(sql, move);
      }),
    );
  },
  Effect.catchTag("ThreadPlacementConflict", cancellationFailures.ThreadPlacementConflict),
);

export const stagePortableThreadCommand = Effect.fn("relay.api.thread_commands.stage")(function* (
  threadId: string,
  command: PortableThreadCommand,
) {
  const { userId } = yield* RelayClientPrincipal;
  const directory = yield* UserDirectory;
  const sql = (yield* RelayDb).$client;
  // Resolve display fields outside the policy transaction. Identity always comes from auth.
  const profile = (yield* directory.lookup({ userIds: [userId] })).get(userId);
  return yield* withPrivateThreadAccess(threadId, "write", (placement) =>
    Effect.gen(function* () {
      const withoutAuthor =
        "author" in command ? (({ author: _untrusted, ...payload }) => payload)(command) : command;
      const journal = makeThreadJournalStore(sql);
      let entry = yield* journal.stage({
        threadId,
        command: withoutAuthor,
        actor: {
          userId,
          displayName: profile?.displayName ?? null,
          imageUrl: profile?.imageUrl ?? null,
        },
      });
      if (!entry) return yield* relayInternalErrorResponse("persistence_failed");
      if (command.type === "thread.move.cancel" && entry.receipt === null) {
        const store = makeThreadPlacementStore(sql);
        // Relay activation can clear the placement before the destination has
        // removed the imported move row. That row is already past cancellation.
        const [completed] =
          placement.operationId === null && placement.generation > 1
            ? yield* sql<{ operationId: string }>`SELECT operation_id AS "operationId"
              FROM relay_thread_moves WHERE thread_id=${threadId} AND phase='completed'
                AND destination_environment_id=${placement.environmentId}
                AND expected_generation=${placement.generation - 1} LIMIT 1`
            : [];
        const operationId = placement.operationId ?? completed?.operationId;
        const move = operationId ? yield* store.findMove({ threadId, operationId }) : null;
        const alreadyCancellingDirect =
          move?.cancellationProtocol === "source-reopen-v1" &&
          (move.phase === "aborting" || move.phase === "aborted");
        const committed = move?.phase === "committed" || move?.phase === "completed";
        if (
          move &&
          (committed ||
            alreadyCancellingDirect ||
            ["preparing", "frozen", "ready"].includes(move.phase))
        ) {
          const [latest] = yield* sql<{
            event: unknown;
          }>`SELECT event_json AS event FROM relay_thread_history
            WHERE thread_id=${threadId} AND environment_id=${move.sourceEnvironmentId}
              AND event_json->>'type'='thread.prompt-queue-changed'
              AND (event_json->'payload'->'entry'->>'messageId'=${command.messageId}
                OR event_json->'payload'->>'removedMessageId'=${command.messageId}) ORDER BY cursor DESC LIMIT 1`;
          const event = latest ? yield* decodeOrchestrationEvent(latest.event) : null;
          const candidate =
            event?.type === "thread.prompt-queue-changed" &&
            event.payload.removedMessageId !== command.messageId
              ? event.payload.entry
              : undefined;
          const direct = alreadyCancellingDirect || move.cancellationProtocol === "available";
          const exactSourceMessage = move.sourceMessageId === command.messageId;
          const exactQueueEntry =
            candidate?.kind === "move" && candidate.revision === command.expectedRevision;
          const activeQueueEntry = exactQueueEntry && candidate.operationId === move.operationId;
          if (committed) {
            if (
              exactSourceMessage ||
              (candidate?.kind === "move" && candidate.operationId === move.operationId)
            )
              return yield* tenancyConflict("thread_command_conflict");
            return { commandId: entry.commandId, position: entry.position, receipt: entry.receipt };
          }
          const exactActive = (direct && exactSourceMessage) || activeQueueEntry;
          // A distinct pending entry can still be cancelled when the inbox reopens.
          if (!exactActive && !(exactQueueEntry && candidate.state === "pending"))
            return yield* tenancyConflict("thread_command_conflict");
          if (exactActive) {
            if (!alreadyCancellingDirect)
              yield* store.requestAbort({
                threadId,
                operationId: move.operationId,
                legacyCancelCommandId: command.commandId,
              });
            if (direct) {
              entry = yield* journal.acceptMoveCancellationRequest({
                threadId,
                environmentId: placement.environmentId,
                generation: placement.generation,
                commandId: command.commandId,
                operationId: move.operationId,
              });
              if (!entry?.receipt) return yield* relayInternalErrorResponse("persistence_failed");
            }
          }
        }
      }
      return { commandId: entry.commandId, position: entry.position, receipt: entry.receipt };
    }),
  ).pipe(
    Effect.catchTags({
      ThreadPlacementConflict: () => tenancyConflict("thread_command_conflict"),
      SchemaError: () => tenancyConflict("thread_command_conflict"),
      ThreadVmResumeConflict: () => tenancyConflict("thread_command_conflict"),
      ThreadVmCapacityConflict: () => tenancyConflict("thread_command_conflict"),
    }),
  );
});
export const getPortableThreadCommandReceipt = Effect.fn("relay.api.thread_commands.receipt")(
  function* (threadId: string, commandId: string) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(threadId, "read", () =>
      makeThreadJournalStore(sql).command(threadId, commandId),
    ).pipe(
      Effect.map((entry) =>
        entry
          ? { commandId: entry.commandId, position: entry.position, receipt: entry.receipt }
          : null,
      ),
    );
  },
);
export const getPendingPortableThreadCommands = Effect.fn("relay.api.thread_commands.pending")(
  function* (threadId: string, after: number, limit: number) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(threadId, "read", () =>
      makeThreadJournalStore(sql).pending(threadId, after, limit),
    ).pipe(
      Effect.catchTag("ThreadPlacementConflict", () => tenancyConflict("thread_command_conflict")),
    );
  },
);

export const threadCommandsApi = HttpApiBuilder.group(RelayApi, "threadCommands", (handlers) =>
  handlers
    .handle("cancelMove", ({ params, payload }) =>
      cancelPortableThreadMove({ ...params, ...payload }),
    )
    .handle("getMoveCancellation", ({ params, query }) =>
      getPortableThreadMoveCancellation({ ...params, ...query }),
    )
    .handle("stage", ({ params, payload }) =>
      stagePortableThreadCommand(params.threadId, payload.command),
    )
    .handle("pending", ({ params, query }) =>
      getPendingPortableThreadCommands(params.threadId, query.after, query.limit),
    )
    .handle("receipt", ({ params }) =>
      getPortableThreadCommandReceipt(params.threadId, params.commandId),
    ),
);
