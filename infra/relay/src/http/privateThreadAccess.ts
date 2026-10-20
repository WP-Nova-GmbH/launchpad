import { RelayClientPrincipal, type RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";

/** Private audience and current repository access are independent of the VM's power state. */
export const withPrivateThreadOwnerAccess = <A, E, R>(
  threadId: string,
  mode: "read" | "write",
  userId: string,
  read: (placement: RelayPortableThreadPlacement) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Serialize against moves and hold membership/grants until the read completes.
          // Org administrators have no exception to a private thread's audience.
          const rows =
            mode === "write"
              ? yield* sql`SELECT thread_id FROM relay_thread_placements
                WHERE thread_id = ${threadId} AND owner_user_id = ${userId} FOR UPDATE`
              : yield* sql`SELECT thread_id FROM relay_thread_placements
                WHERE thread_id = ${threadId} AND owner_user_id = ${userId} FOR SHARE`;
          if (!rows.length) return yield* tenancyNotFound("thread_not_found");
          if ((yield* sql`SELECT 1 FROM relay_thread_deletions WHERE thread_id=${threadId}`).length)
            return yield* tenancyNotFound("thread_not_found");
          const placement = yield* makeThreadPlacementStore(sql).get(threadId);
          if (!placement) return yield* tenancyNotFound("thread_not_found");
          const aborted =
            yield* sql`SELECT 1 FROM relay_thread_local_enrollments WHERE thread_id=${threadId} AND phase='aborted'`;
          if (aborted.length) return yield* tenancyNotFound("thread_not_found");
          const [membership] = yield* sql<{
            role: string;
          }>`SELECT role FROM relay_organization_members
      WHERE user_id = ${userId} AND organization_id = ${placement.organizationId} FOR SHARE`;
          if (!membership) return yield* tenancyNotFound("thread_not_found");
          const repositories = yield* sql`SELECT repository_id FROM relay_repositories
      WHERE repository_id = ${placement.repositoryId} AND organization_id = ${placement.organizationId} FOR SHARE`;
          if (!repositories.length) return yield* tenancyNotFound("thread_not_found");
          if (membership.role !== "admin") {
            const grants = yield* sql`SELECT user_id FROM relay_repository_access
        WHERE repository_id = ${placement.repositoryId} AND organization_id = ${placement.organizationId}
        AND user_id = ${userId} FOR SHARE`;
            if (!grants.length) return yield* tenancyNotFound("thread_not_found");
          }
          return yield* read(placement);
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
  });

export const withPrivateThreadAccess = <A, E, R>(
  threadId: string,
  mode: "read" | "write",
  action: (placement: RelayPortableThreadPlacement) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(RelayClientPrincipal, ({ userId }) =>
    withPrivateThreadOwnerAccess(threadId, mode, userId, action),
  );
