import { readThreadVmRestoreState } from "./ThreadVmRestoreInstall.ts";
import { RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import { assertThreadTransferRuntime } from "../persistence/ThreadTransferRuntime.ts";
import { threadVmMoveServerDigest } from "@t3tools/shared/threadVmServerStart";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { readThreadVmInitialState } from "./ThreadVmInitialState.ts";

export class ThreadVmServerStartError extends Schema.TaggedError<ThreadVmServerStartError>()(
  "ThreadVmServerStartError",
  {},
) {
  override get message() {
    return "VM server startup requires the current prepared thread and ownership fence.";
  }
}
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));

// Pause/final-save drains replace the local operation without replacing enrollment.
// A restart must run the fenced coordinator to reconcile their receipts; this
// check never activates the fence or grants permission to start queued work.
/** Called under the guest's process lock, before starting any server reactors. Never grants execution. */
export const requireThreadVmServerStart = Effect.fn("ThreadVmServer.require_start")(
  function* (receiptSha256: string, workspaceRoot = "/workspace/project") {
    const vm = yield* readInstalledThreadVm();
    const state = yield* readThreadVmInitialState();
    const receipt = state?.receipt;
    if (!vm || !receipt) return yield* new ThreadVmServerStartError();
    const owner = yield* makeThreadExecutionFence(yield* SqlClient.SqlClient).get(
      vm.scope.threadId,
    );
    if (
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId) ||
      receipt.environmentId !== vm.environmentId ||
      receipt.operationId !== vm.operationId ||
      receipt.scope.allocationId !== vm.scope.allocationId ||
      receipt.scope.threadId !== vm.scope.threadId ||
      receipt.scope.repositoryId !== vm.scope.repositoryId ||
      receipt.scope.generation !== 1 ||
      vm.scope.generation !== 1 ||
      receipt.workspaceRoot !== workspaceRoot ||
      state.workspaceRoot !== workspaceRoot ||
      !owner ||
      !["draining", "frozen", "active"].includes(owner.phase) ||
      owner.generation !== 1 ||
      owner.environmentId !== vm.environmentId ||
      owner.relayUrl !== vm.relayUrl ||
      owner.projectId !== receipt.projectId
    )
      return yield* new ThreadVmServerStartError();
    const digest = yield* (yield* Crypto.Crypto).digest(
      "SHA-256",
      new TextEncoder().encode(yield* encodeReceipt(receipt)),
    );
    const actual = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== receiptSha256) return yield* new ThreadVmServerStartError();
    return receipt;
  },
  Effect.mapError(() => new ThreadVmServerStartError()),
);

/** A fresh move guest may receive its archive before it has a checkout. Only
 * its confirmed enrollment can launch this server; queue execution stays fenced. */
export const requireThreadVmMoveServerStart = Effect.fn("ThreadVmServer.require_move_start")(
  function* (receiptSha256: string, workspaceRoot = "/workspace/project") {
    const vm = yield* readInstalledThreadVm();
    if (
      !vm ||
      vm.scope.generation <= 1 ||
      (yield* readThreadVmInitialState()) !== null ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
    )
      return yield* new ThreadVmServerStartError();
    const digest = yield* threadVmMoveServerDigest({
      enrolled: true,
      operationId: vm.operationId,
      allocationId: vm.scope.allocationId,
      threadId: vm.scope.threadId,
      generation: vm.scope.generation,
      environmentId: vm.environmentId,
    });
    if (digest !== receiptSha256) return yield* new ThreadVmServerStartError();
    const sql = yield* SqlClient.SqlClient;
    const owner = yield* makeThreadExecutionFence(sql).get(vm.scope.threadId);
    if (
      owner &&
      (owner.environmentId !== vm.environmentId ||
        owner.relayUrl !== vm.relayUrl ||
        owner.generation !== vm.scope.generation ||
        owner.projectId !== `vm:${vm.scope.threadId}` ||
        !["draining", "frozen", "active"].includes(owner.phase))
    )
      return yield* new ThreadVmServerStartError();
    const unrelated =
      yield* sql`SELECT 1 FROM projection_threads WHERE thread_id!=${vm.scope.threadId}
      UNION ALL SELECT 1 FROM projection_projects WHERE project_id!=${`vm:${vm.scope.threadId}`} LIMIT 1`;
    if (unrelated.length) return yield* new ThreadVmServerStartError();
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const parent = path.dirname(workspaceRoot);
    if ((yield* fs.realPath(parent)) !== parent) return yield* new ThreadVmServerStartError();
    if (!(yield* fs.exists(workspaceRoot))) yield* fs.makeDirectory(workspaceRoot, { mode: 0o700 });
    if (
      (yield* fs.realPath(workspaceRoot)) !== workspaceRoot ||
      (!owner && (yield* fs.readDirectory(workspaceRoot)).length)
    )
      return yield* new ThreadVmServerStartError();
  },
  Effect.mapError(() => new ThreadVmServerStartError()),
);

