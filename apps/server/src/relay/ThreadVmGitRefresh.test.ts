import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeThreadVmGitRefresh } from "./ThreadVmGitRefresh.ts";

it.effect("refreshes completed Git setup every five minutes", () =>
  Effect.gen(function* () {
    let calls = 0;
    const refresh = makeThreadVmGitRefresh(
      Effect.sync(() => {
        calls++;
        return { metadataPending: false };
      }),
    );
    expect(calls).toBe(0);
    yield* refresh;
    yield* TestClock.adjust("4 minutes");
    yield* refresh;
    expect(calls).toBe(1);
    yield* TestClock.adjust("1 minute");
    yield* refresh;
    expect(calls).toBe(2);
  }),
);

it.effect("backs off pending and failed lookups, and resets the delay after success", () =>
  Effect.gen(function* () {
    let calls = 0,
      pending = true,
      fail = false;
    const refresh = makeThreadVmGitRefresh(
      Effect.suspend(() => {
        calls++;
        return fail ? Effect.fail("offline") : Effect.succeed({ metadataPending: pending });
      }),
    );
    yield* refresh;
    yield* refresh;
    expect(calls).toBe(1);
    yield* TestClock.adjust("30 seconds");
    yield* refresh;
    expect(calls).toBe(2);
    fail = true;
    yield* TestClock.adjust("59 seconds");
    yield* refresh;
    expect(calls).toBe(2);
    yield* TestClock.adjust("1 second");
    yield* refresh;
    expect(calls).toBe(3);
    fail = false;
    pending = false;
    yield* TestClock.adjust("2 minutes");
    yield* refresh;
    expect(calls).toBe(4);
    pending = true;
    yield* TestClock.adjust("5 minutes");
    yield* refresh;
    expect(calls).toBe(5);
    yield* TestClock.adjust("30 seconds");
    yield* refresh;
    expect(calls).toBe(6);
  }),
);

it.effect("coalesces overlapping refreshes while unrelated work keeps running", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    let calls = 0;
    const refresh = makeThreadVmGitRefresh(
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return { metadataPending: false };
      }),
    );
    const first = yield* refresh.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* refresh.pipe(Effect.forkChild);
    expect(yield* Effect.succeed("command delivered")).toBe("command delivered");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(calls).toBe(1);
  }),
);

it.effect("preserves shutdown interruption and retries defects", () =>
  Effect.gen(function* () {
    const stopped = yield* makeThreadVmGitRefresh(Effect.interrupt).pipe(Effect.exit);
    expect(Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause)).toBe(true);
    let calls = 0;
    const refresh = makeThreadVmGitRefresh(
      Effect.suspend(() => {
        calls++;
        return calls === 1
          ? Effect.die("metadata defect")
          : Effect.succeed({ metadataPending: false });
      }),
    );
    yield* refresh;
    yield* TestClock.adjust("30 seconds");
    yield* refresh;
    expect(calls).toBe(2);
  }),
);
