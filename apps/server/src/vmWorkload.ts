import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "./processRunner.ts";
import {
  VmControlSpawner,
  VmWorkloadTracking,
  VmSealedWorkloadAdmission,
  VmWorkloadMaintenance,
  makeVmWorkloadSpawner,
} from "./vmWorkloadCommand.ts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";

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
export class VmWorkloadError extends Schema.TaggedError<VmWorkloadError>()("VmWorkloadError", {
  reason: Schema.optional(
    Schema.Literals([
      "control_unavailable",
      "command_exit",
      "command",
      "timeout",
      "decode",
      "identity_mismatch",
    ]),
  ),
  action: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `VM workload state could not be confirmed${this.reason ? ` (${this.reason})` : ""}.`;
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
const decodeHarnessPeer = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ matched: Schema.Boolean })),
);
const decodeWorkflowRecovery = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ ...VmWorkloadInventory.fields, recoverable: Schema.Literal(true) }),
  ),
);
export type VmHarnessStop = typeof VmHarnessStop.Type;
export type VmHarnessStopAdmission = (
  signal: Effect.Effect<VmHarnessStop, VmWorkloadError>,
) => Effect.Effect<VmHarnessStop, VmWorkloadError>;
const isVmWorkloadError = Schema.is(VmWorkloadError);
const harnessFailure = (cause: unknown) =>
  isVmWorkloadError(cause) ? cause : new VmWorkloadError({ reason: "decode", cause });
const harnessCommand = Effect.fn("VmWorkload.owned_harness")(function* (
  args: ReadonlyArray<string>,
) {
  const clock = yield* Clock.Clock;
  const start = clock.monotonicTimeNanosUnsafe();
  const action = args[0];
  const control = yield* VmControlSpawner;
  if (!control) return yield* new VmWorkloadError({ reason: "control_unavailable", action });
  const runner = yield* ProcessRunner.make().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, control),
  );
  const result = yield* runner
    .run({
      command: "/opt/launchpad/bin/launchpad-workload",
      args,
      // The identity helper hashes the pinned Codex executable on cold VM storage.
      timeout: action === "provider-identity" ? "30 seconds" : "10 seconds",
      maxOutputBytes: 4096,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new VmWorkloadError({
            reason: cause._tag === "ProcessTimeoutError" ? "timeout" : "command",
            action,
            cause,
          }),
      ),
      Effect.onExit(() =>
        Effect.annotateCurrentSpan({
          action,
          elapsedMs: Number(clock.monotonicTimeNanosUnsafe() - start) / 1_000_000,
        }),
      ),
    );
  if (result.code !== 0)
    return yield* new VmWorkloadError({
      reason: "command_exit",
      action,
      ...(result.code !== null ? { exitCode: result.code } : {}),
    });
  return result.stdout;
});
export const readVmHarnessIdentity = Effect.fn("VmWorkload.read_harness")(function* (
  groupId: string,
  pid: number,
) {
  const raw = yield* harnessCommand(["provider-identity", groupId, String(pid)]);
  const identity = yield* decodeHarnessIdentity(raw).pipe(
    Effect.mapError(
      (cause) => new VmWorkloadError({ reason: "decode", action: "provider-identity", cause }),
    ),
  );
  if (identity.groupId !== groupId || identity.pid !== pid)
    return yield* new VmWorkloadError({ reason: "identity_mismatch", action: "provider-identity" });
  return identity;
});
export const verifyWorkflowVmHarnessPeer = Effect.fn("VmWorkload.verify_workflow_harness_peer")(
  function* (identity: VmHarnessIdentity, listenerPort: number, clientPort: number) {
    const receipt = yield* harnessCommand([
      "verify-workflow-provider-peer",
      identity.groupId,
      String(identity.pid),
      identity.startTicks,
      String(listenerPort),
      String(clientPort),
    ]);
    return (yield* decodeHarnessPeer(receipt)).matched;
  },
  Effect.mapError(harnessFailure),
);
export const stopIdleVmHarness = Effect.fn("VmWorkload.stop_harness")(function* (
  identity: VmHarnessIdentity,
  operationId: string,
) {
  const encoded = yield* encodeHarnessIdentity(identity);
  return yield* decodeHarnessStop(
    yield* harnessCommand([
      "stop-idle-provider",
      NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32),
      identity.groupId,
      encoded,
    ]),
  );
}, Effect.mapError(harnessFailure));

/** Only the privileged controller can attest that retained setup work is passive. */
export const inspectWorkflowVmRecovery = Effect.fn("VmWorkload.inspect_workflow_recovery")(
  function* () {
    const state = yield* decodeWorkflowRecovery(yield* harnessCommand(["workflow-recovery-state"]));
    if (
      state.sealedBy !== null ||
      state.stopped !== (state.groups.length === 0) ||
      state.groups.some((group) => group.bootId !== state.bootId) ||
      new Set(state.groups.map((group) => group.id)).size !== state.groups.length
    )
      return yield* new VmWorkloadError({
        reason: "identity_mismatch",
        action: "workflow-recovery-state",
      });
    return state;
  },
  Effect.mapError(harnessFailure),
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
      command: "/opt/launchpad/bin/launchpad-workload",
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

/** Serialize operations that inspect and use one guest's unchanged workload seal. */
export const withVmWorkloadMaintenance = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  if (!(yield* VmWorkloadTracking)) return yield* effect;
  const maintenance = yield* VmWorkloadMaintenance;
  if (!maintenance) return yield* new VmWorkloadError();
  return yield* maintenance.withPermits(1)(effect);
});

/** A source export may run its own Git commands while ordinary launches stay
 * sealed. Those commands get tracked too: a detached export hook blocks the final
 * receipt instead of being mistaken for a stopped workspace.
 */
export const withSealedVmWorkloads = <A, E, R>(
  operationId: string,
  effect: Effect.Effect<A, E, R>,
  expected?: { readonly bootId: string; readonly epoch: number },
) =>
  withVmWorkloadMaintenance(
    Effect.gen(function* () {
      if (!(yield* VmWorkloadTracking)) return yield* effect;
      const control = yield* VmControlSpawner;
      if (!control) return yield* new VmWorkloadError();
      const operation = NodeCrypto.createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 32);
      const before = yield* inspectVmWorkloads({ type: "inspect" });
      if (
        !before.stopped ||
        before.sealedBy !== operation ||
        (expected && (before.bootId !== expected.bootId || before.epoch !== expected.epoch))
      )
        return yield* new VmWorkloadError();
      const spawner = makeVmWorkloadSpawner(control);
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const verifyStopped = Effect.gen(function* () {
        const after = yield* inspectVmWorkloads({ type: "inspect" });
        if (
          !after.stopped ||
          after.bootId !== before.bootId ||
          after.epoch !== before.epoch ||
          after.sealedBy !== operation
        )
          return yield* new VmWorkloadError();
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new VmWorkloadError()),
        }),
      );
      return yield* effect.pipe(
        Effect.provideService(VmSealedWorkloadAdmission, {
          bootId: before.bootId,
          operationId: operation,
          epoch: before.epoch,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? verifyStopped : verifyStopped.pipe(Effect.ignoreCause),
        ),
      );
    }),
  );
