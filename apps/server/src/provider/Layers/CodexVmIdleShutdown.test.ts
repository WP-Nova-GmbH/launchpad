import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VmWorkloadError } from "../../vmWorkload.ts";
import { VmControlSpawner, VmWorkloadTracking } from "../../vmWorkloadCommand.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };

const isVmWorkloadError = Schema.is(VmWorkloadError);
const nativeId = "a88473a1-01d4-449a-8194-7d6544d3502d";
const bootId = "13835087-40ba-45c5-bde6-d0092298eaf5";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const packet = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Int),
      method: Schema.optionalKey(Schema.String),
      result: Schema.optionalKey(Schema.Unknown),
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeTurnRequest = Schema.decodeUnknownEffect(CodexSchema.V2TurnStartParams);
const decodeResumeRequest = Schema.decodeUnknownEffect(CodexSchema.V2ThreadResumeParams);
const makeFixture = Effect.fnUntraced(function* (
  options: {
    readonly workflow?: boolean;
    readonly managed?: boolean;
    readonly tracked?: boolean;
    readonly control?: boolean;
    readonly runtimeMode?: RuntimeMode;
    readonly resume?: boolean;
    readonly start?: boolean;
    readonly resumedNativeId?: string;
    readonly invalidIdentity?: boolean;
    readonly identityExitCode?: number;
    readonly threadReadNotification?: unknown;
    readonly beforeNativeFence?: Effect.Effect<void>;
    readonly failPrepareBeforeSignal?: boolean;
    readonly getWorkflowBackgroundRevision?: () => string | undefined;
  } = {},
) {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stopRequested = yield* Queue.unbounded<void>();
  const prepareRequested = yield* Queue.unbounded<void>();
  const inspectionRequested = yield* Queue.unbounded<void>();
  const responses = yield* Queue.unbounded<{ readonly id: number; readonly result: unknown }>();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const send = (value: unknown) => Queue.offer(output, encoder.encode(encode(value) + "\n"));
  const methods: string[] = [];
  const workflowChildActivity: boolean[] = [];
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const decisions: Array<"stop" | "release"> = [];
  const bindPeer = vi.fn();
  const modelProvider = options.managed || options.workflow ? "launchpad_vm" : "openai";
  const model = options.managed || options.workflow ? "gpt-6-astra" : "gpt-5.3-codex";
  let admitted = true,
    controlStops = 0,
    workflowPrepares = 0,
    workflowInspections = 0,
    workflowStopReserved = false,
    workflowStopRejected = false,
    nativeStops = 0,
    processOnly = false,
    groupId = "";
  const acknowledgeExit = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
    Effect.asVoid,
  );
  const end = Queue.end(output).pipe(Effect.andThen(acknowledgeExit));
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Deferred.await(exited),
    isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    kill: () =>
      Effect.sync(() => {
        nativeStops++;
      }).pipe(Effect.andThen(end)),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        const message = packet(decoder.decode(bytes));
        if (!message.method) {
          if (message.id !== undefined)
            yield* Queue.offer(responses, { id: message.id, result: message.result });
          return;
        }
        methods.push(message.method);
        requests.push({ method: message.method, params: message.params });
        if (message.id === undefined) return;
        if (message.method === "thread/read" && options.threadReadNotification)
          yield* send(options.threadReadNotification);
        const result =
          message.method === "initialize"
            ? {
                userAgent: "public-test-peer",
                codexHome: "/tmp/public-test",
                platformFamily: "unix",
                platformOs: "linux",
              }
            : message.method === "thread/start" || message.method === "thread/resume"
              ? {
                  ...wireFixture.responses.threadStart,
                  cwd: "/tmp/project",
                  model,
                  modelProvider,
                  thread: {
                    ...wireFixture.responses.threadStart.thread,
                    id: options.resumedNativeId ?? nativeId,
                  },
                }
              : message.method === "thread/read"
                ? {
                    thread: {
                      id: nativeId,
                      path: "/tmp/public-test/rollout.jsonl",
                      historyMode: "paginated",
                    },
                  }
                : message.method === "turn/start"
                  ? wireFixture.responses.turnStart
                  : {};
        yield* send({ id: message.id, result });
      }),
    ),
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      NodeAssert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipe");
      groupId = command.args[1]!;
      processOnly = yield* NodeSpawner.ProcessOnlyCleanup;
      yield* Scope.addFinalizer(yield* Scope.Scope, end);
      return handle;
    }),
  );
  const control = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected control pipe");
      const action = command.args[0];
      let result: unknown;
      let code = 0;
      let stdout: Stream.Stream<string> | undefined;
      let stdin: Sink.Sink<void, Uint8Array> = Sink.drain;
      if (action === "provider-identity") {
        code = options.identityExitCode ?? 0;
        result = {
          bootId,
          groupId,
          pid: options.invalidIdentity ? 43 : 42,
          startTicks: "1234",
          executableSha256: "a".repeat(64),
        };
      } else if (action === "prepare-idle-provider") {
        workflowPrepares++;
        yield* Queue.offer(prepareRequested, undefined);
        if (options.failPrepareBeforeSignal) {
          code = 1;
          stdout = Stream.empty;
        } else {
          const nonce = command.args[4]!;
          NodeAssert.match(nonce, /^[a-f0-9]{32}$/u);
          const finish = yield* Deferred.make<"rejected" | "reserved">();
          const prepare = Effect.gen(function* () {
            yield* options.beforeNativeFence ?? Effect.void;
            yield* Queue.offer(output, encoder.encode(`\x1elaunchpad-idle:${nonce}\x1f`));
            return encode({ status: "prepared" }) + "\n";
          });
          stdout = Stream.fromEffect(prepare).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.await(finish).pipe(Effect.map((status) => encode({ status }) + "\n")),
              ),
            ),
          );
          stdin = Sink.forEach((bytes: Uint8Array) =>
            Effect.gen(function* () {
              const decision = decoder.decode(bytes).trim();
              if (decision !== "stop" && decision !== "release")
                return yield* Effect.die("Unexpected idle stop decision");
              decisions.push(decision);
              if (decision === "stop" && admitted) {
                workflowStopReserved = true;
                controlStops++;
                yield* Queue.offer(stopRequested, undefined);
              } else workflowStopRejected = true;
              yield* Deferred.succeed(finish, workflowStopReserved ? "reserved" : "rejected");
            }),
          );
        }
      } else if (action === "inspect-idle-provider-stop") {
        workflowInspections++;
        yield* Queue.offer(inspectionRequested, undefined);
        result = {
          status: workflowStopReserved ? "reserved" : workflowStopRejected ? "rejected" : "refused",
        };
      } else {
        NodeAssert.equal(action, "stop-idle-provider");
        controlStops++;
        yield* Queue.offer(stopRequested, undefined);
        result = { admitted };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(100),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin,
        stdout: Stream.encodeText(stdout ?? Stream.make(encode(result))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("public-test-thread"),
    binaryPath: "/opt/public-codex",
    cwd: "/tmp/project",
    runtimeMode: options.runtimeMode ?? "auto",
    ...(options.resume === false
      ? {}
      : { resumeCursor: { threadId: nativeId, resumePolicy: "require-existing" as const } }),
    ...(options.managed || options.workflow ? { managedConnectionId: "test-connection" } : {}),
    ...(options.getWorkflowBackgroundRevision
      ? { getWorkflowBackgroundRevision: options.getWorkflowBackgroundRevision }
      : {}),
    ...(options.workflow
      ? {
          onWorkflowChildrenActive: (busy: boolean) =>
            Effect.sync(() => {
              workflowChildActivity.push(busy);
            }),
          workflowProxy: {
            baseUrl: "http://127.0.0.1:1/v1",
            permitEnv: "TEST_WORKFLOW_PERMIT",
            bindPeer,
          },
        }
      : {}),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(VmControlSpawner, options.control === false ? undefined : control),
    Effect.provideService(VmWorkloadTracking, options.tracked !== false),
  );
  if (options.start !== false) yield* runtime.start();
  const reportActiveWorkflowChild = Effect.gen(function* () {
    const observed = yield* runtime.events.pipe(
      Stream.filter((event) => event.method === "item/agentMessage/delta"),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* send({
      method: "thread/status/changed",
      params: { threadId: "late-child", status: { type: "active", activeFlags: [] } },
    });
    yield* send({
      method: "item/agentMessage/delta",
      params: {
        threadId: nativeId,
        turnId: "last-turn",
        itemId: "last-item",
        delta: "Processed after child activity",
      },
    });
    yield* Fiber.join(observed);
  });
  return {
    runtime,
    send,
    end,
    acknowledgeExit,
    reportActiveWorkflowChild,
    stopRequested,
    prepareRequested,
    inspectionRequested,
    responses,
    methods,
    workflowChildActivity,
    requests,
    decisions,
    bindPeer,
    get processOnly() {
      return processOnly;
    },
    get stops() {
      return controlStops;
    },
    get prepares() {
      return workflowPrepares;
    },
    get inspections() {
      return workflowInspections;
    },
    get nativeStops() {
      return nativeStops;
    },
    reject: () => {
      admitted = false;
    },
    accept: () => {
      admitted = true;
    },
  };
});
const fixture = makeFixture();

