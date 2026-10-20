import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import {
  makeThreadExecutionRelay,
  ThreadExecutionRelayError,
  type ThreadExecutionAuthority,
} from "./ThreadExecutionRelay.ts";

const enrollment = {
  threadId: "thread",
  projectId: "project",
  environmentId: "environment",
  relayUrl: "https://relay.test",
  generation: 1,
  operationId: "enroll",
};
const work = { threadId: "thread", workId: "turn-1", kind: "provider" as const };
const move = {
  threadId: "thread",
  generation: 1,
  operationId: "move",
  previousOperationId: "enroll",
};
const unavailable = (operation: "admit" | "complete") =>
  new ThreadExecutionRelayError({ threadId: "thread", operation, detail: "Relay unavailable" });
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fence = makeThreadExecutionFence(sql);
  yield* fence.prepare(enrollment);
  yield* fence.activate(enrollment);
  const remote = new Map<string, boolean>();
  const authority: ThreadExecutionAuthority = {
    admit: (input) =>
      Effect.sync(() => {
        const prior = remote.has(input.workId);
        if (!prior) remote.set(input.workId, false);
        return { completed: remote.get(input.workId)!, newlyAdmitted: !prior };
      }),
    complete: (input) =>
      Effect.sync(() => {
        assert.isTrue(remote.has(input.workId));
        remote.set(input.workId, true);
      }),
  };
  return { sql, fence, remote, authority };
});
describe("portable execution handshake", () => {
  it.effect("settles stopped provider admissions only after drain and retries lost receipts", () =>
    Effect.gen(function* () {
      const { sql, fence, remote, authority } = yield* fixture;
      const relay = makeThreadExecutionRelay(sql, authority);
      yield* relay.begin(work);
      yield* relay.begin({ ...work, workId: "start-session" });
      const terminal = { ...work, kind: "terminal" as const, workId: "closed" };
      const setup = { ...work, kind: "setup" as const, workId: "ready" };
      yield* relay.begin(terminal);
      yield* relay.begin(setup);
      const workspace = { ...work, kind: "workspace" as const, workId: "write" };
      yield* relay.begin(workspace);
      assert.equal(
        (yield* Effect.flip(relay.confirmProcessesStopped("thread", "provider")))._tag,
        "ThreadExecutionFenceError",
      );
      assert.deepEqual([...remote.values()], [false, false, false, false, false]);
      yield* fence.beginDrain(move);
      const offline = makeThreadExecutionRelay(sql, {
        ...authority,
        complete: () => Effect.fail(unavailable("complete")),
      });
      assert.equal(
        (yield* Effect.flip(offline.confirmProcessesStopped("thread", "provider")))._tag,
        "ThreadExecutionRelayError",
      );
      assert.lengthOf(yield* fence.pendingCompletionReports(), 1);
      yield* makeThreadExecutionRelay(sql, authority).confirmProcessesStopped("thread", "provider");
      assert.equal(remote.get("provider:turn-1"), true);
      assert.equal(remote.get("provider:start-session"), true);
      assert.equal(remote.get("terminal:closed"), false);
      assert.equal(remote.get("setup:ready"), false);
      assert.equal(
        (yield* Effect.flip(offline.confirmProcessesStopped("thread", "vm")))._tag,
        "ThreadExecutionRelayError",
      );
      assert.lengthOf(yield* fence.pendingCompletionReports(), 1);
      yield* makeThreadExecutionRelay(sql, authority).confirmProcessesStopped("thread", "vm");
      assert.equal(remote.get("terminal:closed"), true);
      assert.equal(remote.get("setup:ready"), true);
      assert.equal(remote.get("workspace:write"), false);
      assert.equal((yield* Effect.flip(fence.freeze(move)))._tag, "ThreadExecutionFenceError");
      yield* relay.confirmStopped(workspace);
      yield* fence.freeze(move);
      assert.lengthOf(yield* fence.pendingCompletionReports(), 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("blocks direct client writes after enrollment even while the owner is active", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = makeThreadExecutionFence(sql);
      yield* fence.assertDirectClientAllowed("thread");
      yield* fence.prepare(enrollment);
      yield* fence.activate(enrollment);
      assert.equal(
        (yield* Effect.flip(fence.assertDirectClientAllowed("thread"))).message,
        "Send this thread's commands through the relay inbox.",
      );
      yield* fence.assertDirectClientAllowed("ordinary");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "starts a remotely admitted work identity once across concurrent calls and service restart",
    () =>
      Effect.gen(function* () {
        const { sql, remote, authority } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, authority);
        const starts = yield* Effect.all(
          Array.from({ length: 12 }, () => relay.begin(work)),
          { concurrency: "unbounded" },
        );
        assert.equal(starts.filter((value) => value === "start").length, 1);
        assert.equal(starts.filter((value) => value === "reconcile").length, 11);
        assert.equal(remote.size, 1);
        assert.equal(yield* makeThreadExecutionRelay(sql, authority).begin(work), "reconcile");
        yield* relay.confirmStopped(work);
        assert.equal(yield* relay.begin(work), "completed");
        assert.equal(yield* relay.begin({ ...work, threadId: "ordinary" }), "ordinary");
        assert.equal(remote.size, 1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "recovers a lost admission response without mistaking a reservation for started work",
    () =>
      Effect.gen(function* () {
        const { sql, fence, authority } = yield* fixture;
        const lostReply = makeThreadExecutionRelay(sql, {
          ...authority,
          admit: (input) =>
            authority.admit(input).pipe(Effect.andThen(Effect.fail(unavailable("admit")))),
        });
        assert.equal((yield* Effect.flip(lostReply.begin(work)))._tag, "ThreadExecutionRelayError");
        assert.equal(
          (yield* fence.getWork({ ...work, workId: "provider:turn-1", generation: 1 }))?.started,
          0,
        );
        assert.equal(yield* makeThreadExecutionRelay(sql, authority).begin(work), "start");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "durably retains completion after relay loss and retries only the acknowledgement",
    () =>
      Effect.gen(function* () {
        const { sql, fence, remote, authority } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, {
          ...authority,
          complete: () => Effect.fail(unavailable("complete")),
        });
        assert.equal(yield* relay.begin(work), "start");
        assert.equal(
          (yield* Effect.flip(relay.confirmStopped(work)))._tag,
          "ThreadExecutionRelayError",
        );
        assert.equal(remote.get("provider:turn-1"), false);
        assert.lengthOf(yield* fence.pendingCompletionReports(), 1);
        yield* fence.beginDrain(move);
        yield* fence.freeze(move);
        assert.equal((yield* Effect.flip(fence.retire(move)))._tag, "ThreadExecutionFenceError");
        const restarted = makeThreadExecutionRelay(sql, authority);
        assert.equal(yield* restarted.begin(work), "completed");
        yield* restarted.flushCompletions();
        assert.equal(remote.get("provider:turn-1"), true);
        assert.lengthOf(yield* fence.pendingCompletionReports(), 0);
        yield* fence.retire(move);
        yield* restarted.flushCompletions();
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("lets a drain win an in-flight admission and proves that no tool started", () =>
    Effect.gen(function* () {
      const { sql, fence, remote, authority } = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const relay = makeThreadExecutionRelay(sql, {
        ...authority,
        admit: (input) =>
          Effect.gen(function* () {
            const result = yield* authority.admit(input);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return result;
          }),
      });
      const pending = yield* relay.begin(work).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* fence.beginDrain(move);
      assert.equal((yield* Effect.flip(fence.freeze(move)))._tag, "ThreadExecutionFenceError");
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(pending);
      assert.equal(outcome._tag, "Failure");
      const saved = yield* fence.getWork({ ...work, workId: "provider:turn-1", generation: 1 });
      assert.equal(saved?.started, 0);
      assert.equal(saved?.completed, 1);
      assert.equal(remote.get("provider:turn-1"), true);
      assert.equal(yield* fence.freeze(move), 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("refuses an old generation before reserving or completing work", () =>
    Effect.gen(function* () {
      const { sql, authority, remote } = yield* fixture;
      const relay = makeThreadExecutionRelay(sql, authority);
      const stale = { ...work, expectedGeneration: 2 };
      assert.equal((yield* Effect.flip(relay.begin(stale)))._tag, "ThreadExecutionFenceError");
      assert.equal(
        (yield* Effect.flip(relay.confirmStopped(stale)))._tag,
        "ThreadExecutionFenceError",
      );
      assert.equal(remote.size, 0);
      assert.equal(
        (yield* Effect.flip(relay.begin({ ...stale, threadId: "ordinary" })))._tag,
        "ThreadExecutionFenceError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("keeps an enrolled VM closed until its exact thread owner is activated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fence = makeThreadExecutionFence(sql);
      let admissions = 0;
      const authority: ThreadExecutionAuthority = {
        admit: () =>
          Effect.sync(() => {
            admissions++;
            return { completed: false, newlyAdmitted: true };
          }),
        complete: () => Effect.void,
      };
      const relay = makeThreadExecutionRelay(sql, authority, enrollment);
      assert.equal((yield* Effect.flip(relay.begin(work)))._tag, "ThreadExecutionFenceError");
      assert.equal(
        (yield* Effect.flip(relay.assertAccepting(work.threadId)))._tag,
        "ThreadExecutionFenceError",
      );
      yield* fence.prepare(enrollment);
      assert.equal((yield* Effect.flip(relay.begin(work)))._tag, "ThreadExecutionFenceError");
      yield* fence.activate(enrollment);
      assert.equal(yield* relay.begin(work), "start");
      yield* fence.prepare({ ...enrollment, threadId: "other" });
      yield* fence.activate({ ...enrollment, threadId: "other" });
      assert.equal(
        (yield* Effect.flip(relay.begin({ ...work, threadId: "other" })))._tag,
        "ThreadExecutionFenceError",
      );
      assert.equal(
        (yield* Effect.flip(relay.assertAccepting("other")))._tag,
        "ThreadExecutionFenceError",
      );
      const stale = makeThreadExecutionRelay(sql, authority, { ...enrollment, generation: 2 });
      assert.equal((yield* Effect.flip(stale.begin(work)))._tag, "ThreadExecutionFenceError");
      assert.equal(admissions, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
