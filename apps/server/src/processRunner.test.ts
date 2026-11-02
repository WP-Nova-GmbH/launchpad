// @effect-diagnostics nodeBuiltinImport:off - Mock native taskkill completion independently of the process handle.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";

import * as ProcessRunner from "./processRunner.ts";

vi.mock("node:child_process", { spy: true });

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly shell?: boolean | string;
  };
};

// Accesses private properties of ChildProcessCommand for testing purposes
function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

function makeHandle(input: {
  readonly control?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stdout?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: string | Stream.Stream<Uint8Array>;
  readonly code?: number;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly isRunning?: ChildProcessSpawner.ChildProcessHandle["isRunning"];
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: input.isRunning ?? Effect.succeed(false),
    kill: input.kill ?? (() => Effect.void),
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout:
      typeof input.stdout === "string"
        ? Stream.encodeText(Stream.make(input.stdout))
        : (input.stdout ?? Stream.empty),
    stderr:
      typeof input.stderr === "string"
        ? Stream.encodeText(Stream.make(input.stderr))
        : (input.stderr ?? Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: (fd) =>
      fd === 3 && input.control
        ? typeof input.control === "string"
          ? Stream.encodeText(Stream.make(input.control))
          : input.control
        : Stream.empty,
  });
}

function makeSpawner(
  f: (
    command: ChildProcessCommand,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >,
) {
  return ChildProcessSpawner.make((command) => f(asChildProcessCommand(command)));
}

const decodeLaunchRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidates: Schema.Array(
        Schema.Struct({ shell: Schema.String, args: Schema.Array(Schema.String) }),
      ),
    }),
  ),
);
const runWith =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (input: ProcessRunner.ProcessRunInput) =>
    Effect.service(ProcessRunner.ProcessRunner).pipe(
      Effect.flatMap((runner) =>
        runner.run({
          ...input,
        }),
      ),
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );

