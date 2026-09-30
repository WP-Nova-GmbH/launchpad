import { assert, it } from "@effect/vitest";
import {
  SourceControlProviderError,
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { VcsProcess, VcsProcessInput } from "../vcs/VcsProcess.ts";
import { GitHubCliUnavailableError } from "./GitHubCli.ts";
import { isGitHubCliMissingCause, make } from "./GitHubCliAvailability.ts";

const input: VcsProcessInput = {
  command: "gh",
  args: ["pr", "list"],
  cwd: "/repo",
  operation: "test",
};
const output = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "gh version 1",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const missing = () =>
  new VcsProcessSpawnError({
    operation: "test",
    command: "gh",
    cwd: "/repo",
    cause: PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
  });

it.effect("coalesces missing-tool detection across branches and warns once until recovery", () => {
  const logs: string[] = [];
  return Effect.gen(function* () {
    const availability = yield* make;
    let installed = false;
    const calls: VcsProcessInput[] = [];
    const process: VcsProcess["Service"] = {
      run: (request) =>
        Effect.suspend(() => {
          calls.push(request);
          return installed ? Effect.succeed(output) : Effect.fail(missing());
        }),
    };
    const checkAll = Effect.all(
      Array.from({ length: 8 }, (_, index) =>
        availability.run(process, { ...input, cwd: `/repo${index}` }).pipe(Effect.exit),
      ),
      { concurrency: "unbounded" },
    );
    const first = yield* checkAll;
    assert.isTrue(first.every((exit) => exit._tag === "Failure"));
    yield* TestClock.adjust("4 minutes");
    yield* checkAll;
    assert.lengthOf(calls, 1);
    assert.lengthOf(logs, 1);
    yield* TestClock.adjust("1 minute");
    yield* checkAll;
    assert.lengthOf(calls, 2);
    assert.deepEqual(calls[1]?.args, ["--version"]);
    assert.lengthOf(logs, 1);
    installed = true;
    yield* TestClock.adjust("5 minutes");
    const recovered = yield* checkAll;
    assert.isTrue(recovered.every((exit) => exit._tag === "Success"));
    assert.lengthOf(calls, 11); // two earlier misses, one recovery probe, eight commands
    assert.lengthOf(logs, 2);
    installed = false;
    yield* checkAll;
    assert.lengthOf(logs, 3);
  }).pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message }) => {
            logs.push(String(message));
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
});

it.effect("rescan immediately recovers and explicit actions fail clearly during cooldown", () =>
  Effect.gen(function* () {
    const availability = yield* make;
    let installed = false;
    const process: VcsProcess["Service"] = {
      run: () =>
        Effect.suspend(() => (installed ? Effect.succeed(output) : Effect.fail(missing()))),
    };
    yield* availability.run(process, input).pipe(Effect.flip);
    const error = yield* availability
      .run(process, { ...input, args: ["pr", "create"] })
      .pipe(Effect.flip);
    assert.equal(error._tag, "VcsProcessSpawnError");
    installed = true;
    yield* availability.run(process, { ...input, args: ["--version"] }, true);
    assert.deepEqual(yield* availability.run(process, input), output);
  }),
);

it.effect("a stale command failure cannot undo a successful rescan", () =>
  Effect.gen(function* () {
    const availability = yield* make;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* availability.run({ run: () => Effect.succeed(output) }, input);
    const oldCommand = yield* availability
      .run(
        {
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(missing())),
            ),
        },
        input,
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    yield* availability.run(
      { run: () => Effect.succeed(output) },
      { ...input, args: ["--version"] },
      true,
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(oldCommand);
    assert.deepEqual(yield* availability.run({ run: () => Effect.succeed(output) }, input), output);
  }),
);

it.effect("a failed request in one environment does not disable another", () =>
  Effect.gen(function* () {
    const first = yield* make;
    const second = yield* make;
    yield* first.run({ run: () => Effect.fail(missing()) }, input).pipe(Effect.flip);
    assert.deepEqual(yield* second.run({ run: () => Effect.succeed(output) }, input), output);
  }),
);

