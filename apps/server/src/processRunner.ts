// @effect-diagnostics nodeBuiltinImport:off - Windows tree termination must not use a leader-only fallback.
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  collectUint8StreamText,
  decodeUtf8,
  type CollectedUint8StreamText,
} from "./stream/collectUint8StreamText.ts";

export interface OwnedCommand {
  readonly executable: string;
  readonly capture: (pid: number) => Effect.Effect<void, ProcessOwnershipError>;
  readonly arm: Effect.Effect<void, ProcessOwnershipError>;
  readonly completed: (code: number) => Effect.Effect<void, ProcessOwnershipError>;
  readonly stop: Effect.Effect<void, ProcessOwnershipError>;
}
const decodeOwnedCommandResult = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ protocol: Schema.Literal(1), code: Schema.Int })),
);
/** Only VCS calls inside a workflow mutation inherit this factory. */
export const CurrentWorkflowCommand = Context.Reference<Effect.Effect<
  OwnedCommand,
  ProcessOwnershipError
> | null>("t3/processRunner/CurrentWorkflowCommand", { defaultValue: () => null });

export interface ProcessRunInput {
  readonly owner?: OwnedCommand;
  /** Pair with onExitConfirmed to reserve work in the same masked acquisition as spawning. */
  readonly beforeSpawn?: Effect.Effect<void, ProcessOwnershipError>;
  /** Runs only after no child was started, normal completion, or confirmed native-tree shutdown. */
  readonly onExitConfirmed?: Effect.Effect<void, ProcessOwnershipError>;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  /** Receives every stdout chunk, including bytes beyond the buffered output limit. */
  readonly onStdoutChunk?: ((chunk: Uint8Array) => void) | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly truncatedMarker?: string | undefined;
  /**
   * On timeout, return a synthetic timedOut result.
   * Partial stdout/stderr are not preserved.
   */
  readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: ChildProcessSpawner.ExitCode | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
}

const ProcessInvocationFields = {
  command: Schema.String,
  argumentCount: Schema.Number,
  cwd: Schema.optional(Schema.String),
  spawnCwd: Schema.optional(Schema.String),
};

const formatProcessInvocation = (input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
}): string => {
  const executionCwd = input.spawnCwd ?? input.cwd;
  return executionCwd === undefined
    ? `'${input.command}'`
    : `'${input.command}' in '${executionCwd}'`;
};

