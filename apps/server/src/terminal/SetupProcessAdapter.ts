import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProcessRunner } from "../processRunner.ts";
import { ResourceMonitorBinary } from "../resourceTelemetry/ResourceMonitorBinary.ts";

export class SetupProcessError extends Schema.TaggedError<SetupProcessError>()(
  "SetupProcessError",
  { message: Schema.String },
) {}
export const BootEvidence = Schema.Struct({
  host: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
});
const State = Schema.Struct({
  protocol: Schema.Literal(4),
  identity: Schema.NullOr(Schema.String),
  owned: Schema.Boolean,
  fullStop: Schema.Boolean,
  boot: Schema.NullOr(BootEvidence),
  setupLaunchProtocol: Schema.optional(Schema.Literal(1)),
  commandLaunchProtocol: Schema.optional(Schema.Int),
  launch: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        selectedShell: Schema.NullOr(Schema.NonEmptyString),
        error: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});
const decodeState = Schema.decodeEffect(Schema.fromJsonString(State));
export class SetupProcessAdapter extends Context.Service<
  SetupProcessAdapter,
  {
    readonly launcher: Effect.Effect<string, SetupProcessError>;
    readonly commandLauncher?: Effect.Effect<string, SetupProcessError>;
    readonly host: Effect.Effect<typeof BootEvidence.Type | null, SetupProcessError>;
    readonly inspect: (pid: number) => Effect.Effect<typeof State.Type, SetupProcessError>;
    readonly arm: (pid: number, identity: string) => Effect.Effect<string, SetupProcessError>;
    readonly stop: (pid: number, identity: string) => Effect.Effect<void, SetupProcessError>;
  }
>()("t3/terminal/SetupProcessAdapter") {}

export const layer = Layer.effect(
  SetupProcessAdapter,
  Effect.gen(function* () {
    const binary = yield* ResourceMonitorBinary;
    const runner = yield* ProcessRunner;
    const invoke = Effect.fn("SetupProcessAdapter.invoke")(
      function* (args: ReadonlyArray<string>) {
        const output = yield* runner.run({
          command: yield* binary.resolve,
          args: ["--setup-process", ...args],
          timeout: "10 seconds",
          maxOutputBytes: 4096,
        });
        if (output.code !== 0 || output.timedOut || output.stdoutTruncated)
          return yield* new SetupProcessError({
            message: output.stderr || "Setup ownership inspection failed.",
          });
        return yield* decodeState(output.stdout);
      },
      Effect.mapError((error) => new SetupProcessError({ message: error.message })),
    );
    const host = invoke(["host"]).pipe(Effect.map((state) => state.boot));
    return SetupProcessAdapter.of({
      commandLauncher: Effect.gen(function* () {
        const state = yield* invoke(["host"]);
        if (state.commandLaunchProtocol !== 1)
          return yield* new SetupProcessError({
            message:
              "Owned workflow commands require an updated native helper on a supported host.",
          });
        return yield* binary.resolve.pipe(
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        );
      }),
      // Probe the resolved binary before opening a PTY: stale helpers cannot deliver setup.
      launcher: Effect.gen(function* () {
        const state = yield* invoke(["host"]);
        if (state.setupLaunchProtocol !== 1)
          return yield* new SetupProcessError({
            message: "Setup shell launch support is unavailable. Update the environment.",
          });
        return yield* binary.resolve.pipe(
          Effect.mapError((error) => new SetupProcessError({ message: error.message })),
        );
      }),
      host,
      inspect: (pid) => invoke(["capture", String(pid)]),
      arm: (pid, identity) =>
        invoke(["arm", String(pid), identity]).pipe(
          Effect.flatMap((state) =>
            state.identity === identity &&
            state.owned &&
            !state.fullStop &&
            state.setupLaunchProtocol === 1 &&
            state.launch?.selectedShell &&
            !state.launch.error
              ? Effect.succeed(state.launch.selectedShell)
              : Effect.fail(
                  new SetupProcessError({
                    message: state.launch?.error ?? "Setup owner could not confirm shell launch.",
                  }),
                ),
          ),
        ),
      stop: (pid, identity) =>
        invoke(["stop", String(pid), identity]).pipe(
          Effect.flatMap((state) =>
            state.fullStop && state.owned && state.identity === null
              ? Effect.void
              : Effect.fail(
                  new SetupProcessError({ message: "Setup cleanup could not be confirmed." }),
                ),
          ),
        ),
    });
  }),
);
