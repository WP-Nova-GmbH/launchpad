import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import { ResourceMonitorBinary } from "../resourceTelemetry/ResourceMonitorBinary.ts";
import * as Adapter from "./SetupProcessAdapter.ts";

const harness = Effect.gen(function* () {
  const output = yield* Ref.make({
    code: 0,
    stdout: '{"protocol":4,"identity":"exact-birth","owned":true,"fullStop":false,"boot":null}',
    stderr: "",
  });
  const calls = yield* Ref.make<ReadonlyArray<ProcessRunInput>>([]);
  const layer = Adapter.layer.pipe(
    Layer.provide(Layer.mock(ResourceMonitorBinary, { resolve: Effect.succeed("/native/helper") })),
    Layer.provide(
      Layer.mock(ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (all) => [...all, input]);
            const value = yield* Ref.get(output);
            return {
              ...value,
              code: ChildProcessSpawner.ExitCode(value.code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    ),
  );
  return { output, calls, layer };
});
it.effect("process cleanup uses fresh one-shot operations without periodic telemetry", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const adapter = yield* Adapter.SetupProcessAdapter;
      assert.deepStrictEqual(yield* adapter.inspect(42), {
        protocol: 4,
        identity: "exact-birth",
        owned: true,
        fullStop: false,
        boot: null,
      });
      yield* Ref.update(h.output, (value) => ({
        ...value,
        stdout: '{"protocol":4,"identity":null,"owned":true,"fullStop":true,"boot":null}',
      }));
      yield* adapter.stop(42, "exact-birth");
    }).pipe(Effect.provide(h.layer));
    assert.deepStrictEqual(
      (yield* Ref.get(h.calls)).map((call) => call.args),
      [
        ["--setup-process", "capture", "42"],
        ["--setup-process", "stop", "42", "exact-birth"],
      ],
    );
  }),
);
it.effect.each(["malformed", "denied", "surviving", "stale", "no-ack"] as const)(
  "invalid or unconfirmed OS evidence fails cleanup: %s",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.output, {
        code: mode === "denied" ? 1 : 0,
        stdout:
          mode === "malformed"
            ? "{}"
            : mode === "stale"
              ? '{"identity":null,"bootTimeMs":10}'
              : mode === "surviving"
                ? '{"protocol":4,"identity":"still-running","owned":true,"fullStop":true,"boot":null}'
                : '{"protocol":4,"identity":null,"owned":true,"fullStop":false,"boot":null}',
        stderr: mode === "denied" ? "Access denied" : "",
      });
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.SetupProcessAdapter;
        const error = yield* Effect.flip(adapter.stop(42, "exact-birth"));
        assert.strictEqual(error._tag, "SetupProcessError");
        if (mode === "denied") assert.include(error.message, "Access denied");
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect.each(["stale", "launch-failure", "missing-result", "selected"] as const)(
  "launch receipts prevent delivery for %s helpers",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.update(h.output, (value) => ({
        ...value,
        stdout:
          mode === "stale"
            ? '{"protocol":4,"identity":"exact-birth","owned":true,"fullStop":false,"boot":null}'
            : mode === "launch-failure"
              ? '{"protocol":4,"identity":"exact-birth","owned":true,"fullStop":false,"boot":null,"setupLaunchProtocol":1,"launch":{"selectedShell":null,"error":"Every shell failed"}}'
              : mode === "missing-result"
                ? '{"protocol":4,"identity":"exact-birth","owned":true,"fullStop":false,"boot":null,"setupLaunchProtocol":1}'
                : '{"protocol":4,"identity":"exact-birth","owned":true,"fullStop":false,"boot":null,"setupLaunchProtocol":1,"launch":{"selectedShell":"/bin/sh","error":null}}',
      }));
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.SetupProcessAdapter;
        if (mode === "stale")
          assert.include((yield* Effect.flip(adapter.launcher)).message, "Update the environment");
        else if (mode === "selected")
          assert.equal(yield* adapter.arm(42, "exact-birth"), "/bin/sh");
        else
          assert.strictEqual(
            (yield* Effect.flip(adapter.arm(42, "exact-birth")))._tag,
            "SetupProcessError",
          );
      }).pipe(Effect.provide(h.layer));
    }),
);
