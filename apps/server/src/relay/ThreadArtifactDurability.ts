import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/** Flush an owned staging tree before publishing its immutable catalog pointer. */
export const flushThreadArtifactTree = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of yield* fs.readDirectory(directory)) {
    const file = path.join(directory, name);
    if ((yield* fs.stat(file)).type === "Directory") yield* flushThreadArtifactTree(file);
    else yield* syncThreadArtifactPath(file);
  }
  yield* syncThreadArtifactPath(directory);
});

export const syncThreadArtifactPath = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* (yield* fs.open(file, { flag: "r" })).sync;
    }),
  );
});
