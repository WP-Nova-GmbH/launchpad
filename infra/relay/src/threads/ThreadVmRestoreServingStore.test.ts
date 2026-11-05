import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmRestoreEnrollmentStore } from "./ThreadVmRestoreEnrollmentStore.ts";
import { readThreadVmTrafficAccessToken } from "./ThreadVmIngressToken.ts";
import { nativeRestoreFixture, nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "native serving restore (Postgres)",
  () => {
    layer(nativeRestoreTestLayer)((it) => {
      it.effect(
        "does not boot a historical allocation even with a native-looking restore row",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.input.allocationId}`;
              expect(
                yield* f
                  .worker({ createFromSnapshot: () => Effect.die("Legacy target must never boot") })
                  .runOne(),
              ).toBe(false);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("committed");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
            }),
          ),
      );
      it.effect(
        "commits ownership before native create, then bootstraps before opening enrollment",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              let created = 0,
                bootstrapped = 0;
              const worker = f.worker(
                {
                  createFromSnapshot: (input) =>
                    Effect.gen(function* () {
                      created++;
                      expect(input).toMatchObject({
                        generation: 2,
                        restoreOperationId: f.input.operationId,
                        bootAttempt: 0,
                        sourceTemplateId: "snapshot",
                      });
                      expect(yield* f.placements.get(f.threadId)).toMatchObject({
                        generation: 2,
                        operationId: f.input.operationId,
                        environmentId: `pending-restore:${f.input.allocationId}`,
                      });
                      expect((yield* f.restores.get(f.input.operationId))?.bootCreateStarted).toBe(
                        true,
                      );
                      return yield* f.compute.createFromSnapshot();
                    }).pipe(Effect.orDie),
                },
                (id, identity, request) =>
                  Effect.gen(function* () {
                    bootstrapped++;
                    expect(id).toBe(f.sandboxId);
                    expect(identity.scope.generation).toBe(2);
                    expect(
                      yield* makeThreadVmRestoreEnrollmentStore(f.sql).requested({
                        ...f.input,
                        generation: 2,
                      }),
                    ).toBe(false);
                    const provision =
                      yield* f.sql`SELECT 1 FROM relay_thread_vm_provisions WHERE allocation_id=${f.input.allocationId}`;
                    expect(provision).toHaveLength(0);
                    return yield* f.bootstrap(id, identity, request);
                  }).pipe(Effect.orDie),
              );
              yield* worker.runOne();
              expect(created).toBe(1);
              expect(bootstrapped).toBe(1);
              const row = (yield* f.restores.get(f.input.operationId))!;
              expect(row).toMatchObject({
                phase: "booted",
                sourceGeneration: 1,
                targetGeneration: 2,
                bootstrapReceipt: { kind: "native-warm-restore-bootstrap-v1" },
              });
              expect(
                yield* makeThreadVmRestoreEnrollmentStore(f.sql).requested({
                  ...f.input,
                  generation: 2,
                }),
              ).toBe(true);
              expect(
                yield* readThreadVmTrafficAccessToken(f.sql, {
                  allocationId: f.input.allocationId,
                  operationId: f.input.operationId,
                  threadId: f.threadId,
                  generation: 2,
                  computeRef: f.sandboxId,
                }),
              ).toBeDefined();
            }),
          ),
      );
      it.effect(
        "lost create response never dispatches a second create and holds quota across claims",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              let creates = 0;
              const worker = f.worker({
                createFromSnapshot: () => {
                  creates++;
                  return Effect.fail(
                    new ThreadVmComputeError({ operation: "create", message: "lost reply" }),
                  );
                },
                findOperation: () => Effect.succeed([]),
              });
              yield* worker.runOne();
              yield* f.retry;
              yield* worker.runOne();
              yield* f.retry;
              yield* worker.runOne();
              expect(creates).toBe(1);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("creating");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
              yield* f.restores.requestAbort(f.input.operationId);
              yield* worker.runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborting");
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
            }),
          ),
      );
      for (const problem of [
        "ambiguous",
        "template",
        "network",
        "auto-resume",
        "generation",
      ] as const) {
        it.effect(`does not recover ingress or bootstrap an uncertain create with ${problem}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              const first = (yield* f.serving.claim(f.hostId))!;
              yield* f.serving.beginCreate(first);
              yield* f.sql`UPDATE relay_thread_vm_restores SET claim_id=NULL,claim_until=NULL WHERE operation_id=${f.input.operationId}`;
              const info = {
                ...f.info(),
                ...(problem === "template" ? { templateId: "other" } : {}),
                ...(problem === "network" ? { network: { allowPublicTraffic: true } } : {}),
                ...(problem === "auto-resume"
                  ? { lifecycle: { ...f.info().lifecycle!, autoResume: true } }
                  : {}),
                ...(problem === "generation"
                  ? { metadata: { ...f.info().metadata, "launchpad.generation": "3" } }
                  : {}),
              };
              const worker = f.worker(
                {
                  findOperation: () =>
                    Effect.succeed(
                      problem === "ambiguous" ? [info, { ...info, sandboxId: "second" }] : [info],
                    ),
                  recoverIngress: () => Effect.die("Bad identity must not connect"),
                },
                () => Effect.die("Bad identity must not bootstrap"),
              );
              yield* worker.runOne();
              expect((yield* f.restores.get(f.input.operationId))?.bootReceipt).toBeNull();
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
            }),
          ),
        );
      }
      it.effect(
        "unknown connect holds an ingress marker and never reconnects or cleans up after lease expiry",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              let connects = 0;
              const worker = f.worker({
                createFromSnapshot: () => Effect.succeed({ sandboxId: f.sandboxId }),
                recoverIngress: () => {
                  connects++;
                  return Effect.fail(
                    new ThreadVmComputeError({
                      operation: "recover ingress",
                      message: "unknown reply",
                      connectUncertain: true,
                    }),
                  );
                },
                destroy: () => Effect.die("Unsettled connect must not delete"),
              });
              yield* worker.runOne();
              const row = (yield* f.restores.get(f.input.operationId))!;
              expect(row.bootIngressRecoveryClaimId).not.toBeNull();
              yield* f.sql`UPDATE relay_thread_vm_restores SET claim_until=clock_timestamp()-interval '1 minute',retry_at=clock_timestamp() WHERE operation_id=${row.operationId}`;
              expect(yield* worker.runOne()).toBe(false);
              yield* f.restores.requestAbort(row.operationId);
              expect(yield* worker.runOne()).toBe(false);
              expect(connects).toBe(1);
              expect((yield* f.capacity.get(row.operationId))?.state).toBe("started");
            }),
          ),
      );
      it.effect(
        "a late positive connect only settles its own marker; cancellation destroys the known target without reenrolling",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              const started = yield* Deferred.make<void>(),
                finished =
                  yield* Deferred.make<
                    Effect.Success<ReturnType<typeof f.compute.recoverIngress>>
                  >();
              let deleted = 0,
                bootstrap = 0;
              const worker = f.worker(
                {
                  createFromSnapshot: () => Effect.succeed({ sandboxId: f.sandboxId }),
                  recoverIngress: () =>
                    Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(finished)),
                    ),
                  destroy: () =>
                    Effect.sync(() => {
                      deleted++;
                    }),
                },
                () =>
                  Effect.sync(() => {
                    bootstrap++;
                    return undefined;
                  }).pipe(Effect.andThen(Effect.die("Cancelled target must not bootstrap"))),
              );
              const fiber = yield* Effect.forkChild(worker.runOne());
              yield* Deferred.await(started);
              yield* f.sql`UPDATE relay_thread_vm_restores SET claim_until=clock_timestamp()-interval '1 minute' WHERE operation_id=${f.input.operationId}`;
              yield* f.restores.requestAbort(f.input.operationId);
              expect(yield* worker.runOne()).toBe(false);
              yield* Deferred.succeed(finished, {
                sandboxId: f.sandboxId,
                trafficAccessToken: (yield* f.compute.recoverIngress()).trafficAccessToken!,
              });
              yield* Fiber.join(fiber);
              expect(
                (yield* f.restores.get(f.input.operationId))?.bootIngressRecoveryClaimId,
              ).toBeNull();
              yield* worker.runOne();
              yield* worker.runOne();
              expect(deleted).toBe(1);
              expect(bootstrap).toBe(0);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborted");
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                operationId: null,
                environmentId: `pending-restore:${f.input.allocationId}`,
              });
              expect((yield* f.saved.get(f.input.savedDiskOperationId))?.phase).toBe("available");
            }),
          ),
      );
      it.effect(
        "a proven pre-dispatch connect failure clears only the marker and allows explicit later recovery",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              let connects = 0;
              const worker = f.worker({
                createFromSnapshot: () => Effect.succeed({ sandboxId: f.sandboxId }),
                recoverIngress: () =>
                  ++connects === 1
                    ? Effect.fail(
                        new ThreadVmComputeError({
                          operation: "recover ingress",
                          message: "not dispatched",
                          connectUncertain: false,
                        }),
                      )
                    : f.compute.recoverIngress(),
              });
              yield* worker.runOne();
              expect(
                (yield* f.restores.get(f.input.operationId))?.bootIngressRecoveryClaimId,
              ).toBeNull();
              yield* f.retry;
              yield* worker.runOne();
              expect(connects).toBe(2);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
            }),
          ),
      );
      it.effect(
        "rechecks owner access after bootstrap and keeps enrollment closed if access was revoked",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              yield* f
                .worker({}, (id, identity, input) =>
                  Effect.gen(function* () {
                    yield* f.sql`DELETE FROM relay_organization_members WHERE user_id=${f.input.actorUserId}`;
                    return yield* f.bootstrap(id, identity, input);
                  }).pipe(Effect.orDie),
                )
                .runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("bootstrapping");
              expect(
                yield* makeThreadVmRestoreEnrollmentStore(f.sql).requested({
                  ...f.input,
                  generation: 2,
                }),
              ).toBe(false);
              expect((yield* f.capacity.get(f.input.operationId))?.state).toBe("started");
            }),
          ),
      );
      it.effect(
        "disabled restore processing cleans a committed cancellation without creating or connecting",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              const worker = f.worker(
                {
                  createFromSnapshot: () => Effect.die("Disabled must not create"),
                  recoverIngress: () => Effect.die("Disabled must not connect"),
                },
                f.bootstrap,
                false,
              );
              expect(yield* worker.runOne()).toBe(false);
              yield* f.restores.requestAbort(f.input.operationId);
              expect(yield* worker.runOne()).toBe(true);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("aborted");
            }),
          ),
      );
      it.effect(
        "a cancelled committed restore can retry the same source under a fresh target generation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              yield* f.restores.requestAbort(f.input.operationId);
              yield* f.worker().runOne();
              const second = {
                ...f.input,
                operationId: NodeCrypto.randomUUID(),
                allocationId: NodeCrypto.randomUUID(),
                expectedGeneration: 2,
              };
              const row = yield* f.restores.begin(second);
              expect(row.sourceGeneration).toBe(1);
              expect(row.generation).toBe(2);
              yield* f.capacity.admitNext(f.hostId);
              const claim = (yield* f.restores.claim(f.hostId))!;
              yield* f.restores.beginPrepare(claim);
              yield* f.restores.recordPrepared(claim, {
                version: 1,
                kind: "native-restore-catalog-v1",
                sourceTemplateId: row.sourceTemplateId,
                sourceBuildId: row.sourceBuildId,
              });
              yield* f.serving.commit((yield* f.serving.claim(f.hostId))!);
              expect((yield* f.restores.get(second.operationId))?.targetGeneration).toBe(3);
            }),
          ),
      );
      it.effect("does not cancel an identity issued in the booted-to-importing window", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* nativeRestoreFixture();
            yield* f.boot;
            const credential = NodeCrypto.randomUUID(),
              environment = `issued-${credential}`;
            yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'key',${credential},'now','now')`;
            yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at) VALUES(${f.input.allocationId},${f.input.operationId},${credential},${environment},'key',${credential},'sealed',clock_timestamp()+interval '1 hour')`;
            yield* Effect.flip(f.restores.requestAbort(f.input.operationId));
            expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
              phase: "booted",
              enrollmentIssued: true,
            });
          }),
        ),
      );
      it.effect(
        "explicitly recovers an admitted boot paused before enrollment without repeating bootstrap",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.boot;
              let connects = 0;
              yield* f
                .worker(
                  {
                    inspect: () => Effect.succeed({ ...f.info(), state: "paused" }),
                    recoverIngress: () => {
                      connects++;
                      return f.compute.recoverIngress();
                    },
                  },
                  () => Effect.die("Already bootstrapped destination must not quarantine again"),
                )
                .runOne();
              expect(connects).toBe(1);
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("booted");
              expect(
                (yield* f.restores.get(f.input.operationId))?.bootIngressRecoveryClaimId,
              ).toBeNull();
            }),
          ),
      );
      it.effect(
        "rejects a bootstrap receipt for a different source seal without enabling enrollment",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.commit;
              yield* f
                .worker({}, (id, identity, input) =>
                  f.bootstrap(id, identity, {
                    ...input,
                    source: { ...input.source, sealEpoch: input.source.sealEpoch + 1 },
                  }),
                )
                .runOne();
              expect((yield* f.restores.get(f.input.operationId))?.phase).toBe("bootstrapping");
              expect(
                yield* makeThreadVmRestoreEnrollmentStore(f.sql).requested({
                  ...f.input,
                  generation: 2,
                }),
              ).toBe(false);
            }),
          ),
      );
      it.effect(
        "retries only an exactly acknowledged unenrolled boot while retaining its committed generation",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.boot;
              const claim = (yield* f.serving.claim(f.hostId))!,
                row = yield* f.serving.beginBootRecovery(claim),
                boot = row.bootReceipt!;
              yield* Effect.flip(
                f.serving.retryStoppedBoot(claim, {
                  ...boot,
                  kind: "native-restore-deleted-boot-v1",
                  sandboxId: "wrong",
                  acknowledged: true,
                }),
              );
              expect((yield* f.restores.get(f.input.operationId))?.bootAttempt).toBe(0);
              yield* f.serving.retryStoppedBoot(claim, {
                ...boot,
                kind: "native-restore-deleted-boot-v1",
                acknowledged: true,
              });
              expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
                phase: "committed",
                targetGeneration: 2,
                sourceGeneration: 1,
                bootAttempt: 1,
                bootCreateStarted: false,
                bootReceipt: null,
              });
              expect(yield* f.placements.get(f.threadId)).toMatchObject({
                generation: 2,
                operationId: f.input.operationId,
              });
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
            }),
          ),
      );
      it.effect(
        "only monitors an issued boot after enrollment fails, then retires its vanished unactivated identity",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* nativeRestoreFixture();
              yield* f.boot;
              const credential = NodeCrypto.randomUUID(),
                environment = `failed-enrollment-${credential}`;
              yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credential},${environment},'key',${credential},'now','now')`;
              yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id) VALUES(${environment},${f.input.allocationId},${f.threadId},'repo',2,'key',${credential})`;
              yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at) VALUES(${f.input.allocationId},${f.input.operationId},${credential},${environment},'key',${credential},'sealed',clock_timestamp()+interval '1 hour')`;
              expect(
                yield* f
                  .worker({
                    inspect: () => Effect.die("Healthy issued boot must not steal enrollment"),
                  })
                  .runOne(),
              ).toBe(false);
              yield* f.sql`UPDATE relay_thread_vm_provisions SET error_code='enrollment_unconfirmed' WHERE allocation_id=${f.input.allocationId}`;
              let deletes = 0;
              yield* f
                .worker({
                  inspect: () => Effect.succeed(null),
                  destroy: () =>
                    Effect.sync(() => {
                      deletes++;
                    }),
                })
                .runOne();
              expect(deletes).toBe(1);
              expect(yield* f.restores.get(f.input.operationId)).toMatchObject({
                phase: "committed",
                bootAttempt: 1,
                targetGeneration: 2,
                enrollmentIssued: false,
              });
              expect(
                (yield* f.sql<{
                  revoked: boolean;
                }>`SELECT revoked_at IS NOT NULL AS revoked FROM relay_environment_credentials WHERE credential_id=${credential}`)[0]
                  ?.revoked,
              ).toBe(true);
            }),
          ),
      );
    });
  },
);
