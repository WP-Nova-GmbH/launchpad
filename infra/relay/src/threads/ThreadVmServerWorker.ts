import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmSetupStore, ThreadVmSetupConflict } from "./ThreadVmSetupStore.ts";

type Start = (
  sandboxId: string,
  identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId"> & {
    readonly templateId?: string;
  },
  receiptSha256: string,
) => Effect.Effect<void, ThreadVmComputeError>;

/** Repeated starts are harmless under the guest lock; no launch response grants execution ownership. */
export function makeThreadVmServerWorker(sql: PgClient, start: Start, hostId: string) {
  const provisions = makeThreadVmProvisionStore(sql);
  const setups = makeThreadVmSetupStore(sql);
  const runOne = Effect.fn("relay.thread_vm_server.run_one")(function* () {
    const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const row = yield* provisions.claimStartup(claimId, hostId);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    const release = (errorCode: "startup_unconfirmed" | "startup_access_denied" | null) =>
      provisions
        .releaseStartupClaim({ ...claim, errorCode })
        .pipe(Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void));
    yield* Effect.gen(function* () {
      const setup = yield* setups.get(row.allocationId);
      if (!setup || !row.computeRef)
        return yield* new ThreadVmSetupConflict({ message: "VM allocation is unavailable" });
      const withAccess = <A, E, R>(action: Effect.Effect<A, E, R>) =>
        withPrivateThreadOwnerAccess(row.threadId, "write", setup.ownerUserId, () =>
          Effect.gen(function* () {
            yield* provisions.requireSetupClaim(claim);
            const aliases =
              yield* sql`SELECT canonical_key FROM relay_repository_aliases WHERE repository_id = ${setup.repositoryId} AND organization_id = ${setup.organizationId} AND canonical_key = ${setup.canonicalKey} FOR SHARE`;
            if (!aliases.length) return yield* tenancyNotFound("repository_not_found");
            const current = yield* setups.requireServerStart(row.allocationId);
            if (
              current.environmentId !== setup.environmentId ||
              current.receiptSha256 !== setup.receiptSha256
            )
              return yield* new ThreadVmSetupConflict({ message: "VM preparation changed" });
            return yield* action;
          }),
        );
      const prepared = yield* withAccess(setups.requireServerStart(row.allocationId));
      yield* start(
        row.computeRef,
        {
          operationId: row.operationId,
          templateId: row.templateId,
          scope: {
            allocationId: row.allocationId,
            threadId: ThreadId.make(row.threadId),
            repositoryId: setup.repositoryId,
            generation: row.generation,
          },
        },
        prepared.receiptSha256,
      ).pipe(Effect.timeout("45 seconds"));
      yield* withAccess(release(null));
    }).pipe(
      Effect.catchTags({
        RelayTenancyNotFoundError: () => release("startup_access_denied"),
        ThreadVmSetupConflict: () => release("startup_unconfirmed"),
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
