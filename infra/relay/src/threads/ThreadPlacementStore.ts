import type { RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";

export class ThreadPlacementConflict extends Schema.TaggedError<ThreadPlacementConflict>()(
  "ThreadPlacementConflict",
  { message: Schema.String },
) {}

export type Placement = RelayPortableThreadPlacement;
export interface ThreadMove {
  readonly operationId: string;
  readonly threadId: string;
  readonly actorUserId: string;
  readonly sourceEnvironmentId: string;
  readonly expectedGeneration: number;
  readonly destinationEnvironmentId: string;
  readonly destinationProjectId: string;
  readonly phase:
    | "preparing"
    | "frozen"
    | "ready"
    | "committed"
    | "completed"
    | "aborting"
    | "aborted";
  readonly sourceCursor: number | null;
  readonly manifestSha256: string | null;
  readonly failureDetail?: string | null;
}
interface Admission {
  readonly environmentId: string;
  readonly generation: number;
  readonly completed: boolean;
}
type Owner = Pick<Placement, "threadId" | "environmentId" | "generation">;
type MoveIdentity = Pick<ThreadMove, "threadId" | "operationId">;

const conflict = (message: string) => new ThreadPlacementConflict({ message });

/**
 * Internal transactional store. Authentication and access-policy locks belong to its caller.
 * A row lock serializes admissions, handoff and cancellation; elapsed time never changes ownership.
 * Methods compose with the caller's PgClient transaction so authorization can share that lock.
 */
export function makeThreadPlacementStore(sql: PgClient) {
  const markVmWork = Effect.fnUntraced(function* (
    input: Owner & { readonly workId?: string },
    requireRunning: boolean,
  ) {
    const saved = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
      WHERE thread_id=${input.threadId} AND generation=${input.generation} AND phase != 'restored'`;
    if (saved.length && requireRunning)
      return yield* conflict("VM disk requires an explicit restore or reset");
    const [binding] = yield* sql<{ allocationId: string; state: string }>`
      SELECT a.allocation_id AS "allocationId", a.state
      FROM relay_thread_vm_bindings b
      JOIN relay_thread_vm_allocations a ON a.allocation_id = b.allocation_id
      WHERE b.thread_id = ${input.threadId} AND b.environment_id = ${input.environmentId}
        AND b.generation = ${input.generation} AND b.revoked_at IS NULL AND a.deleted_at IS NULL
      FOR SHARE OF a`;
    if (!binding) return;
    const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
      WHERE allocation_id = ${binding.allocationId} AND generation=${input.generation}
        AND (phase IN ('pending','sealed') OR (phase IN ('cancelled','completed') AND source_reopened_at IS NULL))`;
    if (pausing.length && requireRunning) return yield* conflict("VM pause is in progress");
    const resuming = yield* sql`SELECT 1 FROM relay_thread_vm_resumes
      WHERE allocation_id = ${binding.allocationId} AND phase IN ('waiting','resuming')`;
    if (resuming.length && requireRunning) return yield* conflict("VM resume is in progress");
    if (binding.state !== "running") {
      if (requireRunning) return yield* conflict("VM is not running");
      return;
    }
    if (!requireRunning && input.workId) {
      // Shutdown of a process already positively observed empty is bookkeeping,
      // not new user work. Preserve the idle boundary while its source drain
      // acknowledges completion; ordinary completion still renews activity.
      const inactive = yield* sql`SELECT 1 FROM relay_thread_vm_activity
        WHERE allocation_id=${binding.allocationId} AND activity='idle'
          AND observed_at>=clock_timestamp()-interval '2 minutes'
          AND jsonb_exists(inactive_work_ids,${input.workId})`;
      if (inactive.length) return;
    }
    yield* makeThreadVmActivityStore(sql)
      .recordWork(binding.allocationId)
      .pipe(
        Effect.catchTag("ThreadVmActivityConflict", () =>
          requireRunning ? conflict("VM is not running") : Effect.void,
        ),
      );
  });
  const get = Effect.fn("relay.thread_placement.get")(function* (threadId: string) {
    const [row] =
      yield* sql<Placement>`SELECT thread_id AS "threadId", organization_id AS "organizationId",
      repository_id AS "repositoryId", owner_user_id AS "ownerUserId", environment_id AS "environmentId",
      project_id AS "projectId", generation, operation_id AS "operationId"
      FROM relay_thread_placements WHERE thread_id = ${threadId} AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=${threadId})`;
    return row ?? null;
  });
  const lock = Effect.fnUntraced(function* (threadId: string) {
    const rows =
      yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${threadId} FOR UPDATE`;
    if (!rows.length) return yield* conflict("Portable thread does not exist");
    const placement = yield* get(threadId);
    if (!placement) return yield* conflict("Portable thread does not exist");
    return placement;
  });
  const getMove = Effect.fn("relay.thread_placement.get_move")(function* (input: MoveIdentity) {
    const [row] =
      yield* sql<ThreadMove>`SELECT operation_id AS "operationId", thread_id AS "threadId",
      actor_user_id AS "actorUserId", source_environment_id AS "sourceEnvironmentId", expected_generation AS "expectedGeneration",
      destination_environment_id AS "destinationEnvironmentId", destination_project_id AS "destinationProjectId",
      phase, source_cursor AS "sourceCursor", manifest_sha256 AS "manifestSha256", failure_detail AS "failureDetail"
      FROM relay_thread_moves WHERE operation_id = ${input.operationId} AND thread_id = ${input.threadId}`;
    if (!row) return yield* conflict("Move does not exist for this thread");
    return row;
  });
  const requireOwner = (placement: Placement, input: Owner) =>
    placement.environmentId === input.environmentId && placement.generation === input.generation
      ? Effect.void
      : Effect.fail(conflict("Environment no longer owns this thread generation"));

  const enroll = Effect.fn("relay.thread_placement.enroll")(function* (
    input: Omit<Placement, "generation" | "operationId">,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO relay_thread_placements
        (thread_id, organization_id, repository_id, owner_user_id, environment_id, project_id)
        VALUES (${input.threadId}, ${input.organizationId}, ${input.repositoryId}, ${input.ownerUserId}, ${input.environmentId}, ${input.projectId})
        ON CONFLICT (thread_id) DO NOTHING`;
        const row = yield* lock(input.threadId);
        if (
          row.organizationId !== input.organizationId ||
          row.repositoryId !== input.repositoryId ||
          row.ownerUserId !== input.ownerUserId ||
          row.environmentId !== input.environmentId ||
          row.projectId !== input.projectId ||
          row.generation !== 1 ||
          row.operationId !== null
        ) {
          return yield* conflict("Thread has already been enrolled with another placement");
        }
        return row;
      }),
    );
  });

  const admit = Effect.fn("relay.thread_placement.admit")(function* (
    input: Owner & { readonly workId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        yield* requireOwner(placement, input);
        const [existing] =
          yield* sql<Admission>`SELECT environment_id AS "environmentId", generation, completed
        FROM relay_thread_execution_admissions WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}`;
        if (existing) {
          if (
            existing.environmentId !== input.environmentId ||
            existing.generation !== input.generation
          )
            return yield* conflict("Work was already admitted at another placement");
          return { ...existing, newlyAdmitted: false };
        }
        if (placement.operationId !== null) return yield* conflict("Thread is waiting for a move");
        yield* sql`INSERT INTO relay_thread_execution_admissions (thread_id, work_id, environment_id, generation)
        VALUES (${input.threadId}, ${input.workId}, ${input.environmentId}, ${input.generation})`;
        yield* markVmWork(input, true);
        return {
          environmentId: input.environmentId,
          generation: input.generation,
          completed: false,
          newlyAdmitted: true,
        };
      }),
    );
  });

  const completeWork = Effect.fn("relay.thread_placement.complete_work")(function* (
    input: Owner & { readonly workId: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        yield* requireOwner(placement, input);
        const rows = yield* sql`UPDATE relay_thread_execution_admissions SET completed = true
        WHERE thread_id = ${input.threadId} AND work_id = ${input.workId} AND environment_id = ${input.environmentId}
        AND generation = ${input.generation} AND completed = false RETURNING work_id`;
        if (rows.length) {
          yield* markVmWork(input, false);
          return;
        }
        const existing = yield* sql`SELECT work_id FROM relay_thread_execution_admissions
          WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}
          AND environment_id = ${input.environmentId} AND generation = ${input.generation}
          AND completed = true`;
        if (!existing.length) return yield* conflict("Work has no matching admission");
      }),
    );
  });

  const beginMove = Effect.fn("relay.thread_placement.begin_move")(function* (
    input: Omit<ThreadMove, "phase" | "manifestSha256" | "sourceCursor">,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        if (input.actorUserId !== placement.ownerUserId)
          return yield* conflict("Only the private thread owner can move this thread");
        // Resolve retries before comparing generations: a committed move has already advanced it.
        const prior =
          yield* sql`SELECT operation_id FROM relay_thread_moves WHERE operation_id = ${input.operationId}`;
        if (prior.length) {
          const move = yield* getMove(input);
          if (
            move.actorUserId !== input.actorUserId ||
            move.sourceEnvironmentId !== input.sourceEnvironmentId ||
            move.expectedGeneration !== input.expectedGeneration ||
            move.destinationEnvironmentId !== input.destinationEnvironmentId ||
            move.destinationProjectId !== input.destinationProjectId
          )
            return yield* conflict("Move ID reused with different intent");
          return move;
        }
        yield* requireOwner(placement, {
          threadId: input.threadId,
          environmentId: input.sourceEnvironmentId,
          generation: input.expectedGeneration,
        });
        if (placement.operationId !== null) return yield* conflict("Another move is in progress");
        const saved = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
          WHERE thread_id=${input.threadId} AND generation=${input.expectedGeneration} AND phase != 'restored'`;
        if (saved.length)
          return yield* conflict("Restore or reset the VM before moving its thread");
        const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses x
          JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
          WHERE a.thread_id = ${input.threadId} AND x.generation=${input.expectedGeneration}
            AND (x.phase IN ('pending','sealed') OR (x.phase IN ('cancelled','completed') AND x.source_reopened_at IS NULL))`;
        if (pausing.length) return yield* conflict("VM pause is in progress");
        const resuming = yield* sql`SELECT 1 FROM relay_thread_vm_resumes r
          JOIN relay_thread_vm_allocations a ON a.allocation_id = r.allocation_id
          WHERE a.thread_id = ${input.threadId} AND r.phase IN ('waiting','resuming')`;
        if (resuming.length) return yield* conflict("VM resume is in progress");
        const backingUp = yield* sql`SELECT 1 FROM relay_thread_vm_backups x
          JOIN relay_thread_vm_allocations a ON a.allocation_id = x.allocation_id
          WHERE a.thread_id = ${input.threadId}
            AND x.phase IN ('pending','creating','captured','verifying','cleanup')`;
        if (backingUp.length) return yield* conflict("VM backup is in progress");
        if (input.sourceEnvironmentId === input.destinationEnvironmentId)
          return yield* conflict("Destination is already the current environment");
        yield* sql`INSERT INTO relay_thread_moves (operation_id, thread_id, actor_user_id, source_environment_id,
        expected_generation, destination_environment_id, destination_project_id, phase)
        VALUES (${input.operationId}, ${input.threadId}, ${input.actorUserId}, ${input.sourceEnvironmentId},
        ${input.expectedGeneration}, ${input.destinationEnvironmentId}, ${input.destinationProjectId}, 'preparing')`;
        yield* sql`UPDATE relay_thread_placements SET operation_id = ${input.operationId} WHERE thread_id = ${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  const reportFailure = Effect.fn("relay.thread_placement.report_failure")(function* (
    input: MoveIdentity & Owner & { readonly detail: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        const participant =
          (input.environmentId === move.sourceEnvironmentId &&
            input.generation === move.expectedGeneration) ||
          (input.environmentId === move.destinationEnvironmentId &&
            input.generation === move.expectedGeneration + 1);
        if (
          !participant ||
          placement.operationId !== input.operationId ||
          placement.environmentId !== move.sourceEnvironmentId ||
          placement.generation !== move.expectedGeneration ||
          !["preparing", "frozen", "ready"].includes(move.phase)
        )
          return yield* conflict("Move no longer accepts participant failure reports");
        const detail = input.detail.trim();
        if (!detail || detail.length > 2000) return yield* conflict("Invalid move failure detail");
        yield* sql`UPDATE relay_thread_moves SET failure_detail = COALESCE(failure_detail,${detail})
          WHERE operation_id = ${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  const sourceFrozen = Effect.fn("relay.thread_placement.source_frozen")(function* (
    input: MoveIdentity &
      Owner & { readonly sourceCursor: number; readonly manifestSha256: string },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        yield* requireOwner(placement, input);
        const move = yield* getMove(input);
        if (placement.operationId !== input.operationId)
          return yield* conflict("Move no longer owns the handoff");
        if (move.phase === "frozen" || move.phase === "ready") {
          if (
            move.sourceCursor !== input.sourceCursor ||
            move.manifestSha256 !== input.manifestSha256
          )
            return yield* conflict("Frozen source manifest cannot change");
          return move;
        }
        if (move.phase !== "preparing") return yield* conflict("Move is not preparing");
        const unfinished = yield* sql`SELECT work_id FROM relay_thread_execution_admissions
        WHERE thread_id = ${input.threadId} AND NOT completed LIMIT 1`;
        if (unfinished.length) return yield* conflict("Admitted source work has not drained");
        if (
          !Number.isSafeInteger(input.sourceCursor) ||
          input.sourceCursor < 0 ||
          !/^[0-9a-f]{64}$/.test(input.manifestSha256)
        )
          return yield* conflict("Invalid frozen source manifest");
        const [mirrored] = yield* sql`SELECT 1 FROM relay_thread_history_watermarks
          WHERE thread_id = ${input.threadId} AND environment_id = ${input.environmentId}
            AND generation = ${input.generation} AND source_sequence >= ${input.sourceCursor}`;
        if (!mirrored)
          return yield* conflict("Source history has not been mirrored through the freeze");
        yield* sql`UPDATE relay_thread_moves SET phase = 'frozen', source_cursor = ${input.sourceCursor}, manifest_sha256 = ${input.manifestSha256}, failure_detail = NULL
        WHERE operation_id = ${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  const destinationReady = Effect.fn("relay.thread_placement.destination_ready")(function* (
    input: MoveIdentity & {
      readonly environmentId: string;
      readonly sourceCursor: number;
      readonly manifestSha256: string;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (
          placement.operationId !== input.operationId ||
          !["frozen", "ready"].includes(move.phase) ||
          move.destinationEnvironmentId !== input.environmentId ||
          move.sourceCursor !== input.sourceCursor ||
          move.manifestSha256 !== input.manifestSha256
        )
          return yield* conflict("Destination does not match the frozen source");
        yield* sql`UPDATE relay_thread_moves SET phase = 'ready', failure_detail = NULL WHERE operation_id = ${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  const commitMove = Effect.fn("relay.thread_placement.commit_move")(function* (
    input: MoveIdentity,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (move.phase === "committed" || move.phase === "completed") return move;
        if (
          placement.operationId !== input.operationId ||
          move.phase !== "ready" ||
          move.failureDetail
        )
          return yield* conflict("Move is not ready to commit");
        yield* requireOwner(placement, {
          threadId: input.threadId,
          environmentId: move.sourceEnvironmentId,
          generation: move.expectedGeneration,
        });
        const [artifacts] = yield* sql`SELECT 1 FROM relay_thread_move_artifacts ma
          JOIN relay_thread_artifacts a ON a.artifact_id = ma.manifest_artifact_id
          JOIN relay_thread_artifact_pins p ON p.artifact_id = a.artifact_id
            AND p.operation_id = ma.operation_id
          WHERE ma.operation_id = ${input.operationId} AND a.thread_id = ${input.threadId}
            AND a.operation_id = ${input.operationId} AND a.state = 'complete'`;
        if (!artifacts) return yield* conflict("Frozen move artifacts have not been published");
        const [recovery] = yield* sql<{
          artifactCount: number;
          pinnedCount: number;
        }>`SELECT c.artifact_count AS "artifactCount",count(a.artifact_id)::int AS "pinnedCount"
          FROM relay_thread_move_checkpoints c JOIN relay_thread_move_artifacts ma ON ma.operation_id=c.operation_id AND ma.manifest_artifact_id=c.manifest_artifact_id
          LEFT JOIN relay_thread_artifact_pins p ON p.operation_id='move-recovery:' || c.operation_id AND p.expires_at IS NULL
          LEFT JOIN relay_thread_artifacts a ON a.artifact_id=p.artifact_id AND a.thread_id=c.thread_id AND a.operation_id=c.operation_id AND a.state='complete'
          WHERE c.operation_id=${input.operationId} AND c.thread_id=${input.threadId} AND c.retained GROUP BY c.artifact_count`;
        if (!recovery || recovery.artifactCount !== recovery.pinnedCount)
          return yield* conflict("The exact frozen thread recovery save is incomplete");
        const [unfinished] =
          yield* sql`SELECT 1 FROM relay_thread_execution_admissions WHERE thread_id=${input.threadId} AND NOT completed LIMIT 1`;
        if (unfinished) return yield* conflict("Source work has not fully reconciled");
        yield* sql`UPDATE relay_thread_placements SET environment_id = ${move.destinationEnvironmentId},
        project_id = ${move.destinationProjectId}, generation = generation + 1 WHERE thread_id = ${input.threadId}`;
        yield* sql`UPDATE relay_thread_moves SET phase = 'committed', failure_detail = NULL WHERE operation_id = ${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  const activated = Effect.fn("relay.thread_placement.activated")(function* (
    input: MoveIdentity & Owner,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        yield* requireOwner(placement, input);
        const move = yield* getMove(input);
        if (move.phase === "completed") return move;
        if (placement.operationId !== input.operationId || move.phase !== "committed")
          return yield* conflict("Destination has not been committed");
        yield* sql`UPDATE relay_thread_moves SET phase = 'completed' WHERE operation_id = ${input.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id = NULL WHERE thread_id = ${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  const requestAbort = Effect.fn("relay.thread_placement.request_abort")(function* (
    input: MoveIdentity,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (move.phase === "aborting" || move.phase === "aborted") return move;
        if (
          placement.operationId !== input.operationId ||
          move.phase === "committed" ||
          move.phase === "completed"
        )
          return yield* conflict("Committed ownership cannot be cancelled");
        yield* sql`UPDATE relay_thread_moves SET phase = 'aborting' WHERE operation_id = ${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  // The worker calls this only after positively fencing/removing the partial destination.
  const destinationRemoved = Effect.fn("relay.thread_placement.destination_removed")(function* (
    input: MoveIdentity,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (move.phase === "aborted") return move;
        if (placement.operationId !== input.operationId || move.phase !== "aborting")
          return yield* conflict("Move is not aborting");
        yield* sql`UPDATE relay_thread_moves SET phase = 'aborted' WHERE operation_id = ${input.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id = NULL WHERE thread_id = ${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  return {
    get,
    enroll,
    getMove,
    admit,
    completeWork,
    beginMove,
    reportFailure,
    sourceFrozen,
    destinationReady,
    commitMove,
    activated,
    requestAbort,
    destinationRemoved,
  };
}