describe("runProcess", () => {
  it.effect("collects stdout through an injected ChildProcessSpawner", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner((command) =>
        Effect.sync(() => {
          expect(command.command).toBe("fake");
          expect(command.args).toEqual(["stdout-bytes", "32"]);
          return makeHandle({ stdout: "x".repeat(32) });
        }),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "32"],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("x".repeat(32));
      expect(result.timedOut).toBe(false);
    }),
  );

  it.effect("runs through the ProcessRunner service", () => {
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe("fake");
        expect(command.args).toEqual(["--service"]);
        return makeHandle({ stdout: "service ok" });
      }),
    );
    const layer = ProcessRunner.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );

    return Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: "fake",
        args: ["--service"],
      });

      expect(result.stdout).toBe("service ok");
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves and escapes Windows command shims before spawning", () => {
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe('^"C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd^"');
        expect(command.args).toEqual([
          '^"repos^"',
          '^"pr^"',
          '^"list^"',
          '^"--source-branch^"',
          '^"feature^ ^&^ release^"',
        ]);
        expect(command.options.shell).toBe(true);
        return makeHandle({ stdout: "[]" });
      }),
    );

    return runWith(spawner)({
      command: "az",
      args: ["repos", "pr", "list", "--source-branch", "feature & release"],
      env: { AZURE_CONFIG_DIR: "C:\\Users\\tester\\.azure" },
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) =>
        env.PATH === "C:\\Users\\tester\\AppData\\Roaming\\npm" &&
        env.AZURE_CONFIG_DIR === "C:\\Users\\tester\\.azure"
          ? "C:\\Users\\tester\\AppData\\Roaming\\npm\\az.cmd"
          : undefined,
      ),
      Effect.map((result) => {
        expect(result.stdout).toBe("[]");
      }),
    );
  });

  it.effect("preserves resolved spawn context and cause", () =>
    Effect.gen(function* () {
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: "/actual/fake",
      });
      const spawner = makeSpawner(() => Effect.fail(cause));

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["--flag", "secret-token-value"],
        cwd: "/logical",
        spawnCwd: "/actual",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessSpawnError");
      if (error._tag !== "ProcessSpawnError") {
        return expect.fail("Expected ProcessSpawnError");
      }
      expect(error).toMatchObject({
        command: "fake",
        argumentCount: 2,
        cwd: "/logical",
        spawnCwd: "/actual",
        resolvedCommand: "fake",
        resolvedArgumentCount: 2,
        shell: false,
      });
      expect(error.cause).toBe(cause);
      expect(error.message).toBe("Failed to spawn process 'fake' in '/actual'");
      expect(error).not.toHaveProperty("args");
      expect(error).not.toHaveProperty("resolvedArgs");
      expect(error.message).not.toContain("secret-token-value");
    }),
  );

  it.effect("fails when output exceeds max buffer in default mode", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ProcessOutputLimitError");
      if (error._tag !== "ProcessOutputLimitError") {
        return expect.fail("Expected ProcessOutputLimitError");
      }
      expect(error).toMatchObject({
        stream: "stdout",
        maxBytes: 128,
        observedBytes: 2048,
      });
      expect(error.message).toBe(
        "Process 'fake' stdout produced 2048 bytes, exceeding the 128 byte limit",
      );
    }),
  );

  it.effect("accepts output at the byte limit followed by an empty chunk", () =>
    Effect.gen(function* () {
      const output = new TextEncoder().encode("exactly");
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.make(output, new Uint8Array()),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["exact-limit"],
        maxOutputBytes: output.byteLength,
      });

      expect(result.stdout).toBe("exactly");
    }),
  );

  it.effect("fails fast on output limit before timeout for long-running output", () =>
    Effect.gen(function* () {
      const textChunk = "x".repeat(64);
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: Stream.fromIterable(Array.from({ length: 10 }, () => textChunk)).pipe(
              Stream.encodeText,
            ),
            exitCode: Effect.never,
          }),
        ),
      );

      const error = yield* runWith(spawner)({
        command: "fake",
        args: ["spam-stdout"],
        maxOutputBytes: 128,
        timeout: "2 seconds",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProcessRunner.ProcessOutputLimitError);
    }),
  );

  it.effect("truncates output when outputMode is truncate", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stdout: "x".repeat(2048) })));

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdout-bytes", "2048"],
        maxOutputBytes: 128,
        outputMode: "truncate",
      });

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(128);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
    }),
  );

  it.effect("writes stdin before waiting for exit", () =>
    Effect.gen(function* () {
      const stdinWritten = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            stdout: "stdin payload",
            stdin: Sink.forEach((chunk: Uint8Array) => {
              const text = decoder.decode(chunk, { stream: true });
              return text.includes("stdin payload")
                ? Deferred.succeed(stdinWritten, undefined)
                : Effect.void;
            }),
            exitCode: Deferred.await(stdinWritten).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          }),
        ),
      );

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stdin-echo"],
        stdin: "stdin payload",
      });

      expect(result.stdout).toBe("stdin payload");
      expect(result.code).toBe(0);
    }),
  );

  it.effect("returns output for non-zero exit codes", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() => Effect.succeed(makeHandle({ stderr: "boom", code: 2 })));

      const result = yield* runWith(spawner)({
        command: "fake",
        args: ["stderr-exit", "boom", "2"],
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toBe("boom");
    }),
  );

  it.effect("fails on timeout", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
          }),
        ),
      );
      const errorFiber = yield* runWith(spawner)({
        command: "fake",
        args: ["sleep"],
        cwd: "/logical",
        spawnCwd: "/actual",
        timeout: "50 millis",
      }).pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const error = yield* Fiber.join(errorFiber);

      expect(error._tag).toBe("ProcessTimeoutError");
      if (error._tag !== "ProcessTimeoutError") {
        return expect.fail("Expected ProcessTimeoutError");
      }
      expect(error).toMatchObject({
        command: "fake",
        argumentCount: 1,
        cwd: "/logical",
        spawnCwd: "/actual",
        timeoutMs: 50,
      });
      expect(error.message).toBe("Process 'fake' in '/actual' timed out after 50ms");
    }),
  );

  it.effect("returns a synthetic timed out result when timeoutBehavior is timedOutResult", () =>
    Effect.gen(function* () {
      const spawner = makeSpawner(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
          }),
        ),
      );
      const resultFiber = yield* runWith(spawner)({
        command: "fake",
        args: ["sleep"],
        timeout: "50 millis",
        timeoutBehavior: "timedOutResult",
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const result = yield* Fiber.join(resultFiber);

      expect(result).toMatchObject({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }),
  );
});

