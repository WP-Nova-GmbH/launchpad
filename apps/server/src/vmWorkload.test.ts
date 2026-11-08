import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "./processRunner.ts";
import {
  inspectVmWorkloads,
  withSealedVmWorkloads,
  withVmWorkloadMaintenance,
  readVmHarnessIdentity,
  stopIdleVmHarness,
} from "./vmWorkload.ts";
import {
  VmControlSpawner,
  VmWorkloadTracking,
  VmWorkloadMaintenance,
  VmCoordinatorProcess,
  makeVmWorkloadSpawner,
  withVmWorkloads,
} from "./vmWorkloadCommand.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const bootId = "cb7c9212-2128-478f-9d11-6e4c8ed6f882";
const group = { id: "a".repeat(32), bootId, kind: "provider", leaderPid: 123 };
const empty = { bootId, epoch: 0, sealedBy: null, groups: [], stopped: true };
function respond(stdout: string | ReadonlyArray<string>, code = 0) {
  let index = 0;
  return ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(
          Stream.make(typeof stdout === "string" ? stdout : (stdout[index++] ?? "missing-report")),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
}
describe("VM workload inventory", () => {
  it.effect("retains detached workloads even when their leader is gone", () =>
    Effect.gen(function* () {
      const report = { ...empty, groups: [group], stopped: false };
      const result = yield* inspectVmWorkloads({ type: "inspect" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, respond(json(report))),
        Effect.provideService(VmWorkloadTracking, true),
      );
      expect(result.stopped).toBe(false);
      expect(result.groups).toEqual([group]);
    }),
  );
  it.effect("never treats malformed, mixed-boot or contradictory reports as stopped", () =>
    Effect.gen(function* () {
      for (const report of [
        "not-json",
        "{}",
        json({ ...empty, groups: [group] }),
        json({ ...empty, groups: [], stopped: false }),
        json({ ...empty, groups: [group, group], stopped: false }),
        json({
          ...empty,
          groups: [{ ...group, bootId: "ab7c9212-2128-478f-9d11-6e4c8ed6f882" }],
          stopped: false,
        }),
      ]) {
        const result = yield* inspectVmWorkloads({ type: "inspect" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, respond(report)),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
      }
      const failed = yield* inspectVmWorkloads({ type: "inspect" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, respond(json(empty), 74)),
        Effect.exit,
      );
      expect(Exit.isFailure(failed)).toBe(true);
    }),
  );
  it.effect(
    "never interprets a stop acknowledgement as an empty inventory until children exit",
    () =>
      Effect.gen(function* () {
        const operationId = "explicit-move",
          sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
        for (const groups of [[group], []]) {
          const result = yield* inspectVmWorkloads({ type: "stop", bootId, operationId }).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              respond(json({ ...empty, sealedBy, groups, stopped: groups.length === 0 })),
            ),
          );
          expect(result.stopped).toBe(groups.length === 0);
        }
        expect(
          Exit.isFailure(
            yield* inspectVmWorkloads({ type: "stop", bootId, operationId }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, respond(json(empty))),
              Effect.exit,
            ),
          ),
        ).toBe(true);
      }),
  );
  it.effect("requires the requested operation and boot in a seal receipt", () =>
    Effect.gen(function* () {
      const result = yield* inspectVmWorkloads({
        type: "seal",
        bootId,
        operationId: "move-1",
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          respond(json({ ...empty, sealedBy: "a".repeat(32) })),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      const changedBoot = yield* inspectVmWorkloads({
        type: "reopen",
        bootId: "ab7c9212-2128-478f-9d11-6e4c8ed6f882",
        operationId: "move-1",
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, respond(json(empty))),
        Effect.exit,
      );
      expect(Exit.isFailure(changedBoot)).toBe(true);
    }),
  );
});

it.effect("publishes an export only while its original stop seal is unchanged", () =>
  Effect.gen(function* () {
    const operationId = "move-export";
    const sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
    const before = { ...empty, epoch: 1, sealedBy };
    const maintenance = yield* Semaphore.make(1);
    for (const after of [
      before,
      { ...before, epoch: 3 },
      { ...before, groups: [group], stopped: false },
    ]) {
      let copied = false;
      const raw = respond([json(before), json(after)]);
      const result = yield* withSealedVmWorkloads(
        operationId,
        Effect.sync(() => {
          copied = true;
          return "exported";
        }),
      ).pipe(
        Effect.provideService(VmWorkloadTracking, true),
        Effect.provideService(VmWorkloadMaintenance, maintenance),
        Effect.provideService(VmControlSpawner, raw),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
        Effect.exit,
      );
      expect(copied).toBe(true);
      expect(Exit.isSuccess(result)).toBe(after === before);
    }
    for (const invalid of [empty, { ...before, groups: [group], stopped: false }]) {
      let copied = false;
      const raw = respond(json(invalid));
      const result = yield* withSealedVmWorkloads(
        operationId,
        Effect.sync(() => {
          copied = true;
        }),
      ).pipe(
        Effect.provideService(VmWorkloadTracking, true),
        Effect.provideService(VmWorkloadMaintenance, maintenance),
        Effect.provideService(VmControlSpawner, raw),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
        Effect.exit,
      );
      expect(copied).toBe(false);
      expect(Exit.isFailure(result)).toBe(true);
    }
  }),
);

it.effect(
  "a provider spawner captured before restore setup inherits only that exact sealed transfer admission",
  () =>
    Effect.gen(function* () {
      const operationId = "restore-setup";
      const sealedBy = NodeCrypto.createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 32);
      const gate = { ...empty, epoch: 8, sealedBy };
      const maintenance = yield* Semaphore.make(1);
      let executed: ReadonlyArray<string> = [];
      const raw = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isPipedCommand(command)) throw new Error("Expected one probe");
        executed = command.args;
        return respond("").spawn(command);
      });
      const captured = makeVmWorkloadSpawner(raw);
      yield* withSealedVmWorkloads(
        operationId,
        Effect.gen(function* () {
          const child = yield* captured.spawn(
            ChildProcess.make("/opt/launchpad/bin/launchpad-workload", [
              "run",
              "b".repeat(32),
              "provider",
              "--",
              "codex",
              "app-server",
            ]),
          );
          yield* child.exitCode;
        }),
      ).pipe(
        Effect.provideService(VmWorkloadTracking, true),
        Effect.provideService(VmWorkloadMaintenance, maintenance),
        Effect.provideService(VmControlSpawner, respond([json(gate), json(gate)])),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
      );
      expect(executed).toEqual([
        "run-transfer",
        bootId,
        sealedBy,
        "8",
        "b".repeat(32),
        "--",
        "codex",
        "app-server",
      ]);
      yield* (yield* captured.spawn(
        ChildProcess.make("/opt/launchpad/bin/launchpad-workload", [
          "run",
          "c".repeat(32),
          "provider",
          "--",
          "codex",
          "app-server",
        ]),
      )).exitCode;
      expect(executed[0]).toBe("run");
    }),
);

