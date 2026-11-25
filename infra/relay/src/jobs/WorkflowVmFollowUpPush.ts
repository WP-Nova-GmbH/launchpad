import * as NodeCrypto from "node:crypto";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES,
  type WorkflowVmDispatchBinding,
  type WorkflowVmFollowUpBaseline,
  type WorkflowVmFollowUpPublishingRequest,
  type WorkflowVmFollowUpPublishingResponse,
  type WorkflowVmFollowUpPushResult,
} from "@t3tools/contracts/workflows";
import { LAUNCHPAD_JOB_BRANCH_PREFIX, jobBranchName } from "@t3tools/shared/workflowStorage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { RelayDb } from "../db.ts";
import { relayInternalErrorResponse } from "../http/Api.ts";
import { tenancyConflict, tenancyNotFound } from "../http/tenancyErrors.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadArtifactStore } from "../threads/ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "../threads/ThreadArtifactTransfer.ts";
import { latestWorkflowVmSavedDiskRestore } from "../threads/WorkflowVmFollowUpState.ts";
import { type authorizeWorkflowVmGuest, withWorkflowVmGuest } from "./WorkflowVmBinding.ts";
import { lockWorkflowVmCheckpoint } from "./WorkflowVmCheckpoint.ts";
import {
  requireWorkflowVmFollowUpActor,
  requireWorkflowVmFollowUpWorkspace,
} from "./WorkflowVmFollowUpAccess.ts";
import { observeWorkflowVmGitHub, recheckWorkflowVmGitHub } from "./WorkflowVmGithub.ts";

interface Intent {
  readonly binding: WorkflowVmDispatchBinding;
  readonly canonicalKey: string;
  readonly installationId: string;
  readonly branch: string;
  readonly baselineSha: string;
  readonly oldRemoteSha: string | null;
  readonly newSha: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly attempts: number;
  readonly commandId: string | null;
  readonly retiredCommandIds: readonly string[];
  readonly failureDetail?: string;
}
type Status = "preparing" | "pending" | "armed" | "pushed" | "conflict" | "failed";
interface Push {
  readonly operationId: string;
  readonly actorUserId: string;
  readonly status: Status;
  readonly record: Intent;
}
const changed = () => tenancyConflict("thread_placement_changed");
const unavailable = () => tenancyNotFound("thread_not_found");
const storageError = () => relayInternalErrorResponse("persistence_failed");

export const readWorkflowVmFollowUpPublishedHead = Effect.fnUntraced(function* (
  sql: PgClient,
  jobId: string,
) {
  const [prior] = yield* sql<{ publishedSha: string; publishedBranch: string }>`
    SELECT record#>>'{outcome,commitSha}' AS "publishedSha",record->>'branch' AS "publishedBranch"
    FROM relay_workflow_vm_publications WHERE job_id=${jobId}
      AND record->>'operation'='push' AND record#>>'{outcome,commitSha}' IS NOT NULL
    ORDER BY ordinal DESC LIMIT 1`;
  return prior ?? { publishedSha: null, publishedBranch: null };
});

const readWorkflowVmFollowUpPendingPush = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: { jobId: string; userId?: string },
) {
  const [push] =
    yield* sql<Push>`SELECT operation_id AS "operationId",actor_user_id AS "actorUserId",status,record
    FROM relay_workflow_vm_follow_up_pushes WHERE job_id=${scope.jobId}
      AND status IN ('preparing','pending','armed')
      ${scope.userId === undefined ? sql`` : sql`AND actor_user_id=${scope.userId}`}`;
  return push ?? null;
});

const readConfirmedFollowUpHead = Effect.fnUntraced(function* (sql: PgClient, jobId: string) {
  const [push] = yield* sql<{ sha: string }>`SELECT record->>'newSha' AS sha
    FROM relay_workflow_vm_follow_up_pushes WHERE job_id=${jobId}
      AND status='pushed' ORDER BY updated_at DESC LIMIT 1`;
  return push?.sha ?? (yield* readWorkflowVmFollowUpPublishedHead(sql, jobId)).publishedSha;
});

