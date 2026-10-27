import { Sandbox } from "e2b";
import * as NodeCrypto from "node:crypto";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadVmComputeError, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmConnection } from "./E2BThreadVmConnection.ts";

const Inventory = Schema.Struct({
  bootId: Schema.String,
  sealedBy: Schema.NullOr(Schema.String),
  stopped: Schema.Boolean,
  groups: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Inventory));
// The server seals before publishing its recovery point. Use the same opaque
// helper identity as apps/server/src/vmWorkload.ts when reconciling that seal.
const workloadOperationId = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
type GuestCommand = (
  connection: ConstructorParameters<typeof Sandbox>[0],
  command: string,
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
const guestCommand: GuestCommand = (connection, command) =>
  new Sandbox(connection).commands.run(command, { user: "user", timeoutMs: 10_000 });

/** The guest lock makes the idle check and launch seal one operation. */
export function makeE2BThreadVmPause(
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
  guest: GuestCommand = guestCommand,
) {
  const run = (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    command: (inventory: typeof Inventory.Type) => string | null,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const connection = await inspectE2BThreadVmConnection(
          settings,
          sandboxId,
          identity,
          transport,
          signal,
        );
        const initial = await guest(connection, "/usr/local/bin/launchpad-workload inspect");
        if (initial.exitCode !== 0) throw new Error("Workload inventory unavailable");
        const inventory = decode(initial.stdout);
        const bootId = inventory.bootId;
        if (!/^[0-9a-f-]{36}$/u.test(bootId)) throw new Error("Invalid guest boot identity");
        const action = command(inventory);
        if (action === null) return inventory;
        const result = await guest(connection, action);
        if (result.exitCode !== 0) throw new Error("Guest workload gate unavailable");
        return decode(result.stdout);
      },
      catch: () =>
        new ThreadVmComputeError({
          operation: "pause gate",
          message: "VM workload gate could not be confirmed.",
        }),
    });
  const seal = (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    pauseOperationId: string,
  ) => {
    const operationId = workloadOperationId(pauseOperationId);
    return run(
      sandboxId,
      identity,
      ({ bootId }) => `/usr/local/bin/launchpad-workload seal ${bootId} ${operationId}`,
    ).pipe(
      Effect.flatMap((inventory) =>
        inventory.sealedBy === operationId
          ? Effect.succeed({
              bootId: inventory.bootId,
              idle: inventory.stopped && inventory.groups.length === 0,
            })
          : Effect.fail(
              new ThreadVmComputeError({
                operation: "pause gate",
                message: "VM workload seal does not match.",
              }),
            ),
      ),
    );
  };
  const reopen = (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    pauseOperationId: string,
  ) => {
    const operationId = workloadOperationId(pauseOperationId);
    return run(
      sandboxId,
      identity,
      ({ bootId }) => `/usr/local/bin/launchpad-workload reopen ${bootId} ${operationId}`,
    );
  };
  const reopenAfterResume = (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    pauseOperationId: string | null,
  ) => {
    const operationId = pauseOperationId === null ? null : workloadOperationId(pauseOperationId);
    return run(sandboxId, identity, (inventory) => {
      if (inventory.sealedBy === null) return null;
      if (inventory.sealedBy !== operationId)
        throw new Error("Another operation owns the workload gate");
      return `/usr/local/bin/launchpad-workload reopen ${inventory.bootId} ${operationId}`;
    }).pipe(
      Effect.flatMap((inventory) =>
        inventory.sealedBy === null
          ? Effect.void
          : Effect.fail(
              new ThreadVmComputeError({
                operation: "resume gate",
                message: "VM workload gate did not reopen.",
              }),
            ),
      ),
    );
  };
  return { seal, reopen, reopenAfterResume };
}
