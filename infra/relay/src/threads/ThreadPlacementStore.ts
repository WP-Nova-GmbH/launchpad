import {
  ThreadMoveProgressReport,
  type RelayPortableThreadPlacement,
  type RelayThreadPlacement,
  isPrivateThreadPlacement,
  type ThreadMoveParticipantState,
  type ThreadMoveFailureDiagnostic,
} from "@t3tools/contracts/relay";
import {
  ThreadTransferFormats,
  type ThreadTransferFormat,
  type ThreadTransferEncodingPolicy,
} from "@t3tools/contracts/threadTransferFormat";
import {
  normalizeThreadTransferFormats,
  threadTransferPolicyForFormat,
  THREAD_TRANSFER_SUPPORTED_FORMATS,
} from "@t3tools/shared/threadTransferEncoding";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadMoveParticipantStatus, sourceMoveRetry } from "./ThreadMoveParticipantStatus.ts";

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
  readonly transferEncodingPolicy?: ThreadTransferEncodingPolicy | null;
  readonly participantStates?: readonly ThreadMoveParticipantState[];
  readonly moveFailures?: readonly ThreadMoveFailureDiagnostic[];
  readonly cancellationProtocol?: "legacy" | "available" | "source-reopen-v1";
  readonly sourceReopened?: boolean;
  readonly cancellationBlocker?: "capture_stop_unconfirmed" | "source_reopen_failed" | null;
  readonly legacyCancelCommandId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly destinationVerifiedCommit?: boolean;
}
interface Admission {
  readonly environmentId: string;
  readonly generation: number;
  readonly completed: boolean;
}
type Owner = Pick<Placement, "threadId" | "environmentId" | "generation">;
type MoveIdentity = Pick<ThreadMove, "threadId" | "operationId">;
const encodeFormats = Schema.encodeSync(Schema.fromJsonString(ThreadTransferFormats));

const conflict = (message: string) => new ThreadPlacementConflict({ message });
const validAttempt = Schema.is(ThreadMoveProgressReport.fields.attempt);

/**
 * Internal transactional store. Authentication and access-policy locks belong to its caller.
 * A row lock serializes admissions, handoff and cancellation; elapsed time never changes ownership.
 * Methods compose with the caller's PgClient transaction so authorization can share that lock.
 */
