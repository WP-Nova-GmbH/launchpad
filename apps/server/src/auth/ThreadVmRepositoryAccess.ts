import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
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
  const refresh = yield* Semaphore.make(1);
  const connections = new Set<Effect.Effect<void>>();
  let ownerUserId: string | undefined;
  let validUntil = 0;
  // Coalesce stream checks for five seconds. Idle connections also renew, and a
  // failed renewal drains them within one interval plus the five-second timeout.
  const authorize = (userId: string, force = false) =>
    refresh.withPermits(1)(
      Effect.gen(function* () {
        if (ownerUserId !== undefined && userId !== ownerUserId) return yield* denied();
        const startedAt = (yield* DateTime.now).epochMilliseconds;
        if (!force && ownerUserId === userId && startedAt < validUntil) return;
        yield* Effect.gen(function* () {
          const access = yield* client.threadEnvironment.checkClientAccess({
            params: { environmentId, threadId: vm.scope.threadId },
            payload: { generation: vm.scope.generation, userId },
          });
          if (
            access.environmentId !== environmentId ||
            access.threadId !== vm.scope.threadId ||
            access.projectId !== projectId ||
            access.repositoryId !== vm.scope.repositoryId ||
            access.generation !== vm.scope.generation ||
            access.userId !== userId ||
            (yield* DateTime.now).epochMilliseconds >= startedAt + 5000
          )
            return yield* denied();
          ownerUserId = userId;
          validUntil = startedAt + 5000;
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(denied),
          Effect.tapError(() =>
            Effect.sync(() => {
              validUntil = 0;
            }),
          ),
        );
      }),
    );
  const requireMember = (actor: RepositoryActor) =>
    actor.user ? authorize(actor.user.userId) : Effect.fail(denied());
  const requireProject = (actor: RepositoryActor, requestedProjectId: ProjectId) =>
    requestedProjectId === projectId ? requireMember(actor) : Effect.fail(denied());
  const requireThread = (actor: RepositoryActor, threadId: ThreadId) =>
    threadId === vm.scope.threadId ? requireMember(actor) : Effect.fail(denied());
  yield* forkParked(
    Effect.forever(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (connections.size === 0 || ownerUserId === undefined) return;
            const allowed = yield* authorize(ownerUserId, true).pipe(Effect.isSuccess);
            if (allowed) return;
            const closing = yield* fence.withPermits(1)(
              Effect.sync(() => {
                const closing = [...connections];
                connections.clear();
                return closing;
              }),
            );
            // Release the admission fence before draining. A slow old connection
            // must not prevent revalidation of clients that reconnect meanwhile.
            yield* Effect.forkScoped(Effect.all(closing, { concurrency: "unbounded" }));
          }),
        ),
      ),
    ),
  );
  const access: RepositoryAccessShape = {
    threadId: vm.scope.threadId,
    status: DateTime.now.pipe(
      Effect.map((now) => ({
        enabled: true,
        ready: now.epochMilliseconds < validUntil,
        revision: vm.scope.generation,
      })),
    ),
    requireMember,
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
    registerConnection: (close) =>
      Effect.sync(() => {
        connections.add(close);
        return () => {
          connections.delete(close);
        };
      }),
  };
  return access;
});
