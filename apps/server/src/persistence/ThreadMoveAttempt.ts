import { ThreadMoveProgressReport, type RelayThreadMove } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const rowSchema = Schema.Struct({
  threadId: Schema.String,
  relayUrl: Schema.String,
  attempt: counter,
  revision: counter,
  acknowledgedRevision: counter,
  ended: Schema.Literals([0, 1]),
  report: Schema.NullOr(Schema.fromJsonString(ThreadMoveProgressReport)),
});
const decodeRow = Schema.decodeUnknownEffect(rowSchema);
const encodeReport = Schema.encodeSync(Schema.fromJsonString(ThreadMoveProgressReport));
type Owner = {
  operationId: string;
  threadId: string;
  environmentId: string;
  generation: number;
  relayUrl: string;
};
type Move = Pick<RelayThreadMove, "progress" | "participantStates"> & {
  operationId: string;
  threadId: string;
};

export class ThreadMoveAttemptError extends Schema.TaggedError<ThreadMoveAttemptError>()(
  "ThreadMoveAttemptError",
  { message: Schema.String },
) {}
const changed = () => new ThreadMoveAttemptError({ message: "This move's retry journal changed." });
const nextCounter = (value: number) =>
  Schema.decodeUnknownEffect(counter)(value + 1).pipe(Effect.mapError(changed));

/** Allocate before sending: a lost progress/failure request must not reuse an attempt after restart. */
export function makeThreadMoveAttemptJournal(sql: SqlClient.SqlClient) {
  const read = Effect.fnUntraced(function* (owner: Owner) {
    const [raw] =
      yield* sql`SELECT thread_id AS "threadId",relay_url AS "relayUrl",attempt,revision,
      acknowledged_revision AS "acknowledgedRevision",ended,report_json AS report FROM thread_move_attempts
      WHERE operation_id=${owner.operationId} AND environment_id=${owner.environmentId} AND generation=${owner.generation}`;
    if (!raw) return null;
    const row = yield* decodeRow(raw).pipe(Effect.mapError(changed));
    if (row.threadId !== owner.threadId || row.relayUrl !== owner.relayUrl) return yield* changed();
    if (
      row.report
        ? row.report.attempt !== row.attempt || row.report.revision !== row.revision
        : row.revision !== 0
    )
      return yield* changed();
    return row;
  });
  const begin = Effect.fnUntraced(function* (
    owner: Owner,
    move: Move,
    options: { resumeWaiting?: boolean } = {},
  ) {
    if (move.operationId !== owner.operationId || move.threadId !== owner.threadId)
      return yield* changed();
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* read(owner);
        const progress = move.progress?.find(
          (report) =>
            report.operationId === owner.operationId &&
            report.threadId === owner.threadId &&
            report.environmentId === owner.environmentId &&
            report.generation === owner.generation,
        );
        const state = move.participantStates?.find(
          (participant) =>
            participant.environmentId === owner.environmentId &&
            participant.generation === owner.generation,
        );
        const highest = Math.max(
          prior?.attempt ?? 0,
          progress?.attempt ?? 0,
          state?.failure?.attempt ?? 0,
          state?.resolvedBeforeAttempt ?? 0,
        );
        if (
          options.resumeWaiting &&
          prior &&
          prior.ended === 0 &&
          prior.report?.waitingForAuth != null &&
          prior.attempt === highest &&
          (state?.failure?.attempt ?? 0) < prior.attempt
        )
          return prior;
        const attempt = yield* nextCounter(highest);
        yield* sql`INSERT INTO thread_move_attempts
          (operation_id,thread_id,relay_url,environment_id,generation,attempt)
          VALUES(${owner.operationId},${owner.threadId},${owner.relayUrl},${owner.environmentId},${owner.generation},${attempt})
          ON CONFLICT(operation_id,environment_id,generation) DO UPDATE SET attempt=excluded.attempt,
            revision=0,acknowledged_revision=0,ended=0,report_json=NULL`;
        return (yield* read(owner))!;
      }),
    );
    const attempt = row.attempt;
    return {
      attempt,
      report: row.report,
      acknowledgedRevision: row.acknowledgedRevision,
      save: Effect.fnUntraced(function* (
        body: Omit<ThreadMoveProgressReport, "attempt" | "revision">,
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const latest = yield* read(owner);
            if (!latest || latest.attempt !== attempt || latest.ended !== 0)
              return yield* changed();
            const report = { ...body, attempt, revision: yield* nextCounter(latest.revision) };
            yield* sql`UPDATE thread_move_attempts SET revision=${report.revision},report_json=${encodeReport(report)}
              WHERE operation_id=${owner.operationId} AND environment_id=${owner.environmentId}
                AND generation=${owner.generation} AND attempt=${attempt}`;
            return report;
          }),
        );
      }),
      acknowledge: (revision: number) =>
        sql`UPDATE thread_move_attempts SET acknowledged_revision=max(acknowledged_revision,${revision})
          WHERE operation_id=${owner.operationId} AND environment_id=${owner.environmentId}
            AND generation=${owner.generation} AND attempt=${attempt} AND revision>=${revision}`.pipe(
          Effect.asVoid,
        ),
      end: sql`UPDATE thread_move_attempts SET ended=1
        WHERE operation_id=${owner.operationId} AND environment_id=${owner.environmentId}
          AND generation=${owner.generation} AND attempt=${attempt}`.pipe(Effect.asVoid),
    };
  });
  return { begin };
}

export type ThreadMoveAttempt = Effect.Success<
  ReturnType<ReturnType<typeof makeThreadMoveAttemptJournal>["begin"]>
>;
