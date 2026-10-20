import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
/** Enabled only by the private VM entry points. Never infer this from client input. */
export const VmWorkloadTracking = Context.Reference<boolean>("t3/VmWorkloadTracking", {
  defaultValue: () => false,
});
const helper = "/usr/local/bin/launchpad-workload";
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
  const wrap = (command: ChildProcess.Command): ChildProcess.Command => {
    if (ChildProcess.isPipedCommand(command))
      return ChildProcess.pipeTo(wrap(command.left), wrap(command.right), command.options);
    if (command.options.shell)
      throw new Error("VM processes require an explicit shell executable.");
    // Provider and PTY adapters can choose a more specific workload kind.
    if (command.command === helper) return command;
    const launch = vmWorkloadCommand(command.command, command.args, "process");
    return ChildProcess.make(launch.command, launch.args, command.options);
  };
  return ChildProcessSpawner.make((command) =>
    Effect.try({
      try: () => wrap(command),
      catch: () =>
        PlatformError.badArgument({
          module: "VmWorkload",
          method: "spawn",
          description: "VM workload launch could not be tracked.",
        }),
    }).pipe(Effect.flatMap((wrapped) => raw.spawn(wrapped))),
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
