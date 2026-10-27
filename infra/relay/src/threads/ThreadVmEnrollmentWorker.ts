import { makeThreadVmResetEnrollmentStore } from "./ThreadVmResetEnrollmentStore.ts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadId } from "@t3tools/contracts";
import type {
  RelayThreadVmBootstrap,
  RelayThreadVmEnrollmentReceipt,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import {
  makeThreadVmEnrollmentStore,
  ThreadVmEnrollmentInvalid,
} from "./ThreadVmEnrollmentStore.ts";
import { makeThreadVmMoveDestinationStore } from "./ThreadVmMoveDestinationStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";

type Deliver = (
  sandboxId: string,
  input: RelayThreadVmBootstrap,
) => Effect.Effect<RelayThreadVmEnrollmentReceipt, ThreadVmComputeError>;
/** Retries only the immutable enrollment, never VM creation or execution activation. */
export function makeThreadVmEnrollmentWorker(
  sql: PgClient,
  deliver: Deliver,
  relay: { url: string; issuer: string },
  hostId: string,
) {
  const provisions = makeThreadVmProvisionStore(sql);
  const enrollments = makeThreadVmEnrollmentStore(sql);
  const runOne = Effect.fn("relay.thread_vm_enrollment.run_one")(function* () {
    const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const row = yield* provisions.claimEnrollment(claimId, hostId);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    const attempt = Effect.gen(function* () {
      const allocation = yield* makeThreadVmAllocationStore(sql).get(row.allocationId);
      if (!allocation || !row.computeRef) return yield* new ThreadVmEnrollmentInvalid();
      const bootstrap = yield* withPrivateThreadOwnerAccess(
        row.threadId,
        "read",
        allocation.ownerUserId,
        (placement) =>
          Effect.gen(function* () {
            const seed = yield* enrollments.prepare(row);
            const restoring = yield* makeThreadVmRestoreEnrollmentStore(sql).requested(row);
            return {
              version: 1 as const,
              ...(restoring ? { restore: true as const } : {}),
              operationId: row.operationId,
              templateId: row.templateId,
              scope: {
                allocationId: row.allocationId,
                threadId: ThreadId.make(row.threadId),
                repositoryId: placement.repositoryId,
                generation: row.generation,
              },
              relayUrl: relay.url,
              relayIssuer: relay.issuer,
              seed,
            };
          }),
      );
      // Never hold access or placement locks across a network round trip. The signed
      // exchange and the final receipt each recheck current owner access themselves.
      const receipt = yield* deliver(row.computeRef, bootstrap);
      yield* withPrivateThreadOwnerAccess(row.threadId, "read", allocation.ownerUserId, () =>
        provisions
          .finishEnrollment({ ...claim, receipt })
          .pipe(
            Effect.andThen(makeThreadVmMoveDestinationStore(sql).assigned(receipt)),
            Effect.andThen(makeThreadVmRestoreEnrollmentStore(sql).assigned(receipt)),
            Effect.andThen(makeThreadVmResetEnrollmentStore(sql).assigned(receipt)),
          ),
      );
    });
    const defer = (errorCode: "enrollment_unconfirmed" | "enrollment_access_denied") =>
      provisions
        .deferEnrollment({ ...claim, errorCode })
        .pipe(Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void));
    yield* attempt.pipe(
      Effect.catchTags({
        RelayTenancyNotFoundError: () => defer("enrollment_access_denied"),
        ThreadVmEnrollmentInvalid: () => defer("enrollment_unconfirmed"),
        ThreadVmComputeError: () => defer("enrollment_unconfirmed"),
        SecretBoxError: () => defer("enrollment_unconfirmed"),
        PlatformError: () => defer("enrollment_unconfirmed"),
        RelayInternalError: () => defer("enrollment_unconfirmed"),
        ThreadVmProvisionConflict: () => Effect.void,
        ThreadPlacementConflict: () => defer("enrollment_unconfirmed"),
      }),
    );
    return true;
  });
  return { runOne };
}
