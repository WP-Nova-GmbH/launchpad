import { ProcessOnlyCleanup } from "@effect/platform-node/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import { collectUint8StreamText } from "./stream/collectUint8StreamText.ts";
/** Enabled only by the private VM entry points. Never infer this from client input. */
export const VmWorkloadTracking = Context.Reference<boolean>("t3/VmWorkloadTracking", {
  defaultValue: () => false,
});
export const WorkflowVmGuest = Context.Reference<boolean>("t3/WorkflowVmGuest", {
  defaultValue: () => false,
});
export const VmCoordinatorProcess = Context.Reference<boolean>("t3/VmCoordinatorProcess", {
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
export const workflowVmBaseEnvironment = {
  PATH: "/opt/launchpad/bin:/opt/launchpad/node/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/launchpad-workflow",
  CODEX_HOME: "/home/launchpad-workflow/.codex",
  USER: "launchpad-workflow",
  LOGNAME: "launchpad-workflow",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
} as const;

/** The cgroup helper starts before dropping UID. Keep loader settings out of that exec. */
export const workflowVmProcessEnvironment = (env: NodeJS.ProcessEnv | undefined) => ({
  ...Object.fromEntries(
    Object.entries(env ?? {}).filter(
      ([key]) =>
        !/^(LD_|DYLD_|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$|TZDIR$|MALLOC_TRACE$)/u.test(key),
    ),
  ),
  ...workflowVmBaseEnvironment,
});

const workflowGitEnvironmentKeys = [
  "GIT_ALLOW_PROTOCOL",
  "GIT_ATTR_NOSYSTEM",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_LFS_SKIP_SMUDGE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PROGRESS_DELAY",
  "GIT_TRACE2_EVENT",
  "LC_ALL",
] as const;

/** Preserve per-command Git plumbing while dropping inherited auth and Git configuration. */
export const workflowVmGitEnvironment = (env: NodeJS.ProcessEnv | undefined) => ({
  ...Object.fromEntries(workflowGitEnvironmentKeys.map((key) => [key, env?.[key]])),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
});
/** exec preserves stdio, cwd and environment; forked and detached children inherit
 * the kernel group. The group ID is created before the requested command runs.
 */
export function vmWorkloadCommand(
  command: string,
  args: ReadonlyArray<string>,
  kind: "process" | "provider" | "terminal",
  isolated = false,
) {
  const workloadId = NodeCrypto.randomBytes(16).toString("hex");
  return {
    workloadId,
    command: helper,
    args: [isolated ? "run-workflow" : "run", workloadId, kind, "--", command, ...args],
    shell: false,
  };
}

/** Trusted guest controls bypass the workload spawner. */
export const VmControlSpawner = Context.Reference<
  ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
>("t3/VmControlSpawner", { defaultValue: () => undefined });

const signalError = () =>
  PlatformError.badArgument({
    module: "VmWorkload",
    method: "kill",
    description: "Workflow workload exit could not be confirmed.",
  });
const decodeSignalReceipt = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ signalled: Schema.Boolean })),
);
export const signalWorkflowVmWorkload = Effect.fn("VmWorkload.signalWorkflow")(function* (
  raw: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workloadId: string,
  pid: number,
  signal: string,
) {
  if (!["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"].includes(signal)) return yield* signalError();
  const [receipt, code] = yield* Effect.gen(function* () {
    const child = yield* raw.spawn(
      ChildProcess.make(helper, ["signal-workflow", workloadId, String(pid), signal.slice(3)], {
        env: workflowVmBaseEnvironment,
        extendEnv: false,
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    return yield* Effect.all(
      [collectUint8StreamText({ stream: child.stdout, maxBytes: 4096 }), child.exitCode],
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.scoped, Effect.interruptible, Effect.timeout("5 seconds"));
  if (code !== 0 || receipt.truncated) return yield* signalError();
  return (yield* decodeSignalReceipt(receipt.text)).signalled;
}, Effect.mapError(signalError));

export const signalRunningWorkflowVmWorkload = (
  raw: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workloadId: string,
  pid: number,
  signal: string,
  isRunning: Effect.Effect<boolean, PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    // Spawning acknowledges exec of the launcher, before it registers this PID.
    while (yield* isRunning) {
      if (yield* signalWorkflowVmWorkload(raw, workloadId, pid, signal)) return;
      yield* Effect.sleep("25 millis");
    }
  }).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(signalError()) }),
  );

const withWorkflowSignals = Effect.fnUntraced(function* (
  raw: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.StandardCommand,
  child: ChildProcessSpawner.ChildProcessHandle,
) {
  const workloadId = command.args[1]!;
  const awaitExit = child.exitCode.pipe(Effect.ignore, Effect.interruptible);
  const signal = (value: ChildProcess.Signal) =>
    signalRunningWorkflowVmWorkload(raw, workloadId, child.pid, value, child.isRunning);
  const kill = Effect.fnUntraced(function* (options?: ChildProcess.KillOptions) {
    if (!(yield* child.isRunning)) return;
    yield* signal(options?.killSignal ?? "SIGTERM");
    if (options?.forceKillAfter === undefined) return yield* awaitExit;
    if (Option.isSome(yield* awaitExit.pipe(Effect.timeoutOption(options.forceKillAfter)))) return;
    yield* signal("SIGKILL");
    yield* awaitExit.pipe(
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(signalError()) }),
    );
  });
  let referenced = true;
  yield* Effect.addFinalizer(() =>
    referenced
      ? kill({
          killSignal: command.options.killSignal,
          forceKillAfter: command.options.forceKillAfter ?? "2 seconds",
        }).pipe(Effect.ignore)
      : Effect.void,
  );
  return ChildProcessSpawner.makeHandle({
    ...child,
    kill,
    unref: Effect.map(child.unref, (reref) => {
      referenced = false;
      return Effect.tap(reref, () => Effect.sync(() => void (referenced = true)));
    }),
  });
});

