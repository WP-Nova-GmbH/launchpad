import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { BootEvidence, SetupProcessAdapter, SetupProcessError } from "./SetupProcessAdapter.ts";
export { SetupProcessError } from "./SetupProcessAdapter.ts";

// Attempt IDs are durable, globally unique commands: a recreated thread gets a new owner.
type Attempt = { readonly threadId: string; readonly attemptId: string };
type Cleanup = Attempt & { readonly commandId: string };
const Record = Schema.Struct({
  threadId: Schema.String,
  attemptId: Schema.String,
  terminalId: Schema.String,
  createdAt: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  identity: Schema.NullOr(Schema.String),
  completed: Schema.Boolean,
  exited: Schema.Boolean,
  legacy: Schema.Boolean,
  ownershipVersion: Schema.optional(Schema.Literal(4)),
  boot: Schema.optional(Schema.NullOr(BootEvidence)),
  evidence: Schema.optional(
    Schema.Struct({
      protocol: Schema.Literal(4),
      source: Schema.Literals(["native", "host-restart", "not-delivered"]),
    }),
  ),
});
export type SetupProcessOwner = typeof Record.Type;
export type SetupCleanupReceipt = Pick<
  SetupProcessOwner,
  "threadId" | "attemptId" | "terminalId" | "pid" | "identity"
> & {
  readonly source: "native" | "host-restart" | "not-delivered";
};
const receipt = (record: SetupProcessOwner): SetupCleanupReceipt => ({
  threadId: record.threadId,
  attemptId: record.attemptId,
  terminalId: record.terminalId,
  pid: record.pid,
  identity: record.identity,
  source: record.evidence!.source,
});
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const decode = Schema.decodeEffect(Schema.fromJsonString(Record));
const encode = Schema.encodeSync(Schema.fromJsonString(Record));
const recoveryDetail = (boot: typeof BootEvidence.Type | null) =>
  boot
    ? "Setup cleanup could not be confirmed. Restart the executor host, then retry cleanup."
    : "Setup cleanup could not be confirmed. Automatic host-restart recovery is unavailable on this host; retain this workspace until setup ownership can be recovered.";
const unavailable = () =>
  new SetupProcessError({
    message: "Setup cleanup evidence is unavailable. Update the environment.",
  });

export interface SetupProcessJournalShape {
  readonly owners: (
    threadId: string,
    terminalId?: string,
  ) => Effect.Effect<ReadonlyArray<SetupProcessOwner>, SetupProcessError>;
  readonly launcher: Effect.Effect<string, SetupProcessError>;
  readonly confirmed: (input: Attempt) => Effect.Effect<boolean, SetupProcessError>;
  readonly begin: (
    input: Attempt & { readonly terminalId: string },
  ) => Effect.Effect<void, SetupProcessError>;
  readonly capture: (
    input: Attempt & { readonly pid: number },
  ) => Effect.Effect<string, SetupProcessError>;
  readonly complete: (input: Attempt) => Effect.Effect<void, SetupProcessError>;
  readonly cleanup: (input: Cleanup) => Effect.Effect<SetupCleanupReceipt, SetupProcessError>;
  readonly recover: (input: Attempt) => Effect.Effect<SetupCleanupReceipt, SetupProcessError>;
}
export class SetupProcessJournal extends Context.Reference<SetupProcessJournalShape>(
  "t3/terminal/SetupProcessJournal",
  {
    defaultValue: () => ({
      owners: () => Effect.succeed([]),
      launcher: Effect.fail(unavailable()),
      confirmed: () => Effect.fail(unavailable()),
      begin: () => Effect.fail(unavailable()),
      capture: () => Effect.fail(unavailable()),
      complete: () => Effect.fail(unavailable()),
      cleanup: () => Effect.fail(unavailable()),
      recover: () => Effect.fail(unavailable()),
    }),
  },
) {}

