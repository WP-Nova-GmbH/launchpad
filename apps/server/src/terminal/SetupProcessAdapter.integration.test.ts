import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Journal from "./SetupProcessJournal.ts";
import * as Manager from "./Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Binary from "../resourceTelemetry/ResourceMonitorBinary.ts";
import * as Adapter from "./SetupProcessAdapter.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import { PtyAdapter } from "./PtyAdapter.ts";

const ordinaryAdmission = {
  checkoutAccess: { assertAvailable: () => Effect.void },
  execution: {
    begin: () => Effect.succeed("ordinary" as const),
    assertAccepting: () => Effect.void,
    withActiveWork: <A, E, R>(_work: unknown, effect: Effect.Effect<A, E, R>) => effect,
    confirmOrdinaryStopped: () => Effect.void,
  },
};

const decodeInspectedIdentity = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ identity: Schema.NullOr(Schema.String) })),
);

const native = Binary.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-setup-owner-integration-" })),
  Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
);
const layer = Layer.mergeAll(
  Adapter.layer.pipe(Layer.provide(native), Layer.provide(ProcessRunner.layer)),
  NodePtyAdapter.layer,
).pipe(Layer.provide(NodeServices.layer));

// Native builds are separate; opt in after rebuilding the resolved executable.
it.live.skipIf(
  process.env["T3CODE_SETUP_OWNER_INTEGRATION"] !== "1" ||
    HostProcessPlatform.defaultValue() === "win32",
)("the resolved helper owns a real PTY and stops a reparented ordinary preview", () =>
  Effect.gen(function* () {
    const adapter = yield* Adapter.SetupProcessAdapter;
    const ptys = yield* PtyAdapter;
    const child = yield* Deferred.make<number>();
    const exited = yield* Deferred.make<void>();
    const pty = yield* ptys.spawn({
      ownerExecutable: yield* adapter.launcher,
      shell: "/bin/bash",
      args: ["--noprofile", "--norc", "+H", "-i"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: { ...process.env, SHELL: "/bin/bash", HISTFILE: "/dev/null" },
    });
    const state = yield* adapter.inspect(pty.pid);
    assert.isTrue(state.owned);
    assert.isNotNull(state.identity);
    const birth = state.identity!;
    yield* adapter.arm(pty.pid, birth);
    let stopped = false;
    yield* Effect.addFinalizer(() =>
      stopped ? Effect.void : adapter.stop(pty.pid, birth).pipe(Effect.ignore),
    );
    let output = "";
    const offData = pty.onData((data) => {
      output += data;
      const found = /T3_CHILD=(\d+)/.exec(output);
      if (found && /T3_PARENT_DONE\r?\n/.test(output))
        Deferred.doneUnsafe(child, Effect.succeed(Number(found[1])));
    });
    const offExit = pty.onExit(() => Deferred.doneUnsafe(exited, Effect.void));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        offData();
        offExit();
      }),
    );
    pty.write("(sleep 60 & printf '\\nT3_CHILD=%s\\n' $!); printf 'T3_PARENT_DONE\\n'; exit\r");
    const childPid = yield* Deferred.await(child).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(
        (error) =>
          new Adapter.SetupProcessError({
            message: `Child output failed: ${output}; ${error.message}`,
          }),
      ),
    );
    assert.isAbove(childPid, 0);
    yield* adapter.stop(pty.pid, birth);
    stopped = true;
    yield* Deferred.await(exited).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(
        (error) =>
          new Adapter.SetupProcessError({
            message: `Owner exit callback failed: ${output}; ${error.message}`,
          }),
      ),
    );
  }).pipe(Effect.provide(layer)),
);

