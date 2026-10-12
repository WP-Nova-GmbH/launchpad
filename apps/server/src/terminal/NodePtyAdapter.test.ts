import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const spawn = vi.fn(() => ({
  pid: 42,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn((_listener: (data: string) => void) => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const makeTestLayer = (platform: NodeJS.Platform = "win32") =>
  NodePtyAdapter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessArchitecture, "x64"),
        Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
      ),
    ),
  );

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
