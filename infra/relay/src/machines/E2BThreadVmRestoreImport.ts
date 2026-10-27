import { sendThreadVmCommandInput } from "./E2BThreadVmGuestCommand.ts";
import { Sandbox } from "e2b";
import { ThreadVmRestoreBoot, RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection, type E2BThreadVmIdentity } from "./E2BThreadVmConnection.ts";
const encodeBoot = Schema.encodeSync(Schema.fromJsonString(ThreadVmRestoreBoot));
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayThreadVmRestoreImportReceipt),
);
type Guest = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  payload: string,
) => Promise<string>;
const importGuest: Guest = async (connection, payload) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    "flock --no-fork -x /home/user/.launchpad-enrollment.lock launchpad-server __thread-vm-restore-import --base-dir /home/user/.launchpad",
    {
      user: "user",
      background: true,
      stdin: true,
      timeoutMs: 20 * 60_000,
    },
  );
  const result = await sendThreadVmCommandInput(command, payload);
  if (result.exitCode !== 0) throw new Error("Restore import is unconfirmed");
  return result.stdout;
};
/** Inspect-only attachment; imported bytes never grant execution permission. */
export function makeE2BThreadVmRestoreImport(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: Guest = importGuest,
) {
  return Effect.fn("relay.thread_vm.restore.import_guest")(function* (
    sandboxId: string,
    environmentId: string,
    identity: E2BThreadVmIdentity,
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        const receipt = decodeReceipt(
          (
            await guest(
              connection,
              encodeBoot({
                version: 1,
                operationId: identity.operationId,
                allocationId: identity.scope.allocationId,
                threadId: identity.scope.threadId,
                generation: identity.scope.generation,
              }),
            )
          ).trim(),
        );
        if (
          receipt.operationId !== identity.operationId ||
          receipt.environmentId !== environmentId ||
          receipt.scope.allocationId !== identity.scope.allocationId ||
          receipt.scope.threadId !== identity.scope.threadId ||
          receipt.scope.repositoryId !== identity.scope.repositoryId ||
          receipt.scope.generation !== identity.scope.generation ||
          receipt.projectId !== `vm:${identity.scope.threadId}` ||
          receipt.workspaceRoot !== "/workspace/project" ||
          (receipt.checkoutPath !== receipt.workspaceRoot &&
            !receipt.checkoutPath.startsWith("/home/user/.launchpad/worktrees/"))
        )
          throw new Error("Restore receipt differs");
        return receipt;
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "setup",
          message: "Saved VM import is unconfirmed. Execution remains blocked.",
        }),
    });
  });
}

/** Cleanup is issued only for a completed restore by the durable relay worker. */
export function makeE2BThreadVmRestoreCleanup(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
) {
  return Effect.fn("relay.thread_vm.restore.cleanup_guest")(function* (
    sandboxId: string,
    identity: E2BThreadVmIdentity,
  ) {
    yield* Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
            settings,
            sandboxId,
            identity,
            transport,
            signal,
          ),
          vm = new Sandbox(connection);
        const command = await vm.commands.run(
          "flock --no-fork -x /run/launchpad-restore-identity.lock launchpad-server __thread-vm-restore-cleanup --base-dir /home/user/.launchpad",
          { user: "root", background: true, stdin: true, timeoutMs: 60_000 },
        );
        const result = await sendThreadVmCommandInput(
          command,
          encodeBoot({
            version: 1,
            operationId: identity.operationId,
            allocationId: identity.scope.allocationId,
            threadId: identity.scope.threadId,
            generation: identity.scope.generation,
          }),
        );
        if (result.exitCode !== 0 || result.stdout.trim() !== '{"cleaned":true}')
          throw new Error("Restore cleanup unconfirmed");
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "setup",
          message: "Retired VM identity cleanup is unconfirmed.",
        }),
    });
  });
}
