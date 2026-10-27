import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { finalSaveCatalogFixture as fixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const pause = Effect.fnUntraced(function* (
  f: Fixture,
  phase: "pending" | "sealed",
  certified = false,
  generation = 1,
) {
  yield* f.sql`INSERT INTO relay_thread_vm_pauses
    (allocation_id,operation_id,generation,phase,boot_id,native_checkpoint_operation_id,source_sequence,source_frozen_at)
    VALUES (${f.input.allocationId},${NodeCrypto.randomUUID()},${generation},${phase},
      ${certified ? NodeCrypto.randomUUID() : null},
      ${certified ? f.native.header.operationId : null},
      ${certified ? f.sourceSequence : null},${certified ? "2026-10-01T00:00:00Z" : null})`;
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "thread VM lease preservation (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("renews a pending pause until its source recovery is retained", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* pause(f, "pending");
            const calls: Array<Parameters<Parameters<typeof makeThreadVmLeaseWorker>[1]>> = [];
            const worker = makeThreadVmLeaseWorker(
              f.sql,
              (id, identity) => Effect.sync(() => void calls.push([id, identity])),
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            expect(calls).toEqual([
              [
                f.computeRef,
                {
                  operationId: f.input.allocationId,
                  templateId: "template:build-verified",
                  scope: {
                    allocationId: f.input.allocationId,
                    threadId: f.threadId,
                    repositoryId: "repo",
                    generation: 1,
                  },
                },
              ],
            ]);
            const [lease] = yield* f.sql`SELECT renewed_at,attempted_at FROM relay_thread_vm_leases
              WHERE allocation_id=${f.input.allocationId}`;
            expect(lease?.renewed_at).not.toBeNull();
            expect(lease?.attempted_at).not.toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            expect(yield* worker.runOne()).toBe(false);
          }),
        ),
      );

      for (const phase of ["pending", "sealed"] as const) {
        it.effect(`does not renew a ${phase} pause with retained source recovery`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* pause(f, phase, true);
              const worker = makeThreadVmLeaseWorker(
                f.sql,
                () => Effect.die("A certified pause cannot renew its VM"),
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_leases WHERE allocation_id=${f.input.allocationId}`,
              ).toEqual([]);
            }),
          ),
        );
      }

      it.effect(
        "a retained pause from an older generation does not suppress the current lease",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* pause(f, "pending", true);
              yield* f.sql`UPDATE relay_thread_vm_provisions SET generation=2 WHERE allocation_id=${f.input.allocationId}`;
              yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_thread_vm_bindings SET generation=2 WHERE allocation_id=${f.input.allocationId}`;
              let renewedGeneration: number | undefined;
              const worker = makeThreadVmLeaseWorker(
                f.sql,
                (_id, identity) =>
                  Effect.sync(() => void (renewedGeneration = identity.scope.generation)),
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(true);
              expect(renewedGeneration).toBe(2);
            }),
          ),
      );

      it.effect("a failed renewal keeps the VM owned and never records success", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* pause(f, "pending");
            let attempts = 0;
            const worker = makeThreadVmLeaseWorker(
              f.sql,
              () =>
                Effect.gen(function* () {
                  attempts++;
                  return yield* new ThreadVmComputeError({
                    operation: "lease",
                    message: "Renewal failed without waking the VM",
                  });
                }),
              f.hostId,
            );
            expect(yield* worker.runOne()).toBe(true);
            const [lease] = yield* f.sql`SELECT renewed_at,attempted_at FROM relay_thread_vm_leases
              WHERE allocation_id=${f.input.allocationId}`;
            expect(lease?.renewed_at).toBeNull();
            expect(lease?.attempted_at).not.toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            expect(yield* worker.runOne()).toBe(false);
            expect(attempts).toBe(1);
          }),
        ),
      );

      for (const state of ["paused", "deleting"] as const) {
        it.effect(`does not renew a ${state} allocation`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* pause(f, "pending");
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state=${state} WHERE allocation_id=${f.input.allocationId}`;
              const worker = makeThreadVmLeaseWorker(
                f.sql,
                () => Effect.die("Nonrunning allocations cannot renew"),
                f.hostId,
              );
              expect(yield* worker.runOne()).toBe(false);
            }),
          ),
        );
      }
    });
  },
);
