import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type {
  ThreadVmComputeError,
  ThreadVmCreateInput,
  ThreadVmCreationStopReceipt,
} from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";

interface ProvisionCompute {
  readonly cancelCreate: (
    operationId: string,
  ) => Effect.Effect<ThreadVmCreationStopReceipt, ThreadVmComputeError>;
  readonly create: (
    input: ThreadVmCreateInput,
  ) => Effect.Effect<{ sandboxId: string }, ThreadVmComputeError>;
  readonly findOperation: (
    operationId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ sandboxId: string; metadata: Record<string, string> }>,
    ThreadVmComputeError
  >;
}

/** Creates an inert runner only. Enrollment, setup and execution admission are separate acknowledgements. */
export function makeThreadVmProvisionWorker(
  sql: PgClient,
  compute: ProvisionCompute,
  templateId: string,
  hostId: string,
) {
  const store = makeThreadVmProvisionStore(sql);
  const runOne = Effect.fn("relay.thread_vm_provision.run_one")(function* () {
    const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    yield* makeThreadVmCapacityStore(sql).admitNext(hostId);
    const row = yield* store.claim(claimId, hostId);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    if (row.phase === "pending" && row.allocationState === "deleting") {
      yield* store.cancelUnstarted(claim);
      return true;
    }
    const reconcile = Effect.gen(function* () {
      if (
        row.phase === "creating" &&
        row.allocationState === "deleting" &&
        row.creationIdentityFenced
      ) {
        const receipt = yield* compute.cancelCreate(row.operationId);
        yield* store.confirmCreateCancelled({ ...claim, receipt });
        return;
      }
      if (row.phase === "pending") {
        // Persist the attempt before crossing the network. A lost reply or expired
        // worker lease can discover this operation but must never repeat create.
        const allocation = yield* makeThreadVmAllocationStore(sql).get(row.allocationId);
        if (!allocation) return;
        // Recheck the queued owner's access at admission. Locks cover the durable
        // intent only; the subsequent compute request does not hold database locks.
        const admitted = yield* withPrivateThreadOwnerAccess(
          row.threadId,
          "read",
          allocation.ownerUserId,
          () => store.beginCreate({ ...claim, templateId }).pipe(Effect.as(true)),
        ).pipe(
          Effect.catchTag("RelayTenancyNotFoundError", () =>
            store.rejectUnstarted(claim).pipe(Effect.as(false)),
          ),
        );
        if (!admitted) return;
        const created = yield* compute.create({
          allocationId: row.allocationId,
          operationId: row.operationId,
          threadId: row.threadId,
          generation: row.generation,
          environment: {},
        });
        yield* store.recordCreated({ ...claim, computeRef: created.sandboxId });
        return;
      }
      const matches = yield* compute.findOperation(row.operationId);
      const found = matches[0];
      if (
        matches.length !== 1 ||
        !found ||
        found.metadata["launchpad.managed"] !== "thread-vm-v1" ||
        found.metadata["launchpad.allocation_id"] !== row.allocationId ||
        found.metadata["launchpad.thread_id"] !== row.threadId ||
        found.metadata["launchpad.generation"] !== String(row.generation) ||
        found.metadata["launchpad.operation_id"] !== row.operationId
      ) {
        yield* store.defer({
          ...claim,
          errorCode: matches.length === 0 ? "create_uncertain" : "identity_conflict",
        });
        return;
      }
      yield* store.recordCreated({ ...claim, computeRef: found.sandboxId });
    });
    yield* reconcile.pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.defer({ ...claim, errorCode: "compute_unavailable" }),
        RelayInternalError: () => store.defer({ ...claim, errorCode: "compute_unavailable" }),
      }),
      Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void),
    );
    return true;
  });
  return { runOne };
}