it.effect("wraps both sides of a pipeline and refuses implicit shell execution", () =>
  Effect.gen(function* () {
    const captured: ChildProcess.Command[] = [];
    const raw = ChildProcessSpawner.make((command) => {
      captured.push(command);
      return respond("").spawn(command);
    });
    const tracked = makeVmWorkloadSpawner(raw);
    const command = ChildProcess.pipeTo(
      ChildProcess.make("git", ["status"], {
        cwd: "/workspace",
        env: { SENTINEL: "literal-value" },
      }),
      ChildProcess.make("cat", []),
      { from: "stderr" },
    );
    yield* tracked.spawn(command);
    const actual = captured[0]!;
    expect(ChildProcess.isPipedCommand(actual)).toBe(true);
    if (ChildProcess.isPipedCommand(actual)) {
      for (const side of [actual.left, actual.right]) {
        expect(ChildProcess.isStandardCommand(side)).toBe(true);
        if (ChildProcess.isStandardCommand(side))
          expect(side.command).toBe("/opt/launchpad/bin/launchpad-workload");
      }
      expect(actual.options).toEqual(command.options);
      if (ChildProcess.isStandardCommand(actual.left))
        expect(actual.left.options).toEqual(command.left.options);
    }
    const result = yield* tracked
      .spawn(ChildProcess.make("echo unsafe", [], { shell: true }))
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(captured).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "does not admit sealed maintenance without the shared guest permit or exact saved epoch",
  () =>
    Effect.gen(function* () {
      const operationId = "cancelled-read";
      const sealedBy = NodeCrypto.createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 32);
      const gate = { ...empty, epoch: 4, sealedBy };
      const maintenance = yield* Semaphore.make(1);
      let inspected = 0;
      let executed = false;
      const raw = ChildProcessSpawner.make((command) => {
        inspected++;
        return respond(json(gate)).spawn(command);
      });
      const read = (expected?: { bootId: string; epoch: number }) =>
        withSealedVmWorkloads(
          operationId,
          Effect.sync(() => {
            executed = true;
          }),
          expected,
        ).pipe(
          Effect.provideService(VmWorkloadTracking, true),
          Effect.provideService(VmControlSpawner, raw),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
          Effect.exit,
        );
      expect(Exit.isFailure(yield* read())).toBe(true);
      expect(inspected).toBe(0);
      for (const expected of [
        { bootId: "ab7c9212-2128-478f-9d11-6e4c8ed6f882", epoch: 4 },
        { bootId, epoch: 3 },
      ]) {
        expect(
          Exit.isFailure(
            yield* read(expected).pipe(Effect.provideService(VmWorkloadMaintenance, maintenance)),
          ),
        ).toBe(true);
      }
      expect(inspected).toBe(2);
      expect(executed).toBe(false);
    }),
);

it.effect("serializes two sealed reads with maintenance that can adopt their seal", () =>
  Effect.gen(function* () {
    const operationId = "cancelled-concurrent-read";
    const sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
    const gate = { ...empty, epoch: 4, sealedBy };
    const maintenance = yield* Semaphore.make(1);
    const entered = yield* Deferred.make();
    const release = yield* Deferred.make();
    const requested = yield* Deferred.make();
    let inspections = 0;
    let secondEntered = false;
    let adopted = false;
    const raw = ChildProcessSpawner.make((command) => {
      inspections++;
      return respond(json(gate)).spawn(command);
    });
    yield* Effect.gen(function* () {
      const first = yield* withSealedVmWorkloads(
        operationId,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
        { bootId, epoch: 4 },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* Effect.gen(function* () {
        yield* Deferred.succeed(requested, undefined);
        return yield* withSealedVmWorkloads(
          operationId,
          Effect.sync(() => {
            secondEntered = true;
          }),
        );
      }).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      const adoption = yield* withVmWorkloadMaintenance(
        Effect.sync(() => {
          adopted = true;
        }),
      ).pipe(Effect.forkChild);
      expect(inspections).toBe(1);
      expect(secondEntered).toBe(false);
      expect(adopted).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(adoption);
    }).pipe(
      Effect.provideService(VmWorkloadTracking, true),
      Effect.provideService(VmWorkloadMaintenance, maintenance),
      Effect.provideService(VmControlSpawner, raw),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
    );
    expect(inspections).toBe(4);
    expect(secondEntered).toBe(true);
    expect(adopted).toBe(true);
  }),
);

it.effect(
  "checks the sealed inventory and releases maintenance after failure and interruption",
  () =>
    Effect.gen(function* () {
      const operationId = "failed-sealed-read";
      const sealedBy = NodeCrypto.createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 32);
      const gate = { ...empty, epoch: 2, sealedBy };
      const maintenance = yield* Semaphore.make(1);
      let inspections = 0;
      const raw = ChildProcessSpawner.make((command) => {
        inspections++;
        return respond(json(gate)).spawn(command);
      });
      yield* Effect.gen(function* () {
        const failed = yield* withSealedVmWorkloads(operationId, Effect.fail("git failed")).pipe(
          Effect.result,
        );
        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure") expect(failed.failure).toBe("git failed");
        expect(inspections).toBe(2);
        const entered = yield* Deferred.make();
        const interrupted = yield* withSealedVmWorkloads(
          operationId,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(interrupted);
        expect(inspections).toBe(4);
        expect(yield* withSealedVmWorkloads(operationId, Effect.succeed("read again"))).toBe(
          "read again",
        );
        expect(inspections).toBe(6);
      }).pipe(
        Effect.provideService(VmWorkloadTracking, true),
        Effect.provideService(VmWorkloadMaintenance, maintenance),
        Effect.provideService(VmControlSpawner, raw),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
      );
    }),
);

it.effect(
  "a preconstructed workflow runner admits only trusted Git under the sealed read context",
  () =>
    Effect.gen(function* () {
      const operationId = "captured-checkpoint-read";
      const sealedBy = NodeCrypto.createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 32);
      const gate = { ...empty, epoch: 7, sealedBy };
      const commands: ChildProcess.StandardCommand[] = [];
      const raw = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
        if (command.args[0] === "inspect") return respond(json(gate)).spawn(command);
        commands.push(command);
        return respond("saved patch").spawn(command);
      });
      yield* withVmWorkloads(
        Effect.gen(function* () {
          const captured = yield* ProcessRunner.make();
          const git = captured.run({
            command: "git",
            args: ["--git-dir", "/private/review.git", "diff", "a", "b", "--"],
            cwd: "/private/review.git",
          });
          const patch = yield* withSealedVmWorkloads(
            operationId,
            git.pipe(Effect.provideService(VmCoordinatorProcess, true)),
            { bootId, epoch: 7 },
          );
          expect(patch.stdout).toBe("saved patch");
          for (const [command, args] of [
            ["codex", ["app-server"]],
            ["/bin/bash", []],
          ] as const) {
            expect(
              Exit.isFailure(
                yield* withSealedVmWorkloads(
                  operationId,
                  captured.run({ command, args, cwd: "/workspace" }),
                  { bootId, epoch: 7 },
                ).pipe(Effect.exit),
              ),
            ).toBe(true);
          }
        }),
        true,
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw));
      expect(commands).toHaveLength(1);
      expect(commands[0]!.args.slice(0, 4)).toEqual(["run-transfer", bootId, sealedBy, "7"]);
      expect(commands[0]!.args.slice(5)).toEqual([
        "--",
        "git",
        "--git-dir",
        "/private/review.git",
        "diff",
        "a",
        "b",
        "--",
      ]);
    }),
);

