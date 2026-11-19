import { ProcessOnlyCleanup } from "@effect/platform-node/NodeChildProcessSpawner";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makeVmWorkloadSpawner,
  VmControlSpawner,
  VmCoordinatorProcess,
  vmWorkloadCommand,
  withVmWorkloads,
} from "./vmWorkloadCommand.ts";

const handle = (
  pid: number,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
  isRunning: Effect.Effect<boolean>,
  stdout = Stream.empty as Stream.Stream<Uint8Array>,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(pid),
    exitCode,
    isRunning,
    kill: () => Effect.die("The coordinator cannot signal a different workload UID."),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

it.effect("uses the registered workload identity and escalates if the leader stays alive", () =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const commands = yield* Queue.unbounded<ReadonlyArray<string>>();
    let workloadId = "";
    const raw = ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("unexpected pipe");
        if (command.args[0] === "run-workflow") {
          assert.equal(yield* ProcessOnlyCleanup, true);
          workloadId = command.args[1]!;
          assert.deepEqual(command.args.slice(2), [
            "process",
            "/workspace/project/private",
            "--",
            "git",
            "-c",
            "credential.helper=",
            "status",
          ]);
          assert.equal(command.options.cwd, "/");
          assert.equal(command.options.extendEnv, false);
          assert.equal(command.options.env?.GIT_INDEX_FILE, "/tmp/index");
          assert.equal(command.options.env?.GIT_CONFIG_GLOBAL, "/dev/null");
          assert.equal(command.options.env?.GIT_CONFIG_PARAMETERS, undefined);
          assert.equal(command.options.env?.GH_TOKEN, undefined);
          return handle(
            42,
            Deferred.await(exit),
            Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          );
        }
        assert.equal(command.options.extendEnv, false);
        assert.equal(command.options.env?.GH_TOKEN, undefined);
        yield* Queue.offer(commands, command.args);
        if (command.args[3] === "KILL")
          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1));
        return handle(
          77,
          Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          Effect.succeed(false),
          Stream.make(new TextEncoder().encode('{"signalled":true}')),
        );
      }),
    );
    const child = yield* makeVmWorkloadSpawner(raw, true).spawn(
      ChildProcess.make("git", ["status"], {
        cwd: "/workspace/project/private",
        env: { GIT_INDEX_FILE: "/tmp/index", GIT_CONFIG_PARAMETERS: "test", GH_TOKEN: "test" },
      }),
    );
    const stop = yield* child
      .kill({ forceKillAfter: "1 second" })
      .pipe(Effect.uninterruptible, Effect.forkChild);
    assert.deepEqual(yield* Queue.take(commands), ["signal-workflow", workloadId, "42", "TERM"]);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Queue.take(commands), ["signal-workflow", workloadId, "42", "KILL"]);
    yield* Fiber.join(stop);
  }),
);

it.effect("keeps detached workloads when the isolated command leader already exited", () =>
  Effect.gen(function* () {
    let spawns = 0;
    const raw = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline.");
        assert.deepEqual(command.args.slice(2), ["process", "", "--", "/bin/true"]);
        assert.equal(command.options.cwd, undefined);
        spawns++;
        return handle(42, Effect.succeed(ChildProcessSpawner.ExitCode(0)), Effect.succeed(false));
      }),
    );
    yield* makeVmWorkloadSpawner(raw, true)
      .spawn(ChildProcess.make("/bin/true"))
      .pipe(Effect.scoped);
    assert.equal(spawns, 1);
  }),
);

const codexProbe = () => {
  const launch = vmWorkloadCommand("codex", ["app-server"], "probe");
  return { ...launch, command: ChildProcess.make(launch.command, launch.args) };
};

