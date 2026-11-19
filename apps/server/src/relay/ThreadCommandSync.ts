import { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import {
  CommandId,
  ThreadId,
  ProjectId,
  OrchestrationCommand,
  PortableThreadCommand,
  type ClientOrchestrationCommand,
  type OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import { RelayThreadInboxEntry, RelayThreadPersistedReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { stampCommandAuthor } from "../auth/RepositoryAccess.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import type { makeThreadExecutionRelay } from "./ThreadExecutionRelay.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";

export class ThreadCommandSyncError extends Schema.TaggedError<ThreadCommandSyncError>()(
  "ThreadCommandSyncError",
  { threadId: Schema.String, detail: Schema.String },
) {}
export interface ThreadCommandTransport {
  readonly next: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<RelayThreadInboxEntry | null, ThreadCommandSyncError>;
  readonly acknowledge: (
    owner: ThreadHistoryOwner,
    commandId: string,
    receipt: RelayThreadPersistedReceipt,
    commandReceipt?: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, ThreadCommandSyncError>;
}
const entryJson = Schema.fromJsonString(RelayThreadInboxEntry);
const commandJson = Schema.fromJsonString(OrchestrationCommand);
const receiptJson = Schema.fromJsonString(RelayThreadPersistedReceipt);
const encodeEntry = Schema.encodeEffect(entryJson);
const decodeEntry = Schema.decodeEffect(entryJson);
const encodeCommand = Schema.encodeEffect(commandJson);
const decodeCommand = Schema.decodeEffect(commandJson);
const encodeReceipt = Schema.encodeEffect(receiptJson);
const decodeReceipt = Schema.decodeEffect(receiptJson);
const decodePortableCommand = Schema.decodeUnknownEffect(PortableThreadCommand);
interface Delivery {
  readonly commandId: string;
  readonly generation: number;
  readonly entryJson: string;
  readonly normalizedJson: string | null;
  readonly receiptJson: string | null;
}

/** Local delivery intent precedes normalization; only durable receipts may settle the remote inbox. */
export function makeThreadCommandSync(
  sql: SqlClient.SqlClient,
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  receipts: Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">,
  execution: ReturnType<typeof makeThreadExecutionRelay>,
  transport: ThreadCommandTransport,
  normalize: (
    command: ClientOrchestrationCommand,
    authenticatedUserId?: string,
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError>,
) {
  const fences = makeThreadExecutionFence(sql);
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const fail = (threadId: string, detail: string) =>
    new ThreadCommandSyncError({ threadId, detail });
  const pending = Effect.fnUntraced(function* (owner: ThreadHistoryOwner) {
    const [row] = yield* sql<Delivery>`SELECT command_id AS "commandId", generation,
      entry_json AS "entryJson", normalized_json AS "normalizedJson", receipt_json AS "receiptJson"
      FROM thread_relay_command_deliveries WHERE thread_id = ${owner.threadId}
      AND generation = ${owner.generation} AND settled = 0 ORDER BY position LIMIT 1`;
    return row ?? null;
  });
  const saveReceipt = Effect.fnUntraced(function* (
    commandId: string,
    receipt: RelayThreadPersistedReceipt,
  ) {
    const json = yield* encodeReceipt(receipt);
    yield* sql`UPDATE thread_relay_command_deliveries SET receipt_json = ${json} WHERE command_id = ${commandId}`;
    return receipt;
  });
  const deliver = Effect.fn("ThreadCommandSync.deliver")(function* (threadId: string) {
    const owner = yield* fences.get(threadId);
    if (!owner || owner.phase === "retired" || owner.phase === "frozen") return false;
    let delivery = yield* pending(owner);
    if (!delivery) {
      if (owner.phase !== "active") return false;
      const entry = yield* transport.next(owner);
      if (!entry) return false;
      const command = yield* decodePortableCommand(entry.command);
      if (
        entry.threadId !== threadId ||
        command.threadId !== threadId ||
        command.commandId !== entry.commandId ||
        entry.receipt !== null ||
        entry.acceptedGeneration > owner.generation
      )
        return yield* fail(threadId, "The relay returned an invalid command identity.");
      const encoded = yield* encodeEntry(entry);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const latest = yield* fences.get(threadId);
          if (!latest || latest.generation !== owner.generation || latest.phase !== "active")
            return yield* fail(threadId, "Thread ownership changed before command delivery.");
          const [prior] = yield* sql<Delivery>`SELECT command_id AS "commandId", generation,
          entry_json AS "entryJson", normalized_json AS "normalizedJson", receipt_json AS "receiptJson"
          FROM thread_relay_command_deliveries WHERE command_id = ${entry.commandId}`;
          if (prior) {
            if (prior.generation !== owner.generation || prior.entryJson !== encoded)
              return yield* fail(threadId, "Command delivery identity was reused.");
            return;
          }
          // An old local receipt cannot prove that a newly delivered relay command ran.
          const collision = yield* receipts.getByCommandId({
            commandId: CommandId.make(entry.commandId),
          });
          yield* sql`INSERT INTO thread_relay_command_deliveries (command_id, thread_id, generation, position, entry_json)
          VALUES (${entry.commandId}, ${threadId}, ${owner.generation}, ${entry.position}, ${encoded})`;
          if (Option.isSome(collision))
            yield* saveReceipt(entry.commandId, {
              status: "rejected",
              detail: "Command ID was already used before relay delivery.",
            });
          if ("bootstrap" in command && command.bootstrap !== undefined)
            yield* saveReceipt(entry.commandId, {
              status: "rejected",
              detail:
                "Portable threads use their existing checkout. Create or move the thread before sending this command.",
            });
        }),
      );
      delivery = yield* pending(owner);
    }
    if (!delivery) return false;
    const entry = yield* decodeEntry(delivery.entryJson);
    const work = {
      threadId,
      kind: "workspace" as const,
      expectedGeneration: owner.generation,
      workId: `inbox:${owner.generation}:${delivery.commandId}`,
    };
    let receipt = delivery.receiptJson === null ? null : yield* decodeReceipt(delivery.receiptJson);
    if (receipt === null) {
      const decision = yield* execution.begin(work);
      if (decision === "ordinary" || decision === "completed")
        return yield* fail(threadId, "Command work ended without its durable receipt.");
      // This reservation covers bounded normalization and event persistence, never
      // a tool process. After restart, a saved normalized command is safe to submit
      // again: the engine's receipt transaction deduplicates the command identity.
      let command: OrchestrationCommand | null = null;
      if (delivery.normalizedJson === null) {
        const result = yield* normalize(entry.command, entry.actor.userId).pipe(Effect.result);
        if (result._tag === "Failure") {
          // A declared validation failure precedes engine dispatch. Retire it
          // durably so an expired personal grant cannot block the whole inbox.
          receipt = yield* saveReceipt(delivery.commandId, {
            status: "rejected",
            detail: result.failure.message,
          });
        } else {
          command = stampCommandAuthor(result.success, { user: entry.actor });
          if (
            !("threadId" in command) ||
            command.threadId !== threadId ||
            command.commandId !== delivery.commandId
          )
            return yield* fail(threadId, "Normalized command crossed the delivery boundary.");
          const normalized = yield* encodeCommand(command);
          yield* sql`UPDATE thread_relay_command_deliveries SET normalized_json = ${normalized} WHERE command_id = ${delivery.commandId}`;
        }
      } else command = yield* decodeCommand(delivery.normalizedJson);
      // A failure may still have persisted a rejected receipt. Never infer rejection
      // from a transient exception or an interrupted dispatch.
      if (command !== null) {
        yield* engine.dispatch(command).pipe(Effect.result);
        const persisted = yield* receipts.getByCommandId({
          commandId: CommandId.make(delivery.commandId),
        });
        if (Option.isNone(persisted))
          return yield* fail(threadId, "Command is waiting for a persisted execution receipt.");
        if (persisted.value.aggregateKind !== "thread" || persisted.value.aggregateId !== threadId)
          return yield* fail(threadId, "Command receipt belongs to another thread.");
        receipt = yield* saveReceipt(
          delivery.commandId,
          persisted.value.status === "accepted"
            ? { status: "accepted", sequence: persisted.value.resultSequence }
            : {
                status: "rejected",
                ...(persisted.value.error === null ? {} : { detail: persisted.value.error }),
              },
        );
      }
    }
    if (receipt === null) return yield* fail(threadId, "Command has no durable delivery receipt.");
    const persisted = yield* receipts.getByCommandId({
      commandId: CommandId.make(delivery.commandId),
    });
    const saved =
      Option.isSome(persisted) &&
      persisted.value.aggregateKind === "thread" &&
      persisted.value.aggregateId === threadId &&
      persisted.value.status === receipt.status &&
      (receipt.status === "accepted"
        ? persisted.value.resultSequence === receipt.sequence
        : persisted.value.error === (receipt.detail ?? null))
        ? persisted.value
        : undefined;
    // A pre-dispatch rejection has no engine receipt. Its immutable relay
    // admission timestamp supplies a stable deduplication receipt on every retry.
    const commandReceipt =
      saved ??
      (receipt.status === "rejected" && entry.acceptedAt !== undefined
        ? {
            commandId: CommandId.make(delivery.commandId),
            aggregateKind: "thread" as const,
            aggregateId: ThreadId.make(owner.threadId),
            projectId: ProjectId.make(owner.projectId),
            acceptedAt: entry.acceptedAt,
            resultSequence: 0,
            status: "rejected" as const,
            error: receipt.detail ?? null,
          }
        : undefined);
    yield* transport.acknowledge(owner, delivery.commandId, receipt, commandReceipt);
    const reservation = yield* fences.getWork({
      ...work,
      workId: `workspace:${work.workId}`,
      generation: owner.generation,
    });
    if (reservation) yield* execution.confirmStopped(work);
    yield* sql`UPDATE thread_relay_command_deliveries SET settled = 1 WHERE command_id = ${delivery.commandId}`;
    return true;
  });
  const synchronize = (threadId: string) =>
    Effect.suspend(() => {
      const lock = locks.get(threadId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(threadId, lock);
      lock.users++;
      return lock.semaphore
        .withPermit(
          Effect.gen(function* () {
            // Bound a pass so a busy inbox does not starve lifecycle reconciliation.
            for (let count = 0; count < 20; count++) if (!(yield* deliver(threadId))) return;
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.users--;
              if (lock.users === 0) locks.delete(threadId);
            }),
          ),
        );
    });
  return { synchronize };
}
