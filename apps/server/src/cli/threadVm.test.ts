import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "node:stream";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import { threadVmGitCredentialCommand, threadVmServeCommand } from "./threadVm.ts";

for (const mode of ["initial", "move", "restore"] as const)
  it.effect("accepts the relay's " + mode + " VM startup invocation", () =>
    Effect.gen(function* () {
      const digest = "a".repeat(64);
      let parsed: { receiptSha256: string; move: boolean; restore: boolean } | undefined;
      const command = threadVmServeCommand.pipe(
        Command.withHandler((config) =>
          Effect.sync(() => {
            parsed = config;
          }),
        ),
      );
      yield* Command.runWith(command, { version: "0.0.0" })([
        "--receipt-sha256",
        digest,
        ...(mode === "initial" ? [] : ["--" + mode]),
      ]);
      expect(parsed).toEqual({
        receiptSha256: digest,
        move: mode === "move",
        restore: mode === "restore",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.effect(
  "keeps failed Git credentials on stdout and sanitized recovery guidance on stderr",
  () => {
    const stdout: unknown[][] = [];
    const stderr: unknown[][] = [];
    const input = NodeStream.Readable.from([Buffer.from("private-request".repeat(2048))]);
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
    const testConsole = {
      ...globalThis.console,
      log: (...args: unknown[]) => stdout.push(args),
      error: (...args: unknown[]) => stderr.push(args),
    } satisfies Console.Console;
    return Command.runWith(threadVmGitCredentialCommand, { version: "0.0.0" })(["get"]).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
      Effect.provideService(Console.Console, testConsole),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(stdout).toEqual([["quit=1\n\n"]]);
          expect(stderr.flat().join(" ")).toContain("organization's GitHub connection");
          expect(stderr.flat().join(" ")).not.toContain("private-request");
        }),
      ),
      Effect.ensuring(Effect.sync(() => stdin.mockRestore())),
    );
  },
);
