import { sendThreadVmCommandInput } from "./E2BThreadVmGuestCommand.ts";
import { Sandbox } from "e2b";
import {
  ThreadVmRestoreBoot,
  ThreadVmWarmRestoreBootstrap,
  ThreadVmWarmRestoreBootstrapReceipt,
  RelayThreadVmRestoreImportReceipt,
} from "@t3tools/contracts/relay";
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
const encodeWarmBootstrap = Schema.encodeSync(Schema.fromJsonString(ThreadVmWarmRestoreBootstrap));
const decodeWarmBootstrap = Schema.decodeUnknownSync(ThreadVmWarmRestoreBootstrap);
const decodeWarmReceipt = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadVmWarmRestoreBootstrapReceipt),
);
const bootstrapGuest: Guest = async (connection, payload) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    "/usr/bin/flock --no-fork -x /run/launchpad-restore-identity.lock /opt/launchpad/server/t3 __thread-vm-restore-identity --base-dir /home/user/.launchpad",
    { user: "root", background: true, stdin: true, timeoutMs: 60_000 },
  );
  const result = await sendThreadVmCommandInput(command, payload);
  if (result.exitCode !== 0) throw new Error("Warm restore bootstrap is unconfirmed");
  return result.stdout;
};

/** Native envd is independent of app ingress. This never connects or wakes a VM. */
export function makeE2BThreadVmWarmRestoreBootstrap(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: Guest = bootstrapGuest,
) {
  return Effect.fn("relay.thread_vm.restore.bootstrap_guest")(function* (
    sandboxId: string,
    identity: E2BThreadVmIdentity,
    input: ThreadVmWarmRestoreBootstrap,
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const expected = decodeWarmBootstrap(input);
        if (
          expected.boot.operationId !== identity.operationId ||
          expected.boot.allocationId !== identity.scope.allocationId ||
          expected.boot.threadId !== identity.scope.threadId ||
          expected.boot.generation !== identity.scope.generation ||
          expected.boot.threadId !== expected.source.threadId ||
          expected.boot.generation <= expected.source.generation
        )
          throw new Error("Warm restore scope differs");
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        const receipt = decodeWarmReceipt(
          (await guest(connection, encodeWarmBootstrap(expected))).trim(),
        );
        if (
          encodeWarmBootstrap(receipt) !== encodeWarmBootstrap(expected) ||
          receipt.targetSealEpoch !== expected.source.sealEpoch + 1
        )
          throw new Error("Warm restore bootstrap receipt differs");
        return receipt;
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "bootstrap",
          message: "Saved VM bootstrap is unconfirmed. Execution remains blocked.",
        }),
    });
  });
}
const importGuest: Guest = async (connection, payload) => {
  const vm = new Sandbox(connection);
  const command = await vm.commands.run(
    "/usr/bin/flock --no-fork -x /home/user/.launchpad-enrollment.lock /opt/launchpad/server/t3 __thread-vm-restore-import --base-dir /home/user/.launchpad",
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
          "/usr/bin/flock --no-fork -x /run/launchpad-restore-identity.lock /opt/launchpad/server/t3 __thread-vm-restore-cleanup --base-dir /home/user/.launchpad",
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
