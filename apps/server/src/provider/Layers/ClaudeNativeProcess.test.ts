// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeClaudeNativeProcess } from "./ClaudeNativeProcess.ts";
import { FakeClaudeChild } from "./ClaudeNativeProcess.testFixtures.ts";

vi.mock("node:child_process", { spy: true });
const threadId = ThreadId.make("native-claude-proof");
const spawnOptions = {
  command: "fixture",
  args: [],
  env: {},
  signal: new AbortController().signal,
};
const absent = () => Object.assign(new Error("absent"), { code: "ESRCH" });

it.effect("waits for captured native exit and escalates once", () =>
  Effect.gen(function* () {
    const child = new FakeClaudeChild();
    const entered = yield* Deferred.make<void>();
    const signals: Array<string | number | undefined> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal);
      if (signal === 0) throw absent();
      if (signal === "SIGTERM") Deferred.doneUnsafe(entered, Effect.void);
      if (signal === "SIGKILL") child.exit(null, "SIGKILL");
      return true;
    });
    try {
      const native = yield* makeClaudeNativeProcess(threadId, {
        spawn: () => child.asNativeChild(),
      });
      native.spawn(spawnOptions);
      const stopping = yield* native.stop.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.equal(stopping.pollUnsafe(), undefined);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(stopping);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL", 0]);
      yield* native.stop;
      assert.equal(signals.length, 3);
    } finally {
      kill.mockRestore();
    }
  }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
);

for (const mode of ["present", "denied"] as const)
  it.effect(`retains unconfirmed group evidence: ${mode}`, () =>
    Effect.gen(function* () {
      const child = new FakeClaudeChild();
      let missing = false;
      const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal !== 0) {
          child.exit(null, "SIGTERM");
          return true;
        }
        if (missing) throw absent();
        if (mode === "denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
        return true;
      });
      try {
        const native = yield* makeClaudeNativeProcess(threadId, {
          spawn: () => child.asNativeChild(),
        });
        native.spawn(spawnOptions);
        assert.equal((yield* native.stop.pipe(Effect.result))._tag, "Failure");
        missing = true;
        yield* native.stop;
        assert.deepEqual(child.signals, []);
      } finally {
        kill.mockRestore();
      }
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

it.effect("seals a positively never-acquired runtime against delayed spawn", () =>
  Effect.gen(function* () {
    const native = yield* makeClaudeNativeProcess(threadId);
    yield* native.stop;
    assert.throws(() => native.spawn(spawnOptions), /closed/);
  }),
);

it.effect("Windows requires owned tree success and then delivered exit", () =>
  Effect.gen(function* () {
    const child = new FakeClaudeChild();
    const entered = yield* Deferred.make<void>();
    let fail = true;
    vi.mocked(NodeChildProcess.execFile).mockImplementation((...args) => {
      const callback = args[3];
      if (typeof callback === "function")
        callback(fail ? new Error("tree kill denied") : null, "", "");
      if (!fail) Deferred.doneUnsafe(entered, Effect.void);
      return child.asNativeChild();
    });
    try {
      const native = yield* makeClaudeNativeProcess(threadId, {
        spawn: () => child.asNativeChild(),
      });
      native.spawn(spawnOptions);
      assert.equal((yield* native.stop.pipe(Effect.result))._tag, "Failure");
      fail = false;
      const stopping = yield* native.stop.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.equal(stopping.pollUnsafe(), undefined);
      child.exit(null, "SIGKILL");
      yield* Fiber.join(stopping);
      assert.deepEqual(child.signals, []);
    } finally {
      vi.mocked(NodeChildProcess.execFile).mockRestore();
    }
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect("does not signal a lost Windows leader", () =>
  Effect.gen(function* () {
    const child = new FakeClaudeChild();
    const native = yield* makeClaudeNativeProcess(threadId, { spawn: () => child.asNativeChild() });
    native.spawn(spawnOptions);
    child.exit();
    assert.equal(Exit.isFailure(yield* native.stop.pipe(Effect.exit)), true);
  }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
);