it.layer(NodeServices.layer)("owned idle Codex shutdown", (it) => {
  it.effect(
    "uses the workflow external sandbox for each actual turn and forwards approval decisions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeFixture({
            workflow: true,
            runtimeMode: "approval-required",
            resume: false,
          });
          NodeAssert.equal(f.bindPeer.mock.calls.length, 1);
          for (const [index, decision] of (["accept", "decline"] as const).entries()) {
            yield* f.runtime.sendTurn({ input: `Agent ${index + 1}` });
            const approval = yield* f.runtime.events.pipe(
              Stream.filter((event) => event.method === "item/commandExecution/requestApproval"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
            yield* f.send({
              id: 91 + index,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: nativeId,
                turnId: wireFixture.responses.turnStart.turn.id,
                itemId: `command-${index}`,
                command: "touch marker",
                cwd: "/tmp/project",
                startedAtMs: 1,
              },
            });
            const request = (yield* Fiber.join(approval))[0]!;
            NodeAssert.equal(request.requestKind, "command");
            NodeAssert.ok(request.requestId);
            yield* f.runtime.respondToRequest(request.requestId, decision);
            NodeAssert.deepEqual(yield* Queue.take(f.responses), {
              id: 91 + index,
              result: { decision },
            });
          }
          const turns = yield* Effect.forEach(
            f.requests.filter((request) => request.method === "turn/start"),
            (request) => decodeTurnRequest(request.params),
          );
          NodeAssert.equal(turns.length, 2);
          for (const turn of turns) {
            NodeAssert.equal(turn.threadId, nativeId);
            NodeAssert.deepEqual(turn.sandboxPolicy, {
              type: "externalSandbox",
              networkAccess: "enabled",
            });
            NodeAssert.equal(turn.approvalPolicy, "untrusted");
            NodeAssert.equal(turn.approvalsReviewer, "user");
          }
          NodeAssert.equal(f.methods.filter((method) => method === "thread/start").length, 1);
        }),
      ),
  );
  it.effect(
    "reapplies the workflow policy after replacing and strictly resuming the native runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeFixture({
            workflow: true,
            runtimeMode: "approval-required",
            resume: false,
          });
          yield* first.runtime.sendTurn({ input: "first Agent" });
          yield* first.runtime.closeNativeWriter!;
          const second = yield* makeFixture({ workflow: true, runtimeMode: "approval-required" });
          yield* second.runtime.sendTurn({ input: "next Agent after Review" });
          NodeAssert.equal(second.methods.includes("thread/start"), false);
          NodeAssert.equal(second.methods.filter((method) => method === "thread/resume").length, 1);
          const resume = yield* decodeResumeRequest(
            second.requests.find((request) => request.method === "thread/resume")!.params,
          );
          NodeAssert.equal(resume.threadId, nativeId);
          NodeAssert.equal(resume.modelProvider, "launchpad_vm");
          NodeAssert.equal(resume.approvalPolicy, "untrusted");
          NodeAssert.equal(resume.approvalsReviewer, "user");
          const turn = yield* decodeTurnRequest(
            second.requests.find((request) => request.method === "turn/start")!.params,
          );
          NodeAssert.equal(turn.threadId, nativeId);
          NodeAssert.deepEqual(turn.sandboxPolicy, {
            type: "externalSandbox",
            networkAccess: "enabled",
          });
          NodeAssert.equal(turn.approvalPolicy, "untrusted");
          NodeAssert.equal(turn.approvalsReviewer, "user");
        }),
      ),
  );
  it.effect(
    "rejects a strict native resume mismatch without opening another workflow conversation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeFixture({
            workflow: true,
            runtimeMode: "approval-required",
            start: false,
            resumedNativeId: "b88473a1-01d4-449a-8194-7d6544d3502d",
          });
          NodeAssert.equal((yield* Effect.result(f.runtime.start()))._tag, "Failure");
          NodeAssert.equal(f.methods.includes("thread/start"), false);
          NodeAssert.equal(f.methods.includes("turn/start"), false);
          NodeAssert.equal(f.bindPeer.mock.calls.length, 0);
        }),
      ),
  );
  for (const options of [
    { tracked: false },
    { tracked: false, managed: true },
    { tracked: true },
    { tracked: true, managed: true },
  ])
    it.effect(`keeps native sandboxing without a workflow proxy: ${JSON.stringify(options)}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeFixture({ ...options, runtimeMode: "approval-required" });
          yield* f.runtime.sendTurn({ input: "ordinary Agent" });
          const turn = yield* decodeTurnRequest(
            f.requests.find((request) => request.method === "turn/start")!.params,
          );
          NodeAssert.deepEqual(turn.sandboxPolicy, { type: "readOnly" });
          NodeAssert.equal(turn.approvalPolicy, "untrusted");
          NodeAssert.equal(turn.approvalsReviewer, "user");
          NodeAssert.equal(f.bindPeer.mock.calls.length, 0);
        }),
      ),
    );
  for (const options of [{ tracked: false }, { control: false }])
    it.effect(`rejects unverified workflow runtime: ${JSON.stringify(options)}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const error = yield* makeFixture({ ...options, workflow: true }).pipe(Effect.flip);
          NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
        }),
      ),
    );
  it.effect("rejects a workflow native identity mismatch before the runtime becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true, invalidIdentity: true, start: false });
        NodeAssert.equal((yield* Effect.result(f.runtime.start()))._tag, "Failure");
        NodeAssert.equal(f.methods.includes("turn/start"), false);
        NodeAssert.equal(f.bindPeer.mock.calls.length, 0);
      }),
    ),
  );
  it.effect("retains a native verification helper failure in the startup error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true, identityExitCode: 74, start: false });
        const error = yield* Effect.flip(f.runtime.start());
        NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
        if (error._tag !== "CodexAppServerSpawnError") return;
        NodeAssert.ok(isVmWorkloadError(error.cause));
        if (!isVmWorkloadError(error.cause)) return;
        NodeAssert.equal(error.cause.reason, "command_exit");
        NodeAssert.equal(error.cause.exitCode, 74);
        NodeAssert.equal(f.bindPeer.mock.calls.length, 0);
        NodeAssert.equal(f.methods.includes("turn/start"), false);
      }),
    ),
  );
  it.effect("settles a blocking native question with no answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const requested = yield* f.runtime.events.pipe(
          Stream.filter((event) => event.method === "item/tool/requestUserInput"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* f.send({
          id: 91,
          method: "item/tool/requestUserInput",
          params: {
            isBlocking: true,
            threadId: nativeId,
            turnId: "test-turn",
            itemId: "test-item",
            questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
          },
        });
        const request = (yield* Fiber.join(requested))[0]!;
        NodeAssert.ok(request.requestId);
        yield* f.runtime.respondToUserInput(request.requestId, {});
        NodeAssert.deepEqual(yield* Queue.take(f.responses), { id: 91, result: { answers: {} } });
      }),
    ),
  );
  it.effect(
    "drains final native output and rejects new dispatch after root-only stop admission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          NodeAssert.equal(f.processOnly, true);
          const events = yield* f.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
          const stopping = yield* f.runtime.closeIdleVmHarness!("pause-1", (signal) => signal).pipe(
            Effect.forkScoped,
          );
          yield* Queue.take(f.stopRequested);
          NodeAssert.equal(f.stops, 1);
          const ordinaryCleanup = yield* f.runtime.closeNativeWriter!.pipe(Effect.forkScoped);
          const previous = f.methods.length;
          NodeAssert.equal((yield* Effect.result(f.runtime.compactThread()))._tag, "Failure");
          NodeAssert.equal(f.methods.length, previous);
          yield* f.send({
            method: "item/agentMessage/delta",
            params: {
              threadId: nativeId,
              turnId: "last-turn",
              itemId: "last-item",
              delta: "last durable output",
            },
          });
          yield* f.end;
          NodeAssert.equal(yield* Fiber.join(stopping), true);
          yield* Fiber.join(ordinaryCleanup);
          const drained = yield* Fiber.join(events);
          NodeAssert.ok(drained.some((event) => event.method === "item/agentMessage/delta"));
          NodeAssert.equal(drained.at(-1)?.method, "session/closed");
          NodeAssert.equal(
            yield* f.runtime.closeIdleVmHarness!("pause-1", (signal) => signal),
            true,
          );
          NodeAssert.equal(f.stops, 1);
          // Ordinary provider cleanup follows idle shutdown and consumes the same writer receipt.
          yield* f.runtime.closeNativeWriter!;
          yield* f.runtime.closeNativeWriter!;
          NodeAssert.equal(f.nativeStops, 0);
        }),
      ),
  );
  it.effect("closes and drains a VM writer while a supervised background tool remains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const events = yield* f.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
        // The writer exits, but a detached tool still occupies its original process group.
        const groupProbe = vi.spyOn(process, "kill").mockReturnValue(true);
        try {
          yield* f.send({
            method: "item/agentMessage/delta",
            params: {
              threadId: nativeId,
              turnId: "last-turn",
              itemId: "last-item",
              delta: "output flushed before native EOF",
            },
          });
          yield* f.runtime.closeNativeWriter!;
          yield* f.runtime.closeNativeWriter!;
          NodeAssert.equal(f.nativeStops, 1);
          NodeAssert.equal(groupProbe.mock.calls.length, 0);
          NodeAssert.ok(
            (yield* Fiber.join(events)).some((event) => event.method === "item/agentMessage/delta"),
          );
          // A native-writer receipt must never satisfy the workflow's stronger tree stop.
          NodeAssert.equal((yield* Effect.result(f.runtime.close))._tag, "Failure");
          NodeAssert.deepEqual(groupProbe.mock.calls[0], [-42, 0]);
        } finally {
          groupProbe.mockRestore();
        }
      }),
    ),
  );
  it.effect("keeps a live native turn and its process untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const started = yield* f.runtime.events.pipe(
          Stream.filter((event) => event.method === "turn/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.send({
          method: "turn/started",
          params: {
            threadId: nativeId,
            turn: { id: "live-turn", status: "inProgress", items: [], error: null },
          },
        });
        yield* Fiber.join(started);
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("pause-live", (signal) => signal),
          false,
        );
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("refuses to pause when a workflow child reports active during the idle check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({
          workflow: true,
          threadReadNotification: {
            method: "thread/status/changed",
            params: { threadId: "late-child", status: { type: "active", activeFlags: [] } },
          },
        });
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("pause-child", () =>
            Effect.die("Shutdown admission must not run while the child is active"),
          ),
          false,
        );
        NodeAssert.ok(f.methods.includes("thread/read"));
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect.each(["no child turn", "tracked child turn", "another active child"] as const)(
    "handles a workflow child interruption with %s",
    (activity) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeFixture({ workflow: true });
          yield* f.reportActiveWorkflowChild;
          if (activity !== "no child turn")
            yield* f.send({
              method: "turn/started",
              params: {
                threadId: activity === "tracked child turn" ? "late-child" : "another-child",
                turn: { id: "live-child-turn", status: "inProgress", items: [], error: null },
              },
            });
          const interrupted = yield* f.runtime.events.pipe(
            Stream.filter((event) => event.method === "collabAgent/activity"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* f.send({
            method: "item/completed",
            params: {
              threadId: nativeId,
              turnId: "parent-turn",
              completedAtMs: 1234,
              item: {
                id: "interrupt-child",
                type: "subAgentActivity",
                kind: "interrupted",
                agentThreadId: "late-child",
                agentPath: "/root/late-child",
              },
            },
          });
          yield* Fiber.join(interrupted);
          const idle = activity === "no child turn";
          NodeAssert.deepEqual(
            f.workflowChildActivity,
            idle ? [false, true, false] : [false, true],
          );
          let admissionRequested = false;
          NodeAssert.equal(
            yield* f.runtime.closeIdleVmHarness!("pause-interrupted", () =>
              Effect.sync(() => {
                admissionRequested = true;
                return { admitted: false };
              }),
            ),
            false,
          );
          NodeAssert.equal(admissionRequested, idle);
          NodeAssert.equal(f.stops, 0);
        }),
      ),
  );
  it.effect("refuses to signal Codex when a child starts during pause admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true });
        f.reject();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const stopping = yield* f.runtime.closeIdleVmHarness!("pause-child", (signal) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(signal),
          ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* f.reportActiveWorkflowChild;
        yield* Deferred.succeed(release, undefined);
        NodeAssert.equal(yield* Fiber.join(stopping), false);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("releases frozen Codex when a child became active before the native fence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const freeze = yield* Deferred.make<void>();
        const f = yield* makeFixture({ workflow: true, beforeNativeFence: Deferred.await(freeze) });
        const stopping = yield* f.runtime.closeIdleVmHarness!(
          "pause-child",
          (signal) => signal,
        ).pipe(Effect.forkScoped);
        yield* Queue.take(f.prepareRequested);
        yield* f.send({
          method: "thread/status/changed",
          params: { threadId: "late-child", status: { type: "active", activeFlags: [] } },
        });
        yield* Deferred.succeed(freeze, undefined);
        NodeAssert.equal(yield* Fiber.join(stopping), false);
        NodeAssert.deepEqual(f.decisions, ["release"]);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("only checks the receipt after preparation fails before signalling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true, failPrepareBeforeSignal: true });
        NodeAssert.ok(
          isVmWorkloadError(
            yield* f.runtime.closeIdleVmHarness!("uncertain", (signal) => signal).pipe(Effect.flip),
          ),
        );
        yield* f.reportActiveWorkflowChild;
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("uncertain", (signal) => signal),
          false,
        );
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("next-pause", (signal) => signal),
          false,
        );
        NodeAssert.equal(f.prepares, 1);
        NodeAssert.equal(f.inspections, 1);
        NodeAssert.deepEqual(f.decisions, []);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("only recovers an existing idle reservation with exact local admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true });
        const readMethods = () => f.methods.filter((method) => method === "thread/read").length;
        const before = readMethods();
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!(
            "pending",
            () => Effect.die("Recovery must not admit a fresh stop"),
            undefined,
            true,
          ),
          false,
        );
        NodeAssert.equal(readMethods(), before);

        // The local protocol reservation succeeded before admission lost its reply.
        yield* f.runtime.closeIdleVmHarness!("pending", () =>
          Effect.fail(new VmWorkloadError()),
        ).pipe(Effect.flip);
        const after = readMethods();
        NodeAssert.equal(after, before + 1);
        NodeAssert.equal(f.prepares, 0);
        const recover = f.runtime.closeIdleVmHarness!;
        yield* recover("pending", () => Effect.succeed({ admitted: false }), undefined, true).pipe(
          Effect.flip,
        );
        NodeAssert.equal((yield* Effect.result(f.runtime.compactThread()))._tag, "Failure");
        NodeAssert.equal(f.inspections, 0);
        NodeAssert.equal(yield* recover("pending", (signal) => signal, undefined, true), false);
        yield* f.runtime.compactThread();
        NodeAssert.equal(readMethods(), after);
        NodeAssert.equal(f.prepares, 0);
        NodeAssert.equal(f.inspections, 1);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("allows another turn after recovering a lost native rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true });
        f.reject();
        yield* f.runtime.closeIdleVmHarness!("lost-rejection", (signal) =>
          signal.pipe(Effect.andThen(Effect.fail(new VmWorkloadError()))),
        ).pipe(Effect.flip);
        const methods = [...f.methods];
        NodeAssert.equal(
          (yield* Effect.result(f.runtime.sendTurn({ input: "Wait" })))._tag,
          "Failure",
        );
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!(
            "lost-rejection",
            (signal) => signal,
            undefined,
            true,
          ),
          false,
        );
        NodeAssert.deepEqual(f.methods, methods);
        yield* f.runtime.sendTurn({ input: "Resume the workspace" });
        NodeAssert.equal(f.methods.at(-1), "turn/start");
        NodeAssert.equal(f.prepares, 1);
        NodeAssert.equal(f.inspections, 1);
        NodeAssert.deepEqual(f.decisions, ["stop"]);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("releases frozen Codex after background work changes the observed idle revision", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const freeze = yield* Deferred.make<void>();
        let revision = "old-quiet-revision";
        const f = yield* makeFixture({
          workflow: true,
          beforeNativeFence: Deferred.await(freeze),
          getWorkflowBackgroundRevision: () => revision,
        });
        const stopping = yield* f.runtime.closeIdleVmHarness!(
          "pause-revision",
          (signal) => signal,
          revision,
        ).pipe(Effect.forkScoped);
        yield* Queue.take(f.prepareRequested);
        revision = "new-quiet-revision";
        yield* Deferred.succeed(freeze, undefined);
        NodeAssert.equal(yield* Fiber.join(stopping), false);
        NodeAssert.deepEqual(f.decisions, ["release"]);
        NodeAssert.equal(f.stops, 0);
      }),
    ),
  );
  it.effect("releases native admission only after a positive no-signal rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.reject();
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("rejected", (signal) => signal),
          false,
        );
        NodeAssert.equal(f.stops, 1);
        yield* Queue.take(f.stopRequested);
        // A different operation may retry only because the helper positively rejected.
        f.accept();
        const stopping = yield* f.runtime.closeIdleVmHarness!("accepted", (signal) => signal).pipe(
          Effect.forkScoped,
        );
        yield* Queue.take(f.stopRequested);
        const read = yield* f.runtime.events.pipe(
          Stream.filter((event) => event.method === "session/exited"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.end;
        yield* Fiber.join(read);
        NodeAssert.equal(yield* Fiber.join(stopping), true);
        NodeAssert.equal(f.stops, 2);
      }),
    ),
  );
  it.effect("warm reopening drains a reserved stop only for the matching admitted operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true });
        NodeAssert.equal(
          (yield* Effect.result(
            f.runtime.closeIdleVmHarness!("uncertain", (signal) =>
              signal.pipe(Effect.andThen(Effect.fail(new VmWorkloadError()))),
            ),
          ))._tag,
          "Failure",
        );
        yield* Queue.take(f.stopRequested);
        yield* f.reportActiveWorkflowChild;
        NodeAssert.ok(
          isVmWorkloadError(
            yield* f.runtime.closeIdleVmHarness!(
              "uncertain",
              () => Effect.succeed({ admitted: false }),
              undefined,
              true,
            ).pipe(Effect.flip),
          ),
        );
        NodeAssert.ok(
          isVmWorkloadError(
            yield* f.runtime.closeIdleVmHarness!(
              "different",
              (signal) => signal,
              undefined,
              true,
            ).pipe(Effect.flip),
          ),
        );
        NodeAssert.equal((yield* Effect.result(f.runtime.compactThread()))._tag, "Failure");
        NodeAssert.equal((yield* f.runtime.getSession).status, "ready");
        NodeAssert.equal(f.stops, 1);
        const observedExit = yield* f.runtime.events.pipe(
          Stream.filter((event) => event.method === "session/exited"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const stopped = yield* f.runtime.closeIdleVmHarness!(
          "uncertain",
          (signal) => signal,
          undefined,
          true,
        ).pipe(Effect.forkScoped);
        yield* Queue.take(f.inspectionRequested);
        yield* f.acknowledgeExit;
        yield* Fiber.join(observedExit);
        const completedBeforeEof = stopped.pollUnsafe();
        yield* f.end;
        NodeAssert.equal(yield* Fiber.join(stopped), true);
        NodeAssert.equal(completedBeforeEof, undefined);
        NodeAssert.equal(f.prepares, 1);
        NodeAssert.equal(f.inspections, 1);
        NodeAssert.deepEqual(f.decisions, ["stop"]);
        NodeAssert.equal(f.stops, 1);
      }),
    ),
  );
  it.effect("bounds idle and ordinary drain retries after Codex exits without closing stdout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture({ workflow: true });
        const events = yield* f.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
        const first = yield* f.runtime.closeIdleVmHarness!(
          "reserved-stop",
          (signal) => signal,
        ).pipe(Effect.flip, Effect.forkScoped);
        yield* Queue.take(f.stopRequested);
        yield* f.acknowledgeExit;
        yield* TestClock.adjust("10 seconds");
        const idleError = yield* Fiber.join(first);
        NodeAssert.ok(isVmWorkloadError(idleError));
        NodeAssert.equal(idleError.reason, "timeout");

        for (let attempt = 0; attempt < 2; attempt++) {
          const finished = yield* Deferred.make<void>();
          const retry = yield* f.runtime.closeNativeWriter!.pipe(
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.flip,
            Effect.forkScoped,
          );
          yield* TestClock.adjust("10 seconds");
          if (!(yield* Deferred.isDone(finished))) {
            yield* f.end;
            NodeAssert.fail("Ordinary shutdown is still waiting for output after the deadline");
          }
          const error = yield* Fiber.join(retry);
          const cause = error.cause;
          NodeAssert.ok(Cause.isCause(cause));
          const timeout = Option.getOrThrow(Cause.findErrorOption(cause));
          NodeAssert.ok(isVmWorkloadError(timeout));
          NodeAssert.equal(timeout.reason, "timeout");
        }

        yield* f.send({
          method: "item/agentMessage/delta",
          params: {
            threadId: nativeId,
            turnId: "last-turn",
            itemId: "last-item",
            delta: "Late output",
          },
        });
        yield* f.end;
        yield* f.runtime.closeNativeWriter!;
        NodeAssert.ok(
          (yield* Fiber.join(events)).some((event) => event.method === "item/agentMessage/delta"),
        );
        NodeAssert.equal(f.stops, 1);
        NodeAssert.equal(f.nativeStops, 0);
      }),
    ),
  );
  it.effect("finishes native output draining when the accepted caller is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const events = yield* f.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
        const stopped = yield* f.runtime.closeIdleVmHarness!(
          "cancelled-caller",
          (signal) => signal,
        ).pipe(Effect.forkScoped);
        yield* Queue.take(f.stopRequested);
        const interrupted = yield* Fiber.interrupt(stopped).pipe(Effect.forkScoped);
        yield* f.send({
          method: "item/agentMessage/delta",
          params: {
            threadId: nativeId,
            turnId: "last-turn",
            itemId: "last-item",
            delta: "output after caller left",
          },
        });
        yield* f.end;
        yield* Fiber.join(interrupted);
        NodeAssert.ok(
          (yield* Fiber.join(events)).some((event) => event.method === "item/agentMessage/delta"),
        );
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("cancelled-caller", (signal) => signal),
          true,
        );
        NodeAssert.equal(f.stops, 1);
      }),
    ),
  );
});
