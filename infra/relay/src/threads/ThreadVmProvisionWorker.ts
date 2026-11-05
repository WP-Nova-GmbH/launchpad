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
import { withPreparingWorkflowVm } from "./ThreadVmWorkflowAccess.ts";
import type { RelayInternalError, RelayTenancyNotFoundError } from "@t3tools/contracts/relay";
import type { RelayDb } from "../db.ts";

interface ProvisionCompute {
  readonly create: (
    input: ThreadVmCreateInput,
    templateId?: string,
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
  workflow?: {
    readonly enabled: boolean;
    readonly buildId: string;
    readonly verifyTemplate: (
      templateId: string,
      buildId: string,
    ) => Effect.Effect<void, ThreadVmComputeError>;
  },
) {
  const store = makeThreadVmProvisionStore(sql);
  const allocations = makeThreadVmAllocationStore(sql);
  const verifiedWorkflowBuild = workflow?.enabled
    ? { templateRef: templateId, buildId: workflow.buildId }
    : undefined;
  const runOne = Effect.fn("relay.thread_vm_provision.run_one")(function* () {
    const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    yield* makeThreadVmCapacityStore(sql).admitNext(
      hostId,
      workflow ? { workflowEnabled: workflow.enabled } : "personal",
    );
    const row = yield* store.claim(claimId, hostId, workflow !== undefined, verifiedWorkflowBuild);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    if (row.phase === "pending" && row.allocationState === "deleting") {
      yield* store.cancelUnstarted(claim);
      return true;
    }
    const reconcile = Effect.gen(function* () {
      const allocation = yield* allocations.getAny(row.allocationId);
      if (!allocation || allocation.resourceKind !== row.resourceKind) return;
      const ownerAccess = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | RelayInternalError | RelayTenancyNotFoundError, R | RelayDb> =>
        allocation.resourceKind === "organization_workflow"
          ? withPreparingWorkflowVm(sql, row, () => effect)
          : withPrivateThreadOwnerAccess(
              row.threadId,
              "read",
              allocation.ownerUserId,
              () => effect,
            );
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
        const noAccess = row.workflowSnapshot
          ? store.defer({ ...claim, errorCode: "compute_unavailable" })
          : discard;
        const admitted = yield* ownerAccess(
          created.trafficAccessToken
            ? store.admitIngressRecovery(recovery)
            : store.beginIngressRecovery(recovery),
        ).pipe(
          Effect.as(true),
          Effect.catchTag("RelayTenancyNotFoundError", () => noAccess.pipe(Effect.as(false))),
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
          Effect.catchTag("RelayTenancyNotFoundError", () => noAccess),
          Effect.catchTag("ThreadVmProvisionConflict", (error) =>
            Effect.gen(function* () {
              const current = yield* store.get(claim.allocationId, row.resourceKind);
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
        const snapshot = row.workflowSnapshot;
        if (snapshot && !workflow?.enabled) {
          yield* store.returnWorkflowReservation({ ...claim, errorCode: "workflow_disabled" });
          return;
        }
        if (
          snapshot &&
          verifiedWorkflowBuild &&
          (row.templateId !== verifiedWorkflowBuild.templateRef ||
            snapshot.templateBuildId !== verifiedWorkflowBuild.buildId)
        ) {
          yield* store.rejectUnstarted({ ...claim, errorCode: "workflow_template_stale" });
          return;
        }
        if (snapshot && workflow) {
          const verified = yield* workflow
            .verifyTemplate(row.templateId, snapshot.templateBuildId)
            .pipe(Effect.result);
          if (verified._tag === "Failure") {
            yield* store.returnWorkflowReservation({
              ...claim,
              errorCode: "workflow_template_unverified",
            });
            return;
          }
        } else yield* verifyTemplate;
        const selectedTemplate = snapshot ? row.templateId : templateId;
        const begin = snapshot
          ? withPreparingWorkflowVm(sql, row, (scope) =>
              Effect.gen(function* () {
                const [codex] = yield* sql`SELECT connection_id FROM relay_codex_vm_connections
                WHERE organization_id=${scope.organizationId} AND connection_id=${scope.codexConnectionId}
                  AND status='connected' AND (refresh_started_at IS NULL
                    OR refresh_started_at::timestamptz > clock_timestamp()-interval '6 seconds') FOR SHARE`;
                if (!codex) {
                  yield* store.returnWorkflowReservation({
                    ...claim,
                    errorCode: "workflow_codex_unavailable",
                  });
                  return false;
                }
                yield* store.beginCreate({ ...claim, templateId: selectedTemplate });
                return true;
              }),
            )
          : ownerAccess(store.beginCreate({ ...claim, templateId: selectedTemplate })).pipe(
              Effect.as(true),
            );
        // A lost reply or expired worker claim must never repeat creation.
        const admitted = yield* begin.pipe(
          Effect.catchTag("RelayTenancyNotFoundError", () =>
            (snapshot
              ? store.defer({ ...claim, errorCode: "compute_unavailable" })
              : store.rejectUnstarted(claim)
            ).pipe(Effect.as(false)),
          ),
        );
        if (!admitted) return;
        const created = yield* compute
          .create(
            {
              allocationId: row.allocationId,
              operationId: row.operationId,
              threadId: row.threadId,
              generation: row.generation,
              environment: {},
            },
            selectedTemplate,
          )
          .pipe(
            Effect.catchTag("ThreadVmComputeError", (error) => {
              if (!error.createRejected) return Effect.fail(error);
              return store
                .rejectCreate({
                  allocationId: row.allocationId,
                  operationId: row.operationId,
                  generation: row.generation,
                  threadId: row.threadId,
                  resourceKind: row.resourceKind,
                })
                .pipe(
                  Effect.flatMap((settled) =>
                    settled ? Effect.succeed(null) : Effect.fail(error),
                  ),
                );
            }),
          );
        if (created) yield* finish(created);
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
