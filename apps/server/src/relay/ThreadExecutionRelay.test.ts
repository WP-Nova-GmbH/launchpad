import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { CheckoutAdmission, makeCheckoutCapture } from "../persistence/CheckoutCapture.ts";
import { makeProviderExecution } from "../provider/ProviderExecution.ts";
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
const bindThread = Effect.fnUntraced(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES('project','Project','/workspace/project','[]','2026-10-05T10:00:00.000Z','2026-10-05T10:00:00.000Z')`;
  yield* sql`INSERT OR IGNORE INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES(${threadId},'project','Thread','{"instanceId":"codex","model":"gpt-5"}','full-access','default','2026-10-05T10:00:00.000Z','2026-10-05T10:00:00.000Z')`;
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fence = makeThreadExecutionFence(sql);
  yield* bindThread("thread");
  yield* bindThread("ordinary");
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
  it.effect.each(["thread", "ordinary"] as const)(
    "keeps a held rejected reply retryable until %s admits another invocation",
    (threadId) =>
      Effect.gen(function* () {
        const { sql, authority } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, authority);
        const admit = makeProviderExecution(relay);
        const invocation = yield* admit(threadId, "approval", "held-retry");
        yield* invocation.reject;
        const capture = makeCheckoutCapture(sql);
        const owner = { ...enrollment, operationId: "held-rejected-reply" };
        yield* capture.acquireDrain({
          ...owner,
          checkoutRoot: "/workspace/project",
          gitCommonRoot: "/workspace/project",
        });
        const held = yield* Effect.flip(admit(threadId, "approval", "held-retry"));
        assert.isTrue(held.waitingForCheckout);
        assert.isFalse(held.uncertain);
        yield* capture.release(owner, { outcome: "cancelled" });
        yield* admit(threadId, "approval", "held-retry");
        const pending = yield* Effect.flip(admit(threadId, "approval", "held-retry"));
        assert.isTrue(pending.uncertain);
        assert.isTrue(
          yield* relay.wasStarted({ threadId, kind: "provider", workId: "approval:held-retry" }),
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect.each(["thread", "ordinary"] as const)(
    "retries only a rejected provider invocation for %s",
    (threadId) =>
      Effect.gen(function* () {
        const { sql, authority } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, authority);
        const input = { threadId, kind: "provider" as const, workId: "approval:retry" };
        assert.equal(yield* relay.begin(input), threadId === "ordinary" ? "ordinary" : "start");
        yield* relay.rejectInvocation(input);
        const restarted = makeThreadExecutionRelay(sql, authority);
        assert.equal(yield* restarted.begin(input), threadId === "ordinary" ? "ordinary" : "start");
        yield* restarted.rejectInvocation(input);
        const capture = makeCheckoutCapture(sql);
        const owner = { ...enrollment, operationId: "reject-retry-capture" };
        yield* capture.acquireDrain({
          ...owner,
          checkoutRoot: "/workspace/project",
          gitCommonRoot: "/workspace/project",
        });
        assert.propertyVal(yield* Effect.flip(restarted.begin(input)), "waitingForCheckout", true);
        yield* capture.release(owner, { outcome: "cancelled" });
        yield* restarted.begin(input);
        yield* restarted.completeInvocation(input);
        assert.equal(
          yield* restarted.begin(input),
          threadId === "ordinary" ? "completed" : "reconcile",
        );
        assert.equal(
          (yield* restarted.lookupAdmission(threadId, input.workId, input.kind))?.rejected,
          0,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect.each(["uncertain", "completed"] as const)(
    "never replays an ordinary %s operation after portable enrollment",
    (state) =>
      Effect.gen(function* () {
        const { sql, fence, authority, remote } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, authority);
        const ordinary = {
          threadId: "ordinary",
          kind: "terminal" as const,
          workId: "ordinary-spawn",
        };
        assert.equal(yield* relay.begin(ordinary), "ordinary");
        if (state === "completed") yield* relay.confirmOrdinaryStopped(ordinary);
        const owner = { ...enrollment, threadId: "ordinary", operationId: "ordinary-enrollment" };
        yield* fence.prepare(owner);
        yield* fence.activate(owner);
        assert.equal(
          yield* relay.begin(ordinary),
          state === "completed" ? "completed" : "reconcile",
        );
        assert.equal(remote.size, 0);
        assert.deepEqual(
          yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id='ordinary'`,
          [],
        );
        assert.propertyVal(
          (yield* relay.lookupAdmission("ordinary", ordinary.workId, "terminal"))!,
          "completed",
          state === "completed" ? 1 : 0,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("settles an ordinary PTY after enrollment without completing portable work", () =>
    Effect.gen(function* () {
      const { sql, fence, authority } = yield* fixture;
      const relay = makeThreadExecutionRelay(sql, authority);
      const ordinary = {
        threadId: "ordinary",
        kind: "terminal" as const,
        workId: "ordinary-terminal",
      };
      yield* relay.begin(ordinary);
      yield* fence.prepare({ ...enrollment, threadId: "ordinary", operationId: "new-enrollment" });
      yield* relay.confirmOrdinaryStopped(ordinary);
      assert.propertyVal(
        (yield* relay.lookupAdmission("ordinary", ordinary.workId, "terminal"))!,
        "completed",
        1,
      );
      const portable = { ...work, kind: "terminal" as const };
      yield* relay.begin(portable);
      assert.equal(
        (yield* Effect.flip(relay.confirmOrdinaryStopped(portable)))._tag,
        "ThreadExecutionFenceError",
      );
      assert.propertyVal(
        (yield* relay.lookupAdmission("thread", portable.workId, "terminal"))!,
        "completed",
        0,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
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
      yield* bindThread("thread");
      yield* bindThread("other");
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
  it.effect("durably drains ordinary siblings and lets inherited turns finish", () =>
    Effect.gen(function* () {
      const { sql, authority } = yield* fixture;
      const relay = makeThreadExecutionRelay(sql, authority);
      const capture = makeCheckoutCapture(sql);
      const ordinary = { ...work, threadId: "ordinary", workId: "request" };
      assert.equal(yield* relay.begin(ordinary), "ordinary");
      assert.equal(yield* makeThreadExecutionRelay(sql, authority).begin(ordinary), "reconcile");
      const parent = yield* relay.lookupAdmission(
        ordinary.threadId,
        ordinary.workId,
        ordinary.kind,
      );
      assert.isNotNull(parent);
      const captureOwner = { ...enrollment, operationId: "capture" };
      const scope = { checkoutRoot: "/workspace/project", gitCommonRoot: "/workspace/project" };
      yield* capture.acquireDrain({ ...captureOwner, ...scope });
      assert.equal(
        (yield* Effect.flip(relay.begin({ ...ordinary, workId: "new" })))._tag,
        "CheckoutCaptureError",
      );
      const child = { ...ordinary, workId: "send" };
      assert.equal(
        yield* relay
          .begin(child)
          .pipe(Effect.provideService(CheckoutAdmission, parent!.admissionId)),
        "ordinary",
      );
      yield* relay.bindTurn(child, "turn");
      yield* relay.completeInvocation(child);
      assert.lengthOf(yield* capture.blockers(scope), 2);
      yield* relay.completeTurn("ordinary", "turn");
      assert.lengthOf(yield* capture.blockers(scope), 0);
      yield* capture.enterCapturing(captureOwner);
      assert.equal(
        (yield* Effect.flip(relay.assertAccepting("ordinary")))._tag,
        "CheckoutCaptureError",
      );
      yield* capture.release(captureOwner, { outcome: "sealed", manifestSha256: "a".repeat(64) });
      assert.equal(yield* relay.begin({ ...ordinary, workId: "next" }), "ordinary");
      assert.equal(
        (yield* Effect.flip(relay.begin({ ...ordinary, threadId: "unknown" })))._tag,
        "ThreadExecutionFenceError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("lets admitted ordinary and portable terminals finish during checkout drain", () =>
    Effect.gen(function* () {
      const { sql, authority } = yield* fixture;
      const relay = makeThreadExecutionRelay(sql, authority);
      const capture = makeCheckoutCapture(sql);
      const scope = { checkoutRoot: "/workspace/project", gitCommonRoot: "/workspace/project" };
      const owner = { ...enrollment, operationId: "capture" };
      const portable = { ...work, kind: "terminal" as const, workId: "portable-shell" };
      const ordinary = { ...portable, threadId: "ordinary", workId: "ordinary-shell" };
      yield* relay.begin(portable);
      yield* relay.begin(ordinary);
      yield* capture.acquireDrain({ ...owner, ...scope });
      assert.lengthOf(yield* capture.blockers(scope), 2);
      assert.equal(
        yield* relay.withActiveWork(portable, Effect.succeed("portable input")),
        "portable input",
      );
      assert.equal(
        yield* relay.withActiveWork(ordinary, Effect.succeed("ordinary input")),
        "ordinary input",
      );
      assert.equal(
        (yield* Effect.flip(relay.begin({ ...portable, workId: "late-shell" })))._tag,
        "CheckoutCaptureError",
      );
      yield* relay.confirmStopped(portable);
      yield* relay.confirmStopped(ordinary);
      yield* capture.enterCapturing(owner);
      for (const terminal of [portable, ordinary]) {
        assert.equal(
          (yield* Effect.flip(relay.withActiveWork(terminal, Effect.succeed("unexpected input"))))
            ._tag,
          "ThreadExecutionFenceError",
        );
      }
      assert.equal(
        (yield* Effect.flip(relay.assertAccepting("thread")))._tag,
        "CheckoutCaptureError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "settles idle portable provider invocations without completing their ownership lease",
    () =>
      Effect.gen(function* () {
        const { sql, fence, authority } = yield* fixture;
        const relay = makeThreadExecutionRelay(sql, authority);
        const capture = makeCheckoutCapture(sql);
        const idle = { ...work, workId: "start-session" };
        yield* relay.begin(idle);
        yield* relay.completeInvocation(idle);
        assert.equal(
          (yield* relay.lookupAdmission(idle.threadId, idle.workId, idle.kind))?.completed,
          1,
        );
        assert.equal(
          (yield* fence.getWork({ ...idle, workId: "provider:start-session", generation: 1 }))
            ?.completed,
          0,
        );
        yield* relay.begin(work);
        yield* relay.bindTurn(work, "turn");
        yield* relay.completeInvocation(work);
        assert.equal(
          (yield* relay.lookupAdmission(work.threadId, work.workId, work.kind))?.completed,
          0,
        );
        yield* relay.completeTurn(work.threadId, "turn");
        assert.lengthOf(
          yield* capture.blockers({
            checkoutRoot: "/workspace/project",
            gitCommonRoot: "/workspace/project",
          }),
          0,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