describe("confirmed process cleanup", () => {
  const failure = () =>
    new PlatformError.PlatformError(
      new PlatformError.BadArgument({
        module: "ChildProcess",
        method: "test",
        description: "failed",
      }),
    );
  it.effect("confirms a failed spawn without attempting native termination", () =>
    Effect.gen(function* () {
      let confirmed = 0;
      const outcome = yield* runWith(makeSpawner(() => Effect.fail(failure())))({
        command: "fixture",
        args: [],
        onExitConfirmed: Effect.sync(() => {
          confirmed++;
        }),
      }).pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect(confirmed).toBe(1);
    }),
  );
  it.effect("does not reserve work when interrupted before the runner is entered", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>(),
        releaseAdmission = yield* Deferred.make<void>();
      let spawned = 0,
        reserved = 0;
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(() =>
            Effect.sync(() => {
              spawned++;
              return makeHandle({});
            }),
          ),
        ),
      );
      const fiber = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(admitted, undefined);
          yield* Deferred.await(releaseAdmission);
          return yield* restore(
            runner.run({
              command: "fixture",
              args: [],
              beforeSpawn: Effect.sync(() => {
                reserved++;
              }),
              onExitConfirmed: Effect.void,
            }),
          );
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(admitted);
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseAdmission, undefined);
      yield* Fiber.join(interruption);
      expect(spawned).toBe(0);
      expect(reserved).toBe(0);
    }),
  );
  it.effect("settles an interruption at the admission-to-spawn boundary", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>(),
        releaseAdmission = yield* Deferred.make<void>();
      let spawned = 0,
        confirmed = 0;
      const fiber = yield* runWith(
        makeSpawner(() =>
          Effect.sync(() => {
            spawned++;
            return makeHandle({ control: Stream.never });
          }),
        ),
      )({
        command: "fixture",
        args: [],
        beforeSpawn: Deferred.succeed(admitted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseAdmission)),
        ),
        owner: {
          executable: "owned-fixture",
          capture: () => Effect.void,
          arm: Effect.void,
          completed: () => Effect.void,
          stop: Effect.void,
        },
        onExitConfirmed: Effect.sync(() => {
          confirmed++;
        }),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(admitted);
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseAdmission, undefined);
      yield* Fiber.join(interruption);
      expect(spawned).toBe(1);
      expect(confirmed).toBe(1);
    }),
  );
  it.effect("runs a standalone before-spawn hook before acquiring the child", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* runWith(
        makeSpawner(() =>
          Effect.sync(() => {
            events.push("spawn");
            return makeHandle({});
          }),
        ),
      )({
        command: "fixture",
        args: [],
        beforeSpawn: Effect.sync(() => {
          events.push("reserve");
        }),
      });
      expect(events).toEqual(["reserve", "spawn"]);
    }),
  );
  it.effect("records completion only after the child scope has finalized", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* runWith(
        makeSpawner(() =>
          Effect.acquireRelease(Effect.succeed(makeHandle({})), () =>
            Effect.sync(() => {
              events.push("scope-closed");
            }),
          ),
        ),
      )({
        command: "fixture",
        args: [],
        onExitConfirmed: Effect.sync(() => {
          events.push("confirmed");
        }),
      });
      expect(events).toEqual(["scope-closed", "confirmed"]);
    }),
  );
  for (const owned of [false, true])
    it.effect(`does not reuse stop proof when the same effect runs again (owned: ${owned})`, () =>
      Effect.gen(function* () {
        let run = 0,
          confirmed = 0;
        const probe = vi.spyOn(process, "kill").mockReturnValue(true);
        try {
          const runner = yield* ProcessRunner.make().pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              makeSpawner(() =>
                Effect.sync(() => {
                  run++;
                  return makeHandle({
                    stdout: run === 1 ? "" : "too much",
                    control: '{"protocol":1,"code":0}\n',
                  });
                }),
              ),
            ),
          );
          const operation = runner.run({
            command: "fixture",
            args: [],
            maxOutputBytes: 1,
            ...(owned
              ? {
                  owner: {
                    executable: "owned-fixture",
                    capture: () => Effect.void,
                    arm: Effect.void,
                    completed: () => Effect.void,
                    stop: Effect.suspend(() =>
                      run === 1
                        ? Effect.void
                        : Effect.fail(
                            new ProcessRunner.ProcessOwnershipError({
                              command: "fixture",
                              argumentCount: 0,
                              cause: "stop failed",
                            }),
                          ),
                    ),
                  },
                }
              : {}),
            onExitConfirmed: Effect.sync(() => {
              confirmed++;
            }),
          });
          yield* operation;
          expect(confirmed).toBe(1);
          expect((yield* operation.pipe(Effect.exit))._tag).toBe("Failure");
          expect(confirmed).toBe(1);
        } finally {
          probe.mockRestore();
        }
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
    );
  it.effect("does not confirm normal completion when child-scope finalization fails", () =>
    Effect.gen(function* () {
      let confirmed = 0;
      const result = yield* runWith(
        makeSpawner(() =>
          Effect.acquireRelease(Effect.succeed(makeHandle({})), () =>
            Effect.die("scope finalization failed"),
          ),
        ),
      )({
        command: "fixture",
        args: [],
        onExitConfirmed: Effect.sync(() => {
          confirmed++;
        }),
      }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(confirmed).toBe(0);
    }),
  );
  it.effect(
    "does not confirm normal completion when timeout interrupts child-scope finalization",
    () =>
      Effect.gen(function* () {
        let confirmed = 0;
        const finalizing = yield* Deferred.make<void>();
        const fiber = yield* runWith(
          makeSpawner(() =>
            Effect.acquireRelease(Effect.succeed(makeHandle({})), () =>
              Deferred.succeed(finalizing, undefined).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
              ),
            ),
          ),
        )({
          command: "fixture",
          args: [],
          timeout: "50 millis",
          onExitConfirmed: Effect.sync(() => {
            confirmed++;
          }),
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(finalizing);
        yield* TestClock.adjust("100 millis");
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ProcessTimeoutError");
        expect(confirmed).toBe(0);
      }),
  );
  it.effect("reports a confirmation callback failure instead of returning success", () =>
    Effect.gen(function* () {
      const callbackError = new ProcessRunner.ProcessOwnershipError({
        command: "fixture",
        argumentCount: 0,
        cause: "receipt failed",
      });
      const outcome = yield* runWith(makeSpawner(() => Effect.succeed(makeHandle({}))))({
        command: "fixture",
        args: [],
        onExitConfirmed: Effect.fail(callbackError),
      }).pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure).toBe(callbackError);
    }),
  );
  for (const kind of ["timeout", "interrupt", "output", "read"] as const)
    it.effect(`waits for owned stop confirmation before releasing after ${kind}`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          stopping = yield* Deferred.make<void>(),
          stopped = yield* Deferred.make<void>();
        let confirmed = 0;
        const spawner = makeSpawner(() =>
          Effect.succeed(
            makeHandle({
              stdout:
                kind === "read" ? Stream.fail(failure()) : kind === "output" ? "too much" : "",
              control: Stream.never,
              exitCode: Effect.never,
            }),
          ),
        );
        const running = yield* runWith(spawner)({
          command: "fixture",
          args: [],
          timeout: "50 millis",
          maxOutputBytes: 1,
          owner: {
            executable: "owned-fixture",
            capture: () => Deferred.succeed(entered, undefined).pipe(Effect.asVoid),
            arm: Effect.void,
            completed: () => Effect.void,
            stop: Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Deferred.await(stopped)),
            ),
          },
          onExitConfirmed: Effect.sync(() => {
            confirmed++;
          }),
        }).pipe(Effect.result, Effect.forkScoped);
        if (kind === "timeout" || kind === "interrupt") yield* Deferred.await(entered);
        const interruption =
          kind === "interrupt" ? yield* Fiber.interrupt(running).pipe(Effect.forkScoped) : null;
        if (kind === "timeout") yield* TestClock.adjust("50 millis");
        yield* Deferred.await(stopping);
        expect(confirmed).toBe(0);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(stopped, undefined);
        if (interruption) yield* Fiber.join(interruption);
        else expect((yield* Fiber.join(running))._tag).toBe("Failure");
        expect(confirmed).toBe(1);
      }),
    );
  it.effect("retains the reservation when owned shutdown cannot be confirmed", () =>
    Effect.gen(function* () {
      let confirmed = 0;
      const outcome = yield* runWith(
        makeSpawner(() =>
          Effect.succeed(
            makeHandle({
              stdout: "too much",
              control: Stream.never,
            }),
          ),
        ),
      )({
        command: "fixture",
        args: [],
        maxOutputBytes: 1,
        owner: {
          executable: "owned-fixture",
          capture: () => Effect.void,
          arm: Effect.void,
          completed: () => Effect.void,
          stop: Effect.fail(
            new ProcessRunner.ProcessOwnershipError({
              command: "fixture",
              argumentCount: 0,
              cause: "tree remains",
            }),
          ),
        },
        onExitConfirmed: Effect.sync(() => {
          confirmed++;
        }),
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(confirmed).toBe(0);
    }),
  );
  for (const stopped of [false, true])
    it.effect(`requires owner stop proof after ownership capture fails (${stopped})`, () =>
      Effect.gen(function* () {
        let confirmed = 0;
        const ownerError = new ProcessRunner.ProcessOwnershipError({
          command: "fixture",
          argumentCount: 0,
          cause: "ownership unavailable",
        });
        const result = yield* runWith(
          makeSpawner(() =>
            Effect.succeed(
              makeHandle({
                control: Stream.never,
              }),
            ),
          ),
        )({
          command: "fixture",
          args: [],
          owner: {
            executable: "owned-fixture",
            capture: () => Effect.fail(ownerError),
            arm: Effect.die("must not arm"),
            completed: () => Effect.void,
            stop: stopped ? Effect.void : Effect.fail(ownerError),
          },
          onExitConfirmed: Effect.sync(() => {
            confirmed++;
          }),
        }).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(confirmed).toBe(stopped ? 1 : 0);
      }),
    );
  for (const stopped of [false, true])
    it.effect(`requires successful Windows tree termination before confirming (${stopped})`, () =>
      Effect.gen(function* () {
        let running = true,
          confirmed = 0;
        const taskkill = vi.mocked(NodeChildProcess.execFile).mockImplementation((...args) => {
          expect(args.slice(0, 2)).toEqual(["taskkill", ["/pid", "1", "/t", "/f"]]);
          const callback = args.at(-1);
          if (stopped) running = false;
          if (typeof callback === "function")
            callback(stopped ? null : new Error("denied"), "", "");
          return new NodeChildProcess.ChildProcess();
        });
        try {
          const result = yield* runWith(
            makeSpawner(() =>
              Effect.succeed(
                makeHandle({
                  stdout: "too much",
                  isRunning: Effect.sync(() => running),
                  kill: () => Effect.die("leader-only fallback is not tree proof"),
                }),
              ),
            ),
          )({
            command: "fixture",
            args: [],
            maxOutputBytes: 1,
            onExitConfirmed: Effect.sync(() => {
              confirmed++;
            }),
          }).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
          expect(confirmed).toBe(stopped ? 1 : 0);
        } finally {
          taskkill.mockRestore();
        }
      }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
    );
  for (const absent of [false, true])
    it.effect(`requires exact process group absence after an unowned failure (${absent})`, () =>
      Effect.gen(function* () {
        let running = true,
          confirmed = 0,
          kills = 0;
        const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          expect(pid).toBe(-1);
          expect(signal).toBe(0);
          if (absent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
          return true;
        });
        try {
          const outcome = yield* runWith(
            makeSpawner(() =>
              Effect.succeed(
                makeHandle({
                  stdout: "too much",
                  isRunning: Effect.sync(() => running),
                  kill: () =>
                    Effect.sync(() => {
                      kills++;
                      running = false;
                    }),
                }),
              ),
            ),
          )({
            command: "fixture",
            args: [],
            maxOutputBytes: 1,
            onExitConfirmed: Effect.sync(() => {
              confirmed++;
            }),
          }).pipe(Effect.exit);
          expect(outcome._tag).toBe("Failure");
          expect(kills).toBe(1);
          expect(confirmed).toBe(absent ? 1 : 0);
        } finally {
          probe.mockRestore();
        }
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
    );
});

describe("isWindowsCommandNotFound", () => {
  it.effect("matches the localized German cmd.exe error text", () =>
    Effect.gen(function* () {
      const isCommandNotFound = yield* ProcessRunner.isWindowsCommandNotFound(
        1,
        "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
      ).pipe(Effect.provideService(HostProcessPlatform, "win32"));
      expect(isCommandNotFound).toBe(true);
    }),
  );
});

it.effect("uses private command results and captures ownership before arming", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const spawner = makeSpawner((command) =>
      Effect.sync(() => {
        expect(command.command).toBe("native-owner");
        expect(command.args[0]).toBe("--command-owner-v1");
        const request = decodeLaunchRequest(command.args[2]!);
        expect(request.candidates).toEqual([
          { shell: "git", args: ["commit", "-m", "exact message"] },
        ]);
        return makeHandle({
          stdout: '{"protocol":1,"code":0}',
          control: '{"protocol":1,"code":37}\n',
          exitCode: Effect.never,
        });
      }),
    );
    const result = yield* runWith(spawner)({
      command: "git",
      args: ["commit", "-m", "exact message"],
      owner: {
        executable: "native-owner",
        capture: () =>
          Effect.sync(() => {
            events.push("capture");
          }),
        arm: Effect.sync(() => {
          events.push("arm");
        }),
        completed: (code) =>
          Effect.sync(() => {
            events.push(`result:${code}`);
          }),
        stop: Effect.sync(() => {
          events.push("stop");
        }),
      },
    });
    expect(result.code).toBe(37);
    expect(events.slice(0, 4)).toEqual(["capture", "arm", "result:37", "stop"]);
  }),
);
it.effect("never arms after a failed ownership capture and attempts cleanup", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const spawner = makeSpawner(() =>
      Effect.succeed(makeHandle({ control: '{"protocol":1,"code":0}\n' })),
    );
    const outcome = yield* runWith(spawner)({
      command: "git",
      args: ["push"],
      owner: {
        executable: "native-owner",
        capture: () =>
          Effect.fail(
            new ProcessRunner.ProcessOwnershipError({
              command: "git",
              argumentCount: 1,
              cause: "Save failed",
            }),
          ),
        arm: Effect.sync(() => {
          events.push("arm");
        }),
        completed: () => Effect.void,
        stop: Effect.sync(() => {
          events.push("stop");
        }),
      },
    }).pipe(Effect.result);
    expect(outcome._tag).toBe("Failure");
    expect(events).toEqual(["stop"]);
  }),
);
