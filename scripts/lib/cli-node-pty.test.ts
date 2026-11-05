import * as Schema from "effect/Schema";
import { describe, it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { stageLinuxNodePty } from "./cli-node-pty.ts";

const encodePackage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

describe("Linux CLI terminal package", () => {
  it.effect(
    "rejects missing and wrong-platform binaries and stages the matching native build",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-pty-" });
        const staged = path.join(root, "staged");
        const supplied = path.join(root, "supplied");
        for (const directory of [staged, supplied]) {
          yield* fs.makeDirectory(path.join(directory, "build/Release"), { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "package.json"),
            encodePackage({ name: "node-pty", version: "1.1.0" }),
          );
        }
        expect(
          (yield* Effect.flip(stageLinuxNodePty({ packageDirectory: staged, arch: "arm64" })))
            .message,
        ).toContain("Missing a Linux arm64");
        const native = path.join(supplied, "build/Release/pty.node");
        yield* fs.writeFileString(native, "Mac native library");
        const input = {
          packageDirectory: staged,
          arch: "arm64" as const,
          nativePackageDirectory: supplied,
        };
        expect((yield* Effect.flip(stageLinuxNodePty(input))).message).toContain(
          "Missing a Linux arm64",
        );
        const elf = Buffer.alloc(64);
        elf.writeUInt32BE(0x7f454c46, 0);
        elf[4] = 2;
        elf[5] = 1;
        elf.writeUInt16LE(62, 18);
        yield* fs.writeFile(native, elf);
        expect((yield* Effect.flip(stageLinuxNodePty(input))).message).toContain(
          "Missing a Linux arm64",
        );
        elf.writeUInt16LE(183, 18);
        yield* fs.writeFile(native, elf);
        yield* stageLinuxNodePty(input);
        expect(
          Buffer.from(yield* fs.readFile(path.join(staged, "prebuilds/linux-arm64/pty.node"))),
        ).toEqual(elf);
        yield* fs.writeFileString(
          path.join(supplied, "package.json"),
          encodePackage({ name: "node-pty", version: "1.0.0" }),
        );
        expect((yield* Effect.flip(stageLinuxNodePty(input))).message).toContain("must match");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
