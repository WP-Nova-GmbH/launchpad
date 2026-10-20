import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmResumeWorker } from "./ThreadVmResumeWorker.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmPauseRecoveryStore } from "./ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { finalSaveCatalogFixture as fixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const unavailable = () =>
  new ThreadVmComputeError({ operation: "inspect", message: "Unconfirmed native state" });
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const inspectPaused = (f: Fixture) => Effect.succeed({ ...f.info, state: "paused" as const });
const worker = (f: Fixture, inspect: typeof inspectPaused, supported = true) =>
  makeThreadVmLeaseWorker(f.sql, () => Effect.fail(unavailable()), f.hostId, {
    pausedSnapshotsSupported: Effect.succeed(supported),
    inspect: () => inspect(f),
  });
const state = Effect.fnUntraced(function* (f: Fixture) {
  const [row] = yield* f.sql`SELECT state,native_paused_generation FROM relay_thread_vm_allocations
    WHERE allocation_id=${f.input.allocationId}`;
  return row;
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "certified native VM timeout reconciliation (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "releases exact power capacity and resumes the same allocation without a fake pause",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const journal = makeThreadJournalStore(f.sql);
              const queued = yield* journal.stage({
                threadId: f.threadId,
                actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                command: {
                  type: "thread.queue.pause",
                  threadId: ThreadId.make(f.threadId),
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  createdAt: "2026-10-14T00:00:00Z",
                },
              });
              expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
              expect(yield* state(f)).toMatchObject({
                state: "paused",
                native_paused_generation: 1,
              });
              const capacity = makeThreadVmCapacityStore(f.sql);
              expect((yield* capacity.get(f.input.allocationId))?.state).toBe("released");
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_pauses WHERE allocation_id=${f.input.allocationId}`,
              ).toEqual([]);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE allocation_id=${f.input.allocationId}`,
              ).toEqual([]);
              const resumes = makeThreadVmResumeStore(f.sql);
              expect(yield* resumes.get(f.input.allocationId)).toBeNull();
              expect(yield* journal.next(f.owner)).toBeNull();
              const requested = yield* resumes.request(f.threadId);
              expect((yield* capacity.get(requested.operationId))?.state).toBe("waiting");
              let nativeState: "running" | "paused" = "paused";
              let wakes = 0,
                verifiedGates = 0;
              const resume = makeThreadVmResumeWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                  resume: () =>
                    Effect.sync(() => {
                      wakes++;
                      nativeState = "running";
                    }),
                },
                {
                  reopenAfterResume: (_sandbox, identity, pauseOperationId) =>
                    Effect.gen(function* () {
                      verifiedGates++;
                      expect(pauseOperationId).toBeNull();
                      expect(identity.scope.allocationId).toBe(f.input.allocationId);
                      expect(identity.scope.generation).toBe(1);
                      expect(yield* journal.next(f.owner)).toBeNull();
                    }).pipe(Effect.orDie),
                },
                f.hostId,
              );
              expect(yield* resume.runOne()).toBe(true);
              expect(wakes).toBe(1);
              expect(verifiedGates).toBe(1);
              expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
              expect(yield* state(f)).toMatchObject({
                state: "running",
                native_paused_generation: null,
              });
              expect((yield* capacity.get(requested.operationId))?.state).toBe("started");
              const [command] = yield* f.sql`SELECT receipt_json FROM relay_thread_commands
            WHERE command_id=${queued!.commandId}`;
              expect(command?.receipt_json).toBeNull();
              expect(yield* resume.runOne()).toBe(false);
            }),
          ),
      );

      it.effect(
        "a queued explicit continuation requests normal FIFO wake after certified power-off",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* makeThreadJournalStore(f.sql).stage({
                threadId: f.threadId,
                actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                command: {
                  type: "thread.queue.resume",
                  threadId: ThreadId.make(f.threadId),
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  expectedRevision: 0,
                  createdAt: "2026-10-14T00:00:00Z",
                },
              });
              expect(yield* worker(f, inspectPaused).runOne()).toBe(true);
              const requested = yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId);
              expect(requested?.phase).toBe("waiting");
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(requested!.operationId))?.state,
              ).toBe("waiting");
              expect(yield* state(f)).toMatchObject({ state: "paused" });
            }),
          ),
      );

      it.effect("a revoked binding during native resume cannot publish running readiness", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* worker(f, inspectPaused).runOne();
            const resumes = makeThreadVmResumeStore(f.sql);
            const requested = yield* resumes.request(f.threadId);
            let nativeState: "paused" | "running" = "paused";
            let wakes = 0;
            const resume = makeThreadVmResumeWorker(
              f.sql,
              {
                inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                resume: () =>
                  Effect.gen(function* () {
                    wakes++;
                    nativeState = "running";
                    yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now'
                WHERE credential_id=${f.credentialId}`;
                  }).pipe(Effect.orDie),
              },
              {
                reopenAfterResume: () => Effect.die("Revoked ownership cannot open its guest gate"),
              },
              f.hostId,
            );
            expect(yield* resume.runOne()).toBe(true);
            expect(wakes).toBe(1);
            expect(yield* state(f)).toMatchObject({ state: "paused", native_paused_generation: 1 });
            expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("resuming");
            expect(
              (yield* makeThreadVmCapacityStore(f.sql).get(requested.operationId))?.state,
            ).toBe("started");
          }),
        ),
      );

      for (const key of [
        "launchpad.managed",
        "launchpad.allocation_id",
        "launchpad.operation_id",
        "launchpad.thread_id",
        "launchpad.generation",
      ] as const) {
        it.effect(`does not reconcile a foreign ${key}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* worker(f, (current) =>
                Effect.succeed({
                  ...current.info,
                  state: "paused",
                  metadata: { ...current.info.metadata, [key]: "foreign" },
                }),
              ).runOne();
              expect(yield* state(f)).toMatchObject({
                state: "running",
                native_paused_generation: null,
              });
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
              ).toBe("started");
            }),
          ),
        );
      }
      for (const reason of ["HTTP409", "transient", "missing", "running", "unsupported"] as const) {
        it.effect(`keeps the source and capacity for ${reason}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const inspect =
                reason === "HTTP409" || reason === "transient"
                  ? () => Effect.fail(unavailable())
                  : reason === "missing"
                    ? () => Effect.succeed(null)
                    : reason === "running"
                      ? (current: Fixture) => Effect.succeed(current.info)
                      : inspectPaused;
              yield* makeThreadVmLeaseWorker(f.sql, () => Effect.fail(unavailable()), f.hostId, {
                pausedSnapshotsSupported: Effect.succeed(reason !== "unsupported"),
                inspect: () => inspect(f),
              }).runOne();
              expect(yield* state(f)).toMatchObject({
                state: "running",
                native_paused_generation: null,
              });
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
              ).toBe("started");
              expect(yield* makeThreadVmResumeStore(f.sql).get(f.input.allocationId)).toBeNull();
            }),
          ),
        );
      }

      for (const changed of ["generation", "move", "credential", "deleting"] as const) {
        it.effect(`discards a late native result after ${changed} changes`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const native = worker(f, (current) =>
                Effect.gen(function* () {
                  if (changed === "generation")
                    yield* current.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${current.threadId}`;
                  else if (changed === "move")
                    yield* current.sql`UPDATE relay_thread_placements SET operation_id=${NodeCrypto.randomUUID()} WHERE thread_id=${current.threadId}`;
                  else if (changed === "credential")
                    yield* current.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${current.credentialId}`;
                  else
                    yield* current.sql`UPDATE relay_thread_vm_allocations SET state='deleting' WHERE allocation_id=${current.input.allocationId}`;
                  return { ...current.info, state: "paused" as const };
                }).pipe(Effect.orDie),
              );
              yield* native.runOne();
              expect(yield* state(f)).toMatchObject({
                state: changed === "deleting" ? "deleting" : "running",
                native_paused_generation: null,
              });
              expect(
                (yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state,
              ).toBe("started");
            }),
          ),
        );
      }
      it.effect(
        "a native timeout cancels an uncertified pause and preserves its drain until resumed acknowledgement",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const journal = makeThreadJournalStore(f.sql);
              const queued = yield* journal.stage({
                threadId: f.threadId,
                actor: { userId: f.input.actorUserId, displayName: null, imageUrl: null },
                command: {
                  type: "thread.queue.pause",
                  threadId: ThreadId.make(f.threadId),
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  createdAt: "2026-10-14T00:00:00Z",
                },
              });
              const pauseOperationId = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase)
          VALUES(${f.input.allocationId},${pauseOperationId},1,'pending')`;
              yield* worker(f, inspectPaused).runOne();
              expect(yield* state(f)).toMatchObject({
                state: "paused",
                native_paused_generation: 1,
              });
              const recovery = makeThreadVmPauseRecoveryStore(f.sql, f.objects);
              expect(yield* recovery.get(f.owner)).toMatchObject({
                operationId: pauseOperationId,
                phase: "cancelled",
                sourceReopened: false,
                canActivate: false,
                nativeCheckpointOperationId: null,
              });
              expect(yield* journal.next(f.owner)).toBeNull();
              const resumes = makeThreadVmResumeStore(f.sql);
              yield* resumes.request(f.threadId);
              let nativeState: "paused" | "running" = "paused";
              const resume = makeThreadVmResumeWorker(
                f.sql,
                {
                  inspect: () => Effect.succeed({ ...f.info, state: nativeState }),
                  resume: () =>
                    Effect.sync(() => {
                      nativeState = "running";
                    }),
                },
                {
                  reopenAfterResume: (_sandbox, _identity, operationId) =>
                    Effect.sync(() => {
                      expect(operationId).toBe(pauseOperationId);
                    }),
                },
                f.hostId,
              );
              expect(yield* resume.runOne()).toBe(true);
              expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
              expect(yield* recovery.get(f.owner)).toMatchObject({
                operationId: pauseOperationId,
                phase: "cancelled",
                sourceReopened: false,
                canActivate: true,
                nativeCheckpointOperationId: null,
              });
              expect(yield* journal.next(f.owner)).toBeNull();
              yield* recovery.confirmActivation({ ...f.owner, operationId: pauseOperationId });
              expect((yield* journal.next(f.owner))?.commandId).toBe(queued!.commandId);
              expect((yield* recovery.get(f.owner))?.sourceReopened).toBe(true);
            }),
          ),
      );
      it.effect(
        "finishes an already retained pending pause when native timeout beats worker sealing",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("paused");
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_capacity SET state='started' WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_vm_pauses SET phase='pending' WHERE allocation_id=${f.input.allocationId}`;
              const pause = makeThreadVmPauseWorker(
                f.sql,
                {
                  pausedSnapshotsSupported: Effect.succeed(true),
                  inspect: () => Effect.succeed(f.info),
                  pause: () => Effect.die("The exact native execution is already stopped"),
                },
                {
                  seal: () => Effect.die("A stopped guest cannot seal again"),
                  reopen: () => Effect.die("A retained frozen source must not reopen"),
                },
                f.hostId,
              );
              expect(yield* pause.runOne()).toBe(true);
              expect(yield* state(f)).toMatchObject({
                state: "paused",
                native_paused_generation: null,
              });
              expect(
                (yield* makeThreadVmPauseRecoveryStore(f.sql, f.objects).get(f.owner))?.phase,
              ).toBe("completed");
            }),
          ),
      );
    });
  },
);
