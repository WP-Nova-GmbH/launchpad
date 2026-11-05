import * as NodeCrypto from "node:crypto";
import { CommandId, ThreadId, ProjectId, IsoDateTime } from "@t3tools/contracts";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import {
  nativeCheckpointCatalogTestLayer,
  nativeCheckpointCatalogFixture,
} from "./testUtils/nativeCheckpointCatalog.ts";
const fixture = Effect.gen(function* () {
  const f = yield* nativeCheckpointCatalogFixture,
    journal = makeThreadJournalStore(f.sql),
    commandId = CommandId.make(NodeCrypto.randomUUID());
  const command = {
    type: "thread.meta.update" as const,
    commandId,
    threadId: ThreadId.make(f.threadId),
    title: "Keep receipt",
  };
  const actor = { userId: "user", displayName: "Stefan", imageUrl: null };
  yield* journal.stage({ threadId: f.threadId, actor, command });
  const owner = { threadId: f.threadId, environmentId: "local", generation: 1 };
  const commandReceipt = {
    commandId,
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.make(f.threadId),
    projectId: ProjectId.make("project"),
    acceptedAt: IsoDateTime.make("2026-10-07T12:00:00.000Z"),
    resultSequence: 7,
    status: "accepted" as const,
    error: null,
  };
  const ack = {
    ...owner,
    commandId,
    receipt: { status: "accepted" as const, sequence: 7 },
    commandReceipt,
  };
  const archived = Effect.gen(function* () {
    const [row] = yield* f.sql<{
      receipt: unknown;
    }>`SELECT archive_receipt_json AS receipt FROM relay_thread_commands WHERE command_id=${commandId}`;
    return row?.receipt;
  });
  return { ...f, journal, command, actor, owner, commandReceipt, ack, archived };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "retained command receipts (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("retains the exact full receipt with an idempotent short acknowledgement", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const acceptedAt = (yield* f.journal.next(f.owner))?.acceptedAt;
            expect(acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
            expect(
              (yield* f.journal.stage({ threadId: f.threadId, actor: f.actor, command: f.command }))
                ?.acceptedAt,
            ).toBe(acceptedAt);
            yield* f.journal.acknowledge(f.ack);
            yield* f.journal.acknowledge(f.ack);
            expect(yield* f.archived).toEqual(f.commandReceipt);
            expect(yield* f.journal.next(f.owner)).toBeNull();
            yield* f.journal.acknowledge({
              ...f.owner,
              commandId: f.ack.commandId,
              receipt: f.ack.receipt,
            });
            expect(yield* f.archived).toEqual(f.commandReceipt);
          }),
        ),
      );
      it.effect(
        "a legacy short receipt may be filled once but its full metadata cannot change",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              yield* f.journal.acknowledge({
                ...f.owner,
                commandId: f.ack.commandId,
                receipt: f.ack.receipt,
              });
              expect(yield* f.archived).toBeNull();
              yield* f.journal.acknowledge(f.ack);
              yield* Effect.flip(
                f.journal.acknowledge({
                  ...f.ack,
                  commandReceipt: {
                    ...f.commandReceipt,
                    acceptedAt: IsoDateTime.make("2026-10-07T13:00:00.000Z"),
                  },
                }),
              );
              expect(yield* f.archived).toEqual(f.commandReceipt);
            }),
          ),
      );
      it.effect(
        "foreign thread, command, result or status never completes or archives a command",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              for (const changed of [
                { ...f.commandReceipt, aggregateId: ThreadId.make(NodeCrypto.randomUUID()) },
                { ...f.commandReceipt, commandId: CommandId.make(NodeCrypto.randomUUID()) },
                { ...f.commandReceipt, resultSequence: 8 },
                { ...f.commandReceipt, status: "rejected" as const, error: "Denied" },
              ])
                yield* Effect.flip(f.journal.acknowledge({ ...f.ack, commandReceipt: changed }));
              expect(yield* f.archived).toBeNull();
              expect((yield* f.journal.next(f.owner))?.commandId).toBe(f.ack.commandId);
            }),
          ),
      );
      it.effect(
        "rejections retain a stable deduplication record and must match the displayed reason",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              const rejected = {
                ...f.commandReceipt,
                status: "rejected" as const,
                error: "Cannot bootstrap here",
                resultSequence: 0,
              };
              yield* Effect.flip(
                f.journal.acknowledge({
                  ...f.ack,
                  receipt: { status: "rejected", detail: "Other reason" },
                  commandReceipt: rejected,
                }),
              );
              yield* f.journal.acknowledge({
                ...f.ack,
                receipt: { status: "rejected", detail: rejected.error },
                commandReceipt: rejected,
              });
              expect(yield* f.archived).toEqual(rejected);
            }),
          ),
      );
      it.effect("an old environment cannot fill archived receipts after the thread moved", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.journal.acknowledge({
              ...f.owner,
              commandId: f.ack.commandId,
              receipt: f.ack.receipt,
            });
            yield* f.sql`UPDATE relay_thread_placements SET environment_id='new',generation=2 WHERE thread_id=${f.threadId}`;
            yield* Effect.flip(f.journal.acknowledge(f.ack));
            expect(yield* f.archived).toBeNull();
          }),
        ),
      );
    });
  },
);