const publicResult = (push: Push, detail: string | null = null): WorkflowVmFollowUpPushResult => ({
  operationId: push.operationId,
  branch: push.record.branch,
  commitSha: push.record.newSha,
  status:
    push.status === "pushed" || push.status === "conflict" || push.status === "failed"
      ? push.status
      : "pending",
  detail:
    detail ??
    push.record.failureDetail ??
    (push.status === "conflict"
      ? "The workflow branch changed on GitHub."
      : push.status === "failed"
        ? "The workflow commit was not pushed."
        : null),
});
const reply = (push: Push, detail?: string) =>
  ({ kind: "result", result: publicResult(push, detail) }) as const;

const readRemote = (record: Intent) =>
  observeWorkflowVmGitHub({
    ...record.binding,
    canonicalKey: record.canonicalKey,
    installationId: record.installationId,
    target: { kind: "branch", branch: record.branch },
  }).pipe(
    Effect.map((observed) => (observed.kind === "branch" ? observed.sha : undefined)),
    Effect.catchTag("GithubRequestFailed", (error) =>
      Effect.succeed(
        error.operation === "read-branch" && error.status === 404 && !error.permissionDenied
          ? null
          : undefined,
      ),
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.timeoutOrElse({ duration: "12 seconds", orElse: () => Effect.succeed(undefined) }),
  );

const sourceConfirmedGone = Effect.fnUntraced(function* (
  sql: PgClient,
  binding: WorkflowVmDispatchBinding,
) {
  const [source] = yield* sql`SELECT 1 FROM relay_thread_vm_allocations a
    WHERE a.allocation_id=${binding.allocationId} AND a.thread_id=${binding.threadId}
      AND a.state='deleted' AND a.deleted_at IS NOT NULL
      AND (
        (a.deletion_stop_receipt->>'kind'='native-workflow-source-lost'
          AND a.deletion_stop_receipt->>'confirmedAbsent'='true'
          AND a.deletion_stop_receipt->>'jobId'=${binding.jobId}
          AND a.deletion_stop_receipt->>'sourceOperationId'=${binding.operationId}
          AND a.deletion_stop_receipt->>'generation'=${String(binding.generation)})
        OR EXISTS(SELECT 1 FROM relay_thread_vm_final_saves f
          WHERE f.allocation_id=a.allocation_id AND f.compute_ref=a.compute_ref
            AND f.thread_id=a.thread_id AND f.environment_id=${binding.environmentId}
          AND f.generation=${binding.generation} AND f.phase='completed')
      )`;
  return source !== undefined;
});

const finishPush = Effect.fnUntraced(function* (
  sql: PgClient,
  push: Push,
  status: "pushed" | "conflict" | "failed",
  failureDetail?: string,
) {
  const record = failureDetail === undefined ? push.record : { ...push.record, failureDetail };
  yield* sql`UPDATE relay_workflow_vm_follow_up_pushes SET status=${status},record=${sql.json(record)},updated_at=now()
    WHERE operation_id=${push.operationId}`;
  yield* sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()
    WHERE artifact_id=${push.operationId} AND kind='follow-up-push' AND state='complete'`;
  return { ...push, status, record } satisfies Push;
});

/** A preparing attempt cannot arm a writer once its bundle has entered deletion. */
const settleExpiredPreparingPush = Effect.fnUntraced(function* (sql: PgClient, push: Push) {
  if (push.status !== "preparing") return push;
  const [expired] = yield* sql`SELECT 1 FROM relay_thread_artifacts
    WHERE artifact_id=${push.operationId} AND operation_id=${push.operationId}
      AND thread_id=${push.record.binding.threadId} AND kind='follow-up-push'
      AND state IN ('deleting','deleted') FOR UPDATE`;
  return expired
    ? yield* finishPush(
        sql,
        push,
        "failed",
        "The saved Git bundle expired. Click Push to start a new attempt.",
      )
    : push;
});

const hasFollowUpPushRecovery = Effect.fnUntraced(function* (
  sql: PgClient,
  binding: WorkflowVmDispatchBinding,
) {
  const [recoverable] = yield* sql`SELECT 1 FROM relay_thread_placements t
    JOIN relay_workflow_vm_follow_ups active ON active.job_id=t.workflow_job_id
    JOIN relay_thread_vm_policies policy ON policy.organization_id=t.organization_id
    WHERE t.thread_id=${binding.threadId} AND t.workflow_job_id=${binding.jobId} AND (
      (t.generation>${binding.generation} AND EXISTS (
        SELECT 1 FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_provisions p ON p.allocation_id=a.allocation_id
        WHERE a.thread_id=t.thread_id AND a.deleted_at IS NULL AND p.generation=t.generation))
      OR EXISTS (
        SELECT 1 FROM relay_thread_vm_saved_disks d
        JOIN relay_thread_vm_backups b ON b.operation_id=d.backup_operation_id
        LEFT JOIN LATERAL (${latestWorkflowVmSavedDiskRestore(sql)}) last_restore ON true
        WHERE d.thread_id=t.thread_id AND b.phase='verified'
          AND b.source_receipt#>>'{workflowCheckpoint,jobId}'=t.workflow_job_id
          AND b.source_receipt#>>'{workflowCheckpoint,finishedWorkspaceRevision}'=active.workspace_revision::text
          AND ((d.phase='available'
            AND (last_restore.phase='aborted' AND last_restore.error_code='snapshot_unavailable') IS NOT TRUE
            AND ((d.saved_at AT TIME ZONE policy.calendar_time_zone
              + make_interval(days=>policy.saved_disk_retention_days)) AT TIME ZONE policy.calendar_time_zone)
              > clock_timestamp())
            OR (d.phase='restoring' AND EXISTS (
              SELECT 1 FROM relay_thread_vm_restores r
              JOIN relay_thread_vm_backup_pins pin ON pin.operation_id=r.operation_id AND pin.backup_operation_id=b.operation_id
              WHERE r.operation_id=t.operation_id AND r.saved_disk_operation_id=d.operation_id
                AND r.thread_id=t.thread_id AND r.phase NOT IN ('aborted','completed'))))))`;
  return recoverable !== undefined;
});

/** A stopped or absent writer permits observation even after the actor loses access. */
const reconcilePendingPush = Effect.fn("WorkflowVmFollowUpPush.reconcile")(function* (
  pending: Push,
) {
  const sql = (yield* RelayDb).$client;
  const { binding } = pending.record;
  const sourceGone = yield* sourceConfirmedGone(sql, binding);
  if (pending.status === "armed" && !sourceGone)
    return publicResult(pending, "The previous push is still being checked.");
  const remote =
    pending.status === "preparing"
      ? pending.record.oldRemoteSha
      : yield* readRemote(pending.record);
  if (remote === undefined)
    return publicResult(pending, "GitHub has not confirmed the workflow branch.");
  const status =
    pending.status !== "preparing" && remote === pending.record.newSha
      ? "pushed"
      : remote !== pending.record.oldRemoteSha
        ? "conflict"
        : "failed";
  const detail =
    status === "conflict"
      ? "The workflow branch changed on GitHub."
      : status === "failed"
        ? "The previous VM disappeared before the commit was pushed."
        : null;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockWorkflowVmCheckpoint(sql, binding.jobId))) return null;
      const [current] =
        yield* sql<Push>`SELECT operation_id AS "operationId",actor_user_id AS "actorUserId",status,record
      FROM relay_workflow_vm_follow_up_pushes WHERE job_id=${binding.jobId}
        AND operation_id=${pending.operationId} FOR UPDATE`;
      if (!current) return null;
      if (
        current.status !== pending.status ||
        current.record.attempts !== pending.record.attempts ||
        current.record.commandId !== pending.record.commandId ||
        current.record.binding.generation !== binding.generation
      )
        return publicResult(current);
      const checked = yield* settleExpiredPreparingPush(sql, current);
      if (checked.status !== current.status) return publicResult(checked);
      if (
        remote === current.record.oldRemoteSha &&
        current.record.attempts < 2 &&
        (!sourceGone || (yield* hasFollowUpPushRecovery(sql, binding)))
      ) {
        const actorAllowed = yield* requireWorkflowVmFollowUpActor(
          sql,
          binding,
          current.actorUserId,
        ).pipe(
          Effect.as(true),
          Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(false)),
        );
        if (actorAllowed)
          return publicResult(
            current,
            sourceGone
              ? "Restore the workflow VM to retry this same commit."
              : "Retry to push this same commit.",
          );
        return publicResult(
          yield* finishPush(sql, current, "failed"),
          "The person who requested this push no longer has access.",
        );
      }
      return publicResult(yield* finishPush(sql, current, status), detail);
    }),
  );
});

export const reconcileWorkflowVmFollowUpPush = Effect.fnUntraced(function* (input: {
  readonly jobId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly userId: string;
}) {
  const sql = (yield* RelayDb).$client;
  // A signed-in viewer must still have follow-up access to see the receipt.
  const push = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* requireWorkflowVmFollowUpActor(sql, input, input.userId);
      const pending = yield* readWorkflowVmFollowUpPendingPush(sql, { jobId: input.jobId });
      if (pending) return pending;
      const [latest] =
        yield* sql<Push>`SELECT operation_id AS "operationId",actor_user_id AS "actorUserId",status,record
      FROM relay_workflow_vm_follow_up_pushes WHERE job_id=${input.jobId} AND actor_user_id=${input.userId}
      ORDER BY updated_at DESC LIMIT 1`;
      return latest ?? null;
    }),
  );
  if (!push) return null;
  if (push.status === "pushed" || push.status === "failed" || push.status === "conflict")
    return publicResult(push);
  return yield* reconcilePendingPush(push);
});

/** Use the existing host sweep, independent of an open app. Never dispatch a write here. */
export const reconcileOneWorkflowVmFollowUpPush = Effect.fnUntraced(function* (hostId: string) {
  const sql = (yield* RelayDb).$client;
  const [pending] = yield* sql<Push>`WITH candidate AS (
    SELECT p.operation_id FROM relay_workflow_vm_follow_up_pushes p
    JOIN relay_thread_vm_allocations a ON a.allocation_id=p.record#>>'{binding,allocationId}'
    WHERE (p.status IN ('preparing','pending') OR (p.status='armed' AND a.state='deleted'))
      AND EXISTS (SELECT 1 FROM relay_thread_vm_capacity c WHERE c.allocation_id=a.allocation_id AND c.host_id=${hostId})
      AND p.updated_at<clock_timestamp()-interval '30 seconds'
    ORDER BY p.updated_at,p.operation_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED
  ) UPDATE relay_workflow_vm_follow_up_pushes p SET updated_at=clock_timestamp()
    FROM candidate WHERE p.operation_id=candidate.operation_id
    RETURNING p.operation_id AS "operationId",p.actor_user_id AS "actorUserId",p.status,p.record`;
  if (pending) yield* reconcilePendingPush(pending);
});

/** The downloadable payload is only available to the current, trusted workflow VM. */
export const handleWorkflowVmFollowUpPush = Effect.fn("WorkflowVmFollowUpPush.request")(
  function* (
    input: WorkflowVmFollowUpPublishingRequest & { environmentId: string; threadId: string },
  ) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    const store = makeThreadArtifactStore(sql);
    const transfer = makeThreadArtifactTransfer(sql, objects);
    const github = yield* GithubApp;
    const request = input.request;
    const authorize = <A, E, R>(
      run: (
        scope: Effect.Success<ReturnType<typeof authorizeWorkflowVmGuest>>,
      ) => Effect.Effect<A, E, R>,
    ) =>
      withWorkflowVmGuest(input, request.kind === "stop" ? "enrolled" : "active", (scope) =>
        (request.kind === "stop"
          ? Effect.void
          : requireWorkflowVmFollowUpActor(sql, scope.binding, input.actorUserId).pipe(
              Effect.andThen(requireWorkflowVmFollowUpWorkspace(sql, scope.binding)),
            )
        ).pipe(Effect.andThen(run(scope))),
      );
    const load = Effect.fnUntraced(function* () {
      const [exact] =
        yield* sql<Push>`SELECT operation_id AS "operationId",actor_user_id AS "actorUserId",status,record
        FROM relay_workflow_vm_follow_up_pushes WHERE job_id=${input.jobId}
          AND operation_id=${input.operationId} AND actor_user_id=${input.actorUserId}`;
      return (
        exact ??
        (request.kind === "stop"
          ? null
          : yield* readWorkflowVmFollowUpPendingPush(sql, {
              jobId: input.jobId,
              userId: input.actorUserId,
            }))
      );
    });
    const loadChecked = Effect.fnUntraced(function* () {
      const current = yield* load();
      return current ? yield* settleExpiredPreparingPush(sql, current) : null;
    });
    let push = yield* authorize(loadChecked);
    if (!push && request.kind === "read" && request.headSha) {
      const headSha = request.headSha;
      const previous = yield* authorize(
        Effect.fnUntraced(function* ({ binding }) {
          const [latest] = yield* sql<Push>`SELECT
          operation_id AS "operationId",status,record,actor_user_id AS "actorUserId"
          FROM relay_workflow_vm_follow_up_pushes
          WHERE job_id=${binding.jobId} AND status='pushed' ORDER BY updated_at DESC LIMIT 1`;
          return latest?.actorUserId === input.actorUserId && latest.record.newSha === headSha
            ? latest
            : null;
        }),
      );
      if (previous) return reply(previous);
    }
    if (request.kind === "prepare") {
      const bytes = Buffer.from(request.bundle, "base64");
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > WORKFLOW_VM_FOLLOW_UP_MAX_BUNDLE_BYTES ||
        bytes.toString("base64") !== request.bundle ||
        request.sha === request.baseline.sha
      )
        return yield* changed();
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const sizeBytes = bytes.byteLength;
      push = yield* authorize(
        Effect.fnUntraced(function* ({ binding, snapshot }) {
          const prior = yield* loadChecked();
          if (prior) {
            if (prior.record.newSha !== request.sha) return yield* changed();
            return prior;
          }
          const [rival] = yield* sql`SELECT operation_id FROM relay_workflow_vm_follow_up_pushes
            WHERE job_id=${binding.jobId} AND status IN ('preparing','pending','armed')`;
          if (rival) return yield* changed();
          const { publishedSha, publishedBranch } = yield* readWorkflowVmFollowUpPublishedHead(
            sql,
            binding.jobId,
          );
          const branch =
            publishedBranch ?? jobBranchName(binding.jobId, LAUNCHPAD_JOB_BRANCH_PREFIX);
          if (
            request.baseline.branch !== branch ||
            request.baseline.baseSha !== snapshot.commitSha ||
            (publishedSha !== null && request.baseline.sha !== publishedSha)
          )
            return yield* changed();
          yield* recheckWorkflowVmGitHub(sql, binding, snapshot);
          yield* sql`INSERT INTO relay_workflow_vm_follow_up_baselines
            (job_id,branch,sha,tree_sha,base_sha)
            VALUES (${binding.jobId},${branch},${request.baseline.sha},${request.baseline.treeSha},${snapshot.commitSha})
            ON CONFLICT (job_id) DO NOTHING`;
          const [baseline] = yield* sql<WorkflowVmFollowUpBaseline>`SELECT
            branch,sha,tree_sha AS "treeSha",base_sha AS "baseSha"
            FROM relay_workflow_vm_follow_up_baselines WHERE job_id=${binding.jobId}`;
          if (
            !baseline ||
            baseline.branch !== request.baseline.branch ||
            baseline.sha !== request.baseline.sha ||
            baseline.treeSha !== request.baseline.treeSha ||
            baseline.baseSha !== request.baseline.baseSha
          )
            return yield* changed();
          const oldRemoteSha = yield* readConfirmedFollowUpHead(sql, binding.jobId);
          if (oldRemoteSha !== request.oldRemoteSha) return yield* changed();
          const record: Intent = {
            binding,
            canonicalKey: snapshot.canonicalKey,
            installationId: snapshot.installationId,
            branch,
            baselineSha: baseline.sha,
            newSha: request.sha,
            oldRemoteSha,
            sha256,
            sizeBytes,
            attempts: 0,
            commandId: null,
            retiredCommandIds: [],
          };
          yield* sql`INSERT INTO relay_workflow_vm_follow_up_pushes
            (operation_id,job_id,actor_user_id,generation,status,record)
            VALUES (${input.operationId},${binding.jobId},${input.actorUserId},
              ${binding.generation},'preparing',${sql.json(record)})`;
          return {
            operationId: input.operationId,
            actorUserId: input.actorUserId,
            status: "preparing",
            record,
          } as const;
        }),
      );
      if (push.status === "preparing") {
        if (push.record.sha256 !== sha256 || push.record.sizeBytes !== sizeBytes)
          return yield* changed();
        const artifact = yield* store.begin({
          artifactId: push.operationId,
          operationId: push.operationId,
          threadId: input.threadId,
          kind: "follow-up-push",
          sha256,
          sizeBytes,
        });
        if (artifact.state === "pending") {
          yield* transfer.uploadBytes(
            artifact,
            new ReadableStream<Uint8Array>({
              start: (control) => {
                control.enqueue(new Uint8Array(bytes));
                control.close();
              },
            }),
          );
        }
        push = yield* authorize(
          Effect.fnUntraced(function* () {
            const current = yield* load();
            if (!current || current.operationId !== artifact.operationId) return yield* changed();
            if (current.status !== "preparing") return current;
            yield* store.complete({
              artifactId: artifact.artifactId,
              sha256,
              sizeBytes,
              retentionDays: null,
            });
            yield* sql`UPDATE relay_workflow_vm_follow_up_pushes SET status='pending',updated_at=now()
            WHERE operation_id=${artifact.operationId} AND status='preparing'`;
            const fresh = yield* load();
            if (!fresh) return yield* changed();
            return fresh;
          }),
        );
      }
    }
    if (!push && request.kind === "stop") return { kind: "ok" } as const;
    if (!push)
      return {
        kind: "prepare",
        sha: null,
        oldRemoteSha: yield* authorize(({ binding }) =>
          readConfirmedFollowUpHead(sql, binding.jobId),
        ),
      } as const;
    if (
      push.record.binding.generation !== input.generation &&
      (push.status === "armed" || push.status === "pending" || push.status === "preparing")
    ) {
      if (request.kind !== "read" || !(yield* sourceConfirmedGone(sql, push.record.binding)))
        return reply(push, "This push belongs to an earlier VM connection.");
      const previous = push;
      const remote =
        previous.status === "preparing"
          ? previous.record.oldRemoteSha
          : yield* readRemote(previous.record);
      if (remote === undefined)
        return reply(previous, "GitHub has not confirmed the workflow branch.");
      push = yield* authorize(
        Effect.fnUntraced(function* ({ binding, snapshot }) {
          const current = yield* load();
          if (
            !current ||
            current.operationId !== previous.operationId ||
            current.status !== previous.status ||
            current.record.attempts !== previous.record.attempts ||
            current.record.binding.generation !== previous.record.binding.generation ||
            current.record.binding.generation >= binding.generation ||
            current.record.installationId !== snapshot.installationId ||
            current.record.canonicalKey !== snapshot.canonicalKey
          )
            return yield* changed();
          if (current.status !== "preparing" && remote === current.record.newSha)
            return yield* finishPush(sql, current, "pushed");
          if (remote !== current.record.oldRemoteSha)
            return yield* finishPush(sql, current, "conflict");
          if (current.record.attempts >= 2) return yield* finishPush(sql, current, "failed");
          yield* recheckWorkflowVmGitHub(sql, binding, current.record);
          const status = current.status === "preparing" ? "preparing" : "pending";
          const record: Intent = {
            ...current.record,
            binding,
            retiredCommandIds: current.record.commandId
              ? [...current.record.retiredCommandIds, current.record.commandId]
              : current.record.retiredCommandIds,
            commandId: null,
          };
          yield* sql`UPDATE relay_workflow_vm_follow_up_pushes SET generation=${binding.generation},
          status=${status},record=${sql.json(record)},updated_at=now() WHERE operation_id=${current.operationId}`;
          return { ...current, status, record } satisfies Push;
        }),
      );
    }
    if (request.kind === "confirm") {
      return yield* authorize(
        Effect.fnUntraced(function* ({ binding, snapshot }) {
          const current = yield* load();
          if (
            current?.status !== "armed" ||
            current.record.commandId !== request.commandId ||
            current.record.binding.allocationId !== binding.allocationId ||
            current.record.installationId !== snapshot.installationId ||
            current.record.canonicalKey !== snapshot.canonicalKey
          )
            return yield* changed();
          yield* recheckWorkflowVmGitHub(sql, binding, current.record);
          return { kind: "ok" } as const;
        }),
      );
    }
    if (request.kind === "stop") {
      push = yield* authorize(
        Effect.fnUntraced(function* () {
          const current = yield* load();
          if (!current) return yield* unavailable();
          if (
            current.record.retiredCommandIds.includes(request.commandId) ||
            (current.status !== "pending" &&
              (current.status !== "armed" || current.record.commandId !== request.commandId))
          )
            return current;
          const record: Intent = {
            ...current.record,
            commandId: null,
            retiredCommandIds: [...current.record.retiredCommandIds, request.commandId],
          };
          yield* sql`UPDATE relay_workflow_vm_follow_up_pushes SET status='pending',
          record=${sql.json(record)},updated_at=now() WHERE operation_id=${current.operationId}`;
          return { ...current, record, status: "pending" } as const;
        }),
      );
    }
    if (!["preparing", "pending", "armed"].includes(push.status)) return reply(push);
    if (push.status === "preparing")
      return {
        kind: "prepare",
        sha: push.record.newSha,
        oldRemoteSha: push.record.oldRemoteSha,
      } as const;
    const remote = yield* readRemote(push.record);
    if (remote === undefined) return reply(push, "GitHub has not confirmed the workflow branch.");
    const observedPush = push;
    if (
      push.status === "pending" &&
      (remote !== push.record.oldRemoteSha || push.record.attempts >= 2)
    ) {
      const status =
        remote === push.record.newSha
          ? "pushed"
          : remote !== push.record.oldRemoteSha
            ? "conflict"
            : "failed";
      return yield* authorize(
        Effect.fnUntraced(function* () {
          const current = yield* load();
          if (!current) return yield* unavailable();
          if (
            current.status !== observedPush.status ||
            current.record.attempts !== observedPush.record.attempts
          )
            return reply(current, "The previous push is still being checked.");
          return reply(
            yield* finishPush(sql, current, status),
            status === "conflict"
              ? "The workflow branch changed on GitHub."
              : status === "failed"
                ? "GitHub did not accept the commit after retry."
                : undefined,
          );
        }),
      );
    }
    if (push.status === "armed" || request.kind === "stop")
      return reply(push, "GitHub has not confirmed the workflow commit yet.");
    if (request.kind === "arm") {
      const minted = yield* github.mintRepositoryToken({ ...push.record, access: "workflow-push" });
      return yield* authorize(
        Effect.fnUntraced(function* ({ binding, snapshot }) {
          const current = yield* load();
          if (!current) return yield* unavailable();
          if (
            current.status !== "pending" ||
            current.record.attempts !== observedPush.record.attempts ||
            current.record.retiredCommandIds.includes(request.commandId) ||
            current.record.binding.allocationId !== binding.allocationId ||
            current.record.canonicalKey !== snapshot.canonicalKey ||
            current.record.installationId !== snapshot.installationId
          )
            return reply(current, "The previous push is still being checked.");
          yield* recheckWorkflowVmGitHub(sql, binding, current.record);
          const record: Intent = {
            ...current.record,
            commandId: request.commandId,
            attempts: current.record.attempts + 1,
          };
          yield* sql`UPDATE relay_workflow_vm_follow_up_pushes SET status='armed',record=${sql.json(record)},
          updated_at=now() WHERE operation_id=${current.operationId}`;
          return { kind: "credential", token: Redacted.make(minted.token) } as const;
        }),
      );
    }
    const artifact = yield* store.get(push.operationId);
    if (
      artifact?.state !== "complete" ||
      artifact.kind !== "follow-up-push" ||
      artifact.threadId !== input.threadId ||
      artifact.sha256 !== push.record.sha256 ||
      artifact.sizeBytes !== push.record.sizeBytes
    )
      return yield* storageError();
    let size = 0;
    const chunks = yield* objects.read(artifact.storageKey).pipe(
      Effect.flatMap((body) =>
        body.pipe(
          Stream.tap((chunk) => {
            size += chunk.byteLength;
            return size <= artifact.sizeBytes ? Effect.void : storageError();
          }),
          Stream.runCollect,
        ),
      ),
    );
    const bytes = Buffer.concat(chunks);
    if (
      bytes.byteLength !== push.record.sizeBytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== push.record.sha256
    )
      return yield* storageError();
    yield* authorize(() => Effect.void);
    return {
      kind: "ready",
      result: publicResult(push),
      oldRemoteSha: push.record.oldRemoteSha,
      canonicalKey: push.record.canonicalKey,
      bundle: bytes.toString("base64"),
    } satisfies WorkflowVmFollowUpPublishingResponse;
  },
  Effect.catchTags({
    PlatformError: storageError,
    SqlError: storageError,
    ThreadArtifactConflict: storageError,
    ThreadArtifactObjectError: storageError,
    GithubAppNotConfigured: unavailable,
    GithubRequestFailed: storageError,
    WorkflowInvalidError: changed,
  }),
);
