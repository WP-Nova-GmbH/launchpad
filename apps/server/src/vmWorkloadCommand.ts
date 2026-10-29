import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
/** Enabled only by the private VM entry points. Never infer this from client input. */
export const VmWorkloadTracking = Context.Reference<boolean>("t3/VmWorkloadTracking", {
  defaultValue: () => false,
});
/** One stopped-source transfer/setup may launch tracked helpers while its gate stays closed. */
export const VmSealedWorkloadAdmission = Context.Reference<
  | {
      readonly bootId: string;
      readonly operationId: string;
      readonly epoch: number;
    }
  | undefined
>("t3/VmSealedWorkloadAdmission", { defaultValue: () => undefined });
const helper = "/opt/launchpad/bin/launchpad-workload";
/** exec preserves stdio, cwd and environment; forked and detached children inherit
 * the kernel group. The group ID is created before the requested command runs.
 */
export function vmWorkloadCommand(
  command: string,
  args: ReadonlyArray<string>,
  kind: "process" | "provider" | "terminal",
) {
  const workloadId = NodeCrypto.randomBytes(16).toString("hex");
  return {
    workloadId,
    command: helper,
    args: ["run", workloadId, kind, "--", command, ...args],
    shell: false,
  };
}

/** Only the tunnel, telemetry and workload inspector use this control channel. */
export const VmControlSpawner = Context.Reference<
  ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
>("t3/VmControlSpawner", { defaultValue: () => undefined });

export function makeVmWorkloadSpawner(raw: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  const wrap = (
    command: ChildProcess.Command,
    admission: typeof VmSealedWorkloadAdmission.Service,
  ): ChildProcess.Command => {
    if (ChildProcess.isPipedCommand(command))
      return ChildProcess.pipeTo(
        wrap(command.left, admission),
        wrap(command.right, admission),
        command.options,
      );
    if (command.options.shell)
      throw new Error("VM processes require an explicit shell executable.");
    // Provider and PTY adapters can choose a more specific workload kind.
    const launch =
      command.command === helper
        ? command
        : vmWorkloadCommand(command.command, command.args, "process");
    if (!admission || launch.args[0] !== "run")
      return ChildProcess.make(helper, launch.args, command.options);
    const [, workloadId, , separator, ...args] = launch.args;
    if (!workloadId || separator !== "--") throw new Error("Invalid sealed workload launch");
    return ChildProcess.make(
      helper,
      [
        "run-transfer",
        admission.bootId,
        admission.operationId,
        String(admission.epoch),
        workloadId,
        "--",
        ...args,
      ],
      command.options,
    );
  };
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const admission = yield* VmSealedWorkloadAdmission;
      const wrapped = yield* Effect.try({
        try: () => wrap(command, admission),
        catch: () =>
          PlatformError.badArgument({
            module: "VmWorkload",
            method: "spawn",
            description: "VM workload launch could not be tracked.",
          }),
      });
      return yield* raw.spawn(wrapped);
    }),
  );
}

/** Install at the private guest entry point, before constructing server services.
 * This also covers short-lived Git/probe/auth processes that bypass ProcessRunner.
 */
export const withVmWorkloads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const raw = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeVmWorkloadSpawner(raw)),
      Effect.provideService(VmControlSpawner, raw),
      Effect.provideService(VmWorkloadTracking, true),
    );
  });
