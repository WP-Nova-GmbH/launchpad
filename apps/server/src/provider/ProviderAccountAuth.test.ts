import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerProviderAccountAuthError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeProviderAccountAuth } from "./ProviderAccountAuth.ts";

const encoder = new TextEncoder();
const instanceId = ProviderInstanceId.make("codex_work");

type SpawnCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly env?: NodeJS.ProcessEnv };
};

function makeHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("ProviderAccountAuth", () => {
  it.effect("streams native login output with the configured command and environment", () => {
    const commands: SpawnCommand[] = [];
    const spawner = ChildProcessSpawner.make((rawCommand) => {
      const command = rawCommand as unknown as SpawnCommand;
      commands.push(command);
      return Effect.succeed(
        makeHandle({
          stdout: "Open https://auth.openai.com/codex/device\n",
          stderr: "Waiting for authentication\n",
        }),
      );
    });
    const accountAuth = makeProviderAccountAuth({
      instanceId,
      binaryPath: "codex",
      login: { args: ["login", "--device-auth"], environment: { CODEX_HOME: "/data/codex" } },
      logout: { args: ["logout"], environment: { CODEX_HOME: "/data/codex" } },
      spawner,
    });

    return Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(accountAuth.login));

      expect(commands).toHaveLength(1);
      expect(commands[0]?.command).toBe("codex");
      expect(commands[0]?.args).toEqual(["login", "--device-auth"]);
      expect(commands[0]?.options.env?.CODEX_HOME).toBe("/data/codex");
      expect(events).toEqual(
        expect.arrayContaining([
          {
            type: "output",
            stream: "stdout",
            text: "Open https://auth.openai.com/codex/device\n",
          },
          { type: "output", stream: "stderr", text: "Waiting for authentication\n" },
        ]),
      );
    });
  });

  it.effect("reports a non-zero native login exit", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeHandle({ stderr: "denied\n", code: 7 })),
    );
    const accountAuth = makeProviderAccountAuth({
      instanceId,
      binaryPath: "codex",
      login: { args: ["login", "--device-auth"], environment: {} },
      logout: { args: ["logout"], environment: {} },
      spawner,
    });

    return Effect.gen(function* () {
      const error = yield* Stream.runDrain(accountAuth.login).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ServerProviderAccountAuthError);
      expect(error).toMatchObject({ reason: "command_failed", exitCode: 7, instanceId });
    });
  });

  it.effect("bounds individual websocket output events", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeHandle({ stdout: "x".repeat(40_000) })),
    );
    const accountAuth = makeProviderAccountAuth({
      instanceId,
      binaryPath: "codex",
      login: { args: ["login", "--device-auth"], environment: {} },
      logout: { args: ["logout"], environment: {} },
      spawner,
    });

    return Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(accountAuth.login));

      expect(events).toHaveLength(3);
      expect(events.every((event) => event.text.length <= 16 * 1024)).toBe(true);
      expect(events.map((event) => event.text).join("")).toBe("x".repeat(40_000));
    });
  });

  it.effect("runs the provider-native logout command", () => {
    const commands: SpawnCommand[] = [];
    const spawner = ChildProcessSpawner.make((rawCommand) => {
      commands.push(rawCommand as unknown as SpawnCommand);
      return Effect.succeed(makeHandle({}));
    });
    const accountAuth = makeProviderAccountAuth({
      instanceId,
      binaryPath: "claude",
      login: { args: ["auth", "login", "--claudeai"], environment: {} },
      logout: { args: ["auth", "logout"], environment: { CLAUDE_CONFIG_DIR: "/data/claude" } },
      spawner,
    });

    return accountAuth.logout.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(commands).toHaveLength(1);
          expect(commands[0]?.command).toBe("claude");
          expect(commands[0]?.args).toEqual(["auth", "logout"]);
          expect(commands[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe("/data/claude");
        }),
      ),
    );
  });
});
