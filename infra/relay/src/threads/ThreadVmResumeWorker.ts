import { threadVmOperationMatches } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { ThreadId } from "@t3tools/contracts";
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { SandboxInfo } from "e2b";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type { LinearWorkflowConfiguration } from "../Config.ts";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import type {
  ThreadVmComputeError,
  makeE2BThreadVmCompute,
} from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import type { ResumeClaim } from "./ThreadVmResumeStore.ts";
import {
  makeThreadVmResumeStore,
  THREAD_VM_RESUME_ATTEMPT_TIMEOUT_MS,
} from "./ThreadVmResumeStore.ts";
import {
  readThreadVmTrafficAccessToken,
  sealThreadVmTrafficAccessToken,
} from "./ThreadVmIngressToken.ts";

type Identity = {
  readonly operationId: string;
  readonly templateId?: string;
  readonly scope: {
    readonly allocationId: string;
    readonly threadId: ReturnType<typeof ThreadId.make>;
    readonly repositoryId: ReturnType<typeof RelayRepositoryId.make>;
    readonly generation: number;
  };
};
type ResumeCompute = Pick<ReturnType<typeof makeE2BThreadVmCompute>, "inspect" | "recoverIngress">;
interface ResumeGuest {
  readonly reopenAfterResume: (
    sandboxId: string,
    identity: Identity,
    pauseOperationId: string | null,
  ) => Effect.Effect<unknown, ThreadVmComputeError>;
}
const matches = (info: SandboxInfo | null, claim: ResumeClaim) =>
  info?.sandboxId === claim.computeRef &&
  info.templateId === claim.templateId.split(":")[0] &&
  info.network?.allowPublicTraffic === false &&
  info.lifecycle?.autoResume === false &&
  info.metadata["launchpad.managed"] === "thread-vm-v1" &&
  info.metadata["launchpad.allocation_id"] === claim.allocationId &&
  threadVmOperationMatches(info.metadata, claim.provisionOperationId) &&
  info.metadata["launchpad.thread_id"] === claim.threadId &&
  info.metadata["launchpad.generation"] === String(claim.generation);

// The stock API's 70s request and 75s write deadlines fit inside this client budget.
const CONNECT_TIMEOUT_MS = 90_000;
const GUEST_REOPEN_TIMEOUT_MS = 60_000;
const hasGuestLease = (info: SandboxInfo, now: number) =>
  info.endAt.getTime() - now >= GUEST_REOPEN_TIMEOUT_MS + 5_000;

/** Resume a paused VM only after FIFO physical capacity admission. */
export function makeThreadVmResumeWorker(
  sql: PgClient,
  compute: ResumeCompute,
  guest: ResumeGuest,
  hostId: string,
  workflowEnabled?: boolean,
  linearWorkflow?: LinearWorkflowConfiguration,
  reconcileMissingWorkflowVm?: (claim: ResumeClaim) => Effect.Effect<boolean, SqlError.SqlError>,
) {
  const store = makeThreadVmResumeStore(sql);
  const runOne = Effect.fn("relay.thread_vm.resume.run_one")(function* () {
    yield* makeThreadVmCapacityStore(sql).admitNext(
      hostId,
      workflowEnabled === undefined
        ? "personal"
        : { workflowEnabled, ...(linearWorkflow ? { linearWorkflow } : {}) },
    );
    const claim = yield* store.claim(hostId);
    if (!claim) return false;
    const identity: Identity = {
      operationId: claim.provisionOperationId,
      templateId: claim.templateId,
      scope: {
        allocationId: claim.allocationId,
        threadId: ThreadId.make(claim.threadId),
        repositoryId: RelayRepositoryId.make(claim.repositoryId),
        generation: claim.generation,
      },
    };
    const attempt = Effect.gen(function* () {
      const startWorkflowExecution = !!claim.workflowJobId && claim.capacityState === "reserved";
      if (startWorkflowExecution && workflowEnabled !== true) return;
      if (!startWorkflowExecution) yield* store.begin(claim);
      let info = yield* compute.inspect(claim.computeRef);
      if (!info) {
        if (
          claim.workflowJobId &&
          reconcileMissingWorkflowVm &&
          (yield* reconcileMissingWorkflowVm(claim))
        )
          yield* wakeWorkflows();
        return;
      }
      if (!matches(info, claim)) return;
      if (info.state === "paused" && (yield* store.releaseInactiveWorkflowWake(claim))) {
        yield* wakeWorkflows();
        return;
      }
      const tokenIdentity = {
        allocationId: claim.allocationId,
        computeRef: claim.computeRef,
        operationId: claim.provisionOperationId,
        threadId: claim.threadId,
        generation: claim.generation,
      };
      let token =
        info.state === "running" && hasGuestLease(info, yield* Clock.currentTimeMillis)
          ? yield* readThreadVmTrafficAccessToken(
              sql,
              tokenIdentity,
              claim.workflowJobId ? "organization_workflow" : "personal",
            ).pipe(
              Effect.catchTag("ThreadVmIngressTokenUnavailable", () => Effect.succeed(undefined)),
            )
          : undefined;
      if (!token) {
        yield* store.beginConnect(claim, startWorkflowExecution);
        const connected = yield* compute
          .recoverIngress(
            claim.computeRef,
            { ...tokenIdentity, templateId: claim.templateId },
            CONNECT_TIMEOUT_MS,
          )
          .pipe(
            Effect.tapError((error) =>
              error.connectUncertain === false ? store.settleConnect(claim) : Effect.void,
            ),
          );
        if (connected.sandboxId === claim.computeRef) yield* store.settleConnect(claim);
        if (connected.sandboxId !== claim.computeRef || !connected.trafficAccessToken) return;
        token = connected.trafficAccessToken;
        info = yield* compute.inspect(claim.computeRef);
      } else if (startWorkflowExecution) yield* store.begin(claim);
      if (
        !info ||
        !matches(info, claim) ||
        info.state !== "running" ||
        !hasGuestLease(info, yield* Clock.currentTimeMillis)
      )
        return;
      const sealed = yield* sealThreadVmTrafficAccessToken(tokenIdentity, token);
      if (!(yield* store.finishPower(claim, sealed))) return;
      yield* guest
        .reopenAfterResume(
          claim.computeRef,
          identity,
          claim.finalSaveOperationId ?? claim.pauseOperationId,
        )
        .pipe(Effect.timeout(GUEST_REOPEN_TIMEOUT_MS));
      if ((yield* store.complete(claim)) && claim.workflowJobId) yield* wakeWorkflows();
    });
    yield* attempt.pipe(
      Effect.timeout(THREAD_VM_RESUME_ATTEMPT_TIMEOUT_MS),
      Effect.catchTags({
        ThreadVmComputeError: () => Effect.void,
        ThreadVmResumeConflict: () => Effect.void,
        ThreadVmIngressTokenUnavailable: () => Effect.void,
        TimeoutError: () => Effect.logWarning("Thread VM resume attempt exceeded its deadline."),
      }),
      Effect.andThen(store.defer(claim, workflowEnabled === true)),
    );
    return true;
  });
  return { runOne };
}
