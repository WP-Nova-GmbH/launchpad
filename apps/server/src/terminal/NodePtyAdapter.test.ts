import { VmControlSpawner, VmWorkloadTracking, WorkflowVmGuest } from "../vmWorkloadCommand.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const decodeLaunchRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(1),
      token: Schema.String,
      candidates: Schema.Array(
        Schema.Struct({
          shell: Schema.String,
          args: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
);

const spawn = vi.fn(
  (_file: string, _args: string[], _options: import("node-pty").IPtyForkOptions) => ({
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((_listener: (data: string) => void) => ({ dispose: vi.fn() })),
    onExit: vi.fn((_listener: (event: { exitCode: number; signal?: number }) => void) => ({
      dispose: vi.fn(),
    })),
  }),
);

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const hostLayer = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessArchitecture, "x64"),
    Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
  );

const makeTestLayer = (platform: NodeJS.Platform = "win32") =>
  NodePtyAdapter.layer.pipe(Layer.provide(hostLayer(platform)));

const testLayer = makeTestLayer();

for (const platform of ["win32", "linux", "darwin"] as const) {
  it.effect(`terminates through node-pty using ${platform} semantics`, () =>
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter.PtyAdapter;
      const process = yield* adapter.spawn({
        shell: "test-shell",
        cwd: ".",
        cols: 80,
        rows: 24,
        env: {},
      });
      const nativeProcess = spawn.mock.results.at(-1)!.value;
      nativeProcess.kill.mockImplementation((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();

      assert.deepEqual(
        nativeProcess.kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    }).pipe(Effect.provide(makeTestLayer(platform))),
  );
}

it.effect("spawns through the public adapter with the provided host references", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "C:\\workspace",
      cols: 120,
      rows: 40,
      env: {},
    });

    assert.equal(process.pid, 42);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      ["-NoLogo"],
      {
        cwd: "C:\\workspace",
        cols: 120,
        rows: 40,
        env: { TERM: "xterm-256color" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves a caller-provided TERM in the spawn env on win32", () =>
  Effect.gen(function* () {
    spawn.mockClear();
    const adapter = yield* PtyAdapter.PtyAdapter;
    yield* adapter.spawn({
      shell: "powershell.exe",
      cwd: "C:\\workspace",
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-direct" },
    });

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0], [
      "powershell.exe",
      [],
      {
        cwd: "C:\\workspace",
        cols: 80,
        rows: 24,
        env: { TERM: "xterm-direct" },
        name: "xterm-256color",
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports native module load failures as structured startup defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native binding could not be loaded");
    const exit = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.reject(cause)),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.isTrue(Cause.hasDies(exit.cause));
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, NodePtyAdapter.NodePtyModuleLoadError);
      assert.deepInclude(error, {
        _tag: "NodePtyModuleLoadError",
        platform: "win32",
        architecture: "x64",
      });
      assert.equal(error.message, "Failed to load node-pty for win32-x64.");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessArchitecture, "x64"),
      ),
    ),
  ),
);

it.effect("filters fragmented shell-exit frames while retaining the ownership anchor", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn({
      shell: "/missing",
      ownerExecutable: "/helper",
      ownerShellCandidates: [{ shell: "/missing" }, { shell: "/bin/sh", args: ["-i"] }],
      cwd: ".",
      cols: 80,
      rows: 24,
      env: {},
    });
    const call = spawn.mock.calls.at(-1)! as unknown as [string, string[]];
    const payload = yield* decodeLaunchRequest(call[1][2]!);
    assert.deepEqual(payload.candidates, [
      { shell: "/missing" },
      { shell: "/bin/sh", args: ["-i"] },
    ]);
    const native = spawn.mock.results.at(-1)!.value;
    const feed = native.onData.mock.calls[0]![0];
    const output: string[] = [];
    const exits: PtyAdapter.PtyExitEvent[] = [];
    const ptyExits: PtyAdapter.PtyExitEvent[] = [];
    process.onData((data) => output.push(data));
    process.onShellExit!((event) => exits.push(event));
    process.onExit((event) => ptyExits.push(event));
    const frame = `\x1b]T3_SETUP_EXIT;${payload.token};7\x07`;
    feed("hello" + frame.slice(0, 9));
    feed(frame.slice(9, -2));
    assert.deepEqual(exits, []);
    feed(frame.slice(-2) + "world");
    assert.equal(output.join(""), "helloworld");
    assert.deepEqual(exits, [{ exitCode: 7, signal: null }]);
    assert.deepEqual(ptyExits, []);
    assert.deepEqual(native.kill.mock.calls, []);
    const late: PtyAdapter.PtyExitEvent[] = [];
    process.onShellExit!((event) => late.push(event));
    assert.deepEqual(late, exits);
  }).pipe(Effect.provide(makeTestLayer("darwin"))),
);