it.effect("a timed-out Codex probe waits for the exact cgroup after the launcher exits", () =>
  Effect.gen(function* () {
    const { command, workloadId } = codexProbe();
    const started = yield* Deferred.make<void>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    let stops = 0;
    const raw = ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipe");
        if (command.args[0] === "run-workflow") {
          return handle(
            42,
            Deferred.await(exit),
            Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          );
        }
        assert.deepEqual(command.args, ["stop-workflow-probe", workloadId, "42"]);
        const status = ["missing", "busy", "stopped"][stops++];
        assert.isDefined(status);
        if (status === "missing") yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
        return handle(
          77,
          Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          Effect.succeed(false),
          Stream.make(new TextEncoder().encode(`{"status":"${status}"}`)),
        );
      }),
    );
    const probe = yield* makeVmWorkloadSpawner(raw, true)
      .spawn(command)
      .pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
        Effect.scoped,
        Effect.timeoutOption("1 second"),
        Effect.forkChild,
      );
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("200 millis");
    assert.isTrue(Option.isNone(yield* Fiber.join(probe)));
    assert.equal(stops, 3);
  }),
);

it.effect("interruption after spawning a Codex probe still installs its cgroup cleanup", () =>
  Effect.gen(function* () {
    const { command, workloadId } = codexProbe();
    const started = yield* Deferred.make<void>();
    const releaseHandle = yield* Deferred.make<void>();
    let stopped = false;
    const raw = ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipe");
        if (command.args[0] === "run-workflow") {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(releaseHandle);
          return handle(42, Effect.never, Effect.succeed(true));
        }
        assert.deepEqual(command.args, ["stop-workflow-probe", workloadId, "42"]);
        stopped = true;
        return handle(
          77,
          Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          Effect.succeed(false),
          Stream.make(new TextEncoder().encode('{"status":"stopped"}')),
        );
      }),
    );
    const probe = yield* makeVmWorkloadSpawner(raw, true)
      .spawn(command)
      .pipe(
        Effect.andThen(Effect.die("Interrupted probe must not initialize")),
        Effect.scoped,
        Effect.forkChild,
      );
    yield* Deferred.await(started);
    probe.interruptUnsafe();
    yield* Deferred.succeed(releaseHandle, undefined);
    yield* Fiber.await(probe);
    assert.isTrue(stopped);
  }),
);

it.effect("keeps private review Git and explicit controls separate from checkout workloads", () =>
  Effect.gen(function* () {
    const commands: ChildProcess.StandardCommand[] = [];
    const raw = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline.");
        commands.push(command);
        return handle(42, Effect.succeed(ChildProcessSpawner.ExitCode(0)), Effect.succeed(false));
      }),
    );
    const review = "/home/user/.launchpad/userdata/workflow-review.git";
    yield* withVmWorkloads(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner
          .spawn(
            ChildProcess.make("git", ["--git-dir", review, "rev-parse", "HEAD"], {
              cwd: review,
              env: { HOME: "/home/user", GIT_CONFIG_GLOBAL: "/dev/null" },
            }),
          )
          .pipe(Effect.provideService(VmCoordinatorProcess, true));
        yield* spawner.spawn(
          ChildProcess.make("git", ["status", "--porcelain"], {
            cwd: "/workspace/project",
            env: { HOME: "/home/user", GH_TOKEN: "coordinator-only" },
          }),
        );
        const control = yield* VmControlSpawner;
        assert.ok(control);
        yield* control.spawn(
          ChildProcess.make("/opt/launchpad/bin/launchpad-workload", [
            "provider-identity",
            "a".repeat(32),
            "42",
          ]),
        );
      }),
      true,
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw));

    assert.equal(commands.length, 3);
    const [trusted, checkout, control] = commands;
    assert.equal(trusted!.command, "/opt/launchpad/bin/launchpad-workload");
    assert.equal(trusted!.args[0], "run");
    assert.deepEqual(trusted!.args.slice(2), [
      "process",
      "--",
      "git",
      "--git-dir",
      review,
      "rev-parse",
      "HEAD",
    ]);
    assert.equal(trusted!.options.cwd, review);
    assert.equal(trusted!.options.env?.HOME, "/home/user");
    assert.equal(checkout!.args[0], "run-workflow");
    assert.deepEqual(checkout!.args.slice(2), [
      "process",
      "/workspace/project",
      "--",
      "git",
      "-c",
      "credential.helper=",
      "status",
      "--porcelain",
    ]);
    assert.equal(checkout!.options.cwd, "/");
    assert.equal(checkout!.options.env?.HOME, "/home/launchpad-workflow");
    assert.equal(checkout!.options.env?.GH_TOKEN, undefined);
    assert.deepEqual(control!.args, ["provider-identity", "a".repeat(32), "42"]);
  }),
);