const encodeRestoreReceipt = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmRestoreImportReceipt),
);
/** A restored VM starts its coordinator only after complete frozen installation.
 * Provider readiness and current relay acknowledgement still precede activation. */
export const requireThreadVmRestoreServerStart = Effect.fn("ThreadVmServer.require_restore_start")(
  function* (receiptSha256: string, workspaceRoot = "/workspace/project") {
    const vm = yield* readInstalledThreadVm(),
      state = yield* readThreadVmRestoreState();
    if (!vm || !state || vm.scope.generation <= 1 || (yield* readThreadVmInitialState()) !== null)
      return yield* new ThreadVmServerStartError();
    const receipt = state.receipt,
      sql = yield* SqlClient.SqlClient;
    const owner = yield* makeThreadExecutionFence(sql).get(vm.scope.threadId);
    if (
      !owner ||
      !["active", "frozen", "draining"].includes(owner.phase) ||
      (owner.phase === "frozen" &&
        owner.operationId !== vm.operationId &&
        state.phase !== "activated") ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId) ||
      owner.environmentId !== vm.environmentId ||
      owner.relayUrl !== vm.relayUrl ||
      receipt.environmentId !== vm.environmentId ||
      receipt.operationId !== vm.operationId ||
      owner.projectId !== receipt.projectId ||
      receipt.projectId !== `vm:${vm.scope.threadId}` ||
      owner.generation !== vm.scope.generation ||
      receipt.scope.generation !== vm.scope.generation ||
      receipt.scope.allocationId !== vm.scope.allocationId ||
      receipt.scope.repositoryId !== vm.scope.repositoryId ||
      receipt.scope.threadId !== vm.scope.threadId ||
      receipt.workspaceRoot !== workspaceRoot
    )
      return yield* new ThreadVmServerStartError();
    const [baseline] =
      yield* sql`SELECT 1 FROM thread_transfer_baselines WHERE operation_id=${vm.operationId} AND thread_id=${vm.scope.threadId}
      AND generation=${vm.scope.generation} AND manifest_sha256=${receipt.manifestSha256} AND destination_sequence=${receipt.sequence}`;
    if (!baseline) return yield* new ThreadVmServerStartError();
    if (
      state.phase !== "activated" ||
      (owner.phase === "frozen" && owner.operationId === vm.operationId)
    )
      yield* assertThreadTransferRuntime(sql, vm.operationId);
    const bytes = yield* (yield* Crypto.Crypto).digest(
      "SHA-256",
      new TextEncoder().encode(yield* encodeRestoreReceipt(receipt)),
    );
    const digest = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== receiptSha256) return yield* new ThreadVmServerStartError();
    const fs = yield* FileSystem.FileSystem;
    if (
      (yield* fs.realPath(workspaceRoot)) !== workspaceRoot ||
      (yield* fs.realPath(receipt.checkoutPath)) !== receipt.checkoutPath
    )
      return yield* new ThreadVmServerStartError();
    return receipt;
  },
  Effect.mapError(() => new ThreadVmServerStartError()),
);