it.effect("keeps the captured setup owner inside the VM workload boundary", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const owned = yield* adapter.spawn({
      shell: "/bin/sh",
      args: ["-i"],
      ownerExecutable: "/native-owner",
      cwd: ".",
      cols: 80,
      rows: 24,
      env: {},
    });
    const [command, args] = spawn.mock.calls.at(-1)! as unknown as [string, string[]];
    assert.equal(command, "/opt/launchpad/bin/launchpad-workload");
    assert.deepEqual(args.slice(2, 7), [
      "terminal",
      "--",
      "/native-owner",
      "--setup-owner-v4",
      "--launch-v1",
    ]);
    const payload = yield* decodeLaunchRequest(args[7]!);
    assert.deepEqual(payload.candidates, [{ shell: "/bin/sh", args: ["-i"] }]);
    assert.equal(owned.pid, 42);
  }).pipe(
    Effect.provide(
      makeTestLayer("linux").pipe(Layer.provide(Layer.succeed(VmWorkloadTracking, true))),
    ),
  ),
);

it.effect("signals workflow PTYs through their registered guest workload", () =>
  Effect.gen(function* () {
    const signals: ReadonlyArray<string>[] = [];
    const raw = ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("unexpected pipe");
        signals.push(command.args);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(77),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode('{"signalled":true}')),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer));
    const removed = yield* Deferred.make<string>();
    const adapter = yield* NodePtyAdapter.make().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: (path, options) =>
          fs.remove(path, options).pipe(Effect.tap(() => Deferred.succeed(removed, path))),
      }),
      Effect.provide(
        Layer.mergeAll(
          hostLayer("linux"),
          Layer.succeed(VmWorkloadTracking, true),
          Layer.succeed(WorkflowVmGuest, true),
          Layer.succeed(VmControlSpawner, raw),
        ),
      ),
    );
    const terminal = yield* adapter.spawn({
      shell: "/bin/bash",
      cwd: "/workspace/project",
      cols: 80,
      rows: 24,
      env: { LD_PRELOAD: "/workspace/project/untrusted.so", PORT: "4000" },
    });
    const [, args, options] = spawn.mock.calls.at(-1)! as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    assert.deepEqual(args.slice(2), ["terminal", "--", "/bin/bash"]);
    assert.equal(args[0], "run-workflow");
    assert.equal(options.env.LD_PRELOAD, undefined);
    assert.equal(options.env.PORT, "4000");
    assert.equal(options.env.HOME, "/home/launchpad-workflow");
    yield* Effect.promise(async () => terminal.kill("SIGTERM"));
    assert.deepEqual(signals, [["signal-workflow", args[1]!, "42", "TERM"]]);
    assert.deepEqual(spawn.mock.results.at(-1)!.value.kill.mock.calls, []);

    const script = `${"x".repeat(192 * 1024)}\r\nmake setup\r\nexit 7\r\n`;
    const ownerInput = {
      shell: "/bin/bash",
      ownerExecutable: "/opt/launchpad/server/resource-monitor/t3-resource-monitor",
      ownerShellCandidates: [{ shell: "/bin/bash", args: ["-c", script] }],
      cwd: "/workspace/project",
      cols: 80,
      rows: 24,
      env: { LAUNCHPAD_WORKFLOW_SETUP_EXIT_TOKEN: "supplied-by-workload" },
    };
    const owned = yield* adapter.spawn(ownerInput);
    const [, ownerArgs, ownerOptions] = spawn.mock.calls.at(-1)! as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    const scriptFile = ownerArgs[7]!;
    assert.deepEqual(ownerArgs.slice(5), ["--setup-owner-v4", "--script-file-v1", scriptFile]);
    assert.match(scriptFile, /^\/tmp\/launchpad-workflow-setup-[0-9a-f]{32}\.sh$/u);
    assert.equal(
      yield* fs.readFileString(scriptFile),
      `${"x".repeat(192 * 1024)}\nmake setup\nexit 7\n`,
    );
    assert.equal((yield* fs.stat(scriptFile)).mode & 0o777, 0o600);
    const token = ownerOptions.env.LAUNCHPAD_WORKFLOW_SETUP_EXIT_TOKEN!;
    assert.match(token, /^[0-9a-f]{32}$/u);
    assert.isFalse(ownerArgs.some((arg) => arg.includes(token)));
    const exits: PtyAdapter.PtyExitEvent[] = [];
    owned.onShellExit!((exit) => exits.push(exit));
    const nativeOwner = spawn.mock.results.at(-1)!.value;
    const feed = nativeOwner.onData.mock.calls[0]![0];
    feed("\x1b]T3_SETUP_EXIT;supplied-by-workload;0\x07");
    assert.deepEqual(exits, []);
    feed(`\x1b]T3_SETUP_EXIT;${token};7\x07`);
    assert.deepEqual(exits, [{ exitCode: 7, signal: null }]);

    // An exit before the native helper takes the script must also remove it.
    for (const [onExit] of nativeOwner.onExit.mock.calls) onExit({ exitCode: 70 });
    assert.equal(yield* Deferred.await(removed), scriptFile);
    assert.isFalse(yield* fs.exists(scriptFile));

    let failedScriptFile: string | undefined;
    spawn.mockImplementationOnce((_command, args) => {
      failedScriptFile = args[7];
      throw new Error("native PTY spawn failed");
    });
    yield* adapter.spawn(ownerInput).pipe(Effect.flip);
    assert.isDefined(failedScriptFile);
    assert.isFalse(yield* fs.exists(failedScriptFile!));
  }),
);
