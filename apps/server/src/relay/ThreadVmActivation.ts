import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { readThreadVmInitialState } from "./ThreadVmInitialState.ts";

export class ThreadVmActivationError extends Schema.TaggedError<ThreadVmActivationError>()(
  "ThreadVmActivationError",
  {},
) {
  override get message() {
    return "VM execution is waiting for relay confirmation.";
  }
}

/** Startup may mirror history while frozen; no local timeout or receipt can grant ownership. */
export const activateInitialThreadVm = Effect.fn("ThreadVmActivation.activate_initial")(
  function* (threadId: string) {
    const vm = yield* readInstalledThreadVm();
    if (!vm || vm.scope.threadId !== threadId || vm.scope.generation !== 1) return false;
    const fence = makeThreadExecutionFence(yield* SqlClient.SqlClient);
    const owner = yield* fence.get(threadId);
    if (!owner || owner.phase !== "frozen" || owner.operationId !== vm.operationId) return false;
    const initial = yield* readThreadVmInitialState();
    const receipt = initial?.receipt;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    if (
      !receipt ||
      environmentId !== vm.environmentId ||
      receipt.environmentId !== environmentId ||
      receipt.operationId !== vm.operationId ||
      receipt.scope.allocationId !== vm.scope.allocationId ||
      receipt.scope.repositoryId !== vm.scope.repositoryId ||
      receipt.scope.threadId !== threadId ||
      receipt.scope.generation !== 1 ||
      owner.environmentId !== environmentId ||
      owner.relayUrl !== vm.relayUrl ||
      owner.projectId !== receipt.projectId ||
      owner.generation !== 1
    )
      return yield* new ThreadVmActivationError();
    const client = yield* makeExecutorRelayApiClient({
      url: vm.relayUrl,
      issuer: vm.relayIssuer,
      environmentCredential: vm.environmentCredential,
    });
    const confirmation = yield* client.threadEnvironment.confirmInitialActivation({
      params: {
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make(threadId),
      },
      payload: receipt,
    });
    if (!confirmation.ready) return false;
    yield* fence.activate({ threadId, generation: 1, operationId: vm.operationId });
    return true;
  },
  Effect.timeout("15 seconds"),
  Effect.mapError(() => new ThreadVmActivationError()),
);