it.effect("bounds a failed read's unavailable final inspection before releasing maintenance", () =>
  Effect.gen(function* () {
    const operationId = "unavailable-read-check";
    const sealedBy = NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
    const gate = { ...empty, epoch: 3, sealedBy };
    const maintenance = yield* Semaphore.make(1);
    const checking = yield* Deferred.make();
    let inspections = 0;
    const raw = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        inspections++;
        const child = yield* respond(json(gate)).spawn(command);
        if (inspections !== 2) return child;
        yield* Deferred.succeed(checking, undefined);
        return ChildProcessSpawner.makeHandle({ ...child, stdout: Stream.never });
      }),
    );
    yield* Effect.gen(function* () {
      const read = yield* withSealedVmWorkloads(operationId, Effect.fail("read failed")).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(checking);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(read);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBe("read failed");
      expect(yield* withVmWorkloadMaintenance(Effect.succeed("released"))).toBe("released");
      expect(inspections).toBe(2);
    }).pipe(
      Effect.provideService(VmWorkloadTracking, true),
      Effect.provideService(VmWorkloadMaintenance, maintenance),
      Effect.provideService(VmControlSpawner, raw),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
    );
  }),
);

it.effect("keeps exact owned harness identity separate from physical-stop proof", () =>
  Effect.gen(function* () {
    const identity = {
      bootId,
      groupId: group.id,
      pid: 123,
      startTicks: "98765",
      executableSha256: "b".repeat(64),
    };
    expect(
      yield* readVmHarnessIdentity(group.id, 123).pipe(
        Effect.provideService(VmControlSpawner, respond(json(identity))),
      ),
    ).toEqual(identity);
    for (const admitted of [false, true]) {
      expect(
        yield* stopIdleVmHarness(identity, "pause-owned").pipe(
          Effect.provideService(VmControlSpawner, respond(json({ admitted }))),
        ),
      ).toEqual({ admitted });
    }
    const stillLive = yield* inspectVmWorkloads({ type: "inspect" }).pipe(
      Effect.provideService(
        VmControlSpawner,
        respond(json({ ...empty, groups: [group], stopped: false })),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        respond("unexpected-control-fallback"),
      ),
    );
    expect(stillLive.stopped).toBe(false);
  }),
);

