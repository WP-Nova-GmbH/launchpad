import { assertWorkflowThreadReleased } from "../persistence/WorkflowThreadOwnership.ts";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ThreadPromptQueue,
  ModelSelection,
  OrchestrationSession,
} from "@t3tools/contracts";
import { OrchestrationCommandReceipt } from "@t3tools/contracts/threadTransfer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";
import type { makeThreadHistorySync } from "./ThreadHistorySync.ts";
import { ThreadMoveError } from "./ThreadMoveTransport.ts";
import type { ThreadLocalEnrollmentTransport } from "./ThreadLocalEnrollmentTransport.ts";
const decodeQueue = Schema.decodeEffect(Schema.fromJsonString(ThreadPromptQueue));
const decodeModel = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(OrchestrationCommandReceipt));
const decodeSession = Schema.decodeUnknownEffect(OrchestrationSession);
interface Intent {
  threadId: string;
  operationId: string;
  projectId: string;
  relayUrl: string;
  environmentId: string;
  canonicalKey: string;
  actorUserId: string;
  phase: "pending" | "active";
}

/** First enrollment drains ordinary work once. Retries never open its fence on an uncertain relay reply. */
export const makeThreadLocalEnrollmentWorker = Effect.fn("ThreadLocalEnrollmentWorker.make")(
  function* (
    transport: ThreadLocalEnrollmentTransport,
    history: ReturnType<typeof makeThreadHistorySync>,
  ) {
    const sql = yield* SqlClient.SqlClient,
      engine = yield* OrchestrationEngineService,
      provider = yield* ProviderService,
      registry = yield* ProviderInstanceRegistry,
      resolver = yield* RepositoryIdentityResolver,
      terminals = yield* TerminalManager,
      fences = makeThreadExecutionFence(sql);
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const fail = (threadId: string, detail: string) => new ThreadMoveError({ threadId, detail });
    const read = Effect.fnUntraced(function* (threadId: string) {
      const [intent] =
        yield* sql<Intent>`SELECT thread_id AS "threadId",operation_id AS "operationId",project_id AS "projectId",
      relay_url AS "relayUrl",environment_id AS "environmentId",canonical_key AS "canonicalKey",actor_user_id AS "actorUserId",phase
      FROM thread_local_enrollments WHERE thread_id=${threadId}`;
      return intent ?? null;
    });
    const idle = Effect.fnUntraced(function* (threadId: string) {
      const busy = yield* sql`SELECT 1 FROM projection_turns WHERE thread_id=${threadId}
      AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
      UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId} AND (completed=0 OR relay_completed=0)
      UNION ALL SELECT 1 FROM provider_session_runtime r WHERE r.thread_id=${threadId}
        AND json_extract(r.runtime_payload_json,'$.activeTurnId') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id=r.thread_id
          AND t.turn_id=json_extract(r.runtime_payload_json,'$.activeTurnId')
          AND t.completed_at IS NOT NULL AND t.state IN ('completed','failed','interrupted')
          AND t.checkpoint_status IN ('ready','skipped','error')) LIMIT 1`;
      if (busy.length) return false;
      // The persisted runtime marker names the last admitted turn, not live
      // activity. Its settled receipt is safe only while the adapter is idle too.
      return !(yield* provider.listSessions()).some(
        (session) =>
          session.threadId === threadId &&
          (session.activeTurnId !== undefined ||
            session.status === "running" ||
            session.status === "connecting"),
      );
    });
    const synchronize = Effect.fn("ThreadLocalEnrollmentWorker.synchronize")(function* (
      threadId: string,
      discovery: ThreadHistoryOwner,
    ) {
      let intent = yield* read(threadId),
        fence = yield* fences.get(threadId);
      if (intent?.phase === "active" || (!intent && fence)) return true;
      if (!intent) {
        const [row] = yield* sql<{
          queue: string;
          model: string;
          projectId: string;
          workspace: string;
          worktree: string | null;
          archivedAt: string | null;
        }>`
        SELECT q.state_json AS queue,t.model_selection_json AS model,t.project_id AS "projectId",p.workspace_root AS workspace,
          t.worktree_path AS worktree,t.archived_at AS "archivedAt" FROM projection_threads t
          JOIN projection_thread_prompt_queues q USING(thread_id) JOIN projection_projects p USING(project_id)
        WHERE t.thread_id=${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
        if (!row) return false;
        const queue = yield* decodeQueue(row.queue),
          head = queue.entries[0],
          model = yield* decodeModel(row.model);
        if (
          !head ||
          head.kind !== "move" ||
          !queue.enabled ||
          row.archivedAt ||
          queue.awaitingTurnId ||
          (queue.preparation &&
            (!queue.preparation.settled || queue.preparation.state !== "ready")) ||
          !(yield* idle(threadId))
        )
          return false;
        if ((yield* registry.getInstance(model.instanceId))?.driverKind !== "codex")
          return yield* fail(threadId, "Portable moves currently require Codex.");
        const actorUserId = (head.editedBy ?? head.author)?.userId;
        if (!actorUserId)
          return yield* fail(threadId, "Sign in before moving this private thread.");
        const repository = yield* resolver.resolve(row.worktree ?? row.workspace, {
          refresh: true,
        });
        if (!repository)
          return yield* fail(
            threadId,
            "Register this repository with your relay before moving its thread.",
          );
        yield* assertWorkflowThreadReleased(sql, threadId).pipe(
          Effect.mapError((error) => fail(threadId, error.message)),
        );
        if (head.state === "pending")
          yield* engine.dispatch({
            type: "thread.move.claim",
            threadId: ThreadId.make(threadId),
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            messageId: head.messageId,
            expectedRevision: head.revision,
            expectedControlRevision: queue.revision,
            createdAt: yield* now,
          });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertWorkflowThreadReleased(sql, threadId).pipe(
              Effect.mapError((error) => fail(threadId, error.message)),
            );
            if (!(yield* idle(threadId)))
              return yield* fail(
                threadId,
                "Wait for the current turn and checkpoint before enrollment.",
              );
            yield* sql`INSERT INTO thread_local_enrollments(thread_id,operation_id,project_id,relay_url,environment_id,canonical_key,actor_user_id)
          VALUES(${threadId},${NodeCrypto.randomUUID()},${row.projectId},${discovery.relayUrl},${discovery.environmentId},${repository.canonicalKey},${actorUserId})
          ON CONFLICT(thread_id) DO NOTHING`;
          }),
        );
        intent = yield* read(threadId);
      }
      if (
        !intent ||
        intent.environmentId !== discovery.environmentId ||
        intent.relayUrl !== discovery.relayUrl
      )
        return yield* fail(threadId, "The enrollment relay or source environment changed.");
      const owner = { ...intent, generation: 1 },
        request = {
          operationId: intent.operationId,
          actorUserId: intent.actorUserId,
          canonicalKey: intent.canonicalKey,
          projectId: ProjectId.make(intent.projectId),
        };
      const [control] = yield* sql<{
        queue: string;
      }>`SELECT state_json AS queue FROM projection_thread_prompt_queues WHERE thread_id=${threadId}`;
      const head = control ? (yield* decodeQueue(control.queue)).entries[0] : undefined;
      const [previousAbort] = yield* sql<{
        moveOperationId: string;
      }>`SELECT move_operation_id AS "moveOperationId"
        FROM thread_local_enrollment_aborts WHERE operation_id=${intent.operationId} AND thread_id=${threadId}`;
      if (
        previousAbort &&
        (head?.kind !== "move" || head.operationId !== previousAbort.moveOperationId)
      ) {
        // A crash after the queue receipt may leave only the already-cancelled enrollment intent.
        if ((yield* fences.get(threadId))?.operationId === intent.operationId)
          return yield* fail(
            threadId,
            "The cancelled enrollment fence still requires reconciliation.",
          );
        yield* sql`DELETE FROM thread_local_enrollments WHERE thread_id=${threadId} AND operation_id=${intent.operationId}`;
        return false;
      }
      if (head?.kind === "move" && head.state === "cancelling" && head.operationId) {
        const [certificate] = yield* sql<{
          moveOperationId: string;
        }>`SELECT move_operation_id AS "moveOperationId"
          FROM thread_local_enrollment_aborts WHERE operation_id=${intent.operationId} AND thread_id=${threadId}`;
        if (certificate && certificate.moveOperationId !== head.operationId)
          return yield* fail(threadId, "Enrollment cancellation identity changed.");
        const aborted = certificate ? null : yield* transport.abort(owner, request);
        if (
          aborted &&
          (aborted.operationId !== intent.operationId ||
            aborted.threadId !== threadId ||
            aborted.environmentId !== intent.environmentId ||
            aborted.projectId !== intent.projectId ||
            aborted.canonicalKey !== intent.canonicalKey ||
            aborted.actorUserId !== intent.actorUserId)
        )
          return yield* fail(threadId, "The relay did not confirm this enrollment cancellation.");
        if (certificate || aborted?.outcome === "aborted") {
          // The relay has retained an immutable abort certificate and cannot admit this enrollment again.
          // Remove only this never-activated local fence. History, provider state and workspace stay intact.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* fences.get(threadId);
              if (
                current &&
                (current.operationId !== intent!.operationId ||
                  current.generation !== 1 ||
                  current.environmentId !== intent!.environmentId ||
                  !["draining", "frozen"].includes(current.phase))
              )
                return yield* fail(
                  threadId,
                  "A different or active fence cannot be released by initial cancellation.",
                );
              const work =
                yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${threadId}
              UNION ALL SELECT 1 FROM thread_checkout_claims WHERE thread_id=${threadId} LIMIT 1`;
              if (work.length)
                return yield* fail(
                  threadId,
                  "Enrollment cancellation cannot release admitted work.",
                );
              yield* sql`INSERT INTO thread_local_enrollment_aborts(operation_id,thread_id,move_operation_id)
              VALUES(${intent!.operationId},${threadId},${head.operationId}) ON CONFLICT(operation_id) DO NOTHING`;
              yield* sql`DELETE FROM thread_execution_fences WHERE thread_id=${threadId} AND operation_id=${intent!.operationId}`;
            }),
          );
          yield* engine.dispatch({
            type: "thread.move.finish",
            threadId: ThreadId.make(threadId),
            commandId: CommandId.make(`${head.operationId}:initial-cancel:${head.revision}`),
            messageId: head.messageId,
            operationId: head.operationId,
            expectedRevision: head.revision,
            outcome: "cancelled",
            createdAt: yield* now,
          });
          yield* sql`DELETE FROM thread_local_enrollments WHERE thread_id=${threadId} AND operation_id=${intent.operationId}`;
          return false;
        }
      }
      yield* assertWorkflowThreadReleased(sql, threadId).pipe(
        Effect.mapError((error) => fail(threadId, error.message)),
      );
      const prepared = yield* transport.prepare(owner, request);
      if (
        prepared.operationId !== intent.operationId ||
        prepared.threadId !== threadId ||
        prepared.placement.environmentId !== intent.environmentId ||
        prepared.placement.projectId !== intent.projectId ||
        prepared.placement.ownerUserId !== intent.actorUserId ||
        prepared.placement.generation !== 1
      )
        return yield* fail(threadId, "The relay did not confirm this local enrollment.");
      if (!fence) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* idle(threadId)))
              return yield* fail(
                threadId,
                "The source has new work; wait for it before enrollment.",
              );
            yield* fences.prepare(owner);
            yield* sql`UPDATE thread_execution_fences SET phase='draining' WHERE thread_id=${threadId}
          AND operation_id=${intent!.operationId} AND phase='frozen' AND frozen_sequence IS NULL`;
          }),
        );
        fence = yield* fences.get(threadId);
      }
      if (
        !fence ||
        fence.operationId !== intent.operationId ||
        fence.generation !== 1 ||
        fence.environmentId !== intent.environmentId
      )
        return yield* fail(threadId, "The local enrollment fence changed.");
      if (fence.phase === "draining") {
        if (!(yield* idle(threadId))) return false;
        const [runtime] = yield* sql<{
          status: string;
        }>`SELECT status FROM provider_session_runtime WHERE thread_id=${threadId}`;
        if (
          (runtime && runtime.status !== "stopped") ||
          (yield* provider.listSessions()).some((s) => s.threadId === threadId)
        )
          yield* provider.stopSession({ threadId: ThreadId.make(threadId) });
        if (runtime) {
          if (!provider.flushRuntimeEvents)
            return yield* fail(threadId, "Stopped provider output has not been confirmed.");
          yield* provider.flushRuntimeEvents(ThreadId.make(threadId));
          const [session] =
            yield* sql`SELECT thread_id AS "threadId",status,provider_name AS "providerName",provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",active_turn_id AS "activeTurnId",last_error AS "lastError",updated_at AS "updatedAt"
          FROM projection_thread_sessions WHERE thread_id=${threadId}`;
          if (session && session.status !== "stopped")
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`${intent.operationId}:source-stopped`),
              threadId: ThreadId.make(threadId),
              createdAt: yield* now,
              session: yield* decodeSession({
                ...session,
                status: "stopped",
                activeTurnId: null,
                lastError: null,
                updatedAt: yield* now,
              }),
            });
        }
        yield* terminals.close({ threadId: ThreadId.make(threadId), waitForProcessExit: true });
        yield* fences.freeze(owner);
        fence = yield* fences.get(threadId);
      }
      if (fence?.phase !== "frozen" && fence?.phase !== "active") return false;
      if (fence.phase === "frozen") {
        if (fence.frozenSequence === null)
          return yield* fail(threadId, "The frozen enrollment watermark is missing.");
        yield* history.synchronize(threadId);
        let after = "",
          count = 0;
        for (;;) {
          const rows =
            yield* sql`SELECT command_id AS "commandId",aggregate_kind AS "aggregateKind",aggregate_id AS "aggregateId",
          project_id AS "projectId",accepted_at AS "acceptedAt",result_sequence AS "resultSequence",status,error
          FROM orchestration_command_receipts WHERE aggregate_kind='thread' AND aggregate_id=${threadId}
          AND command_id>${after} ORDER BY command_id LIMIT 100`;
          const receipts = yield* decodeReceipts(rows);
          if (!receipts.length) break;
          yield* transport.receipts(owner, { operationId: intent.operationId, receipts });
          count += receipts.length;
          after = receipts.at(-1)!.commandId;
        }
        const confirmed = yield* transport.confirm(owner, {
          operationId: intent.operationId,
          sourceSequence: fence.frozenSequence,
          receiptCount: count,
        });
        if (
          confirmed.phase !== "active" ||
          confirmed.operationId !== intent.operationId ||
          confirmed.threadId !== threadId ||
          confirmed.sourceSequence !== fence.frozenSequence ||
          confirmed.receiptCount !== count ||
          confirmed.placement.environmentId !== intent.environmentId ||
          confirmed.placement.generation !== 1 ||
          confirmed.placement.operationId !== null
        )
          return yield* fail(threadId, "The relay did not confirm the complete local baseline.");
        yield* fences.activate(owner);
      }
      yield* sql`UPDATE thread_local_enrollments SET phase='active' WHERE thread_id=${threadId} AND operation_id=${intent.operationId}`;
      return true;
    });
    return { synchronize };
  },
);
