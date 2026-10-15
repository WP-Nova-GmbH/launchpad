import * as NodeURL from "node:url";
import { HostProcessPlatform, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProcessRunner, ProcessOwnershipError, layer as processLayer } from "./processRunner.ts";
import { ResourceMonitorBinary } from "./resourceTelemetry/ResourceMonitorBinary.ts";
import { SetupProcessAdapter, layer as adapterLayer } from "./terminal/SetupProcessAdapter.ts";

const executable = NodeURL.fileURLToPath(
  new URL("../../../native/resource-monitor/target/debug/t3-resource-monitor", import.meta.url),
);
const supported = HostProcessPlatform.defaultValue() !== "win32";
const layer = adapterLayer.pipe(
  Layer.provide(Layer.succeed(ResourceMonitorBinary, { resolve: Effect.succeed(executable) })),
  Layer.provideMerge(processLayer),
  Layer.provideMerge(NodeServices.layer),
);
it.live.skipIf(!supported)(
  "runs an owned command through real pipes, stdin, private results and exact native cleanup",
  (context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(executable)))
        return yield* Effect.sync(() =>
          context.skip("Build the native resource-monitor helper to run this integration test."),
        );
      const native = yield* SetupProcessAdapter;
      const runner = yield* ProcessRunner;
      const events: string[] = [];
      let pid: number | null = null;
      let identity: string | null = null;
      let stopped = false;
      const ownError = (cause: unknown) =>
        new ProcessOwnershipError({ command: "native integration", argumentCount: 0, cause });
      const result = yield* runner.run({
        command: yield* HostProcessExecutablePath,
        args: [
          "-e",
          "const fs=require('node:fs'); if(fs.readFileSync(0,'utf8')!=='exact stdin'||process.env.WORKFLOW_TEST_VALUE!=='exact env') process.exit(9); process.stdout.write('{\"protocol\":1,\"code\":0}'); process.exitCode=37;",
        ],
        stdin: "exact stdin",
        env: { WORKFLOW_TEST_VALUE: "exact env" },
        maxOutputBytes: 256,
        owner: {
          executable,
          capture: (actualPid) =>
            Effect.gen(function* () {
              pid = actualPid;
              const state = yield* native.inspect(actualPid);
              identity = state.identity;
              assert.isTrue(state.owned);
              assert.isNotNull(identity);
              events.push("capture");
            }).pipe(Effect.mapError(ownError)),
          arm: Effect.gen(function* () {
            assert.isNotNull(pid);
            assert.isNotNull(identity);
            yield* native.arm(pid!, identity!);
            events.push("arm");
          }).pipe(Effect.mapError(ownError)),
          completed: (code) =>
            Effect.sync(() => {
              assert.equal(code, 37);
              events.push("result");
            }),
          stop: Effect.gen(function* () {
            if (stopped) return;
            if (pid !== null && identity !== null) yield* native.stop(pid, identity);
            stopped = true;
            events.push("stop");
          }).pipe(Effect.mapError(ownError)),
        },
      });
      assert.equal(result.code, 37);
      assert.equal(result.stdout, '{"protocol":1,"code":0}');
      assert.deepEqual(events, ["capture", "arm", "result", "stop"]);
    }).pipe(Effect.provide(layer)),
);