export function makeThreadPlacementStore(sql: PgClient) {
  const participants = makeThreadMoveParticipantStatus(sql);
  const markVmWork = Effect.fnUntraced(function* (
    input: Owner & { readonly workId?: string },
    requireRunning: boolean,
  ) {
    const saved = yield* sql`SELECT 1 FROM relay_thread_vm_saved_disks
      WHERE thread_id=${input.threadId} AND generation=${input.generation} AND phase != 'restored'`;
    if (saved.length && requireRunning)
      return yield* conflict("VM disk requires an explicit restore or reset");
    const [binding] = yield* sql<{ allocationId: string; state: string; runtimeProtocol: string }>`
      SELECT a.allocation_id AS "allocationId", a.state,a.runtime_protocol AS "runtimeProtocol"
      FROM relay_thread_vm_bindings b
      JOIN relay_thread_vm_allocations a ON a.allocation_id = b.allocation_id
      WHERE b.thread_id = ${input.threadId} AND b.environment_id = ${input.environmentId}
        AND b.generation = ${input.generation} AND b.revoked_at IS NULL AND a.deleted_at IS NULL
      FOR SHARE OF a`;
    if (!binding) return;
    if (binding.runtimeProtocol !== "native-v1") {
      if (requireRunning)
        return yield* conflict(
          "This VM belongs to an earlier runtime and requires manual migration.",
        );
      return;
    }
    const pausing = yield* sql`SELECT 1 FROM relay_thread_vm_pauses
      WHERE allocation_id = ${binding.allocationId} AND generation=${input.generation}
        AND (phase IN ('pending','sealed') OR (phase IN ('cancelled','completed') AND source_reopened_at IS NULL))
      UNION ALL SELECT 1 FROM relay_thread_vm_backups x WHERE x.allocation_id=${binding.allocationId} AND x.generation=${input.generation}
        AND x.source_reopened_at IS NULL AND (x.phase IN ('pending','creating') OR x.source_receipt IS NOT NULL
          OR (x.phase='failed' AND x.capture_started_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses p WHERE p.backup_operation_id=x.operation_id)`;
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
  const getAny = Effect.fn("relay.thread_placement.get_any")(function* (threadId: string) {
    const [row] = yield* sql<
      RelayThreadPlacement & { localEnrollment: boolean }
    >`SELECT thread_id AS "threadId", organization_id AS "organizationId",
      repository_id AS "repositoryId", owner_user_id AS "ownerUserId", environment_id AS "environmentId",
      audience, workflow_job_id AS "workflowJobId",
      project_id AS "projectId", generation, operation_id AS "operationId",
      CASE WHEN original_environment_id IS NULL THEN NULL ELSE
        jsonb_build_object('environmentId',original_environment_id,'projectId',original_project_id)
      END AS "originalLocation",
      EXISTS(SELECT 1 FROM relay_thread_local_enrollments e
        WHERE e.thread_id=relay_thread_placements.thread_id AND e.phase IN ('preparing','active')) AS "localEnrollment"
      FROM relay_thread_placements WHERE thread_id = ${threadId} AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=${threadId})`;
    if (!row) return null;
    const { originalLocation, localEnrollment, ...current } = row;
    const placement: RelayThreadPlacement = current;
    if (originalLocation != null) return { ...placement, originalLocation };
    return localEnrollment ? placement : { ...placement, originalLocation: null };
  });
  const get = Effect.fn("relay.thread_placement.get")(function* (threadId: string) {
    const placement = yield* getAny(threadId);
    if (placement?.audience !== "private" || !isPrivateThreadPlacement(placement)) return null;
    const { audience: _audience, workflowJobId: _workflowJobId, ...privatePlacement } = placement;
    return privatePlacement;
  });
  const prepareWorkflow = Effect.fn("relay.thread_placement.prepare_workflow")(function* (input: {
    threadId: string;
    workflowJobId: string;
    organizationId: string;
    repositoryId: string;
    operationId: string;
    waiting?: boolean;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const jobs = yield* sql`SELECT job_id FROM relay_workflow_jobs
          WHERE job_id=${input.workflowJobId} AND organization_id=${input.organizationId}
            AND repository_id=${input.repositoryId} AND ${
              input.waiting
                ? sql`status='queued' AND pending_control IS NULL AND record ? 'vmAdmission'
                AND record->'runtime'='null'::jsonb AND record->'workflow'='null'::jsonb`
                : sql`status='preparing' AND record#>>'{workflow,definition,target,kind}'='vm'
                AND record#>>'{runtime,kind}'='vm' AND record#>>'{runtime,threadId}'=${input.threadId}`
            }
          FOR SHARE`;
        if (!jobs.length)
          return yield* conflict("Workflow preparation has no matching accepted VM job");
        yield* sql`INSERT INTO relay_thread_placements
          (thread_id,organization_id,repository_id,audience,owner_user_id,workflow_job_id,
            environment_id,project_id,generation,operation_id)
          VALUES(${input.threadId},${input.organizationId},${input.repositoryId},'repository',NULL,
            ${input.workflowJobId},NULL,NULL,1,${input.operationId})
          ON CONFLICT DO NOTHING`;
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const placement = yield* getAny(input.threadId);
        if (
          !placement ||
          placement.audience !== "repository" ||
          placement.workflowJobId !== input.workflowJobId ||
          placement.organizationId !== input.organizationId ||
          placement.repositoryId !== input.repositoryId ||
          placement.generation !== 1 ||
          placement.operationId !== input.operationId ||
          placement.environmentId !== null ||
          placement.projectId !== null
        )
          return yield* conflict("Workflow preparation identity is already assigned or changed");
        return placement;
      }),
    );
  });
  const assignWorkflow = Effect.fn("relay.thread_placement.assign_workflow")(function* (input: {
    threadId: string;
    workflowJobId: string;
    allocationId: string;
    operationId: string;
    environmentId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR UPDATE`;
        const placement = yield* getAny(input.threadId);
        if (
          !placement ||
          placement.audience !== "repository" ||
          placement.generation !== 1 ||
          placement.workflowJobId !== input.workflowJobId ||
          placement.operationId !== input.operationId
        )
          return yield* conflict("Workflow preparation no longer owns this placement");
        const bindings = yield* sql`SELECT b.environment_id FROM relay_thread_vm_allocations a
          JOIN relay_thread_vm_provisions p USING(allocation_id)
          JOIN relay_thread_vm_bindings b USING(allocation_id)
          JOIN relay_thread_vm_enrollments e USING(allocation_id)
          JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
          WHERE a.allocation_id=${input.allocationId} AND a.resource_kind='organization_workflow'
            AND a.organization_id=${placement.organizationId} AND a.thread_id=${input.threadId}
            AND a.state='running' AND a.deleted_at IS NULL AND p.operation_id=${input.operationId}
            AND p.generation=1 AND p.phase='created' AND b.thread_id=${input.threadId}
            AND b.repository_id=${placement.repositoryId} AND b.generation=1
            AND b.environment_id=${input.environmentId} AND b.revoked_at IS NULL
            AND e.environment_id=b.environment_id AND e.credential_id=b.credential_id
            AND e.operation_id=${input.operationId} AND e.installed_at IS NOT NULL
            AND c.environment_id=b.environment_id AND c.environment_public_key=b.environment_public_key
            AND c.revoked_at IS NULL FOR SHARE OF a,b,e,c`;
        if (!bindings.length)
          return yield* conflict("Workflow assignment requires its installed VM identity");
        const projectId = `vm:${input.threadId}`;
        if (
          placement.environmentId !== null &&
          (placement.environmentId !== input.environmentId || placement.projectId !== projectId)
        )
          return yield* conflict("Workflow placement is already assigned to another environment");
        yield* sql`UPDATE relay_thread_placements SET environment_id=${input.environmentId},project_id=${projectId}
          WHERE thread_id=${input.threadId}`;
        return (yield* getAny(input.threadId))!;
      }),
    );
  });
  const lockPlacement = Effect.fnUntraced(function* (threadId: string) {
    const rows =
      yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${threadId} FOR UPDATE`;
    if (!rows.length) return yield* conflict("Portable thread does not exist");
  });
  const lock = Effect.fnUntraced(function* (threadId: string) {
    yield* lockPlacement(threadId);
    const placement = yield* get(threadId);
    if (!placement) return yield* conflict("Portable thread does not exist");
    return placement;
  });
  const lockWorkPlacement = Effect.fnUntraced(function* (threadId: string, workflowJobId?: string) {
    if (workflowJobId === undefined) return yield* lock(threadId);
    yield* lockPlacement(threadId);
    const placement = yield* getAny(threadId);
    if (placement?.audience !== "repository" || placement.workflowJobId !== workflowJobId)
      return yield* conflict("Workflow no longer owns this portable thread");
    return placement;
  });
  const findMove = Effect.fn("relay.thread_placement.find_move")(function* (input: MoveIdentity) {
    const [row] =
      yield* sql<ThreadMove>`SELECT operation_id AS "operationId", thread_id AS "threadId",
      actor_user_id AS "actorUserId", source_environment_id AS "sourceEnvironmentId", expected_generation AS "expectedGeneration",
      destination_environment_id AS "destinationEnvironmentId", destination_project_id AS "destinationProjectId",
      phase, source_cursor AS "sourceCursor", manifest_sha256 AS "manifestSha256", failure_detail AS "failureDetail",
      transfer_encoding_policy AS "transferEncodingPolicy",
      cancellation_protocol AS "cancellationProtocol", (source_reopened_at IS NOT NULL) AS "sourceReopened",
      cancellation_blocker AS "cancellationBlocker", legacy_cancel_command_id AS "legacyCancelCommandId",
      source_message_id AS "sourceMessageId", destination_verified_commit AS "destinationVerifiedCommit"
      FROM relay_thread_moves WHERE operation_id = ${input.operationId} AND thread_id = ${input.threadId}`;
    return row ? yield* participants.project(row) : null;
  });
  const getMove = Effect.fn("relay.thread_placement.get_move")(function* (input: MoveIdentity) {
    const move = yield* findMove(input);
    return move ?? (yield* conflict("Move does not exist for this thread"));
  });
  const requireOwner = (
    placement: Pick<RelayThreadPlacement, "environmentId" | "generation">,
    input: Owner,
  ) =>
    placement.environmentId === input.environmentId && placement.generation === input.generation
      ? Effect.void
      : Effect.fail(conflict("Environment no longer owns this thread generation"));

  const enroll = Effect.fn("relay.thread_placement.enroll")(function* (
    input: Omit<Placement, "generation" | "operationId" | "originalLocation">,
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
    workflowJobId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lockWorkPlacement(input.threadId, workflowJobId);
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
    workflowJobId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lockWorkPlacement(input.threadId, workflowJobId);
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
    input: Omit<ThreadMove, "phase" | "manifestSha256" | "sourceCursor"> & {
      readonly sourceThreadTransferFormats?: readonly ThreadTransferFormat[];
      readonly supportsSourceReopenAck?: true;
    },
  ) {
    const formats = normalizeThreadTransferFormats(input.sourceThreadTransferFormats);
    if (!formats.length) return yield* conflict("The source offers no supported transfer format");
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
          const [offer] = yield* sql<{
            formats: readonly ThreadTransferFormat[];
          }>`SELECT source_formats_json AS formats
            FROM relay_thread_moves WHERE operation_id=${input.operationId}`;
          if (
            move.actorUserId !== input.actorUserId ||
            move.sourceEnvironmentId !== input.sourceEnvironmentId ||
            move.expectedGeneration !== input.expectedGeneration ||
            move.destinationEnvironmentId !== input.destinationEnvironmentId ||
            move.destinationProjectId !== input.destinationProjectId ||
            (move.sourceMessageId != null &&
              input.sourceMessageId != null &&
              move.sourceMessageId !== input.sourceMessageId) ||
            !offer ||
            normalizeThreadTransferFormats(offer.formats).join(",") !== formats.join(",")
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
        const legacy =
          yield* sql`SELECT 1 FROM relay_thread_vm_allocations WHERE thread_id=${input.threadId} AND deleted_at IS NULL AND runtime_protocol<>'native-v1'`;
        if (legacy.length)
          return yield* conflict(
            "This VM belongs to an earlier runtime and requires manual migration.",
          );
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
            AND (x.phase IN ('pending','creating','captured','verifying','cleanup') OR ((x.source_receipt IS NOT NULL OR (x.phase='failed' AND x.capture_started_at IS NULL)) AND x.source_reopened_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM relay_thread_vm_pauses p WHERE p.backup_operation_id=x.operation_id)))`;
        if (backingUp.length) return yield* conflict("VM backup is in progress");
        if (input.sourceEnvironmentId === input.destinationEnvironmentId)
          return yield* conflict("Destination is already the current environment");
        yield* sql`INSERT INTO relay_thread_moves (operation_id, thread_id, actor_user_id, source_environment_id,
        expected_generation, destination_environment_id, destination_project_id, phase, source_formats_json,transfer_encoding_policy,cancellation_protocol,source_message_id)
        VALUES (${input.operationId}, ${input.threadId}, ${input.actorUserId}, ${input.sourceEnvironmentId},
        ${input.expectedGeneration}, ${input.destinationEnvironmentId}, ${input.destinationProjectId}, 'preparing',
          ${encodeFormats(formats)}::jsonb,${formats.includes("launchpad-thread-chunks-v2") ? null : "v1-64MiB"},
          ${input.supportsSourceReopenAck ? "available" : "legacy"}, ${input.sourceMessageId ?? null})`;
        yield* sql`UPDATE relay_thread_placements SET operation_id = ${input.operationId} WHERE thread_id = ${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  const selectEncoding = Effect.fn("relay.thread_placement.select_encoding")(function* (
    input: Pick<
      ThreadMove,
      | "threadId"
      | "operationId"
      | "actorUserId"
      | "sourceEnvironmentId"
      | "expectedGeneration"
      | "destinationEnvironmentId"
      | "destinationProjectId"
    > & {
      readonly destinationThreadTransferFormats: readonly ThreadTransferFormat[];
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (
          placement.operationId !== input.operationId ||
          placement.environmentId !== input.sourceEnvironmentId ||
          placement.generation !== input.expectedGeneration ||
          !["preparing", "frozen"].includes(move.phase) ||
          move.actorUserId !== input.actorUserId ||
          move.sourceEnvironmentId !== input.sourceEnvironmentId ||
          move.expectedGeneration !== input.expectedGeneration ||
          move.destinationEnvironmentId !== input.destinationEnvironmentId ||
          move.destinationProjectId !== input.destinationProjectId
        )
          return yield* conflict("The move participants changed during encoding selection");
        if (move.transferEncodingPolicy != null) return move;
        const [offer] = yield* sql<{
          formats: readonly ThreadTransferFormat[];
        }>`SELECT source_formats_json AS formats
        FROM relay_thread_moves WHERE operation_id=${input.operationId} FOR UPDATE`;
        if (!offer) return yield* conflict("The source format offer is unavailable");
        const source = normalizeThreadTransferFormats(offer.formats);
        const destination = normalizeThreadTransferFormats(input.destinationThreadTransferFormats);
        const format = THREAD_TRANSFER_SUPPORTED_FORMATS.toReversed().find(
          (format) => source.includes(format) && destination.includes(format),
        );
        if (!format) return yield* conflict("The environments share no supported transfer format");
        yield* sql`UPDATE relay_thread_moves SET transfer_encoding_policy=${threadTransferPolicyForFormat(format)}
        WHERE operation_id=${input.operationId} AND transfer_encoding_policy IS NULL`;
        return yield* getMove(input);
      }),
    );
  });
  const reportFailure = Effect.fn("relay.thread_placement.report_failure")(function* (
    input: MoveIdentity &
      Owner & { readonly detail: string; readonly attempt?: number; readonly requiresRetry?: true },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        const source =
          input.environmentId === move.sourceEnvironmentId &&
          input.generation === move.expectedGeneration;
        const participant =
          source ||
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
        if (
          input.requiresRetry &&
          (!source || input.attempt === undefined || !Number.isSafeInteger(input.attempt + 2))
        )
          return yield* conflict("Only a numbered source save failure can require retry");
        if (input.attempt === undefined)
          yield* sql`UPDATE relay_thread_moves SET failure_detail = COALESCE(failure_detail,${detail})
            WHERE operation_id = ${input.operationId}`;
        else {
          if (!validAttempt(input.attempt)) return yield* conflict("Invalid move failure attempt");
          yield* participants.reportFailure({ ...input, attempt: input.attempt, detail });
        }
        return yield* getMove(input);
      }),
    );
  });

  const requestRetry = Effect.fn("relay.thread_placement.request_retry")(function* (
    input: MoveIdentity & { readonly sourceGeneration: number; readonly failedAttempt: number },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (
          placement.operationId !== input.operationId ||
          placement.environmentId !== move.sourceEnvironmentId ||
          placement.generation !== input.sourceGeneration ||
          move.expectedGeneration !== input.sourceGeneration ||
          !["preparing", "frozen", "ready"].includes(move.phase)
        )
          return yield* conflict("Move no longer accepts source retry");
        const source = move.participantStates?.find(
          (participant) =>
            participant.environmentId === move.sourceEnvironmentId &&
            participant.generation === move.expectedGeneration,
        );
        if (
          source?.failure?.attempt !== input.failedAttempt ||
          !source.failure.requiresRetry ||
          !Number.isSafeInteger(input.failedAttempt + 2)
        )
          return yield* conflict("This source save is no longer waiting for retry");
        if (source.resolvedBeforeAttempt > input.failedAttempt) return move;
        if (sourceMoveRetry(move)?.attempt !== input.failedAttempt)
          return yield* conflict("This source save is no longer waiting for retry");
        yield* participants.resolveBefore({
          operationId: move.operationId,
          environmentId: move.sourceEnvironmentId,
          generation: move.expectedGeneration,
          attempt: input.failedAttempt + 1,
        });
        return yield* getMove(input);
      }),
    );
  });

  const sourceFrozen = Effect.fn("relay.thread_placement.source_frozen")(function* (
    input: MoveIdentity &
      Owner & {
        readonly sourceCursor: number;
        readonly manifestSha256: string;
        readonly attempt?: number;
      },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        yield* requireOwner(placement, input);
        const move = yield* getMove(input);
        if (input.attempt !== undefined && !validAttempt(input.attempt))
          return yield* conflict("Invalid move freeze attempt");
        if (placement.operationId !== input.operationId)
          return yield* conflict("Move no longer owns the handoff");
        const retry = sourceMoveRetry(move);
        if (retry && (!retry.requested || (input.attempt ?? 0) <= retry.attempt))
          return yield* conflict("The source save requires an authorized new attempt");
        if (move.phase === "frozen" || move.phase === "ready") {
          if (
            move.sourceCursor !== input.sourceCursor ||
            move.manifestSha256 !== input.manifestSha256
          )
            return yield* conflict("Frozen source manifest cannot change");
          if (input.attempt !== undefined)
            yield* participants.resolveBefore({ ...input, attempt: input.attempt });
          return yield* getMove(input);
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
        if (input.attempt !== undefined)
          yield* participants.resolveBefore({ ...input, attempt: input.attempt });
        return yield* getMove(input);
      }),
    );
  });

  const destinationReady = Effect.fn("relay.thread_placement.destination_ready")(function* (
    input: MoveIdentity & {
      readonly environmentId: string;
      readonly generation?: number;
      readonly sourceCursor: number;
      readonly manifestSha256: string;
      readonly attempt?: number;
      readonly destinationVerifiedCommit?: true;
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
          (input.destinationVerifiedCommit && input.generation !== move.expectedGeneration + 1) ||
          move.sourceCursor !== input.sourceCursor ||
          move.manifestSha256 !== input.manifestSha256
        )
          return yield* conflict("Destination does not match the frozen source");
        if (input.attempt !== undefined && !validAttempt(input.attempt))
          return yield* conflict("Invalid move readiness attempt");
        yield* sql`UPDATE relay_thread_moves SET phase = 'ready', failure_detail = NULL,
          destination_verified_commit=destination_verified_commit OR ${input.destinationVerifiedCommit ?? false}
          WHERE operation_id = ${input.operationId}`;
        if (input.attempt !== undefined)
          yield* participants.resolveBefore({
            ...input,
            generation: move.expectedGeneration + 1,
            attempt: input.attempt,
          });
        return yield* getMove(input);
      }),
    );
  });

  const commitMove = Effect.fn("relay.thread_placement.commit_move")(function* (
    input: MoveIdentity & { readonly environmentId?: string; readonly generation?: number },
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
        if (
          move.destinationVerifiedCommit &&
          (input.environmentId !== move.destinationEnvironmentId ||
            input.generation !== move.expectedGeneration + 1)
        )
          return yield* conflict("The destination must verify and commit this move");
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
    input: MoveIdentity & {
      readonly legacyCancelCommandId?: string;
    },
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
        const sourceReopenRequired = move.cancellationProtocol === "available";
        yield* sql`UPDATE relay_thread_moves SET phase = 'aborting',
          cancellation_protocol=${sourceReopenRequired ? "source-reopen-v1" : "legacy"},
          legacy_cancel_command_id=${sourceReopenRequired ? null : (input.legacyCancelCommandId ?? null)}
          WHERE operation_id = ${input.operationId}`;
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
        if (move.cancellationProtocol !== "source-reopen-v1")
          yield* sql`UPDATE relay_thread_placements SET operation_id = NULL WHERE thread_id = ${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  const advertiseSourceReopen = Effect.fn("relay.thread_placement.advertise_source_reopen")(
    function* (input: MoveIdentity & Owner) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const placement = yield* lock(input.threadId);
          const move = yield* getMove(input);
          if (
            placement.operationId !== input.operationId ||
            move.sourceEnvironmentId !== input.environmentId ||
            move.expectedGeneration !== input.generation ||
            move.cancellationProtocol !== "legacy" ||
            !["preparing", "frozen", "ready"].includes(move.phase)
          )
            return move;
          yield* sql`UPDATE relay_thread_moves SET cancellation_protocol='available'
            WHERE operation_id=${input.operationId}`;
          return yield* getMove(input);
        }),
      );
    },
  );

  const sourceReopened = Effect.fn("relay.thread_placement.source_reopened")(function* (
    input: MoveIdentity & Owner,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        if (
          move.sourceEnvironmentId !== input.environmentId ||
          move.expectedGeneration !== input.generation ||
          move.cancellationProtocol !== "source-reopen-v1" ||
          move.phase !== "aborted"
        )
          return yield* conflict("The move is not waiting for this source to reopen");
        if (move.sourceReopened) return move;
        yield* requireOwner(placement, input);
        if (placement.operationId !== input.operationId)
          return yield* conflict("Source reopening belongs to a different move");
        yield* sql`UPDATE relay_thread_moves SET source_reopened_at=clock_timestamp(),
          cancellation_blocker=NULL WHERE operation_id=${input.operationId}`;
        yield* sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${input.threadId}`;
        return yield* getMove(input);
      }),
    );
  });

  const reopenBlocked = Effect.fn("relay.thread_placement.reopen_blocked")(function* (
    input: MoveIdentity &
      Owner & {
        readonly reason: "capture_stop_unconfirmed" | "source_reopen_failed";
      },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const placement = yield* lock(input.threadId);
        const move = yield* getMove(input);
        yield* requireOwner(placement, input);
        if (
          placement.operationId !== input.operationId ||
          move.sourceEnvironmentId !== input.environmentId ||
          move.expectedGeneration !== input.generation ||
          move.cancellationProtocol !== "source-reopen-v1" ||
          !["aborting", "aborted"].includes(move.phase) ||
          move.sourceReopened
        )
          return yield* conflict("The move is not waiting for this source to reopen");
        if (move.cancellationBlocker === input.reason) return move;
        yield* sql`UPDATE relay_thread_moves SET cancellation_blocker=${input.reason}
          WHERE operation_id=${input.operationId}`;
        return yield* getMove(input);
      }),
    );
  });

  return {
    get,
    getAny,
    prepareWorkflow,
    assignWorkflow,
    enroll,
    getMove,
    findMove,
    admit,
    completeWork,
    beginMove,
    selectEncoding,
    reportFailure,
    requestRetry,
    sourceFrozen,
    destinationReady,
    commitMove,
    activated,
    requestAbort,
    destinationRemoved,
    advertiseSourceReopen,
    sourceReopened,
    reopenBlocked,
  };
}
