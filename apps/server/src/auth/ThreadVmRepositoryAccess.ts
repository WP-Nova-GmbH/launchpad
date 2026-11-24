import {
  AuthOrchestrationReadScope,
  AuthWorkflowVmFollowUpScope,
  EnvironmentAuthorizationError,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { randomUUID } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ThreadExecution } from "../relay/ThreadExecution.ts";
import { WorkflowVmFollowUpPublisher } from "../relay/WorkflowVmFollowUpPush.ts";
import { WorkflowVmAttempts } from "../relay/WorkflowVmAttempts.ts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { requireReleasedWorkflowVmRun } from "../persistence/WorkflowThreadOwnership.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeExecutorRelayApiClient } from "../relay/executorRelayClient.ts";
import type { InstalledThreadVm } from "../relay/ThreadVmEnrollment.ts";
import { forkParked } from "../serverActivation.ts";
import type { RepositoryAccessShape, RepositoryActor } from "./RepositoryAccess.ts";

const denied = () =>
  new EnvironmentAuthorizationError({
    message: "Private VM access is unavailable or has been removed.",
    requiredScope: AuthOrchestrationReadScope,
  });

/** Private VMs never inherit a cached organization policy or an administrator exception. */
export const makeThreadVmRepositoryAccess = Effect.fn("ThreadVmRepositoryAccess.make")(function* (
  vm: InstalledThreadVm,
  receipt: RelayThreadVmSetupReceipt | null,
  workflowVm = false,
) {
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const url = normalizeSecureRelayUrl(vm.relayUrl);
  const issuer = normalizeSecureRelayUrl(vm.relayIssuer);
  const projectId =
    receipt?.projectId ??
    (vm.scope.generation > 1 ? ProjectId.make(`vm:${vm.scope.threadId}`) : null);
  if (
    !projectId ||
    !url ||
    !issuer ||
    vm.environmentId !== environmentId ||
    (receipt &&
      (receipt.environmentId !== environmentId ||
        receipt.operationId !== vm.operationId ||
        receipt.scope.allocationId !== vm.scope.allocationId ||
        receipt.scope.repositoryId !== vm.scope.repositoryId ||
        receipt.scope.threadId !== vm.scope.threadId ||
        receipt.scope.generation !== vm.scope.generation))
  )
    return yield* denied();
  const client = yield* makeExecutorRelayApiClient({
    url,
    issuer,
    environmentCredential: vm.environmentCredential,
  });
  const fence = yield* Semaphore.make(1);
  const refresh = new Map<string, Semaphore.Semaphore>();
  const connections = new Map<
    Effect.Effect<void>,
    { userId: string; followUp: boolean } | undefined
  >();
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  let liveViewerClosed = false;
  const checkClient = Effect.fnUntraced(
    function* (userId: string, followUp: boolean) {
      const access = yield* client.threadEnvironment.checkClientAccess({
        params: { environmentId, threadId: vm.scope.threadId },
        payload: {
          generation: vm.scope.generation,
          userId,
          ...(followUp ? { workflowFollowUp: true as const } : {}),
        },
      });
      if (
        access.environmentId !== environmentId ||
        access.threadId !== vm.scope.threadId ||
        access.projectId !== projectId ||
        access.repositoryId !== vm.scope.repositoryId ||
        access.generation !== vm.scope.generation ||
        access.userId !== userId
      )
        return yield* denied();
      return access;
    },
    Effect.timeout("5 seconds"),
    Effect.mapError(denied),
  );
  const requireFollowUpLocal = Effect.fnUntraced(function* () {
    if (!workflowVm || Option.isNone(sql)) return yield* denied();
    return yield* requireReleasedWorkflowVmRun(sql.value, { ...vm.scope, environmentId }).pipe(
      Effect.mapError(denied),
    );
  });
  const requireLiveViewer = Effect.fnUntraced(function* () {
    if (!workflowVm) return;
    if (!liveViewerClosed && Option.isSome(sql))
      liveViewerClosed = yield* requireReleasedWorkflowVmRun(sql.value, {
        ...vm.scope,
        environmentId,
      }).pipe(Effect.isSuccess);
    if (liveViewerClosed) return yield* denied();
  });
  const validThrough = new Map<string, number>();
  let ownerUserId: string | undefined;
  // Coalesce stream checks for five seconds. Idle connections also renew, and a
  // failed renewal drains them within one interval plus the five-second timeout.
  const authorize = (userId: string, force = false, followUp = false) =>
    Effect.suspend(() => {
      const key = workflowVm ? `${followUp ? "follow-up" : "viewer"}:${userId}` : "owner";
      const gate = refresh.get(key) ?? Semaphore.makeUnsafe(1);
      refresh.set(key, gate);
      return gate.withPermits(1)(
        Effect.gen(function* () {
          if (!workflowVm && ownerUserId !== undefined && userId !== ownerUserId)
            return yield* denied();
          if (!followUp && liveViewerClosed) return yield* denied();
          const startedAt = (yield* DateTime.now).epochMilliseconds;
          if (!force && startedAt < (validThrough.get(key) ?? 0)) return;
          if (!followUp) yield* requireLiveViewer();
          yield* Effect.gen(function* () {
            const access = yield* checkClient(userId, followUp);
            if ((yield* DateTime.now).epochMilliseconds >= startedAt + 5000) return yield* denied();
            if (followUp) {
              if (!access.workflowFollowUp?.ready) return yield* denied();
              const run = yield* requireFollowUpLocal();
              if (run.jobId !== access.workflowFollowUp.jobId) return yield* denied();
            }
            if (!workflowVm) ownerUserId = userId;
            validThrough.set(key, startedAt + 5000);
          }).pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(denied),
            Effect.tapError(() =>
              Effect.sync(() => {
                validThrough.delete(key);
              }),
            ),
          );
        }),
      );
    });
  const requireFollowUp = (actor: RepositoryActor, fresh = false) =>
    workflowVm && actor.user ? authorize(actor.user.userId, fresh, true) : Effect.fail(denied());
  const readEnvironment = Effect.fnUntraced(function* (actor: RepositoryActor) {
    const { resolveFollowUp } = yield* WorkflowVmAttempts;
    if (!actor.user || !resolveFollowUp) return yield* denied();
    const run = yield* requireFollowUpLocal();
    if (run.runtime.kind !== "vm") return yield* denied();
    const configuration = yield* resolveFollowUp(run.runtime, actor.user.userId);
    if (!configuration) return yield* denied();
    return configuration.environment;
  }, Effect.mapError(denied));
  const prepareActor = Effect.fnUntraced(function* (actor: RepositoryActor) {
    const execution = yield* Effect.serviceOption(ThreadExecution);
    const publisher = yield* WorkflowVmFollowUpPublisher;
    if (!actor.user || Option.isNone(execution)) return yield* denied();
    const userId = actor.user.userId;
    const run = yield* requireFollowUpLocal();
    const current = (yield* checkClient(userId, true)).workflowFollowUp;
    if (!current || current.jobId !== run.jobId) return yield* denied();

    // Drain a retained result socket before a follow-up can publish new history.
    liveViewerClosed = true;
    const closing = yield* fence.withPermits(1)(
      Effect.sync(() => {
        const viewers = [];
        for (const [close, connection] of connections) {
          if (connection?.followUp) continue;
          connections.delete(close);
          viewers.push(close);
        }
        return viewers;
      }),
    );
    yield* Effect.all(closing, { concurrency: "unbounded" }).pipe(Effect.timeout("5 seconds"));
    if (!current.ready) {
      const work = {
        kind: "workspace" as const,
        threadId: vm.scope.threadId,
        workId: `follow-up-prepare:${randomUUID()}`,
        expectedGeneration: vm.scope.generation,
        followUpUserId: userId,
        followUpPreparing: true as const,
      };
      const lease = execution.value;
      yield* Effect.acquireUseRelease(
        lease
          .begin(work)
          .pipe(
            Effect.flatMap((permission) =>
              permission === "start" ? Effect.void : Effect.fail(denied()),
            ),
          ),
        () =>
          publisher
            .prepareBaseline({
              jobId: current.jobId,
              threadId: work.threadId,
              generation: vm.scope.generation,
              publishedSha: current.publishedSha,
              publishedBranch: current.publishedBranch,
            })
            .pipe(
              Effect.andThen(
                client.threadEnvironment.confirmWorkflowVmFollowUpReady({
                  params: { environmentId, threadId: vm.scope.threadId },
                  payload: {
                    generation: vm.scope.generation,
                    userId,
                    workId: `${work.kind}:${work.workId}`,
                  },
                }),
              ),
            ),
        () => lease.confirmStopped(work).pipe(Effect.ignore({ log: true })),
      );
    }
    yield* requireFollowUp(actor, true);
  }, Effect.mapError(denied));
  const requireMember = (actor: RepositoryActor) =>
    actor.scopes && Array.from(actor.scopes).includes(AuthWorkflowVmFollowUpScope)
      ? requireFollowUp(actor)
      : actor.user
        ? authorize(actor.user.userId)
        : Effect.fail(denied());
  const requireProject = (actor: RepositoryActor, requestedProjectId: ProjectId) =>
    requestedProjectId === projectId ? requireMember(actor) : Effect.fail(denied());
  const requireThread = (actor: RepositoryActor, threadId: ThreadId) =>
    threadId === vm.scope.threadId ? requireMember(actor) : Effect.fail(denied());
  yield* forkParked(
    Effect.forever(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* Effect.forEach(
              new Map(
                [...connections.values()].flatMap((actor) =>
                  actor ? [[`${actor.followUp}:${actor.userId}`, actor] as const] : [],
                ),
              ).values(),
              Effect.fnUntraced(function* ({ userId, followUp }) {
                if (yield* authorize(userId, true, followUp).pipe(Effect.isSuccess)) return;
                const closing = yield* fence.withPermits(1)(
                  Effect.sync(() => {
                    const closing = [];
                    for (const [close, actor] of connections) {
                      if (actor?.userId !== userId || actor.followUp !== followUp) continue;
                      connections.delete(close);
                      closing.push(close);
                    }
                    return closing;
                  }),
                );
                // A slow old connection cannot hold the admission fence while it drains.
                yield* Effect.forkScoped(Effect.all(closing, { concurrency: "unbounded" }));
              }),
              { concurrency: "unbounded", discard: true },
            );
          }),
        ),
      ),
    ),
  );
  const access: RepositoryAccessShape = {
    threadId: vm.scope.threadId,
    ...(workflowVm
      ? {
          workflowVm,
          workflowFollowUp: {
            threadId: vm.scope.threadId,
            generation: vm.scope.generation,
            requireActor: requireFollowUp,
            prepareActor,
            readEnvironment,
          },
        }
      : {}),
    status: DateTime.now.pipe(
      Effect.map((now) => ({
        enabled: true,
        ready: [...validThrough.values()].some((expiry) => now.epochMilliseconds < expiry),
        revision: vm.scope.generation,
      })),
    ),
    requireMember,
    // Workflow automation is organization-machine work, outside a private VM credential.
    requireWorkflowProject: () => Effect.fail(denied()),
    requireProject,
    requirePersistedProject: requireProject,
    requireThread,
    projectIds: (actor) => requireMember(actor).pipe(Effect.as(new Set([projectId]))),
    authorizeClone: () => Effect.fail(denied()),
    // Trusted relay inbox delivery dispatches directly to the engine. Client
    // writes must use that inbox so a connection cannot bypass a queued move.
    requireCommand: () =>
      Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Send private VM commands through the relay thread queue.",
          requiredScope: AuthOrchestrationReadScope,
        }),
      ),
    apply: () => Effect.fail(denied()),
    withFence: fence.withPermits(1),
    registerConnection: (close, actor) =>
      Effect.sync(() => {
        const userId = actor?.user?.userId ?? ownerUserId;
        connections.set(
          close,
          userId
            ? {
                userId,
                followUp:
                  actor?.scopes !== undefined &&
                  Array.from(actor.scopes).includes(AuthWorkflowVmFollowUpScope),
              }
            : undefined,
        );
        return () => {
          connections.delete(close);
        };
      }),
  };
  return access;
});
