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
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
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
  } = {},
) {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stopRequested = yield* Queue.unbounded<void>();
  const responses = yield* Queue.unbounded<{ readonly id: number; readonly result: unknown }>();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const send = (value: unknown) => Queue.offer(output, encoder.encode(encode(value) + "\n"));
  const methods: string[] = [];
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const bindPeer = vi.fn();
  const modelProvider = options.managed || options.workflow ? "launchpad_vm" : "openai";
  const model = options.managed || options.workflow ? "gpt-6-astra" : "gpt-5.3-codex";
  let admitted = true,
    controlStops = 0,
    nativeStops = 0,
    processOnly = false,
    groupId = "";
  const end = Queue.end(output).pipe(
    Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
    Effect.asVoid,
  );
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
      let result: unknown;
      if (command.args[0] === "provider-identity")
        result = {
          bootId,
          groupId,
          pid: options.invalidIdentity ? 43 : 42,
          startTicks: "1234",
          executableSha256: "a".repeat(64),
        };
      else {
        NodeAssert.equal(command.args[0], "stop-idle-provider");
        controlStops++;
        yield* Queue.offer(stopRequested, undefined);
        result = { admitted };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(100),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(
            command.args[0] === "provider-identity" ? (options.identityExitCode ?? 0) : 0,
          ),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(encode(result))),
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
    ...(options.workflow
      ? {
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
  return {
    runtime,
    send,
    end,
    stopRequested,
    responses,
    methods,
    requests,
    bindPeer,
    get processOnly() {
      return processOnly;
    },
    get stops() {
      return controlStops;
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
  it.effect("holds uncertain stop admission and permits only the same operation to reconcile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        NodeAssert.equal(
          (yield* Effect.result(
            f.runtime.closeIdleVmHarness!("uncertain", () => Effect.fail(new VmWorkloadError())),
          ))._tag,
          "Failure",
        );
        NodeAssert.equal(
          yield* f.runtime.closeIdleVmHarness!("different", (signal) => signal),
          false,
        );
        NodeAssert.equal((yield* Effect.result(f.runtime.compactThread()))._tag, "Failure");
        const stopped = yield* f.runtime.closeIdleVmHarness!("uncertain", (signal) => signal).pipe(
          Effect.forkScoped,
        );
        yield* Queue.take(f.stopRequested);
        yield* f.end;
        NodeAssert.equal(yield* Fiber.join(stopped), true);
        NodeAssert.equal(f.stops, 1);
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