it.effect(
  "holds idle shutdown on missing control capability, malformed identity or uncertain helper exit",
  () =>
    Effect.gen(function* () {
      const identity = {
        bootId,
        groupId: group.id,
        pid: 123,
        startTicks: "98765",
        executableSha256: "b".repeat(64),
      };
      expect(
        Exit.isFailure(
          yield* readVmHarnessIdentity(group.id, 123).pipe(
            Effect.provideService(VmControlSpawner, undefined),
            Effect.exit,
          ),
        ),
      ).toBe(true);
      for (const output of [
        "{}",
        json({ ...identity, pid: 0 }),
        json({ ...identity, pid: 124 }),
        json({ ...identity, groupId: "c".repeat(32) }),
        json({ ...identity, startTicks: "changed" }),
        json({ ...identity, executableSha256: "unknown" }),
      ]) {
        expect(
          Exit.isFailure(
            yield* readVmHarnessIdentity(group.id, 123).pipe(
              Effect.provideService(VmControlSpawner, respond(output)),
              Effect.exit,
            ),
          ),
        ).toBe(true);
      }
      expect(
        Exit.isFailure(
          yield* stopIdleVmHarness(identity, "pause-owned").pipe(
            Effect.provideService(VmControlSpawner, respond(json({ admitted: true }), 74)),
            Effect.exit,
          ),
        ),
      ).toBe(true);
    }),
);
