import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { makeThreadVmIdleDeletionWorker } from "./ThreadVmIdleDeletionWorker.ts";
import {
  makeThreadVmPolicyStore,
  idleDeadlines,
  writeThreadVmIdleDeadline,
} from "./ThreadVmPolicy.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";

const fixture = Effect.fnUntraced(function* (state: "running" | "paused" = "running") {
  const f = yield* finalSaveCatalogFixture(state),
    organizationId = NodeCrypto.randomUUID();
  yield* f.sql`UPDATE relay_thread_placements SET organization_id=${organizationId} WHERE thread_id=${f.threadId}`;
  yield* f.sql`UPDATE relay_thread_vm_allocations SET organization_id=${organizationId} WHERE allocation_id=${f.input.allocationId}`;
  const policies = makeThreadVmPolicyStore(f.sql),
    policy = yield* policies.get(organizationId);
  return {
    ...f,
    organizationId,
    policies,
    policy,
    worker: makeThreadVmIdleDeletionWorker(f.sql, f.objects, f.hostId),
  };
});
const deadlines = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const [row] = yield* f.sql<{
    deleteAt: string | null;
    pauseAt: string | null;
    witnessed: boolean;
    policyRevision: number | null;
    timeZone: string | null;
  }>`SELECT
    to_char(delete_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deleteAt",
    to_char(pause_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "pauseAt",
    (deadline_idle_since IS NOT DISTINCT FROM idle_since) AS witnessed,deadline_policy_revision AS "policyRevision",deadline_time_zone AS "timeZone"
    FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`;
  return row!;
});
const operation = Effect.fnUntraced(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const [row] = yield* f.sql<{
    operationId: string | null;
  }>`SELECT operation_id AS "operationId" FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
  return row?.operationId ? yield* f.store.get(row.operationId) : null;
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "automatic inactivity admission (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const action of ["pause", "idle-delete"] as const) {
        it.effect(
          `reserves ${action} with stopped process admissions but still requires shutdown receipts`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(),
                  placement = makeThreadPlacementStore(f.sql),
                  activity = makeThreadVmActivityStore(f.sql);
                const workId = "provider:settled";
                yield* placement.admit({ ...f.owner, workId });
                const revision = yield* activity.beginInspection(f.input.allocationId);
                yield* activity.finishInspection({
                  allocationId: f.input.allocationId,
                  revision,
                  activity: "idle",
                  inactiveWorkIds: [workId],
                });
                yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '10 days',lifecycle_checked_at=NULL WHERE allocation_id=${f.input.allocationId}`;
                if (action === "pause")
                  expect(yield* makeThreadVmPauseStore(f.sql).reserveIdle(f.hostId)).toBe(
                    f.input.allocationId,
                  );
                else {
                  expect(yield* f.worker.runOne()).toBe(true);
                  expect((yield* operation(f))?.phase).toBe("draining");
                  f.input.operationId = (yield* operation(f))!.operationId;
                  expect((yield* Effect.flip(f.freeze))._tag).toBe("ThreadVmFinalSaveConflict");
                  const before = yield* activity.get(f.input.allocationId);
                  yield* placement.completeWork({ ...f.owner, workId });
                  expect(yield* activity.get(f.input.allocationId)).toEqual(before);
                  const [point] = yield* f.sql<{
                    operationId: string;
                  }>`SELECT operation_id AS "operationId" FROM relay_thread_native_checkpoints
                WHERE thread_id=${f.threadId} AND capture_operation_id=${f.input.operationId}`;
                  yield* f.store.sourceFrozen({
                    operationId: f.input.operationId,
                    environmentId: f.sourceEnvironmentId,
                    generation: 1,
                    nativeCheckpointOperationId: point!.operationId,
                  });
                  expect((yield* operation(f))?.phase).toBe("frozen");
                }
                expect(
                  yield* f.sql`SELECT completed FROM relay_thread_execution_admissions WHERE thread_id=${f.threadId} AND work_id=${workId}`,
                ).toEqual([{ completed: action === "idle-delete" }]);
              }),
            ),
        );
      }
      for (const state of ["running", "paused"] as const) {
        it.effect(`admits a due ${state} VM without stopping, waking or deleting it`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(state);
              expect(yield* f.worker.runOne()).toBe(true);
              const saved = (yield* operation(f))!;
              expect(saved).toMatchObject({
                threadId: f.threadId,
                allocationId: f.input.allocationId,
                actorUserId: f.input.actorUserId,
                reason: "idle",
                phase: state === "paused" ? "frozen" : "draining",
              });
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe(state);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_resumes WHERE allocation_id=${f.input.allocationId}`,
              ).toHaveLength(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_backups WHERE allocation_id=${f.input.allocationId}`,
              ).toHaveLength(0);
              expect(yield* f.worker.runOne()).toBe(false);
              expect((yield* deadlines(f)).witnessed).toBe(true);
            }),
          ),
        );
      }
      it.effect("refreshes a missing deadline once and skips the VM until it is actually due", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '1 hour' WHERE allocation_id=${f.input.allocationId}`;
            expect(yield* f.worker.runOne()).toBe(true);
            expect(yield* operation(f)).toBeNull();
            expect(yield* deadlines(f)).toMatchObject({
              witnessed: true,
              policyRevision: f.policy.revision,
              timeZone: "UTC",
            });
            expect(yield* f.worker.runOne()).toBe(false);
          }),
        ),
      );
      for (const problem of [
        "busy",
        "unknown",
        "stale",
        "unfinished",
        "pending-command",
        "revoked",
        "wrong-generation",
        "move",
        "uncertified-pause",
        "unacknowledged-reopen",
      ] as const) {
        it.effect(`holds resources rather than trusting an ineligible source (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(problem === "uncertified-pause" ? "paused" : "running");
              if (problem === "busy" || problem === "unknown")
                yield* f.sql`UPDATE relay_thread_vm_activity SET activity=${problem},idle_since=NULL WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "stale")
                yield* f.sql`UPDATE relay_thread_vm_activity SET observed_at=clock_timestamp()-interval '3 minutes' WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "unfinished")
                yield* f.sql`INSERT INTO relay_thread_execution_admissions(thread_id,work_id,environment_id,generation,completed) VALUES(${f.threadId},'pending-work',${f.sourceEnvironmentId},1,false)`;
              if (problem === "pending-command")
                yield* f.sql`INSERT INTO relay_thread_commands(command_id,thread_id,position,accepted_generation,actor_json,payload_json) VALUES(${NodeCrypto.randomUUID()},${f.threadId},1,1,'{}','{}')`;
              if (problem === "revoked")
                yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "wrong-generation")
                yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.threadId}`;
              if (problem === "move")
                yield* f.sql`UPDATE relay_thread_placements SET operation_id=${NodeCrypto.randomUUID()} WHERE thread_id=${f.threadId}`;
              if (problem === "uncertified-pause")
                yield* f.sql`UPDATE relay_thread_vm_pauses SET native_checkpoint_operation_id=NULL,source_sequence=NULL,source_frozen_at=NULL WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "unacknowledged-reopen")
                yield* f.sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase) VALUES(${f.input.allocationId},${NodeCrypto.randomUUID()},1,'cancelled')`;
              expect(yield* f.worker.runOne()).toBe(false);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe(
                problem === "uncertified-pause" ? "paused" : "running",
              );
              if (problem !== "move") expect(yield* operation(f)).toBeNull();
            }),
          ),
        );
      }
      it.effect(
        "recomputes weekday/timezone deadlines atomically on policy edits, including a shorter new deadline",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since='2026-10-23T14:00:00Z',lifecycle_checked_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              const edited = yield* f.policies.update({
                organizationId: f.organizationId,
                expectedRevision: f.policy.revision,
                policy: {
                  ...f.policy.policy,
                  calendarTimeZone: "Europe/Berlin",
                  pauseAfterIdleMinutes: 10,
                },
              });
              expect(yield* deadlines(f)).toEqual({
                deleteAt: "2026-10-27T15:00:00.000Z",
                pauseAt: "2026-10-23T14:10:00.000Z",
                witnessed: true,
                policyRevision: edited.revision,
                timeZone: "Europe/Berlin",
              });
              // Old cached eligibility cannot beat a longer policy, and editing again resets the retry hold.
              yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '10 days',lifecycle_checked_at=NULL WHERE allocation_id=${f.input.allocationId}`;
              const extended = yield* f.policies.update({
                organizationId: f.organizationId,
                expectedRevision: edited.revision,
                policy: { ...edited.policy, deleteAfterIdleWeekdays: 30 },
              });
              expect(yield* f.worker.runOne()).toBe(false);
              expect(yield* operation(f)).toBeNull();
              yield* f.sql`UPDATE relay_thread_vm_activity SET lifecycle_checked_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
              yield* f.policies.update({
                organizationId: f.organizationId,
                expectedRevision: extended.revision,
                policy: { ...extended.policy, deleteAfterIdleWeekdays: 1 },
              });
              expect(yield* f.worker.runOne()).toBe(true);
              expect((yield* operation(f))?.phase).toBe("draining");
            }),
          ),
      );
      it.effect(
        "clears obsolete deadlines for meaningful work and regenerates them for a later idle report",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                activity = makeThreadVmActivityStore(f.sql);
              yield* writeThreadVmIdleDeadline(f.sql, f.input.allocationId, f.policy);
              yield* activity.recordWork(f.input.allocationId);
              expect((yield* deadlines(f)).deleteAt).toBeNull();
              const revision = yield* activity.beginInspection(f.input.allocationId);
              expect(
                yield* activity.finishInspection({
                  allocationId: f.input.allocationId,
                  revision,
                  activity: "idle",
                }),
              ).toBe(true);
              expect(yield* deadlines(f)).toMatchObject({
                witnessed: true,
                policyRevision: f.policy.revision,
              });
              expect(yield* f.worker.runOne()).toBe(false);
              const older = yield* activity.beginInspection(f.input.allocationId);
              yield* activity.recordWork(f.input.allocationId);
              expect(
                yield* activity.finishInspection({
                  allocationId: f.input.allocationId,
                  revision: older,
                  activity: "idle",
                }),
              ).toBe(false);
              expect((yield* deadlines(f)).deleteAt).toBeNull();
            }),
          ),
      );
      it.effect("allows only one simultaneous worker to reserve the source drain", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* Effect.all([f.worker.runOne(), f.worker.runOne()], { concurrency: "unbounded" });
            expect(
              yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE allocation_id=${f.input.allocationId}`,
            ).toHaveLength(1);
            expect((yield* operation(f))?.phase).toBe("draining");
          }),
        ),
      );
      it.effect("advances past a first non-due candidate to another user's due VM", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const early = yield* fixture(),
              due = yield* fixture();
            yield* makeThreadVmCapacityStore(early.sql).configure(early.hostId, 2);
            yield* early.sql`UPDATE relay_thread_vm_capacity SET host_id=${early.hostId} WHERE allocation_id=${due.input.allocationId}`;
            yield* early.sql`UPDATE relay_thread_vm_activity SET lifecycle_checked_at=clock_timestamp()-interval '2 minutes' WHERE allocation_id=${due.input.allocationId}`;
            yield* early.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '1 hour' WHERE allocation_id=${early.input.allocationId}`;
            expect(yield* early.worker.runOne()).toBe(true);
            expect(yield* operation(early)).toBeNull();
            expect(yield* early.worker.runOne()).toBe(true);
            expect((yield* operation(due))?.phase).toBe("draining");
          }),
        ),
      );
      it.effect("rechecks the current policy instead of trusting a forged overdue cache", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '1 hour' WHERE allocation_id=${f.input.allocationId}`;
            yield* writeThreadVmIdleDeadline(f.sql, f.input.allocationId, f.policy);
            yield* f.sql`UPDATE relay_thread_vm_activity SET delete_due_at=deadline_idle_since+interval '1 second' WHERE allocation_id=${f.input.allocationId}`;
            expect(yield* f.worker.runOne()).toBe(true);
            expect(yield* operation(f)).toBeNull();
            const [row] = yield* f.sql<{
              idleSince: string;
            }>`SELECT to_char(idle_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "idleSince" FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`;
            expect((yield* deadlines(f)).deleteAt).toBe(
              idleDeadlines({
                idleSince: DateTime.makeUnsafe(row!.idleSince),
                activity: "idle",
                policy: f.policy.policy,
              })!.deleteAt,
            );
          }),
        ),
      );
    });
  },
);