export const layer = Layer.effect(
  SetupProcessJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const processes = yield* SetupProcessAdapter;
    const locks = new Map<string, Semaphore.Semaphore>();
    const get = (input: Attempt) =>
      sql<{ record_json: string }>`
    SELECT record_json FROM setup_processes WHERE thread_id = ${input.threadId}
    AND attempt_id = ${input.attemptId}
  `.pipe(
        Effect.flatMap((rows) => (rows[0] ? decode(rows[0].record_json) : Effect.succeed(null))),
        Effect.mapError((error) => new SetupProcessError({ message: error.message })),
      );
    const save = (record: typeof Record.Type) =>
      sql`
    INSERT INTO setup_processes (thread_id, attempt_id, record_json)
    VALUES (${record.threadId}, ${record.attemptId}, ${encode(record)})
    ON CONFLICT(thread_id, attempt_id) DO UPDATE SET record_json = excluded.record_json
  `.pipe(
        Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        Effect.asVoid,
      );
    const locked = <A, E>(input: Attempt, effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const key = encodeKey([input.threadId, input.attemptId]);
        let lock = locks.get(key);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return yield* lock.withPermit(effect);
      });
    const stop = Effect.fn("SetupProcessJournal.stop")(function* (input: Attempt) {
      let record = yield* get(input);
      if (!record) {
        const accepted = yield* sql<{
          accepted_at: string;
        }>`SELECT accepted_at FROM orchestration_command_receipts
        WHERE command_id = ${input.attemptId} AND aggregate_id = ${input.threadId}`.pipe(
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        );
        record = {
          ...input,
          terminalId: "setup-" + input.attemptId,
          createdAt: accepted[0]?.accepted_at ?? DateTime.formatIso(DateTime.nowUnsafe()),
          pid: null,
          identity: null,
          completed: false,
          exited: false,
          legacy: true,
        };
        yield* save(record);
      }
      if (record.evidence) return receipt(record);
      let source: "native" | "host-restart" | "not-delivered";
      const currentBoot = yield* processes.host;
      if (
        record.boot &&
        currentBoot &&
        record.boot.host === currentBoot.host &&
        record.boot.session !== currentBoot.session
      ) {
        source = "host-restart";
      } else if (!record.legacy && record.pid === null && record.identity === null) {
        // Durable intent precedes capture-before-write; setup was never delivered.
        source = "not-delivered";
      } else if (record.ownershipVersion === 4 && record.pid !== null && record.identity !== null) {
        if (!record.boot && currentBoot) {
          record = { ...record, boot: currentBoot };
          yield* save(record);
        }
        const recovery = recoveryDetail(record.boot ?? null);
        yield* processes
          .stop(record.pid!, record.identity!)
          .pipe(
            Effect.mapError(
              (error) => new SetupProcessError({ message: error.message + " " + recovery }),
            ),
          );
        source = "native";
      } else {
        // A legacy record needs a saved same-host baseline and a subsequent boot change.
        if (!record.boot && currentBoot) {
          record = { ...record, boot: currentBoot };
          yield* save(record);
        }
        return yield* new SetupProcessError({ message: recoveryDetail(record.boot ?? null) });
      }
      // Save proof before terminal callbacks or cleanup done can authorize release.
      const confirmed = { ...record, exited: true, evidence: { protocol: 4 as const, source } };
      yield* save(confirmed);
      return receipt(confirmed);
    });
    const cleanupAttempt = (input: Cleanup) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ state: string; detail: string | null }>`
        SELECT state, detail FROM setup_process_cleanup WHERE thread_id = ${input.threadId}
        AND attempt_id = ${input.attemptId} AND command_id = ${input.commandId}
      `.pipe(Effect.mapError((error) => new SetupProcessError({ message: error.message })));
        const saved = yield* get(input);
        if (rows[0]?.state === "done" && saved?.evidence) return receipt(saved);
        if (rows[0]?.state === "failed")
          return yield* new SetupProcessError({ message: rows[0].detail! });
        yield* sql`INSERT INTO setup_process_cleanup (thread_id, attempt_id, command_id, state)
        VALUES (${input.threadId}, ${input.attemptId}, ${input.commandId}, 'pending')
        ON CONFLICT DO NOTHING`.pipe(
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        );
        const result = yield* stop(input).pipe(Effect.result);
        const detail = result._tag === "Failure" ? result.failure.message : null;
        yield* sql`UPDATE setup_process_cleanup SET state = ${detail ? "failed" : "done"}, detail = ${detail}
        WHERE thread_id = ${input.threadId} AND attempt_id = ${input.attemptId}
        AND command_id = ${input.commandId}`.pipe(
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        );
        if (result._tag === "Failure") return yield* result.failure;
        return result.success;
      });
    return {
      owners: (threadId, terminalId) =>
        sql<{
          record_json: string;
        }>`SELECT record_json FROM setup_processes WHERE thread_id = ${threadId}`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.record_json))),
          Effect.map((owners) =>
            owners.filter((owner) => terminalId === undefined || owner.terminalId === terminalId),
          ),
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        ),
      launcher: processes.launcher,
      confirmed: (input) => get(input).pipe(Effect.map((record) => !!record?.evidence)),
      begin: (input) =>
        locked(
          input,
          Effect.gen(function* () {
            if (yield* get(input))
              return yield* new SetupProcessError({
                message: "Setup attempt already owns a terminal; it cannot be relaunched.",
              });
            yield* save({
              ...input,
              createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
              pid: null,
              identity: null,
              completed: false,
              exited: false,
              legacy: false,
              boot: yield* processes.host,
            });
          }),
        ),
      capture: (input) =>
        locked(
          input,
          Effect.gen(function* () {
            const record = yield* get(input);
            if (!record || record.exited || record.pid !== null) return yield* unavailable();
            const inspected = yield* processes.inspect(input.pid);
            if (!inspected.identity || !inspected.owned)
              return yield* new SetupProcessError({
                message: "Setup terminal exited before its identity could be saved.",
              });
            yield* save({
              ...record,
              pid: input.pid,
              identity: inspected.identity,
              ownershipVersion: 4,
              boot: inspected.boot,
            });
            return yield* processes.arm(input.pid, inspected.identity);
          }),
        ),
      complete: (input) =>
        locked(
          input,
          Effect.gen(function* () {
            const record = yield* get(input);
            if (record) yield* save({ ...record, completed: true });
          }),
        ),
      cleanup: (input) => locked(input, cleanupAttempt(input)),
      recover: (input) =>
        locked(
          input,
          Effect.gen(function* () {
            const saved = yield* get(input);
            if (saved?.evidence) return receipt(saved);
            const latest = yield* sql<{
              commandId: string;
            }>`SELECT command_id AS "commandId" FROM setup_process_cleanup
              WHERE thread_id = ${input.threadId} AND attempt_id = ${input.attemptId} ORDER BY rowid DESC LIMIT 1`.pipe(
              Effect.mapError((error) => new SetupProcessError({ message: error.message })),
            );
            return yield* cleanupAttempt({
              ...input,
              commandId:
                latest[0]?.commandId ??
                `setup-recovery:${encodeKey([input.threadId, input.attemptId])}`,
            });
          }),
        ),
    };
  }),
);
