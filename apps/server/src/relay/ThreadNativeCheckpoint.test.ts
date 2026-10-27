import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PlatformError from "effect/PlatformError";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ThreadNativeCheckpointError,
  makeThreadNativeCheckpoint,
} from "./ThreadNativeCheckpoint.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-checkpoint-" });
  const store = makeThreadNativeCheckpoint(sql);
  const input = {
    threadId: "portable",
    turnId: "turn-1",
    artifactRoot: path.join(root, "artifacts"),
  };
  const enroll = sql`INSERT INTO thread_execution_fences
    (thread_id, relay_url, environment_id, project_id, generation, operation_id, phase)
    VALUES ('portable', 'https://relay.invalid', 'source', 'project', 1, 'enroll', 'active')`;
  let calls = 0;
  const exportConversation = Effect.fnUntraced(function* (stage: string) {
    calls++;
    const directory = path.join(stage, "conversation");
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(path.join(directory, "manifest.json"), '{"threadId":"native"}');
    yield* fs.writeFileString(path.join(directory, "rollout.jsonl"), "retained turn");
    return { directory, nativeThreadId: "native" };
  });
  return { fs, path, sql, root, store, input, enroll, exportConversation, calls: () => calls };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory)),
  );

it.effect("does not touch providers or disk for an ordinary local thread", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* f.store.capture(f.input, f.exportConversation)).toBeNull();
      expect(f.calls()).toBe(0);
      expect(yield* f.fs.exists(f.input.artifactRoot)).toBe(false);
    }),
  ),
);
it.effect("publishes a complete local point once and retains earlier turns", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const first = yield* f.store.capture(f.input, f.exportConversation);
      expect(first?.publishedArtifactId).toBeNull();
      expect(yield* f.store.capture(f.input, f.exportConversation)).toEqual(first);
      expect(f.calls()).toBe(1);
      yield* f.store.capture({ ...f.input, turnId: "turn-2" }, f.exportConversation);
      expect(yield* f.store.get("portable", 1, "turn-1")).toEqual(first);
      expect(yield* f.fs.readFileString(f.path.join(first!.directory, "rollout.jsonl"))).toBe(
        "retained turn",
      );
    }),
  ),
);
it.effect("failed capture preserves the last point and clears its partial files", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const first = yield* f.store.capture(f.input, f.exportConversation);
      const before = yield* f.fs.readDirectory(f.path.dirname(f.path.dirname(first!.directory)));
      yield* Effect.flip(
        f.store.capture({ ...f.input, turnId: "turn-2" }, (stage) =>
          f
            .exportConversation(stage)
            .pipe(
              Effect.andThen(
                Effect.fail(new ThreadNativeCheckpointError({ message: "writer failed" })),
              ),
            ),
        ),
      );
      expect(yield* f.store.get("portable", 1, "turn-1")).toEqual(first);
      expect(yield* f.store.get("portable", 1, "turn-2")).toBeNull();
      expect(yield* f.fs.readDirectory(f.path.dirname(f.path.dirname(first!.directory)))).toEqual(
        before,
      );
    }),
  ),
);
it.effect("lost ownership during export cannot publish a recovery point", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const error = yield* Effect.flip(
        f.store.capture(f.input, (stage) =>
          f
            .exportConversation(stage)
            .pipe(
              Effect.tap(
                () =>
                  f.sql`UPDATE thread_execution_fences SET phase = 'frozen' WHERE thread_id = 'portable'`,
              ),
            ),
        ),
      );
      expect(error.message).toContain("ownership changed");
      expect(yield* f.store.get("portable", 1, "turn-1")).toBeNull();
    }),
  ),
);
it.effect("a frozen source cannot capture even when its prior point exists", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      yield* f.store.capture(f.input, f.exportConversation);
      yield* f.sql`UPDATE thread_execution_fences SET phase = 'frozen' WHERE thread_id = 'portable'`;
      expect(
        (yield* Effect.flip(f.store.capture(f.input, f.exportConversation))).message,
      ).toContain("no longer owns");
      expect(f.calls()).toBe(1);
    }),
  ),
);
it.effect("a damaged retained manifest blocks duplicate completion", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const first = yield* f.store.capture(f.input, f.exportConversation);
      yield* f.fs.writeFileString(f.path.join(first!.directory, "manifest.json"), "corrupt");
      expect(
        (yield* Effect.flip(f.store.capture(f.input, f.exportConversation))).message,
      ).toContain("damaged");
      expect(f.calls()).toBe(1);
    }),
  ),
);
it.effect("fsync failure cannot publish or replace the previous recovery point", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const first = yield* f.store.capture(f.input, f.exportConversation);
      const original = f.fs.open;
      const faulty = {
        ...f.fs,
        open: (...args: Parameters<typeof original>) =>
          original(...args).pipe(
            Effect.map((file) => ({
              ...file,
              sync: Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "sync",
                  description: "injected disk flush failure",
                }),
              ),
            })),
          ),
      };
      yield* Effect.flip(
        f.store
          .capture({ ...f.input, turnId: "turn-2" }, f.exportConversation)
          .pipe(Effect.provideService(FileSystem.FileSystem, faulty)),
      );
      expect(yield* f.store.get("portable", 1, "turn-1")).toEqual(first);
      expect(yield* f.store.get("portable", 1, "turn-2")).toBeNull();
    }),
  ),
);

it.effect("rollout corruption blocks duplicate completion even with an intact manifest", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const first = yield* f.store.capture(f.input, f.exportConversation);
      yield* f.fs.writeFileString(f.path.join(first!.directory, "rollout.jsonl"), "corrupt turn");
      expect(
        (yield* Effect.flip(f.store.capture(f.input, f.exportConversation))).message,
      ).toContain("damaged");
      expect(f.calls()).toBe(1);
    }),
  ),
);

it.effect("an acknowledged-late catalog commit keeps its complete files for retry", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enroll;
      const uncertainSql = new Proxy(f.sql, {
        get(target, key) {
          if (key === "withTransaction")
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              target
                .withTransaction(effect)
                .pipe(
                  Effect.andThen(
                    Effect.fail(new ThreadNativeCheckpointError({ message: "lost commit reply" })),
                  ),
                );
          return Reflect.get(target, key);
        },
      });
      yield* Effect.flip(
        makeThreadNativeCheckpoint(uncertainSql).capture(f.input, f.exportConversation),
      );
      const point = yield* f.store.get("portable", 1, "turn-1");
      expect(point).not.toBeNull();
      expect(yield* f.fs.readFileString(f.path.join(point!.directory, "rollout.jsonl"))).toBe(
        "retained turn",
      );
      expect(yield* f.store.capture(f.input, f.exportConversation)).toEqual(point);
      expect(f.calls()).toBe(1);
    }),
  ),
);