const ownershipLayer = Journal.layer.pipe(
  Layer.provideMerge(layer),
  Layer.provideMerge(native),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
for (const action of ["close", "restart", "delete", "recovered-close", "fallback-close"] as const) {
  it.live.skipIf(
    process.env["T3CODE_SETUP_OWNER_INTEGRATION"] !== "1" ||
      HostProcessPlatform.defaultValue() === "win32",
  )(`real terminal ${action} stops a completed setup's reparented preview`, () =>
    Effect.gen(function* () {
      const journal = yield* Journal.SetupProcessJournal;
      const ptys = yield* PtyAdapter;
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-cleanup-" });
      const manager = yield* Manager.makeWithOptions({
        ...ordinaryAdmission,
        logsDir,
        ptyAdapter: ptys,
        shellResolver: () =>
          action === "fallback-close" ? "/definitely/missing-shell" : "/bin/bash",
        env: { ...process.env, SHELL: "/bin/bash", HISTFILE: "/dev/null" },
        processTable: Effect.succeed([]),
      });
      const attempt = { threadId: `native-${action}`, attemptId: `native-${action}-attempt` };
      const terminalId = `setup-${attempt.attemptId}`;
      yield* journal.begin({ ...attempt, terminalId });
      const opened = yield* manager.open({
        ...attempt,
        terminalId,
        cwd: process.cwd(),
        setupProcessOwner: yield* journal.launcher,
        setupAttemptId: attempt.attemptId,
      });
      const selected = yield* journal.capture({ ...attempt, pid: opened.pid! });
      if (action === "fallback-close") assert.equal(selected, "/bin/bash");
      yield* Effect.addFinalizer(() =>
        journal.cleanup({ ...attempt, commandId: "fixture-finalizer" }).pipe(
          Effect.flatMap((receipt) => manager.closeOwned({ ...receipt, receipt })),
          Effect.ignore,
        ),
      );
      const child = yield* Deferred.make<number>();
      let output = "";
      const off = yield* manager.subscribe((event) =>
        Effect.sync(() => {
          if (event.type !== "output" || event.threadId !== attempt.threadId) return;
          output += event.data;
          const found = /T3_CHILD=(\d+)/.exec(output);
          if (found && /T3_PARENT_DONE\r?\n/.test(output))
            Deferred.doneUnsafe(child, Effect.succeed(Number(found[1])));
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(off));
      yield* manager.writeSetup({
        ...attempt,
        terminalId,
        expectedPid: opened.pid!,
        data: 'sh -c \'(sleep 60 & printf "\\nT3_CHILD=%s\\n" "$!"); printf "T3_PARENT_DONE\\n"\'\r',
      });
      const childPid = yield* Deferred.await(child).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(
          (error) =>
            new Adapter.SetupProcessError({
              message: `Child output failed in ${selected}: ${output}; ${error.message}`,
            }),
        ),
      );
      yield* journal.complete(attempt);
      if (action === "recovered-close") {
        const freshManager = yield* Manager.makeWithOptions({
          ...ordinaryAdmission,
          logsDir,
          ptyAdapter: ptys,
          processTable: Effect.succeed([]),
        });
        yield* freshManager.close({ threadId: attempt.threadId });
      }
      if (action === "close" || action === "fallback-close")
        yield* manager.close({ threadId: attempt.threadId, terminalId });
      if (action === "restart") {
        const fresh = yield* manager.restart({
          threadId: attempt.threadId,
          terminalId,
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
        });
        assert.isNotNull(fresh.pid);
        assert.notEqual(fresh.pid, opened.pid);
        assert.isTrue(
          yield* manager
            .writeSetup({
              ...attempt,
              terminalId,
              expectedPid: opened.pid!,
              data: "echo STALE_SETUP\r",
            })
            .pipe(Effect.isFailure),
        );
        const oldProof = yield* journal.cleanup({ ...attempt, commandId: "late-receipt" });
        assert.isFalse(yield* manager.closeOwned({ ...oldProof, receipt: oldProof }));
        const attached = yield* manager.open({
          threadId: attempt.threadId,
          terminalId,
          cwd: process.cwd(),
        });
        assert.equal(attached.pid, fresh.pid);
      }
      if (action === "delete") yield* (yield* manager.captureCleanup(attempt.threadId)).stop;
      assert.isTrue(yield* journal.confirmed(attempt));
      const runner = yield* ProcessRunner.ProcessRunner;
      const inspect = yield* runner.run({
        command: yield* (yield* Binary.ResourceMonitorBinary).resolve,
        args: ["--setup-process", "inspect", String(childPid)],
        timeout: "5 seconds",
      });
      assert.equal(inspect.code, 0);
      const state = yield* decodeInspectedIdentity(inspect.stdout);
      assert.isNull(state.identity);
    }).pipe(Effect.provide(ownershipLayer)),
  );
}
