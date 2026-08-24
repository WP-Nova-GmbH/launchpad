import {
  ServerProviderAccountAuthError,
  type ProviderInstanceId,
  type ServerProviderAccountAuthOutputEvent,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface ProviderAccountAuthCommand {
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ProviderAccountAuthShape {
  readonly login: Stream.Stream<
    ServerProviderAccountAuthOutputEvent,
    ServerProviderAccountAuthError
  >;
  readonly logout: Effect.Effect<void, ServerProviderAccountAuthError>;
}

const MAX_OUTPUT_EVENT_LENGTH = 16 * 1024;

function* chunkOutput(text: string): Generator<string> {
  for (let offset = 0; offset < text.length; offset += MAX_OUTPUT_EVENT_LENGTH) {
    yield text.slice(offset, offset + MAX_OUTPUT_EVENT_LENGTH);
  }
}

function accountAuthError(input: {
  readonly instanceId: ProviderInstanceId;
  readonly reason: ServerProviderAccountAuthError["reason"];
  readonly detail?: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
}) {
  return new ServerProviderAccountAuthError({
    instanceId: input.instanceId,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

function outputStream(
  stream: "stdout" | "stderr",
  source: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<ServerProviderAccountAuthOutputEvent, unknown> {
  return source.pipe(
    Stream.decodeText(),
    Stream.flatMap((text) => Stream.fromIterable(chunkOutput(text))),
    Stream.map((text) => ({ type: "output" as const, stream, text })),
  );
}

export function makeProviderAccountAuth(input: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly login: ProviderAccountAuthCommand;
  readonly logout: ProviderAccountAuthCommand;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): ProviderAccountAuthShape {
  const spawn = (command: ProviderAccountAuthCommand) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(input.binaryPath, command.args, {
        env: command.environment,
      });
      return yield* input.spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: command.environment,
          shell: resolved.shell,
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        accountAuthError({
          instanceId: input.instanceId,
          reason: "command_unavailable",
          detail: `Could not start ${input.binaryPath}.`,
          cause,
        }),
      ),
    );

  const login = Stream.unwrap(
    Effect.gen(function* () {
      const child = yield* spawn(input.login);
      const output = Stream.merge(
        outputStream("stdout", child.stdout),
        outputStream("stderr", child.stderr),
      ).pipe(
        Stream.mapError((cause) =>
          accountAuthError({
            instanceId: input.instanceId,
            reason: "command_failed",
            detail: "Could not read provider login output.",
            cause,
          }),
        ),
      );
      const exit = Stream.fromEffect(
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            accountAuthError({
              instanceId: input.instanceId,
              reason: "command_failed",
              detail: "Could not read the provider login exit code.",
              cause,
            }),
          ),
        ),
      ).pipe(
        Stream.flatMap((code) => {
          const exitCode = Number(code);
          return exitCode === 0
            ? Stream.empty
            : Stream.fail(
                accountAuthError({
                  instanceId: input.instanceId,
                  reason: "command_failed",
                  detail: `The provider login command exited with code ${exitCode}.`,
                  exitCode,
                }),
              );
        }),
      );
      return Stream.concat(output, exit);
    }),
  ).pipe(Stream.scoped);

  const logout = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawn(input.logout);
      const exitCode = Number(
        yield* child.exitCode.pipe(
          Effect.mapError((cause) =>
            accountAuthError({
              instanceId: input.instanceId,
              reason: "command_failed",
              detail: "Could not read the provider logout exit code.",
              cause,
            }),
          ),
        ),
      );
      if (exitCode !== 0) {
        return yield* accountAuthError({
          instanceId: input.instanceId,
          reason: "command_failed",
          detail: `The provider logout command exited with code ${exitCode}.`,
          exitCode,
        });
      }
    }),
  );

  return { login, logout };
}
