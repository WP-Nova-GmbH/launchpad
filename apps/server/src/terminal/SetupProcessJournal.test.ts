import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SetupProcessAdapter, SetupProcessError } from "./SetupProcessAdapter.ts";
import * as Journal from "./SetupProcessJournal.ts";

const attempt = { threadId: "thread", attemptId: "attempt" };
const owned = { ...attempt, terminalId: "setup-attempt" };
const cleanup = { ...attempt, commandId: "stop-1" };
const harness = Effect.gen(function* () {
  const identity = yield* Ref.make<string | null>("original-birth");
  const boot = yield* Ref.make<{ host: string; session: string } | null>({
    host: "host-1",
    session: "boot-1",
  });
  const fail = yield* Ref.make(false);
  const inspectFail = yield* Ref.make(false);
  const stops = yield* Ref.make(0);
  const signals = yield* Ref.make<ReadonlyArray<string>>([]);
  const newJournal = () =>
    Effect.service(Journal.SetupProcessJournal).pipe(
      Effect.provide(
        Journal.layer.pipe(
          Layer.provide(
            Layer.mock(SetupProcessAdapter, {
              launcher: Effect.succeed("/native/helper"),
              arm: () => Effect.succeed("/bin/sh"),
              host: Ref.get(boot),
              inspect: () =>
                Effect.gen(function* () {
                  if (yield* Ref.get(inspectFail))
                    return yield* new SetupProcessError({ message: "Access denied" });
                  return {
                    protocol: 4 as const,
                    identity: yield* Ref.get(identity),
                    owned: true,
                    fullStop: false,
                    boot: yield* Ref.get(boot),
                  };
                }),
              stop: (_pid, birth) =>
                Effect.gen(function* () {
                  if ((yield* Ref.get(identity)) !== birth)
                    return yield* new SetupProcessError({ message: "Ownership lost" });
                  yield* Ref.update(stops, (n) => n + 1);
                  if (yield* Ref.get(fail))
                    return yield* new SetupProcessError({ message: "Termination denied" });
                  yield* Ref.update(signals, (all) => [...all, birth]);
                  yield* Ref.set(identity, null);
                }),
            }),
          ),
        ),
      ),
    );
  return { identity, boot, fail, inspectFail, stops, signals, newJournal };
});

