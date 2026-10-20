import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "./processRunner.ts";
import { VmControlSpawner, VmWorkloadTracking } from "./vmWorkloadCommand.ts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const BootId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
export const VmWorkloadInventory = Schema.Struct({
  bootId: BootId,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sealedBy: Schema.NullOr(Identifier),
  groups: Schema.Array(
    Schema.Struct({
      id: Identifier,
      bootId: BootId,
      kind: Schema.Literals(["process", "provider", "terminal", "transfer"]),
      leaderPid: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  stopped: Schema.Boolean,
});
export class VmWorkloadError extends Schema.TaggedError<VmWorkloadError>()("VmWorkloadError", {}) {
  override get message() {
    return "VM workload state could not be confirmed.";
  }
}

export const VmHarnessIdentity = Schema.Struct({
  bootId: BootId,
  groupId: Identifier,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startTicks: Schema.String.check(Schema.isPattern(/^[0-9]+$/u)),
  executableSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type VmHarnessIdentity = typeof VmHarnessIdentity.Type;
const VmHarnessStop = Schema.Struct({ admitted: Schema.Boolean });
const harnessIdentityJson = Schema.fromJsonString(VmHarnessIdentity);
const decodeHarnessIdentity = Schema.decodeEffect(harnessIdentityJson);
const encodeHarnessIdentity = Schema.encodeEffect(harnessIdentityJson);
const decodeHarnessStop = Schema.decodeEffect(Schema.fromJsonString(VmHarnessStop));
export type VmHarnessStop = typeof VmHarnessStop.Type;
export type VmHarnessStopAdmission = (
  signal: Effect.Effect<VmHarnessStop, VmWorkloadError>,
) => Effect.Effect<VmHarnessStop, VmWorkloadError>;
const harnessCommand = Effect.fn("VmWorkload.owned_harness")(
  function* (args: ReadonlyArray<string>) {
    const control = yield* VmControlSpawner;
    if (!control) return yield* new VmWorkloadError();
    const runner = yield* ProcessRunner.make().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, control),
    );
    const result = yield* runner.run({
      command: "/usr/local/bin/launchpad-workload",
      args,
      timeout: "10 seconds",
      maxOutputBytes: 4096,
    });
    if (result.code !== 0) return yield* new VmWorkloadError();
    return result.stdout;
  },
  Effect.mapError(() => new VmWorkloadError()),
);
export const readVmHarnessIdentity = Effect.fn("VmWorkload.read_harness")(
  function* (groupId: string, pid: number) {
    const identity = yield* decodeHarnessIdentity(
      yield* harnessCommand(["provider-identity", groupId, String(pid)]),
    );
    if (identity.groupId !== groupId || identity.pid !== pid) return yield* new VmWorkloadError();
    return identity;
  },
  Effect.mapError(() => new VmWorkloadError()),
);
export const stopIdleVmHarness = Effect.fn("VmWorkload.stop_harness")(
  function* (identity: VmHarnessIdentity, operationId: string) {
    const encoded = yield* encodeHarnessIdentity(identity);
    return yield* decodeHarnessStop(
      yield* harnessCommand([
        "stop-idle-provider",
        NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32),
        identity.groupId,
        encoded,
      ]),
    );
  },
  Effect.mapError(() => new VmWorkloadError()),
);

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(VmWorkloadInventory));
/** Control operations stay outside the workload group so inspection cannot count
 * itself as busy. An unreadable or contradictory inventory is never an empty one.
 */
export const inspectVmWorkloads = Effect.fn("VmWorkload.inspect")(
  function* (
    action:
      | { readonly type: "inspect" }
      | {
          readonly type: "seal" | "reopen" | "stop";
          readonly bootId: string;
          readonly operationId: string;
        },
  ) {
    const operation =
      action.type === "inspect"
        ? undefined
        : NodeCrypto.createHash("sha256").update(action.operationId).digest("hex").slice(0, 32);
    const args = action.type === "inspect" ? ["inspect"] : [action.type, action.bootId, operation!];
    const control = (yield* VmControlSpawner) ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
    const runner = yield* ProcessRunner.make().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, control),
    );
    const result = yield* runner.run({
      command: "/usr/local/bin/launchpad-workload",
      args,
      timeout: "10 seconds",
      maxOutputBytes: 1024 * 1024,
    });
    if (result.code !== 0) return yield* new VmWorkloadError();
    const inventory = yield* decode(result.stdout);
    if (
      inventory.stopped !== (inventory.groups.length === 0) ||
      inventory.groups.some((group) => group.bootId !== inventory.bootId) ||
      new Set(inventory.groups.map((group) => group.id)).size !== inventory.groups.length ||
      (action.type !== "inspect" && inventory.bootId !== action.bootId) ||
      ((action.type === "seal" || action.type === "stop") && inventory.sealedBy !== operation) ||
      (action.type === "reopen" && inventory.sealedBy !== null)
    ) {
      return yield* new VmWorkloadError();
    }
    return inventory;
  },
  Effect.mapError(() => new VmWorkloadError()),
);

/** A source export may run its own Git commands while ordinary launches stay
 * sealed. Those commands get tracked too: a detached export hook blocks the final
 * receipt instead of being mistaken for a stopped workspace.
 */
export const withSealedVmWorkloads = <A, E, R>(
  operationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!(yield* VmWorkloadTracking)) return yield* effect;
    const control = yield* VmControlSpawner;
    if (!control) return yield* new VmWorkloadError();
    const operation = NodeCrypto.createHash("sha256")
      .update(operationId)
      .digest("hex")
      .slice(0, 32);
    const before = yield* inspectVmWorkloads({ type: "inspect" });
    if (!before.stopped || before.sealedBy !== operation) return yield* new VmWorkloadError();
    const wrap = (command: ChildProcess.Command): ChildProcess.Command => {
      if (ChildProcess.isPipedCommand(command))
        return ChildProcess.pipeTo(wrap(command.left), wrap(command.right), command.options);
      if (command.options.shell) throw new Error("Transfer requires a direct executable.");
      return ChildProcess.make(
        "/usr/local/bin/launchpad-workload",
        [
          "run-transfer",
          before.bootId,
          operation,
          String(before.epoch),
          NodeCrypto.randomBytes(16).toString("hex"),
          "--",
          command.command,
          ...command.args,
        ],
        command.options,
      );
    };
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.try({
        try: () => wrap(command),
        catch: () =>
          PlatformError.badArgument({
            module: "VmWorkload",
            method: "export",
            description: "Transfer command could not be tracked.",
          }),
      }).pipe(Effect.flatMap((wrapped) => control.spawn(wrapped))),
    );
    const runner = yield* ProcessRunner.make().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const result = yield* effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    const after = yield* inspectVmWorkloads({ type: "inspect" });
    if (
      !after.stopped ||
      after.bootId !== before.bootId ||
      after.epoch !== before.epoch ||
      after.sealedBy !== operation
    )
      return yield* new VmWorkloadError();
    return result;
  });
