import type { PgClient } from "@effect/sql-pg/PgClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import { threadVmMoveServerDigest } from "@t3tools/shared/threadVmServerStart";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";

type Start = (
  sandboxId: string,
  identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId"> & {
    readonly templateId?: string;
  },
  digest: string,
  mode: "move",
) => Effect.Effect<void, ThreadVmComputeError>;
/** Start only the import server. A launch acknowledgement never activates the VM. */
export function makeThreadVmMoveServerWorker(sql: PgClient, start: Start, hostId: string) {
  const provisions = makeThreadVmProvisionStore(sql);
  const runOne = Effect.fn("relay.thread_vm_move.start_server")(function* () {
    const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const row = yield* provisions.claimMoveStartup(claimId, hostId);
    if (!row || !row.computeRef) return false;
    const release = (errorCode: "startup_unconfirmed" | "startup_access_denied" | null) =>
      provisions
        .releaseStartupClaim({ allocationId: row.allocationId, claimId, errorCode })
        .pipe(Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void));
    const requireCurrent = Effect.gen(function* () {
      const [current] = yield* sql<{
        ownerUserId: string;
        environmentId: string;
        repositoryId: string;
      }>`SELECT a.owner_user_id AS "ownerUserId",b.environment_id AS "environmentId",b.repository_id AS "repositoryId"
        FROM relay_thread_vm_allocations a JOIN relay_thread_vm_bindings b USING(allocation_id)
          JOIN relay_thread_vm_move_destinations d USING(allocation_id) JOIN relay_thread_moves m ON m.operation_id=d.operation_id
          JOIN relay_thread_placements t ON t.thread_id=a.thread_id
          JOIN relay_thread_vm_enrollments e ON e.allocation_id=a.allocation_id JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        WHERE a.allocation_id=${row.allocationId} AND a.state='running' AND a.deleted_at IS NULL AND a.compute_ref=${row.computeRef}
          AND b.revoked_at IS NULL AND c.revoked_at IS NULL AND e.installed_at IS NOT NULL
          AND b.environment_id=m.destination_environment_id AND b.generation=${row.generation}
          AND ((m.phase IN ('frozen','ready') AND t.operation_id=m.operation_id AND t.generation=m.expected_generation)
            OR (m.phase='committed' AND t.operation_id=m.operation_id AND t.generation=b.generation AND t.environment_id=b.environment_id)
            OR (m.phase='completed' AND t.operation_id IS NULL AND t.generation=b.generation AND t.environment_id=b.environment_id))`;
      if (!current) return yield* tenancyNotFound("thread_not_found");
      return yield* withPrivateThreadOwnerAccess(row.threadId, "write", current.ownerUserId, () =>
        provisions
          .requireSetupClaim({ allocationId: row.allocationId, claimId })
          .pipe(Effect.as(current)),
      );
    });
    yield* Effect.gen(function* () {
      const current = yield* requireCurrent;
      const identity = {
        operationId: row.operationId,
        templateId: row.templateId,
        scope: {
          allocationId: row.allocationId,
          threadId: ThreadId.make(row.threadId),
          repositoryId: current.repositoryId,
          generation: row.generation,
        },
      };
      const digest = yield* threadVmMoveServerDigest({
        enrolled: true,
        operationId: row.operationId,
        allocationId: row.allocationId,
        threadId: identity.scope.threadId,
        generation: row.generation,
        environmentId: EnvironmentId.make(current.environmentId),
      });
      yield* start(row.computeRef!, identity, digest, "move").pipe(Effect.timeout("45 seconds"));
      yield* requireCurrent;
      yield* release(null);
    }).pipe(
      Effect.catchTags({
        RelayTenancyNotFoundError: () => release("startup_access_denied"),
        ThreadVmComputeError: () => release("startup_unconfirmed"),
        TimeoutError: () => release("startup_unconfirmed"),
        RelayInternalError: () => release("startup_unconfirmed"),
        ThreadVmProvisionConflict: () => Effect.void,
      }),
    );
    return true;
  });
  return { runOne };
}
