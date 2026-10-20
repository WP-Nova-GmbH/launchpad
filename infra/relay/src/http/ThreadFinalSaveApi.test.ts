import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import {
  getThreadVmFinalSave,
  freezeThreadVmFinalSave,
  cancelThreadVmFinalSave,
} from "./ThreadEnvironmentApi.ts";

const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(nativeCheckpointCatalogTestLayer),
);
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "source final-save acknowledgement (Postgres)",
  () => {
    layer(services)((it) => {
      for (const certified of [false, true]) {
        it.effect(
          `source cancellation is limited to the pre-capture phase (certified=${certified})`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* finalSaveCatalogFixture();
                yield* f.store.begin(f.input);
                if (certified) yield* f.freeze;
                const provide = Effect.provideService(RelayEnvironmentPrincipal, {
                  environmentId: f.sourceEnvironmentId,
                  environmentPublicKey: "test-key",
                  credentialId: f.credentialId,
                  threadVm: {
                    allocationId: f.input.allocationId,
                    threadId: ThreadId.make(f.threadId),
                    repositoryId: "repo",
                    generation: 1,
                  },
                });
                const input = { ...f.owner, operationId: f.input.operationId };
                const result = yield* Effect.result(
                  cancelThreadVmFinalSave(input).pipe(
                    provide,
                    Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                  ),
                );
                expect(result._tag).toBe(certified ? "Failure" : "Success");
                expect((yield* f.store.get(f.input.operationId))?.phase).toBe(
                  certified ? "frozen" : "aborting",
                );
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
                if (!certified) {
                  expect(
                    (yield* f.sql<{
                      activity: string;
                    }>`SELECT activity FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`)[0]
                      ?.activity,
                  ).toBe("unknown");
                  expect((yield* f.store.cancelBeforeFreeze(input)).phase).toBe("aborting");
                }
              }),
            ),
        );
      }
      for (const problem of [
        "foreign-allocation",
        "foreign-thread",
        "stale-generation",
        "revoked-credential",
        "ordinary-environment",
        "none",
      ] as const) {
        it.effect(`accepts only the exact source allocation (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture();
              yield* f.store.begin(f.input);
              const [binding] = yield* f.sql<{
                credentialId: string;
              }>`SELECT credential_id AS "credentialId" FROM relay_thread_vm_bindings WHERE allocation_id=${f.input.allocationId}`;
              const principal = {
                environmentId: f.sourceEnvironmentId,
                environmentPublicKey: "test-key",
                credentialId: binding!.credentialId,
                ...(problem === "ordinary-environment"
                  ? {}
                  : {
                      threadVm: {
                        allocationId:
                          problem === "foreign-allocation"
                            ? NodeCrypto.randomUUID()
                            : f.input.allocationId,
                        threadId: ThreadId.make(f.threadId),
                        repositoryId: "repo",
                        generation: 1,
                      },
                    }),
              };
              if (problem === "revoked-credential")
                yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${binding!.credentialId}`;
              const owner = {
                threadId: problem === "foreign-thread" ? NodeCrypto.randomUUID() : f.threadId,
                environmentId: f.sourceEnvironmentId,
                generation: problem === "stale-generation" ? 2 : 1,
              };
              const provide = Effect.provideService(RelayEnvironmentPrincipal, principal),
                objects = Effect.provideService(ThreadArtifactObjectStorage, f.objects);
              const result = yield* Effect.result(
                getThreadVmFinalSave(owner).pipe(provide, objects),
              );
              if (problem !== "none") {
                expect(
                  (yield* Effect.result(
                    cancelThreadVmFinalSave({ ...owner, operationId: f.input.operationId }).pipe(
                      provide,
                      objects,
                    ),
                  ))._tag,
                ).toBe("Failure");
                expect(result._tag).toBe("Failure");
                expect((yield* f.store.get(f.input.operationId))?.phase).toBe("draining");
                return;
              }
              expect(result).toMatchObject({
                _tag: "Success",
                success: { operationId: f.input.operationId, phase: "draining" },
              });
              const older = yield* Effect.result(
                freezeThreadVmFinalSave({
                  ...owner,
                  operationId: f.input.operationId,
                  nativeCheckpointOperationId: f.native.header.operationId,
                }).pipe(provide, objects),
              );
              expect(older._tag).toBe("Failure");
              yield* f.freeze;
              const operation = (yield* f.store.get(f.input.operationId))!;
              const input = {
                ...owner,
                operationId: f.input.operationId,
                nativeCheckpointOperationId: operation.nativeCheckpointOperationId!,
              };
              const receipt = yield* freezeThreadVmFinalSave(input).pipe(provide, objects);
              expect(receipt.phase).toBe("frozen");
              expect(yield* freezeThreadVmFinalSave(input).pipe(provide, objects)).toEqual(receipt);
              expect(
                (yield* getThreadVmFinalSave(owner).pipe(provide, objects))
                  ?.nativeCheckpointOperationId,
              ).toBe(input.nativeCheckpointOperationId);
            }),
          ),
        );
      }
    });
  },
);
