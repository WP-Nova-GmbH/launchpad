import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import {
  ThreadVmConnectionUnavailable,
  type ThreadVmConnectionTarget,
} from "./ThreadVmConnection.ts";

/** A read-only snapshot of an already running VM, never a request to provision or resume it. */
const readThreadVmTarget = Effect.fn("relay.thread_vm_connection.authorize")(
  function* (userId: string, threadId: ThreadId, allowPaused: boolean) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadOwnerAccess(threadId, "read", userId, (placement) =>
      Effect.gen(function* () {
        if (placement.operationId !== null) return yield* new ThreadVmConnectionUnavailable();
        // Match the writer's allocation-before-binding lock order. No network work runs under these locks.
        const [allocation] = yield* sql<{
          allocationId: string;
          sandboxId: string;
          templateId: string;
          state: "running" | "paused";
        }>`
          SELECT allocation_id AS "allocationId", compute_ref AS "sandboxId", template_id AS "templateId", state
          FROM relay_thread_vm_allocations WHERE thread_id = ${threadId}
          AND (state = 'running' OR (${allowPaused} AND state = 'paused')) AND deleted_at IS NULL AND compute_ref IS NOT NULL
          AND (${allowPaused} OR NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
            WHERE x.allocation_id = relay_thread_vm_allocations.allocation_id
              AND x.phase IN ('pending','sealed')))
          AND (${allowPaused} OR NOT EXISTS (SELECT 1 FROM relay_thread_vm_resumes r
            WHERE r.allocation_id = relay_thread_vm_allocations.allocation_id
              AND r.phase IN ('waiting','resuming')))
          FOR SHARE`;
        if (!allocation) return yield* new ThreadVmConnectionUnavailable();
        const [binding] = yield* sql<{
          environmentPublicKey: string;
          credentialId: string;
          operationId: string;
        }>`
          SELECT b.environment_public_key AS "environmentPublicKey", b.credential_id AS "credentialId", p.operation_id AS "operationId"
          FROM relay_thread_vm_bindings b
          JOIN relay_environment_credentials c ON c.credential_id = b.credential_id
          JOIN relay_thread_vm_provisions p ON p.allocation_id = b.allocation_id
          JOIN relay_thread_vm_enrollments e ON e.allocation_id = b.allocation_id
          JOIN relay_thread_vm_ready s ON s.allocation_id = b.allocation_id
          WHERE b.allocation_id = ${allocation.allocationId} AND b.thread_id = ${threadId}
          AND b.environment_id = ${placement.environmentId} AND b.repository_id = ${placement.repositoryId}
          AND b.generation = ${placement.generation} AND b.revoked_at IS NULL
          AND c.environment_id = b.environment_id AND c.environment_public_key = b.environment_public_key AND c.revoked_at IS NULL
          AND p.phase = 'created' AND p.generation = b.generation
          AND e.operation_id = p.operation_id AND e.environment_id = b.environment_id
          AND e.environment_public_key = b.environment_public_key AND e.credential_id = b.credential_id AND e.installed_at IS NOT NULL
          AND s.environment_id = b.environment_id AND s.phase = 'ready' AND s.receipt_sha256 IS NOT NULL
          FOR SHARE OF b,c,p,e`;
        if (!binding) return yield* new ThreadVmConnectionUnavailable();
        return {
          state: allocation.state,
          environmentId: EnvironmentId.make(placement.environmentId),
          projectId: ProjectId.make(placement.projectId),
          environmentPublicKey: binding.environmentPublicKey,
          credentialId: binding.credentialId,
          sandboxId: allocation.sandboxId,
          identity: {
            operationId: binding.operationId,
            templateId: allocation.templateId,
            scope: {
              allocationId: allocation.allocationId,
              threadId,
              repositoryId: placement.repositoryId,
              generation: placement.generation,
            },
          },
        } satisfies ThreadVmConnectionTarget & { state: "running" | "paused" };
      }),
    );
  },
  Effect.mapError(() => new ThreadVmConnectionUnavailable()),
);

/** Connection requests require running compute; status reads may observe a paused VM without waking it. */
export const authorizeThreadVmConnection = (userId: string, threadId: ThreadId) =>
  readThreadVmTarget(userId, threadId, false);
export const authorizeThreadVmStatus = (userId: string, threadId: ThreadId) =>
  readThreadVmTarget(userId, threadId, true);