export class ProcessSpawnError extends Schema.TaggedError<ProcessSpawnError>()(
  "ProcessSpawnError",
  {
    ...ProcessInvocationFields,
    resolvedCommand: Schema.optional(Schema.String),
    resolvedArgumentCount: Schema.optional(Schema.Number),
    shell: Schema.optional(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessStdinError extends Schema.TaggedError<ProcessStdinError>()(
  "ProcessStdinError",
  {
    ...ProcessInvocationFields,
    stdinBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write stdin for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessOutputLimitError extends Schema.TaggedError<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} ${this.stream} produced ${this.observedBytes} bytes, exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ProcessReadError extends Schema.TaggedError<ProcessReadError>()("ProcessReadError", {
  ...ProcessInvocationFields,
  stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read ${this.stream} for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    ...ProcessInvocationFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} timed out after ${this.timeoutMs}ms`;
  }
}

export const ProcessOwnershipError = ProcessSpawnError;
export type ProcessOwnershipError = ProcessSpawnError;

export const ProcessRunError = Schema.Union([
  ProcessSpawnError,
  ProcessStdinError,
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessTimeoutError,
]);
export type ProcessRunError = typeof ProcessRunError.Type;

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
  }
>()("t3/processRunner") {}

const encodeOwnedCommand = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(1),
      token: Schema.String,
      candidates: Schema.Array(
        Schema.Struct({ shell: Schema.String, args: Schema.Array(Schema.String) }),
      ),
    }),
  ),
);
const DEFAULT_TIMEOUT = "60 seconds";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export const isWindowsCommandNotFound = Effect.fn("processRunner.isWindowsCommandNotFound")(
  function* (code: number | null, stderr: string) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return false;
    if (code === 9009) return true;
    return hasWindowsCommandNotFoundMessage(stderr);
  },
);

const collectText = Effect.fn("processRunner.collectText")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
}) {
  const stream = input.stream.pipe(
    Stream.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: input.streamName,
          cause,
        }),
    ),
  );

  if (input.outputMode === "truncate") {
    return yield* collectUint8StreamText({
      stream,
      maxBytes: input.maxOutputBytes,
      truncatedMarker: input.truncatedMarker,
    });
  }

  return yield* stream.pipe(
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array<ArrayBufferLike>[];
        readonly bytes: number;
      },
      Uint8Array<ArrayBufferLike>,
      ProcessOutputLimitError | ProcessReadError,
      never
    >(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const remainingBytes = input.maxOutputBytes - state.bytes;
        if (chunk.byteLength > remainingBytes) {
          return Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              argumentCount: input.args.length,
              cwd: input.cwd,
              spawnCwd: input.spawnCwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
              observedBytes: state.bytes + chunk.byteLength,
            }),
          );
        }

        state.chunks.push(chunk);
        return Effect.succeed({
          chunks: state.chunks,
          bytes: state.bytes + chunk.byteLength,
        });
      },
    ),
    Effect.map((state): CollectedUint8StreamText => ({
      ...decodeUtf8(Buffer.concat(state.chunks, state.bytes)),
      bytes: state.bytes,
      truncated: false,
    })),
  );
});

function finalizeRunProcess<R>(
  effect: Effect.Effect<ProcessRunOutput, ProcessRunError, R | Scope.Scope>,
  input: ProcessRunInput,
): Effect.Effect<ProcessRunOutput, ProcessRunError, Exclude<R, Scope.Scope>> {
  const timeout = Duration.fromInputUnsafe(input.timeout ?? DEFAULT_TIMEOUT);
  const timeoutBehavior = input.timeoutBehavior ?? "error";

  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(result.value);
      }
      if (timeoutBehavior === "timedOutResult") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } satisfies ProcessRunOutput);
      }
      return Effect.fail(
        new ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          timeoutMs: Duration.toMillis(timeout),
        }),
      );
    }),
  );
}

const spawnChild = Effect.fn("processRunner.spawnChild")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: ProcessRunInput,
): Effect.fn.Return<ChildProcessSpawner.ChildProcessHandle, ProcessRunError, Scope.Scope> {
  const extendEnv = input.env !== undefined;
  const spawnCommand = yield* resolveSpawnCommand(
    input.command,
    input.args,
    input.env === undefined ? {} : { env: input.env, extendEnv },
  );

  const owner = input.owner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        owner?.executable ?? spawnCommand.command,
        owner
          ? [
              "--command-owner-v1",
              "--launch-v1",
              encodeOwnedCommand({
                protocol: 1,
                token: "0".repeat(32),
                candidates: [{ shell: spawnCommand.command, args: spawnCommand.args }],
              }),
            ]
          : spawnCommand.args,
        {
          ...(owner ? { additionalFds: { fd3: { type: "output" as const } } } : {}),
          ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
          ...(input.env !== undefined
            ? {
                env: input.env,
                extendEnv,
              }
            : {}),
          shell: owner ? false : spawnCommand.shell,
        },
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            resolvedCommand: spawnCommand.command,
            resolvedArgumentCount: spawnCommand.args.length,
            shell: spawnCommand.shell,
            cause,
          }),
      ),
    );

  return child;
});

const useChild = Effect.fn("processRunner.useChild")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  input: ProcessRunInput,
) {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "error";
  const truncatedMarker = input.truncatedMarker ?? "";
  const stdin = input.stdin;
  const onStdoutChunk = input.onStdoutChunk;
  const writeStdin =
    stdin === undefined
      ? Effect.void
      : Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessStdinError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                stdinBytes: Buffer.byteLength(stdin),
                cause,
              }),
          ),
        );

  const ownershipError = (cause: unknown) =>
    new ProcessOwnershipError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      spawnCwd: input.spawnCwd,
      cause,
    });
  const owner = input.owner;
  const stopOwner = owner ? owner.stop.pipe(Effect.mapError(ownershipError)) : Effect.void;
  const ownedResult = !owner
    ? Effect.succeed(null)
    : Effect.gen(function* () {
        yield* owner.capture(child.pid).pipe(Effect.mapError(ownershipError));
        yield* owner.arm.pipe(Effect.mapError(ownershipError));
        const frame = yield* collectText({
          ...input,
          streamName: "stdout",
          stream: child.getOutputFd(3),
          maxOutputBytes: 4096,
          outputMode: "error",
          truncatedMarker: "",
        });
        const result = yield* decodeOwnedCommandResult(frame.text).pipe(
          Effect.mapError(ownershipError),
        );
        yield* owner.completed(result.code);
        yield* stopOwner;
        return ChildProcessSpawner.ExitCode(result.code);
      });
  const [stdout, stderr, , ownedCode] = yield* Effect.all(
    [
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stdout",
        stream: onStdoutChunk
          ? child.stdout.pipe(Stream.tap((chunk) => Effect.sync(() => onStdoutChunk(chunk))))
          : child.stdout,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
      }),
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stderr",
        stream: child.stderr,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
      }),
      writeStdin,
      ownedResult,
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.onExit(() => stopOwner));

  const exitCode =
    ownedCode ??
    (yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new ProcessReadError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            stream: "exitCode",
            cause,
          }),
      ),
    ));

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: exitCode,
    timedOut: false,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutInvalidUtf8: stdout.invalidUtf8,
    stderrInvalidUtf8: stderr.invalidUtf8,
  } satisfies ProcessRunOutput;
});

const isMissingProcess = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }));

/** A stopped leader alone does not prove that its original process group stopped. */
const confirmNativeStop = Effect.fn("processRunner.confirmNativeStop")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  input: ProcessRunInput,
) {
  const failure = (cause: unknown) =>
    new ProcessOwnershipError({
      command: input.command,
      argumentCount: input.args.length,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
      cause,
    });
  const platform = yield* HostProcessPlatform;
  const running = yield* child.isRunning.pipe(Effect.mapError(failure));
  if (platform === "win32") {
    if (!running) return yield* failure("The original native tree ownership was lost.");
    yield* Effect.callback<void, ProcessOwnershipError>((resume) => {
      NodeChildProcess.execFile(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, timeout: 3_000 },
        (error) => resume(error ? Effect.fail(failure(error)) : Effect.void),
      );
    });
    yield* child.exitCode.pipe(Effect.ignore);
  } else if (running)
    yield* child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.mapError(failure));
  if (yield* child.isRunning.pipe(Effect.mapError(failure)))
    return yield* failure("The original native child is still running.");
  if (platform === "win32") return;
  const absent = yield* Effect.try({
    try: () => {
      try {
        process.kill(-Number(child.pid), 0);
        return false;
      } catch (cause) {
        if (isMissingProcess(cause)) return true;
        throw cause;
      }
    },
    catch: failure,
  });
  if (!absent) return yield* failure("The original process group is still present.");
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ProcessRunner.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: ProcessRunner["Service"]["run"] = (input) => {
    if (!input.onExitConfirmed)
      return finalizeRunProcess(
        Effect.flatMap(
          input.beforeSpawn
            ? Effect.uninterruptible(
                input.beforeSpawn.pipe(Effect.andThen(spawnChild(spawner, input))),
              )
            : spawnChild(spawner, input),
          (child) => useChild(child, input),
        ),
        input,
      );
    const confirm = input.onExitConfirmed;
    return Effect.suspend(() => {
      let acquired = false;
      let stopConfirmed = false;
      let ownerStopped = false;
      const owner = input.owner;
      const childInput = owner
        ? {
            ...input,
            owner: {
              ...owner,
              stop: owner.stop.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    ownerStopped = true;
                  }),
                ),
              ),
            },
          }
        : input;
      const execution = Effect.acquireUseRelease(
        (input.beforeSpawn ?? Effect.void).pipe(
          Effect.andThen(spawnChild(spawner, input)),
          Effect.tap(() =>
            Effect.sync(() => {
              acquired = true;
            }),
          ),
        ),
        (child) => useChild(child, childInput),
        (child, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : (owner
                ? ownerStopped
                  ? Effect.void
                  : childInput.owner!.stop
                : confirmNativeStop(child, input)
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    stopConfirmed = true;
                  }),
                ),
              ),
      );
      return finalizeRunProcess(execution, input).pipe(
        Effect.onExit((exit) =>
          !acquired || stopConfirmed || ownerStopped || Exit.isSuccess(exit)
            ? confirm
            : Effect.void,
        ),
      );
    });
  };

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());
