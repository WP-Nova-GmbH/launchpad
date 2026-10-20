import { Sandbox } from "e2b";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";

type GuestStart = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  command: string,
) => Promise<void>;
const startGuest: GuestStart = async (connection, command) => {
  const vm = new Sandbox(connection);
  await vm.commands.run(command, { user: "user", background: true, timeoutMs: 0 });
};

/** Reconciliation never wakes a paused VM. flock owns the singleton across transport retries. */
export function makeE2BThreadVmServer(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  start: GuestStart = startGuest,
) {
  return Effect.fn("relay.thread_vm.start_server")(function* (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    receiptSha256: string,
    mode: "initial" | "move" | "restore" = "initial",
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        // The only interpolated argument is a digest, never shell text, identity data or a secret.
        if (!/^[0-9a-f]{64}$/u.test(receiptSha256)) throw new Error("Invalid receipt digest");
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        await start(
          connection,
          "flock --nonblock --conflict-exit-code 75 --no-fork /home/user/.launchpad/thread-server.lock launchpad-server __thread-vm-serve --receipt-sha256 " +
            receiptSha256 +
            (mode === "move" ? " --move" : mode === "restore" ? " --restore" : ""),
        );
        // This acknowledges a launch request only. Execution readiness comes from the guest's relay handshake.
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "startup",
          message: "VM server startup is unconfirmed.",
        }),
    });
  });
}