export function makeVmWorkloadSpawner(
  raw: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workflow = false,
) {
  const wrap = (
    command: ChildProcess.Command,
    admission: typeof VmSealedWorkloadAdmission.Service,
    trusted: boolean,
  ): ChildProcess.Command => {
    if (ChildProcess.isPipedCommand(command)) {
      if (workflow && !trusted)
        throw new Error("Workflow VM pipelines require an explicit shell executable.");
      return ChildProcess.pipeTo(
        wrap(command.left, admission, trusted),
        wrap(command.right, admission, trusted),
        command.options,
      );
    }
    if (command.options.shell)
      throw new Error("VM processes require an explicit shell executable.");
    // Provider and PTY adapters can choose a more specific workload kind.
    const launch =
      command.command === helper
        ? command
        : vmWorkloadCommand(command.command, command.args, "process");
    if ((workflow && !trusted) || launch.args[0] === "run-workflow") {
      if (admission) throw new Error("Workflow VM workload admission is sealed");
      if (
        (launch.args[0] !== "run" && launch.args[0] !== "run-workflow") ||
        !/^[a-f0-9]{32}$/u.test(launch.args[1] ?? "") ||
        launch.args[3] !== "--" ||
        !launch.args[4] ||
        command.options.additionalFds
      )
        throw new Error("Unsupported workflow workload launch");
      const [, workloadId, kind, , executable, ...args] = launch.args;
      const git = executable === "git" || executable === "/usr/bin/git";
      return ChildProcess.make(
        helper,
        [
          "run-workflow",
          workloadId!,
          kind!,
          "--",
          executable,
          ...(git ? ["-c", "credential.helper=", ...args] : args),
        ],
        {
          ...command.options,
          env: workflowVmProcessEnvironment(
            git ? workflowVmGitEnvironment(command.options.env) : command.options.env,
          ),
          extendEnv: false,
        },
      );
    }
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
      const trusted = yield* VmCoordinatorProcess;
      const wrapped = yield* Effect.try({
        try: () => wrap(command, admission, trusted),
        catch: () =>
          PlatformError.badArgument({
            module: "VmWorkload",
            method: "spawn",
            description: "VM workload launch could not be tracked.",
          }),
      });
      if (!ChildProcess.isStandardCommand(wrapped) || wrapped.args[0] !== "run-workflow")
        return yield* raw.spawn(wrapped);
      const child = yield* raw.spawn(wrapped).pipe(Effect.provideService(ProcessOnlyCleanup, true));
      return yield* withWorkflowSignals(raw, wrapped, child);
    }),
  );
}

/** Install at the private guest entry point, before constructing server services.
 * This also covers short-lived Git/probe/auth processes that bypass ProcessRunner.
 */
export const withVmWorkloads = <A, E, R>(effect: Effect.Effect<A, E, R>, workflow = false) =>
  Effect.gen(function* () {
    const raw = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeVmWorkloadSpawner(raw, workflow),
      ),
      Effect.provideService(VmControlSpawner, raw),
      Effect.provideService(VmWorkloadTracking, true),
      Effect.provideService(WorkflowVmGuest, workflow),
    );
  });

export const isWorkflowVmGuest = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.exists("/etc/launchpad/workflow-guest"),
);
