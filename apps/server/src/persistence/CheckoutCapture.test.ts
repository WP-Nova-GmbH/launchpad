import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeCheckoutCapture } from "./CheckoutCapture.ts";
import { runMigrations } from "./Migrations.ts";

const source = { checkoutRoot: "/workspace/source", gitCommonRoot: "/workspace/repository/.git" };
const owner = { operationId: "move", threadId: "moving", environmentId: "source", generation: 1 };
const request = { ...source, threadId: "sibling", workId: "request", kind: "provider" as const };

describe("durable checkout capture admission", () => {
  it.effect("inherits file subpaths without granting ancestors or another checkout", () =>
    Effect.gen(function* () {
      const capture = makeCheckoutCapture(yield* SqlClient.SqlClient);
      const parent = yield* capture.admit(request);
      yield* capture.acquireDrain({ ...owner, ...source });
      yield* capture.assertAccepting(
        { ...source, checkoutRoot: `${source.checkoutRoot}/new/file` },
        { parentAdmissionId: parent.admissionId },
      );
      for (const checkoutRoot of ["/workspace", "/workspace/sibling"])
        assert.equal(
          (yield* Effect.flip(
            capture.assertAccepting(
              { ...source, checkoutRoot },
              { parentAdmissionId: parent.admissionId },
            ),
          ))._tag,
          "CheckoutCaptureError",
        );
      yield* capture.complete(parent.admissionId);
      assert.equal(
        (yield* Effect.flip(
          capture.assertAccepting(
            { ...source, checkoutRoot: `${source.checkoutRoot}/new/file` },
            { parentAdmissionId: parent.admissionId },
          ),
        ))._tag,
        "CheckoutCaptureError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("waits for sibling worktree Git metadata but permits its file writers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capture = makeCheckoutCapture(sql);
      yield* capture.acquireDrain({ ...owner, ...source });
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('sibling-file','write-file'),('sibling-git','vcs')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES
        ('sibling-file','/workspace/other/file'),('sibling-git','/workspace/other'),('sibling-git',${source.gitCommonRoot})`;
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(owner)),
        "waitingForCheckout",
        true,
      );
      yield* sql`DELETE FROM checkout_operations WHERE operation_id='sibling-git'`;
      yield* capture.enterCapturing(owner);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM checkout_operations WHERE operation_id='sibling-file'`,
        1,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("drains inherited work, seals once, and releases siblings without recapturing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capture = makeCheckoutCapture(sql);
      const parent = yield* capture.admit(request);
      yield* capture.acquireDrain({ ...owner, ...source });
      assert.propertyVal(
        yield* Effect.flip(capture.admit({ ...request, workId: "new" })),
        "waitingForCheckout",
        true,
      );
      const child = yield* capture.admit({
        ...request,
        workId: "setup",
        kind: "setup",
        parentAdmissionId: parent.admissionId,
      });
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(owner)),
        "waitingForCheckout",
        true,
      );
      yield* capture.bindTurn(parent.admissionId, "turn");
      yield* capture.completeTurn(request.threadId, "turn");
      assert.lengthOf(yield* capture.blockers(source), 1);
      assert.propertyVal(
        yield* Effect.flip(
          capture.admit({
            ...request,
            workId: "late-child",
            parentAdmissionId: parent.admissionId,
          }),
        ),
        "waitingForCheckout",
        false,
      );
      yield* capture.complete(child.admissionId);
      yield* capture.enterCapturing(owner);
      assert.equal(
        (yield* Effect.flip(
          capture.assertAccepting(source, { parentAdmissionId: child.admissionId }),
        ))._tag,
        "CheckoutCaptureError",
      );
      const sealed = { outcome: "sealed" as const, manifestSha256: "a".repeat(64) };
      yield* capture.release(owner, sealed);
      const restarted = makeCheckoutCapture(sql);
      assert.equal(
        (yield* restarted.acquireDrain({ ...owner, ...source })).releaseOutcome,
        "sealed",
      );
      yield* restarted.release(owner, sealed);
      assert.equal(
        (yield* restarted.admit({ ...request, workId: "after-seal" })).decision,
        "start",
      );
      assert.equal(
        (yield* Effect.flip(restarted.release(owner, { outcome: "failed" })))._tag,
        "CheckoutCaptureError",
      );
      assert.equal(
        (yield* Effect.flip(restarted.release({ ...owner, generation: 2 }, sealed)))._tag,
        "CheckoutCaptureError",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("permits other worktree file work and serializes shared Git capture", () =>
    Effect.gen(function* () {
      const capture = makeCheckoutCapture(yield* SqlClient.SqlClient);
      const other = { ...source, checkoutRoot: "/workspace/other" };
      const second = { ...owner, operationId: "second", threadId: "second" };
      yield* capture.acquireDrain({ ...owner, ...source });
      yield* capture.enterCapturing(owner);
      const separate = yield* capture.admit({ ...request, ...other });
      assert.equal(separate.decision, "start");
      yield* capture.acquireDrain({ ...second, ...other });
      assert.propertyVal(
        yield* Effect.flip(capture.assertAccepting(other, { repository: true })),
        "waitingForCheckout",
        true,
      );
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(second)),
        "waitingForCheckout",
        true,
      );
      yield* capture.release(owner, { outcome: "sealed", manifestSha256: "b".repeat(64) });
      yield* capture.complete(separate.admissionId);
      yield* capture.enterCapturing(second);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "retains uncertain starts and distinguishes failed retries from cancelled captures",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const capture = makeCheckoutCapture(sql);
        const admitted = yield* capture.admit({ ...request, kind: "terminal" });
        assert.equal(
          (yield* makeCheckoutCapture(sql).admit({ ...request, kind: "terminal" })).decision,
          "reconcile",
        );
        yield* capture.acquireDrain({ ...owner, ...source });
        assert.lengthOf(yield* makeCheckoutCapture(sql).blockers(source), 1);
        yield* capture.release(owner, { outcome: "failed" });
        yield* capture.acquireDrain({ ...owner, ...source });
        yield* capture.complete(admitted.admissionId);
        yield* capture.enterCapturing(owner);
        yield* capture.release(owner, { outcome: "failed", expectedPhase: "capturing" });
        yield* capture.acquireDrain({ ...owner, ...source });
        yield* capture.release(owner, { outcome: "cancelled" });
        assert.equal(
          (yield* Effect.flip(capture.acquireDrain({ ...owner, ...source })))._tag,
          "CheckoutCaptureError",
        );
        const next = { ...owner, operationId: "next" };
        yield* capture.acquireDrain({ ...next, ...source });
        assert.propertyVal(
          yield* Effect.flip(capture.acquireDrain({ ...owner, operationId: "racing", ...source })),
          "waitingForCheckout",
          true,
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("retains a capture when a stale draining cancellation or failure races its start", () =>
    Effect.gen(function* () {
      const capture = makeCheckoutCapture(yield* SqlClient.SqlClient);
      yield* capture.acquireDrain({ ...owner, ...source });
      assert.equal((yield* capture.get(owner.operationId))?.phase, "draining");
      yield* capture.enterCapturing(owner);
      for (const outcome of ["cancelled", "failed"] as const) {
        assert.propertyVal(
          yield* Effect.flip(capture.release(owner, { outcome })),
          "message",
          "The checkout capture phase changed before release.",
        );
        assert.equal((yield* capture.get(owner.operationId))?.phase, "capturing");
      }
      assert.propertyVal(
        yield* Effect.flip(capture.assertAccepting(source)),
        "waitingForCheckout",
        true,
      );
      yield* capture.release(owner, { outcome: "failed", expectedPhase: "capturing" });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("waits for projected blockers and actual checkout operations before capture", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capture = makeCheckoutCapture(sql);
      yield* capture.acquireDrain({ ...owner, ...source });
      yield* Effect.flip(
        capture.enterCapturing(owner, { additionalBlockers: ["turn still running"] }),
      );
      yield* sql`INSERT INTO checkout_operations(operation_id,kind) VALUES('git','vcs')`;
      yield* sql`INSERT INTO checkout_operation_paths(operation_id,path) VALUES('git',${source.checkoutRoot})`;
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(owner)),
        "waitingForCheckout",
        true,
      );
      yield* sql`DELETE FROM checkout_operations WHERE operation_id='git'`;
      yield* capture.enterCapturing(owner);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("binds a provider invocation and its parent through final checkpoint completion", () =>
    Effect.gen(function* () {
      const capture = makeCheckoutCapture(yield* SqlClient.SqlClient);
      const parent = yield* capture.admit(request);
      const child = yield* capture.admit({
        ...request,
        workId: "send",
        parentAdmissionId: parent.admissionId,
      });
      yield* capture.bindTurn(child.admissionId, "turn");
      const pendingResponse = yield* capture.admit({
        ...request,
        workId: "approval-awaiting-ack",
        parentAdmissionId: parent.admissionId,
      });
      assert.equal(yield* capture.activeAdmission(request.threadId, "turn"), parent.admissionId);
      assert.equal(
        (yield* Effect.flip(capture.bindTurn(child.admissionId, "other")))._tag,
        "CheckoutCaptureError",
      );
      yield* capture.completeTurn(request.threadId, "turn");
      assert.equal(yield* capture.activeAdmission(request.threadId, "turn"), undefined);
      assert.deepEqual(
        (yield* capture.blockers(source)).map((row) => row.admissionId),
        [pendingResponse.admissionId],
      );
      yield* capture.acquireDrain({ ...owner, ...source });
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(owner)),
        "waitingForCheckout",
        true,
      );
      yield* capture.complete(pendingResponse.admissionId);
      yield* capture.enterCapturing(owner);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("binds every provider ancestor without binding an uncertain sibling", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capture = makeCheckoutCapture(sql);
      const original = yield* capture.admit(request);
      const replay = yield* capture.admit({
        ...request,
        workId: "replayed-request",
        parentAdmissionId: original.admissionId,
      });
      const native = yield* capture.admit({
        ...request,
        workId: "native-send",
        parentAdmissionId: replay.admissionId,
      });
      const uncertain = yield* capture.admit({
        ...request,
        workId: "unacknowledged-approval",
        parentAdmissionId: replay.admissionId,
      });
      yield* capture.acquireDrain({ ...owner, ...source });
      const recovered = makeCheckoutCapture(sql);
      yield* recovered.bindTurn(native.admissionId, "turn");
      for (const ancestor of [original, replay, native])
        assert.equal((yield* recovered.getAdmission(ancestor.admissionId))?.turnId, "turn");
      assert.equal((yield* recovered.getAdmission(uncertain.admissionId))?.turnId, null);
      assert.equal(
        (yield* Effect.flip(recovered.bindTurn(uncertain.admissionId, "other-turn")))._tag,
        "CheckoutCaptureError",
      );
      yield* recovered.completeTurn(request.threadId, "turn");
      assert.deepEqual(
        (yield* recovered.blockers(source)).map((row) => row.admissionId),
        [uncertain.admissionId],
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("settles only unbound request starts while preserving native writer evidence", () =>
    Effect.gen(function* () {
      const capture = makeCheckoutCapture(yield* SqlClient.SqlClient);
      const queued = yield* capture.admit({ ...request, workId: "request:queued" });
      const bound = yield* capture.admit({ ...request, workId: "request:bound" });
      yield* capture.bindTurn(bound.admissionId, "running-turn");
      const uncertain = yield* capture.admit({ ...request, workId: "send-turn:unknown" });
      const terminal = yield* capture.admit({
        ...request,
        kind: "terminal",
        workId: "request:terminal",
      });
      for (const admission of [queued, bound, uncertain, terminal])
        yield* capture.completeUnboundRequest(admission.admissionId);
      assert.equal((yield* capture.getAdmission(queued.admissionId))?.completed, 1);
      assert.deepEqual(
        (yield* capture.blockers(source)).map((row) => row.admissionId),
        [bound.admissionId, uncertain.admissionId, terminal.admissionId],
      );
      yield* capture.acquireDrain({ ...owner, ...source });
      assert.propertyVal(
        yield* Effect.flip(capture.enterCapturing(owner)),
        "waitingForCheckout",
        true,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "reconciles late steer acknowledgements from an exact durable turn finalization receipt",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const capture = makeCheckoutCapture(sql);
        const parent = yield* capture.admit(request);
        const send = yield* capture.admit({
          ...request,
          workId: "late-steer",
          parentAdmissionId: parent.admissionId,
        });
        const unknown = yield* capture.admit({
          ...request,
          workId: "unknown-approval",
          parentAdmissionId: parent.admissionId,
        });
        yield* capture.bindTurn(send.admissionId, "turn");
        assert.equal((yield* capture.getAdmission(send.admissionId))?.completed, 0);
        yield* capture.complete(send.admissionId);
        yield* capture.complete(parent.admissionId);
        const beforeReceipt = yield* capture.admit({ ...request, workId: "before-finalization" });
        yield* capture.bindTurn(beforeReceipt.admissionId, "turn");
        assert.equal((yield* capture.getAdmission(beforeReceipt.admissionId))?.completed, 0);
        yield* capture.completeTurn(request.threadId, "turn");
        const lateParent = yield* capture.admit({ ...request, workId: "late-request" });
        const lateSend = yield* capture.admit({
          ...request,
          workId: "late-send",
          parentAdmissionId: lateParent.admissionId,
        });
        yield* capture.acquireDrain({ ...owner, ...source });
        yield* makeCheckoutCapture(sql).bindTurn(lateSend.admissionId, "turn");
        assert.equal((yield* capture.getAdmission(lateParent.admissionId))?.completed, 1);
        assert.equal((yield* capture.getAdmission(lateSend.admissionId))?.completed, 1);
        assert.equal((yield* capture.getAdmission(lateSend.admissionId))?.turnFinalized, 1);
        assert.deepEqual(
          (yield* capture.blockers(source)).map((row) => row.admissionId),
          [unknown.admissionId],
        );
        yield* capture.complete(unknown.admissionId);
        yield* capture.enterCapturing(owner);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("keeps older ownership triggers from downgrading the checkout reader barrier", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* makeCheckoutCapture(sql).admit(request);
      yield* sql`UPDATE effect_sql_migrations SET name='OrchestrationEvents_PortableThreadReaderV1' WHERE migration_id=1`;
      const [marker] = yield* sql<{
        name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id=1`;
      assert.equal(marker?.name, "OrchestrationEvents_CheckoutCaptureReaderV1");
      assert.lengthOf(yield* runMigrations(), 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
