import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  inspectVmWorkloads,
  withSealedVmWorkloads,
  readVmHarnessIdentity,
  stopIdleVmHarness,
} from "./vmWorkload.ts";
import {
  VmControlSpawner,
  VmWorkloadTracking,
  makeVmWorkloadSpawner,
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
        Effect.provideService(VmControlSpawner, raw),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, raw),
        Effect.exit,
      );
      expect(copied).toBe(false);
      expect(Exit.isFailure(result)).toBe(true);
    }
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
          expect(side.command).toBe("/usr/local/bin/launchpad-workload");
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