it.effect.each(["surviving", "absent", "reused"] as const)(
  "a fresh manager confirms the original process after restart: %s",
  (state) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* h.newJournal();
      yield* first.begin(owned);
      yield* first.capture({ ...attempt, pid: 42 });
      if (state !== "surviving")
        yield* Ref.set(h.identity, state === "absent" ? null : "reused-birth");
      const fresh = yield* h.newJournal();
      if (state === "surviving") yield* fresh.recover(attempt);
      else yield* Effect.flip(fresh.recover(attempt));
      assert.deepStrictEqual(
        yield* Ref.get(h.signals),
        state === "surviving" ? ["original-birth"] : [],
      );
      if (state === "surviving") yield* fresh.cleanup(cleanup);
      else yield* Effect.flip(fresh.cleanup(cleanup));
      assert.strictEqual(yield* Ref.get(h.identity), state === "reused" ? "reused-birth" : null);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "failed Stop and duplicate events make one physical attempt; a fresh Stop can retry",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const journal = yield* h.newJournal();
      yield* journal.begin(owned);
      yield* journal.capture({ ...attempt, pid: 42 });
      yield* Ref.set(h.fail, true);
      assert.include((yield* Effect.flip(journal.cleanup(cleanup))).message, "Termination denied");
      yield* Ref.set(h.fail, false);
      yield* Effect.flip(journal.cleanup(cleanup));
      assert.strictEqual(yield* Ref.get(h.stops), 1);
      const fresh = yield* h.newJournal();
      yield* Effect.flip(fresh.recover(attempt)); // Restart cannot implicitly retry the failure.
      assert.strictEqual(yield* Ref.get(h.stops), 1);
      yield* fresh.cleanup({ ...cleanup, commandId: "stop-2" });
      assert.strictEqual(yield* Ref.get(h.stops), 2);
      yield* fresh.recover(attempt); // The older failure cannot undo the successful retry.
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("OS exit without durable proof stays unconfirmed after restart", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* journal.begin(owned);
    yield* journal.capture({ ...attempt, pid: 42 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO setup_process_cleanup (thread_id, attempt_id, command_id, state)
      VALUES ('thread', 'attempt', 'stop-1', 'pending')`;
    yield* Ref.set(h.identity, null); // OS exit happened, persistence acknowledgement did not.
    const fresh = yield* h.newJournal();
    yield* Effect.flip(fresh.recover(attempt));
    yield* Effect.flip(fresh.cleanup(cleanup));
    assert.deepStrictEqual(yield* Ref.get(h.signals), []);
    assert.deepStrictEqual(yield* sql`SELECT state FROM setup_process_cleanup`, [
      { state: "failed" },
    ]);
    yield* Effect.flip((yield* h.newJournal()).recover(attempt));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "identity/termination errors remain unconfirmed; missing birth needs a verified host restart",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const journal = yield* h.newJournal();
      yield* journal.begin(owned);
      yield* journal.capture({ ...attempt, pid: 42 });
      yield* Ref.set(h.inspectFail, true);
      // stop() errors cannot be converted into absence by an empty terminal manager.
      yield* Ref.set(h.fail, true);
      assert.include((yield* Effect.flip(journal.cleanup(cleanup))).message, "Termination denied");
      yield* Ref.set(h.inspectFail, false);
      const legacy = { threadId: "legacy", attemptId: "legacy-attempt" };
      assert.include(
        (yield* Effect.flip(journal.recover(legacy))).message,
        "Restart the executor host",
      );
      yield* Ref.set(h.boot, { host: "host-1", session: "boot-2" });
      yield* journal.cleanup({ ...legacy, commandId: "after-host-restart" });
      assert.deepStrictEqual(yield* Ref.get(h.signals), []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("legacy PTY and boolean done cannot prove cleanup; a later same-host boot can", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* Effect.flip(journal.recover(attempt));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE setup_processes SET record_json = json_set(record_json, '$.exited', json('true'))`;
    yield* sql`INSERT INTO setup_process_cleanup VALUES ('thread', 'attempt', 'stop-1', 'done', NULL)`;
    yield* Effect.flip(journal.cleanup(cleanup));
    assert.isFalse(yield* journal.confirmed(attempt));
    yield* Ref.set(h.boot, { host: "another-host", session: "boot-2" });
    yield* Effect.flip(journal.cleanup({ ...cleanup, commandId: "stop-2" }));
    yield* Ref.set(h.boot, { host: "host-1", session: "boot-2" });
    yield* journal.cleanup({ ...cleanup, commandId: "stop-3" });
    assert.isTrue(yield* journal.confirmed(attempt));
    assert.strictEqual(yield* Ref.get(h.stops), 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("launch intent without capture cannot replay a setup command", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* journal.begin(owned);
    yield* Ref.set(h.inspectFail, true);
    yield* Effect.flip(journal.capture({ ...attempt, pid: 42 }));
    yield* Effect.flip(journal.begin(owned));
    const fresh = yield* h.newJournal();
    yield* fresh.recover(attempt);
    assert.deepStrictEqual(yield* Ref.get(h.signals), []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("receipt write failure after OS stop retains uncertainty until verified reboot", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* journal.begin(owned);
    yield* journal.capture({ ...attempt, pid: 42 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_proof BEFORE UPDATE ON setup_processes
      WHEN json_extract(NEW.record_json, '$.evidence.protocol') = 4
      BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END`;
    assert.strictEqual((yield* Effect.flip(journal.cleanup(cleanup)))._tag, "SetupProcessError");
    assert.isFalse(yield* journal.confirmed(attempt));
    yield* sql`DROP TRIGGER reject_proof`;
    yield* Effect.flip((yield* h.newJournal()).cleanup({ ...cleanup, commandId: "stop-2" }));
    yield* Ref.set(h.boot, { host: "host-1", session: "boot-2" });
    yield* (yield* h.newJournal()).cleanup({ ...cleanup, commandId: "stop-3" });
    const stops = yield* Ref.get(h.stops);
    yield* (yield* h.newJournal()).recover(attempt);
    assert.strictEqual(yield* Ref.get(h.stops), stops);
    assert.isTrue(yield* journal.confirmed(attempt));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect.each(["same-boot-clock-jump", "unavailable"] as const)(
  "uncertain boot evidence cannot recover: %s",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      if (mode === "unavailable") yield* Ref.set(h.boot, null);
      const journal = yield* h.newJournal();
      yield* journal.begin(owned);
      yield* journal.capture({ ...attempt, pid: 42 });
      yield* Ref.set(h.identity, null);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE setup_processes SET record_json = json_set(record_json, '$.createdAt', '1900-01-01T00:00:00Z')`;
      const error = yield* Effect.flip(journal.cleanup(cleanup));
      assert.include(
        error.message,
        mode === "unavailable" ? "unavailable on this host" : "Restart the executor host",
      );
      assert.isFalse(yield* journal.confirmed(attempt));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("failed recovery is durable and never implicitly retries a physical stop", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* journal.begin(owned);
    yield* journal.capture({ ...attempt, pid: 42 });
    yield* Ref.set(h.fail, true);
    yield* Effect.flip(journal.recover(attempt));
    yield* Ref.set(h.fail, false);
    yield* Effect.flip((yield* h.newJournal()).recover(attempt));
    assert.equal(yield* Ref.get(h.stops), 1);
    const proof = yield* journal.cleanup({ ...cleanup, commandId: "explicit-recovery-retry" });
    assert.equal(proof.identity, "original-birth");
    assert.equal(proof.source, "native");
    assert.deepStrictEqual(yield* journal.recover(attempt), proof);
    assert.equal(yield* Ref.get(h.stops), 2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("closing an uncaptured intent fences late capture before shell arming", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const journal = yield* h.newJournal();
    yield* journal.begin(owned);
    const proof = yield* journal.cleanup(cleanup);
    assert.equal(proof.source, "not-delivered");
    yield* Effect.flip(journal.capture({ ...attempt, pid: 42 }));
    assert.equal(yield* Ref.get(h.stops), 0);
    assert.deepStrictEqual(
      (yield* journal.owners("thread", "setup-attempt")).map((owner) => owner.attemptId),
      ["attempt"],
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "a captured attempt cannot adopt a different process or be launched again after cleanup",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const journal = yield* h.newJournal();
      yield* journal.begin(owned);
      yield* journal.capture({ ...attempt, pid: 42 });
      yield* Ref.set(h.identity, "replacement-birth");
      yield* Effect.flip(journal.capture({ ...attempt, pid: 43 }));
      yield* Effect.flip(journal.begin(owned));
      const [saved] = yield* journal.owners(attempt.threadId, owned.terminalId);
      assert.strictEqual(saved?.pid, 42);
      assert.strictEqual(saved?.identity, "original-birth");
      yield* Ref.set(h.identity, "original-birth");
      yield* journal.cleanup(cleanup);
      const fresh = yield* h.newJournal();
      yield* Effect.flip(fresh.begin(owned));
      yield* Effect.flip(fresh.capture({ ...attempt, pid: 43 }));
      assert.deepStrictEqual(yield* Ref.get(h.signals), ["original-birth"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
