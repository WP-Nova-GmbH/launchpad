import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { ThreadId } from "@t3tools/contracts";
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

const nativeId = "a88473a1-01d4-449a-8194-7d6544d3502d";
const bootId = "13835087-40ba-45c5-bde6-d0092298eaf5";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const packet = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Int),
      method: Schema.optionalKey(Schema.String),
    }),
  ),
);
const fixture = Effect.gen(function* () {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stopRequested = yield* Queue.unbounded<void>();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const send = (value: unknown) => Queue.offer(output, encoder.encode(encode(value) + "\n"));
  const methods: string[] = [];
  let admitted = true,
    controlStops = 0,
    processOnly = false,
    groupId = "";
  const end = Queue.end(output).pipe(
    Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
    Effect.asVoid,
  );
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Deferred.await(exited),
    isRunning: Effect.succeed(true),
    kill: () => end,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        const message = packet(decoder.decode(bytes));
        if (!message.method) return;
        methods.push(message.method);
        if (message.id === undefined) return;
        const result =
          message.method === "initialize"
            ? {
                userAgent: "public-test-peer",
                codexHome: "/tmp/public-test",
                platformFamily: "unix",
                platformOs: "linux",
              }
            : message.method === "thread/resume"
              ? { cwd: "/tmp/project", model: "gpt-5.3-codex", thread: { id: nativeId } }
              : message.method === "thread/read"
                ? {
                    thread: {
                      id: nativeId,
                      path: "/tmp/public-test/rollout.jsonl",
                      historyMode: "paginated",
                    },
                  }
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
        result = { bootId, groupId, pid: 42, startTicks: "1234", executableSha256: "a".repeat(64) };
      else {
        NodeAssert.equal(command.args[0], "stop-idle-provider");
        controlStops++;
        yield* Queue.offer(stopRequested, undefined);
        result = { admitted };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(100),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
    runtimeMode: "auto",
    resumeCursor: { threadId: nativeId },
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(VmControlSpawner, control),
    Effect.provideService(VmWorkloadTracking, true),
  );
  yield* runtime.start();
  return {
    runtime,
    send,
    end,
    stopRequested,
    methods,
    get processOnly() {
      return processOnly;
    },
    get stops() {
      return controlStops;
    },
    reject: () => {
      admitted = false;
    },
    accept: () => {
      admitted = true;
    },
  };
});

it.layer(NodeServices.layer)("owned idle Codex shutdown", (it) => {
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
          const drained = yield* Fiber.join(events);
          NodeAssert.ok(drained.some((event) => event.method === "item/agentMessage/delta"));
          NodeAssert.equal(drained.at(-1)?.method, "session/closed");
          NodeAssert.equal(
            yield* f.runtime.closeIdleVmHarness!("pause-1", (signal) => signal),
            true,
          );
          NodeAssert.equal(f.stops, 1);
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
