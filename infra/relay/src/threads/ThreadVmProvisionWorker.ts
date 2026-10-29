import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type {
  ThreadVmComputeError,
  ThreadVmCreateInput,
  ThreadVmCreated,
  ThreadVmKnownIdentity,
} from "../machines/E2BThreadVmCompute.ts";
import { sealThreadVmTrafficAccessToken } from "./ThreadVmIngressToken.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";

interface ProvisionCompute {
  readonly create: (
    input: ThreadVmCreateInput,
  ) => Effect.Effect<ThreadVmCreated, ThreadVmComputeError>;
  readonly recoverIngress: (
    sandboxId: string,
    identity: ThreadVmKnownIdentity,
  ) => Effect.Effect<ThreadVmCreated, ThreadVmComputeError>;
  readonly findOperation: (
    operationId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ sandboxId: string; metadata: Record<string, string> }>,
    ThreadVmComputeError
  >;
}

/** Creates an inert runner only. Enrollment and execution wait for a durable private connection. */
export function makeThreadVmProvisionWorker(
  sql: PgClient,
  compute: ProvisionCompute,
  templateId: string,
  hostId: string,
  verifyTemplate: Effect.Effect<void, ThreadVmComputeError> = Effect.void,
) {
  const store = makeThreadVmProvisionStore(sql);
  const allocations = makeThreadVmAllocationStore(sql);
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
      const allocation = yield* allocations.get(row.allocationId);
      if (!allocation) return;
      const ownerAccess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withPrivateThreadOwnerAccess(row.threadId, "read", allocation.ownerUserId, () => effect);
      const finish = Effect.fnUntraced(function* (created: ThreadVmCreated) {
        const known = yield* store.recordObserved({ ...claim, computeRef: created.sandboxId });
        const discard = Effect.gen(function* () {
          yield* store.cancelKnown({ ...claim, computeRef: created.sandboxId });
          yield* store.recordCreated({ ...claim, computeRef: created.sandboxId });
        });
        if (known.allocationState === "deleting") {
          yield* discard;
          return;
        }
        const identity = {
          allocationId: known.allocationId,
          operationId: known.operationId,
          threadId: known.threadId,
          generation: known.generation,
          templateId: known.templateId,
        };
        const recovery = { ...claim, computeRef: created.sandboxId, hostId };
        const admitted = yield* ownerAccess(
          created.trafficAccessToken
            ? store.admitIngressRecovery(recovery)
            : store.beginIngressRecovery(recovery),
        ).pipe(
          Effect.as(true),
          Effect.catchTag("RelayTenancyNotFoundError", () => discard.pipe(Effect.as(false))),
        );
        if (!admitted) return;
        const connected = created.trafficAccessToken
          ? created
          : yield* compute
              .recoverIngress(created.sandboxId, identity)
              .pipe(
                Effect.tapError((error) =>
                  error.connectUncertain === false
                    ? store.settleIngressRecovery(recovery)
                    : Effect.void,
                ),
              );
        if (!created.trafficAccessToken && connected.sandboxId === created.sandboxId)
          yield* store.settleIngressRecovery(recovery);
        if (connected.sandboxId !== created.sandboxId || !connected.trafficAccessToken) {
          yield* store.defer({ ...claim, errorCode: "identity_conflict" });
          return;
        }
        const sealedTrafficAccessToken = yield* sealThreadVmTrafficAccessToken(
          { ...identity, computeRef: created.sandboxId },
          connected.trafficAccessToken,
        );
        // Access, claim and capacity may change while connect is in flight.
        // Cancellation records the known ID for cleanup without starting enrollment.
        yield* ownerAccess(
          Effect.gen(function* () {
            yield* store.admitIngressRecovery({ ...claim, computeRef: created.sandboxId, hostId });
            yield* store.recordCreated({
              ...claim,
              computeRef: created.sandboxId,
              sealedTrafficAccessToken,
            });
          }),
        ).pipe(
          Effect.catchTag("RelayTenancyNotFoundError", () => discard),
          Effect.catchTag("ThreadVmProvisionConflict", (error) =>
            Effect.gen(function* () {
              const current = yield* store.get(claim.allocationId);
              if (
                current?.claimId === claimId &&
                current.phase === "creating" &&
                current.computeRef === created.sandboxId &&
                current.allocationState === "deleting"
              )
                return yield* discard;
              return yield* error;
            }),
          ),
        );
      });
      if (row.phase === "pending") {
        // Base-image availability concerns a new dispatch only; a known or
        // uncertain existing VM must reconcile using its own immutable image.
        yield* verifyTemplate;
        // A lost reply or expired worker claim must never repeat creation.
        const admitted = yield* ownerAccess(store.beginCreate({ ...claim, templateId })).pipe(
          Effect.as(true),
          Effect.catchTag("RelayTenancyNotFoundError", () =>
            store.rejectUnstarted(claim).pipe(Effect.as(false)),
          ),
        );
        if (!admitted) return;
        yield* finish(
          yield* compute.create({
            allocationId: row.allocationId,
            operationId: row.operationId,
            threadId: row.threadId,
            generation: row.generation,
            environment: {},
          }),
        );
        return;
      }
      if (row.computeRef) {
        yield* finish({ sandboxId: row.computeRef });
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
      yield* finish({ sandboxId: found.sandboxId });
    });
    yield* reconcile.pipe(
      Effect.catchTags({
        ThreadVmComputeError: () => store.defer({ ...claim, errorCode: "compute_unavailable" }),
        ThreadVmIngressTokenUnavailable: () =>
          store.defer({ ...claim, errorCode: "compute_unavailable" }),
        RelayInternalError: () => store.defer({ ...claim, errorCode: "compute_unavailable" }),
      }),
      Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void),
    );
    return true;
  });
  return { runOne };
}
