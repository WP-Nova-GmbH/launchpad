import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { assertThreadTransferRuntime } from "../persistence/ThreadTransferRuntime.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { prepareThreadTransfer } from "./ThreadTransferReadiness.ts";
import { configureThreadVmRepository } from "./ThreadVmRepositoryBinding.ts";
import {
  readThreadVmRestoreState,
  encodeThreadVmRestoreState,
  THREAD_VM_RESTORE_STATE_SECRET,
} from "./ThreadVmRestoreInstall.ts";
export class ThreadVmRestoreActivationError extends Schema.TaggedError<ThreadVmRestoreActivationError>()(
  "ThreadVmRestoreActivationError",
  {},
) {
  override get message() {
    return "Restored VM execution is waiting for verified setup and current relay ownership.";
  }
}
/** Only the server coordinator runs readiness. Uncertain setup is never replayed,
 * a missing native conversation never falls back to a fresh one, and relay
 * acknowledgement precedes local queue activation. */
export const activateRestoredThreadVm = Effect.fn("ThreadVmRestoreActivation.activate")(
  function* (threadId: string) {
    const vm = yield* readInstalledThreadVm();
    if (!vm || vm.scope.threadId !== threadId || vm.scope.generation <= 1) return false;
    const state = yield* readThreadVmRestoreState();
    if (!state) return false;
    const receipt = state.receipt,
      fences = makeThreadExecutionFence(yield* SqlClient.SqlClient),
      owner = yield* fences.get(threadId);
    if (
      !owner ||
      !["active", "frozen"].includes(owner.phase) ||
      owner.operationId !== vm.operationId
    )
      return false;
    if (
      receipt.environmentId !== vm.environmentId ||
      receipt.operationId !== vm.operationId ||
      receipt.scope.allocationId !== vm.scope.allocationId ||
      receipt.scope.threadId !== threadId ||
      receipt.scope.repositoryId !== vm.scope.repositoryId ||
      receipt.scope.generation !== vm.scope.generation ||
      owner.environmentId !== vm.environmentId ||
      owner.generation !== vm.scope.generation ||
      owner.projectId !== receipt.projectId ||
      owner.relayUrl !== vm.relayUrl ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
    )
      return yield* new ThreadVmRestoreActivationError();
    if (state.phase === "activated" && owner.phase === "active") return false;
    if (owner.phase === "frozen")
      yield* configureThreadVmRepository(owner, receipt.checkoutPath, "import");
    const secrets = yield* ServerSecretStore;
    if (state.phase === "installed") {
      if (owner.phase !== "frozen") return yield* new ThreadVmRestoreActivationError();
      yield* prepareThreadTransfer({
        threadId: ThreadId.make(threadId),
        operationId: vm.operationId,
        generation: vm.scope.generation,
        manifestSha256: receipt.manifestSha256,
      });
      yield* secrets.set(
        THREAD_VM_RESTORE_STATE_SECRET,
        new TextEncoder().encode(yield* encodeThreadVmRestoreState({ ...state, phase: "ready" })),
      );
    }
    if (owner.phase === "frozen")
      yield* assertThreadTransferRuntime(yield* SqlClient.SqlClient, vm.operationId);
    const client = yield* makeExecutorRelayApiClient({
      url: vm.relayUrl,
      issuer: vm.relayIssuer,
      environmentCredential: vm.environmentCredential,
    });
    const confirmation = yield* client.threadEnvironment
      .confirmRestoreActivation({
        params: { environmentId: vm.environmentId, threadId: ThreadId.make(threadId) },
        payload: receipt,
      })
      .pipe(Effect.timeout("15 seconds"));
    if (!confirmation.ready) return false;
    // Persist acknowledgement before opening execution: a crash cannot leave
    // an active provider runtime looking like an unfinished import on restart.
    yield* secrets.set(
      THREAD_VM_RESTORE_STATE_SECRET,
      new TextEncoder().encode(yield* encodeThreadVmRestoreState({ ...state, phase: "activated" })),
    );
    if (owner.phase === "frozen")
      yield* fences.activate({
        threadId,
        generation: vm.scope.generation,
        operationId: vm.operationId,
      });
    return true;
  },
  Effect.mapError(() => new ThreadVmRestoreActivationError()),
);
