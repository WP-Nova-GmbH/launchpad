import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  ThreadMoveParticipantState,
  type ThreadMoveFailureDiagnostic,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadMove } from "./ThreadPlacementStore.ts";

const decode = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ ...ThreadMoveParticipantState.fields, progressAttempt: Schema.Number }),
  ),
);
type Participant = {
  operationId: string;
  environmentId: string;
  generation: number;
  attempt: number;
};

export function sourceMoveRetry(move: ThreadMove) {
  const failure = move.moveFailures?.find(
    (failure) =>
      failure.active &&
      failure.requiresRetry &&
      failure.environmentId === move.sourceEnvironmentId &&
      failure.generation === move.expectedGeneration,
  );
  if (!failure) return null;
  const source = move.participantStates?.find(
    (participant) =>
      participant.environmentId === failure.environmentId &&
      participant.generation === failure.generation,
  );
  return {
    attempt: failure.attempt,
    requested: (source?.resolvedBeforeAttempt ?? 0) > failure.attempt,
  };
}

/** Callers serialize reports with the placement lock; rows retain resolved-attempt tombstones. */
export function makeThreadMoveParticipantStatus(sql: PgClient) {
  const project = Effect.fnUntraced(function* (move: ThreadMove) {
    const rows = yield* sql<{ state: unknown }>`SELECT jsonb_build_object(
      'environmentId',s.environment_id,'generation',s.generation,
      'resolvedBeforeAttempt',s.resolved_before_attempt,
      'failure',CASE WHEN s.failure_attempt IS NULL THEN NULL ELSE jsonb_build_object(
        'attempt',s.failure_attempt,'detail',s.failure_detail,
        'reportedAt',to_char(s.failure_reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        || CASE WHEN s.failure_requires_retry THEN '{"requiresRetry":true}'::jsonb ELSE '{}'::jsonb END END,
      'progressAttempt',coalesce(p.attempt,0)) AS state
      FROM relay_thread_move_participant_status s
      LEFT JOIN relay_thread_move_progress p ON p.operation_id=s.operation_id
        AND p.environment_id=s.environment_id AND p.generation=s.generation
      WHERE s.operation_id=${move.operationId} ORDER BY s.environment_id`;
    const states = (yield* decode(rows.map((row) => row.state)).pipe(Effect.orDie)).filter(
      (state) =>
        (state.environmentId === move.sourceEnvironmentId &&
          state.generation === move.expectedGeneration) ||
        (state.environmentId === move.destinationEnvironmentId &&
          state.generation === move.expectedGeneration + 1),
    );
    const acceptsFailures = ["preparing", "frozen", "ready"].includes(move.phase);
    const destinationOwnsCommit = move.phase === "ready" && move.destinationVerifiedCommit;
    const moveFailures: ThreadMoveFailureDiagnostic[] = states.flatMap((state) =>
      state.failure
        ? [
            {
              environmentId: state.environmentId,
              generation: state.generation,
              ...state.failure,
              active:
                acceptsFailures &&
                // Older sources can still report a refused commit as a transient
                // failure. A verified destination can use the retained recovery save.
                (!destinationOwnsCommit ||
                  state.environmentId !== move.sourceEnvironmentId ||
                  state.failure.requiresRetry === true) &&
                (state.failure.requiresRetry ||
                  state.failure.attempt >= state.resolvedBeforeAttempt) &&
                state.failure.attempt >= state.progressAttempt,
            },
          ]
        : [],
    );
    const active = moveFailures
      .filter((failure) => failure.active)
      .sort(
        (a, b) =>
          b.reportedAt.localeCompare(a.reportedAt) ||
          a.environmentId.localeCompare(b.environmentId),
      );
    return {
      ...move,
      failureDetail: acceptsFailures
        ? (active.find((failure) => failure.requiresRetry)?.detail ??
          move.failureDetail ??
          active[0]?.detail ??
          null)
        : null,
      participantStates: states.map((state) => ({
        environmentId: state.environmentId,
        generation: state.generation,
        resolvedBeforeAttempt: state.resolvedBeforeAttempt,
        failure: state.failure,
      })),
      moveFailures,
    };
  });

  const reportFailure = Effect.fnUntraced(function* (
    input: Participant & { detail: string; requiresRetry?: true },
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO relay_thread_move_participant_status
      (operation_id,environment_id,generation,failure_attempt,failure_detail,failure_reported_at,failure_requires_retry)
      SELECT ${input.operationId},${input.environmentId},${input.generation},${input.attempt},${input.detail},${now}::timestamptz,${input.requiresRetry ?? false}
      WHERE NOT EXISTS(SELECT 1 FROM relay_thread_move_progress p WHERE p.operation_id=${input.operationId}
        AND p.environment_id=${input.environmentId} AND p.generation=${input.generation} AND p.attempt>${input.attempt})
      ON CONFLICT(operation_id,environment_id) DO UPDATE SET
        failure_attempt=excluded.failure_attempt,failure_detail=excluded.failure_detail,
        failure_reported_at=excluded.failure_reported_at,failure_requires_retry=excluded.failure_requires_retry
      WHERE relay_thread_move_participant_status.generation=excluded.generation
        AND relay_thread_move_participant_status.resolved_before_attempt<=excluded.failure_attempt
        AND NOT (relay_thread_move_participant_status.failure_requires_retry AND
          relay_thread_move_participant_status.failure_attempt>=relay_thread_move_participant_status.resolved_before_attempt)
        AND (relay_thread_move_participant_status.failure_attempt IS NULL
          OR relay_thread_move_participant_status.failure_attempt<excluded.failure_attempt)`;
  });

  const resolveBefore = Effect.fnUntraced(function* (input: Participant) {
    yield* sql`INSERT INTO relay_thread_move_participant_status
      (operation_id,environment_id,generation,resolved_before_attempt)
      VALUES (${input.operationId},${input.environmentId},${input.generation},${input.attempt})
      ON CONFLICT(operation_id,environment_id) DO UPDATE SET
        resolved_before_attempt=greatest(relay_thread_move_participant_status.resolved_before_attempt,excluded.resolved_before_attempt)
      WHERE relay_thread_move_participant_status.generation=excluded.generation`;
  });

  const acceptsProgress = Effect.fnUntraced(function* (input: Participant) {
    const rejected = yield* sql`SELECT 1 FROM relay_thread_move_participant_status
      WHERE operation_id=${input.operationId} AND environment_id=${input.environmentId}
        AND (generation!=${input.generation} OR resolved_before_attempt>${input.attempt}
          OR failure_attempt>=${input.attempt}
          OR (failure_requires_retry AND failure_attempt>=resolved_before_attempt))`;
    return rejected.length === 0;
  });
  return { project, reportFailure, resolveBefore, acceptsProgress };
}
