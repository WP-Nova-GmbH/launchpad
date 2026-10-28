import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayEnvironmentPrincipal, RelayRepositoryId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { withThreadMoveParticipant } from "./ThreadMovesApi.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";

type Owner = { threadId: string; environmentId: string; generation: number };
/** A quarantined move guest can use its one repository for setup, without execution ownership. */
export const withThreadVmRepositoryScope = <A, E, R>(
  input: Owner,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const principal = yield* RelayEnvironmentPrincipal,
      sql = (yield* RelayDb).$client;
    if (
      !principal.threadVm ||
      principal.threadVm.threadId !== input.threadId ||
      principal.threadVm.generation !== input.generation
    )
      return yield* tenancyNotFound("thread_not_found");
    const [placement] = yield* sql<{
      current: boolean;
    }>`SELECT environment_id=${input.environmentId} AND generation=${input.generation} AS current
    FROM relay_thread_placements WHERE thread_id=${input.threadId}`;
    if (placement?.current) return yield* withEnvironmentThread(input, true, action);
    const [candidate] = yield* sql<{
      operationId: string;
    }>`SELECT operation_id AS "operationId" FROM relay_thread_vm_move_destinations
    WHERE allocation_id=${principal.threadVm.allocationId}`;
    if (!candidate) return yield* tenancyNotFound("thread_not_found");
    return yield* withThreadMoveParticipant(
      { ...input, operationId: candidate.operationId },
      "destination",
      true,
      (move) =>
        Effect.gen(function* () {
          if (!["frozen", "ready"].includes(move.phase))
            return yield* tenancyNotFound("thread_not_found");
          const installed = yield* sql`SELECT 1 FROM relay_thread_vm_enrollments e
      JOIN relay_thread_vm_provisions p USING(allocation_id) JOIN relay_thread_vm_allocations a USING(allocation_id)
      JOIN relay_thread_move_artifacts r ON r.operation_id=e.operation_id
      WHERE e.allocation_id=${principal.threadVm!.allocationId} AND e.operation_id=${move.operationId}
      AND e.environment_id=${input.environmentId} AND e.installed_at IS NOT NULL
      AND p.generation=${input.generation} AND p.phase='created' AND a.state='running' AND a.deleted_at IS NULL FOR SHARE OF e,p`;
          if (!installed.length) return yield* tenancyNotFound("thread_not_found");
          return yield* action;
        }),
    );
  });

export const getThreadVmRepositoryBinding = Effect.fn("relay.api.thread_vm.repository_binding")(
  function* (input: Owner) {
    const principal = yield* RelayEnvironmentPrincipal,
      sql = (yield* RelayDb).$client;
    const authorize = withThreadVmRepositoryScope(
      input,
      Effect.gen(function* () {
        const aliases = yield* sql<{
          canonicalKey: string;
          repositoryId: string;
          operationId: string;
        }>`SELECT r.canonical_key AS "canonicalKey",
      r.repository_id AS "repositoryId",e.operation_id AS "operationId" FROM relay_repository_aliases r
      JOIN relay_thread_placements t ON t.repository_id=r.repository_id AND t.organization_id=r.organization_id
      JOIN relay_thread_vm_enrollments e ON e.allocation_id=${principal.threadVm!.allocationId}
      WHERE t.thread_id=${input.threadId} AND r.repository_id=${principal.threadVm!.repositoryId}
      AND r.canonical_key LIKE 'github.com/%' AND e.environment_id=${input.environmentId} AND e.installed_at IS NOT NULL
      FOR SHARE OF r,e`;
        if (aliases.length !== 1) return yield* tenancyNotFound("repository_not_found");
        const binding = aliases[0]!;
        return {
          ...input,
          ...binding,
          environmentId: EnvironmentId.make(input.environmentId),
          threadId: ThreadId.make(input.threadId),
          repositoryId: RelayRepositoryId.make(binding.repositoryId),
        };
      }),
    );
    const binding = yield* authorize;
    // Bound the whole optional lookup below the guest binding deadline, including App storage reads.
    const git = yield* (yield* GithubApp).gitMetadata.pipe(
      Effect.timeoutOrElse({
        duration: "7 seconds",
        orElse: () => Effect.succeed({ status: "unknown" as const }),
      }),
    );
    const current = yield* authorize;
    if (
      binding.canonicalKey !== current.canonicalKey ||
      binding.repositoryId !== current.repositoryId ||
      binding.operationId !== current.operationId
    )
      return yield* tenancyConflict("thread_placement_changed");
    return { ...current, git };
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);
