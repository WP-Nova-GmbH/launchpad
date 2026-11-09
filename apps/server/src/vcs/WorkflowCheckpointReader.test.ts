import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  readWorkflowCheckpointExclude,
  stageWorkflowCheckpoint,
  WorkflowCheckpointReadError,
} from "./WorkflowCheckpointReader.ts";

const frame = (
  kind: number,
  path = "",
  payload = "",
  length = BigInt(Buffer.byteLength(payload)),
) => {
  const header = Buffer.alloc(13);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(Buffer.byteLength(path), 1);
  header.writeBigUInt64BE(length, 5);
  return Buffer.concat([header, Buffer.from(path), Buffer.from(payload)]);
};

const spawn = (output: Uint8Array, status = 0) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(status)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(output.subarray(0, 6), output.subarray(6)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  );

it.layer(NodeServices.layer)("Workflow checkpoint reader", (it) => {
  it.effect("reports copied bytes and files without logging paths or contents", () => {
    const messages: unknown[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped();
      const filename = "private-checkpoint-filename";
      const contents = "private-checkpoint-contents";
      yield* stageWorkflowCheckpoint(
        spawn(Buffer.concat([frame(1, filename, contents), frame(0)])),
        staging,
        staging,
        [filename],
      );
      expect(yield* fs.readFileString(`${staging}/${filename}`)).toBe(contents);
      expect(messages).toContainEqual([
        "Workflow checkpoint capture completed",
        expect.objectContaining({
          phase: "complete",
          filesCopied: 1,
          bytesCopied: Buffer.byteLength(contents),
          readerExitCode: 0,
        }),
      ]);
      const logged = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(messages);
      expect(logged).not.toContain(filename);
      expect(logged).not.toContain(contents);
      expect(logged).not.toContain(staging);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("distinguishes a reader exit from a filesystem failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped();
      const rejected = yield* Effect.flip(
        stageWorkflowCheckpoint(spawn(frame(0), 74), staging, staging, []),
      );
      expect(rejected).toMatchObject({
        _tag: "WorkflowCheckpointReadError",
        reason: "reader-exit",
        exitCode: 74,
      });
      const filesystem = yield* Effect.flip(
        stageWorkflowCheckpoint(spawn(frame(0)), staging, `${staging}/missing`, []),
      );
      expect(filesystem).toMatchObject({
        _tag: "WorkflowCheckpointReadError",
        reason: "filesystem",
        systemCode: "ENOENT",
      });
      expect(filesystem.message).not.toContain(staging);
    }),
  );

  it.effect("reports a timeout and the last transfer phase when the stream stops", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      const blocked = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const child = yield* spawn(frame(0)).spawn(command);
          yield* Deferred.succeed(started, undefined);
          return ChildProcessSpawner.makeHandle({
            ...child,
            stdout: Stream.never,
            exitCode: Effect.never,
          });
        }),
      );
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
      const capture = yield* stageWorkflowCheckpoint(blocked, staging, staging, []).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(capture);
      expect(error).toBeInstanceOf(WorkflowCheckpointReadError);
      expect(error.reason).toBe("timeout");
      expect(messages).toContainEqual([
        "Workflow checkpoint capture failed",
        expect.objectContaining({
          reason: "timeout",
          phase: "read",
          bytesReceived: 0,
          filesCopied: 0,
        }),
      ]);
    }),
  );

  it.effect("allows an active capture to finish after two minutes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped();
      const frames = [frame(1, "first", "one"), frame(1, "second", "two"), frame(0)];
      const requested = yield* Effect.forEach(frames, () => Deferred.make<void>());
      const release = yield* Effect.forEach(frames, () => Deferred.make<void>());
      const active = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const child = yield* spawn(frame(0)).spawn(command);
          return ChildProcessSpawner.makeHandle({
            ...child,
            stdout: Stream.fromIterable(frames.entries()).pipe(
              Stream.mapEffect(([index, bytes]) =>
                Deferred.succeed(requested[index]!, undefined).pipe(
                  Effect.andThen(Deferred.await(release[index]!)),
                  Effect.as(bytes),
                ),
              ),
            ),
          });
        }),
      );
      const capture = yield* stageWorkflowCheckpoint(active, staging, staging, [
        "first",
        "second",
      ]).pipe(Effect.result, Effect.forkScoped);
      for (let index = 0; index < frames.length; index++) {
        const next = yield* Effect.raceFirst(
          Deferred.await(requested[index]!).pipe(Effect.as("requested")),
          Fiber.join(capture).pipe(Effect.as("finished")),
        );
        expect(next).toBe("requested");
        yield* TestClock.adjust("90 seconds");
        yield* Deferred.succeed(release[index]!, undefined);
      }
      expect((yield* Fiber.join(capture))._tag).toBe("Success");
      expect(yield* fs.readFileString(`${staging}/first`)).toBe("one");
      expect(yield* fs.readFileString(`${staging}/second`)).toBe("two");
    }),
  );

  it.effect("caps total capture time even when bytes keep arriving", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staging = yield* fs.makeTempDirectoryScoped();
      const frames = [frame(1, "incomplete", "", 20n), ...Array(12).fill(Buffer.from("x"))];
      const requested = yield* Effect.forEach(frames, () => Deferred.make<void>());
      const release = yield* Effect.forEach(frames, () => Deferred.make<void>());
      const active = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const child = yield* spawn(frame(0)).spawn(command);
          return ChildProcessSpawner.makeHandle({
            ...child,
            stdout: Stream.fromIterable(frames.entries()).pipe(
              Stream.mapEffect(([index, bytes]) =>
                Deferred.succeed(requested[index]!, undefined).pipe(
                  Effect.andThen(Deferred.await(release[index]!)),
                  Effect.as(bytes),
                ),
              ),
            ),
          });
        }),
      );
      const capture = yield* stageWorkflowCheckpoint(active, staging, staging, ["incomplete"]).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      for (let index = 0; index < 10; index++) {
        const next = yield* Effect.raceFirst(
          Deferred.await(requested[index]!).pipe(Effect.as("requested")),
          Fiber.join(capture).pipe(Effect.as("finished")),
        );
        expect(next).toBe("requested");
        yield* TestClock.adjust("1 minute");
        yield* Deferred.succeed(release[index]!, undefined);
      }
      const result = yield* Fiber.join(capture);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("timeout");
    }),
  );

  it.effect("refuses a later record under a staged symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const staging = path.join(root, "staging");
      yield* fs.makeDirectory(staging);
      const stream = Buffer.concat([
        frame(3, "link", root),
        frame(1, "link/child", "forged"),
        frame(0),
      ]);
      yield* Effect.flip(stageWorkflowCheckpoint(spawn(stream), root, staging, ["link/child"]));
      expect(yield* fs.exists(path.join(root, "child"))).toBe(false);
    }),
  );

  it.effect("requires all candidate records, a complete frame and a clean exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const output = frame(1, "expected", "real data");
      for (const [stream, status] of [
        [frame(0), 0],
        [Buffer.concat([frame(1, "../outside", "forged"), frame(0)]), 0],
        [Buffer.concat([frame(1, "expected", "", 2n ** 63n), frame(0)]), 0],
        [output.subarray(0, -2), 0],
        [output, 0],
        [Buffer.concat([output, frame(0), Buffer.from("trailing")]), 0],
        [Buffer.concat([output, frame(0)]), 74],
      ] as const) {
        const staging = yield* fs.makeTempDirectoryScoped();
        yield* Effect.flip(
          stageWorkflowCheckpoint(spawn(stream, status), staging, staging, ["expected"]),
        );
      }
    }),
  );

  it.effect("keeps ignore rules byte-exact and rejects oversized or failed reads", () =>
    Effect.gen(function* () {
      const rules = Uint8Array.from([255, 10]);
      expect(yield* readWorkflowCheckpointExclude(spawn(rules), "/unused")).toEqual(rules);
      yield* Effect.flip(readWorkflowCheckpointExclude(spawn(rules, 74), "/unused"));
      yield* Effect.flip(readWorkflowCheckpointExclude(spawn(new Uint8Array(65_537)), "/unused"));
    }),
  );
});
