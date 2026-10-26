import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  contents: string,
  fileName = "launchpad.json",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("T3ProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid launchpad.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.config?.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.config?.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect(
      "uses t3.json only when launchpad.json is missing and switches back after removal",
      () =>
        Effect.gen(function* () {
          const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeProjectFile(
            cwd,
            '{ "iconPath": "legacy.svg", "scripts": [{ "name": "Old", "command": "old" }] }',
            "t3.json",
          );
          expect(Option.getOrThrow(yield* loader.load(cwd)).fileName).toBe("t3.json");
          yield* writeProjectFile(cwd, '{ "iconPath": "new.svg" }');
          expect(Option.getOrThrow(yield* loader.load(cwd))).toEqual({
            fileName: "launchpad.json",
            config: { iconPath: "new.svg" },
          });
          yield* fs.remove(path.join(cwd, "launchpad.json"));
          expect(Option.getOrThrow(yield* loader.load(cwd)).fileName).toBe("t3.json");
        }),
    );

    it.effect("does not fall back when the preferred file is malformed or unreadable", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "iconPath": "legacy.svg" }', "t3.json");
        yield* writeProjectFile(cwd, "{ broken");
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
        yield* fs.remove(path.join(cwd, "launchpad.json"));
        yield* fs.makeDirectory(path.join(cwd, "launchpad.json"));
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
      }),
    );

    it.effect("returns none when both config files are missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