it.effect("a missing project directory does not disable the installed executable", () =>
  Effect.gen(function* () {
    const availability = yield* make;
    const directoryError = new VcsProcessSpawnError({
      operation: "test",
      command: "gh",
      cwd: "/repo",
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: "/repo",
      }),
    });
    const calls: VcsProcessInput[] = [];
    yield* availability
      .run(
        {
          run: (request) =>
            Effect.suspend(() => {
              calls.push(request);
              return request.args[0] === "--version"
                ? Effect.succeed(output)
                : Effect.fail(directoryError);
            }),
        },
        input,
      )
      .pipe(Effect.flip);
    yield* availability.run(
      {
        run: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return output;
          }),
      },
      input,
    );
    assert.equal(calls.filter((request) => request.args[0] === "--version").length, 1);
    assert.equal(calls[0]?.cwd, globalThis.process.cwd());
  }),
);

it.effect.each(["cold", "recovery"] as const)(
  "limits failed %s probes without misclassifying timeouts",
  (state) =>
    Effect.gen(function* () {
      const availability = yield* make;
      if (state === "recovery") {
        yield* availability.run({ run: () => Effect.fail(missing()) }, input).pipe(Effect.flip);
        yield* TestClock.adjust("5 minutes");
      }
      const timeout = new VcsProcessTimeoutError({
        operation: "probe",
        command: "gh",
        cwd: "/repo",
        timeoutMs: 5000,
      });
      const calls: VcsProcessInput[] = [];
      const process: VcsProcess["Service"] = {
        run: (request) =>
          Effect.suspend(() => {
            calls.push(request);
            return Effect.fail(timeout);
          }),
      };
      for (let index = 0; index < 4; index++) {
        assert.strictEqual(yield* availability.run(process, input).pipe(Effect.flip), timeout);
      }
      assert.lengthOf(calls, 1);
      assert.deepEqual(calls[0]?.args, ["--version"]);
      yield* TestClock.adjust("5 minutes");
      yield* availability.run(process, input).pipe(Effect.flip);
      assert.lengthOf(calls, 2);
      // Explicit rescan can recover immediately, despite the cached probe timeout.
      yield* availability.run(
        { run: () => Effect.succeed(output) },
        { ...input, args: ["--version"] },
        true,
      );
      assert.deepEqual(
        yield* availability.run({ run: () => Effect.succeed(output) }, input),
        output,
      );
    }),
);

it.effect("authentication failures do not disable GitHub or block other commands and rescan", () =>
  Effect.gen(function* () {
    const availability = yield* make;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const authentication = new VcsProcessExitError({
      operation: "test",
      command: "gh",
      cwd: "/repo",
      exitCode: 1,
      detail: "Not logged in",
      failureKind: "authentication",
    });
    const calls: VcsProcessInput[] = [];
    const failed = yield* availability
      .run(
        {
          run: (request) =>
            Effect.suspend(() => {
              calls.push(request);
              return request.args[0] === "--version"
                ? Effect.succeed(output)
                : Effect.fail(authentication);
            }),
        },
        input,
      )
      .pipe(Effect.flip);
    assert.strictEqual(failed, authentication);
    const running = yield* availability
      .run(
        {
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(output),
            ),
        },
        input,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    // Both finish while the first real GitHub command is still blocked.
    yield* availability.run(
      {
        run: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return output;
          }),
      },
      input,
    );
    assert.equal(calls.filter((request) => request.args[0] === "--version").length, 1);
    yield* availability.run(
      { run: () => Effect.succeed(output) },
      { ...input, args: ["--version"] },
      true,
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(running);
  }),
);

it("suppresses only missing GitHub errors, including wrapped causes", () => {
  const error = new SourceControlProviderError({
    provider: "github",
    operation: "list",
    cwd: "/repo",
    detail: "missing",
    cause: new GitHubCliUnavailableError({ command: "gh", cwd: "/repo", cause: missing() }),
  });
  assert.isTrue(isGitHubCliMissingCause(Cause.fail(error)));
  assert.isFalse(isGitHubCliMissingCause(Cause.die(error)));
  assert.isFalse(isGitHubCliMissingCause(Cause.fail(new Error("gh missing"))));
  assert.isFalse(
    isGitHubCliMissingCause(
      Cause.fail({
        _tag: "PullRequestUnavailableError",
        provider: "gitlab",
        reason: "cli-missing",
      }),
    ),
  );
  assert.isFalse(
    isGitHubCliMissingCause(
      Cause.fail({
        _tag: "PullRequestUnavailableError",
        provider: "github",
        reason: "cli-unauthenticated",
      }),
    ),
  );
  assert.isTrue(
    isGitHubCliMissingCause(
      Cause.fail({
        _tag: "PullRequestUnavailableError",
        provider: "github",
        reason: "cli-missing",
      }),
    ),
  );
});
