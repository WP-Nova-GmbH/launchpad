import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { threadVmServeCommand } from "./threadVm.ts";

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
