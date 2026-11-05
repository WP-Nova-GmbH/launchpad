import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  readWorkflowCheckpointExclude,
  stageWorkflowCheckpoint,
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
