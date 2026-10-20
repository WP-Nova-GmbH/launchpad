import { OrchestrationEvent, type PortableThreadCommand } from "@t3tools/contracts";
import { RelayApi, RelayClientPrincipal } from "@t3tools/contracts/relay";
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
      const entry = yield* makeThreadJournalStore(sql).stage({
        threadId,
        command: withoutAuthor,
        actor: {
          userId,
          displayName: profile?.displayName ?? null,
          imageUrl: profile?.imageUrl ?? null,
        },
      });
      if (!entry) return yield* relayInternalErrorResponse("persistence_failed");
      if (
        command.type === "thread.move.cancel" &&
        placement.operationId !== null &&
        entry.receipt === null
      ) {
        const store = makeThreadPlacementStore(sql);
        const move = yield* store.getMove({ threadId, operationId: placement.operationId });
        if (["preparing", "frozen", "ready"].includes(move.phase)) {
          const [latest] = yield* sql<{
            event: unknown;
          }>`SELECT event_json AS event FROM relay_thread_history
            WHERE thread_id=${threadId} AND event_json->>'type'='thread.prompt-queue-changed'
              AND (event_json->'payload'->'entry'->>'messageId'=${command.messageId}
                OR event_json->'payload'->>'removedMessageId'=${command.messageId}) ORDER BY cursor DESC LIMIT 1`;
          if (latest) {
            const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)(latest.event);
            if (event.type === "thread.prompt-queue-changed") {
              const head = event.payload.entry;
              if (
                head?.kind === "move" &&
                head.operationId === move.operationId &&
                head.revision === command.expectedRevision &&
                event.payload.removedMessageId !== command.messageId
              )
                yield* store.requestAbort({ threadId, operationId: move.operationId });
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
