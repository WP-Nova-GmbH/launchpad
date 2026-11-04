import {
  VmControlSpawner,
  VmWorkloadTracking,
  WorkflowVmGuest,
  signalRunningWorkflowVmWorkload,
  vmWorkloadCommand,
  workflowVmProcessEnvironment,
} from "../vmWorkloadCommand.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty stays external to the CLI bundle because it dlopens a native
// addon. Inside a Node single-executable, `import()` cannot load files from
// disk (only built-ins resolve), while `require` always reads the real
// filesystem, so both the module and its spawn-helper resolve through it.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

/** Injectable so tests can substitute a fake module; `require` bypasses module mocks. */
export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "server/terminal/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

const encodeSetupLaunch = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(1),
      token: Schema.String,
      candidates: Schema.Array(
        Schema.Struct({ shell: Schema.String, args: Schema.optional(Schema.Array(Schema.String)) }),
      ),
    }),
  ),
);

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private readonly signalWorkflow: ((signal: string) => Promise<void>) | undefined;
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly shellExitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private shellExit: PtyAdapter.PtyExitEvent | undefined;
  private pendingFrame = "";

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform,
    token?: string,
    signalWorkflow?: (signal: string) => Promise<void>,
  ) {
    this.process = process;
    this.platform = platform;
    this.signalWorkflow = signalWorkflow;
    if (token) {
      const prefix = `\x1b]T3_SETUP_EXIT;${token};`;
      process.onData((data) => {
        this.pendingFrame += data;
        while (this.pendingFrame.length > 0) {
          const index = this.pendingFrame.indexOf(prefix);
          if (index < 0) {
            let keep = Math.min(prefix.length - 1, this.pendingFrame.length);
            while (keep > 0 && !prefix.startsWith(this.pendingFrame.slice(-keep))) keep--;
            const output = this.pendingFrame.slice(0, this.pendingFrame.length - keep);
            this.pendingFrame = keep ? this.pendingFrame.slice(-keep) : "";
            for (const listener of this.outputListeners) if (output) listener(output);
            break;
          }
          const output = this.pendingFrame.slice(0, index);
          for (const listener of this.outputListeners) if (output) listener(output);
          this.pendingFrame = this.pendingFrame.slice(index);
          const end = this.pendingFrame.indexOf("\x07", prefix.length);
          if (end < 0 && this.pendingFrame.length <= prefix.length + 16) break;
          const code = end < 0 ? "" : this.pendingFrame.slice(prefix.length, end);
          if (/^-?\d{1,10}$/.test(code)) {
            this.shellExit = { exitCode: Number(code), signal: null };
            for (const listener of this.shellExitListeners) listener(this.shellExit);
            this.pendingFrame = this.pendingFrame.slice(end + 1);
          } else {
            for (const listener of this.outputListeners) listener(this.pendingFrame[0]!);
            this.pendingFrame = this.pendingFrame.slice(1);
          }
        }
      });
      process.onExit(() => {
        for (const listener of this.outputListeners)
          if (this.pendingFrame) listener(this.pendingFrame);
        this.pendingFrame = "";
      });
    } else
      process.onData((data) => {
        for (const listener of this.outputListeners) listener(data);
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void | Promise<void> {
    if (this.signalWorkflow) return this.signalWorkflow(signal ?? "SIGHUP");
    // node-pty terminates the Windows process tree without a POSIX signal.
    this.process.kill(this.platform === "win32" ? undefined : signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.outputListeners.add(callback);
    return () => {
      this.outputListeners.delete(callback);
    };
  }

  onShellExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.shellExitListeners.add(callback);
    if (this.shellExit) callback(this.shellExit);
    return () => {
      this.shellExitListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const trackWorkloads = yield* VmWorkloadTracking;
  const workflowGuest = yield* WorkflowVmGuest;
  const controlSpawner = yield* VmControlSpawner;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      if (workflowGuest && (!trackWorkloads || !controlSpawner)) {
        return yield* new PtyAdapter.PtySpawnError({
          adapter: "node-pty",
          shell: input.shell,
          cause: new Error("Workflow terminal isolation is unavailable."),
        });
      }
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env = workflowGuest
        ? workflowVmProcessEnvironment(input.env)
        : platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const token = input.ownerExecutable ? NodeCrypto.randomUUID().replaceAll("-", "") : undefined;
      const protectedOwner = workflowGuest && token !== undefined;
      const candidate = input.ownerShellCandidates?.[0];
      const script = candidate?.args?.[1];
      const spawnError = (cause: unknown) =>
        new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell: input.shell, cause });
      if (
        protectedOwner &&
        (input.ownerShellCandidates?.length !== 1 ||
          candidate?.shell !== "/bin/bash" ||
          candidate.args?.length !== 2 ||
          candidate.args[0] !== "-c" ||
          script === undefined ||
          script.includes("\0"))
      ) {
        return yield* spawnError(new Error("Invalid workflow setup shell."));
      }
      const scriptFile = protectedOwner
        ? `/tmp/launchpad-workflow-setup-${NodeCrypto.randomUUID().replaceAll("-", "")}.sh`
        : undefined;
      const removeScript = scriptFile
        ? fs.remove(scriptFile, { force: true }).pipe(Effect.ignore)
        : Effect.void;
      const ownedCommand = input.ownerExecutable ?? input.shell;
      const ownedArgs = scriptFile
        ? ["--setup-owner-v4", "--script-file-v1", scriptFile]
        : input.ownerExecutable
          ? [
              "--setup-owner-v4",
              "--launch-v1",
              encodeSetupLaunch({
                protocol: 1,
                token: token!,
                candidates: input.ownerShellCandidates ?? [
                  { shell: input.shell, args: input.args ?? [] },
                ],
              }),
            ]
          : (input.args ?? []);
      const workload = trackWorkloads
        ? vmWorkloadCommand(ownedCommand, ownedArgs, "terminal", workflowGuest)
        : null;
      const launch = workload ?? { command: ownedCommand, args: ownedArgs };
      const ptyProcess = yield* Effect.gen(function* () {
        if (scriptFile) {
          yield* Effect.gen(function* () {
            const file = yield* fs.open(scriptFile, { flag: "wx", mode: 0o600 });
            yield* file
              .writeAll(Buffer.from(script!.replaceAll("\r\n", "\n")))
              .pipe(Effect.onError(() => removeScript));
          }).pipe(Effect.scoped, Effect.mapError(spawnError));
        }
        const process = yield* Effect.try({
          try: () =>
            nodePty.spawn(launch.command, launch.args, {
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: protectedOwner ? { ...env, LAUNCHPAD_WORKFLOW_SETUP_EXIT_TOKEN: token } : env,
              name: "xterm-256color",
            }),
          catch: spawnError,
        }).pipe(Effect.onError(() => removeScript));
        if (scriptFile) process.onExit(() => void runPromise(removeScript));
        return process;
      }).pipe(Effect.uninterruptible);
      if (!workflowGuest || !workload || !controlSpawner)
        return new NodePtyProcess(ptyProcess, platform, token);
      let running = true;
      ptyProcess.onExit(() => void (running = false));
      return new NodePtyProcess(ptyProcess, platform, token, (signal) =>
        runPromise(
          removeScript.pipe(
            Effect.andThen(
              signalRunningWorkflowVmWorkload(
                controlSpawner,
                workload.workloadId,
                ptyProcess.pid,
                signal,
                Effect.sync(() => running),
              ),
            ),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
