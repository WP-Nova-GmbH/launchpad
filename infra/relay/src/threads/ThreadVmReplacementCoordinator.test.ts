import * as NodeCrypto from "node:crypto";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { RelayOrganizationId, RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { RelayThreadVmCreateRequest } from "@t3tools/contracts/relay";
import { makeThreadVmMoveDestinationStore } from "./ThreadVmMoveDestinationStore.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import {
  getThreadVmReplacement,
  getThreadVmReplacementCandidates,
  selectThreadVmReplacement,
  cancelThreadVmReplacement,
} from "../http/ThreadVmsApi.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { makeThreadVmSetupStore } from "./ThreadVmSetupStore.ts";
import { makeThreadVmFinalSaveDeletionWorker } from "./ThreadVmFinalSaveDeletionWorker.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmPolicyStore } from "./ThreadVmPolicy.ts";
import { threadVmQuotaUsage } from "./ThreadVmQuota.ts";

const incomingMove = Effect.fnUntraced(function* (
  sql: PgClient,
  threadId: string,
  operationId: string,
  ownerUserId: string,
  enroll = true,
) {
  const environmentId = NodeCrypto.randomUUID(),
    credentialId = NodeCrypto.randomUUID();
  if (enroll) {
    yield* makeThreadPlacementStore(sql).enroll({
      threadId,
      environmentId,
      projectId: "source-project",
      organizationId: "org",
      repositoryId: "repo",
      ownerUserId,
    });
    yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
      VALUES(${credentialId},${environmentId},'source-key',${credentialId},'now','now')`;
    yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
      VALUES(${ownerUserId},${environmentId},'source-key','https://source.test','wss://source.test','cloudflare','now','now')`;
  }
  return {
    kind: "move" as const,
    threadId,
    operationId,
    actorUserId: ownerUserId,
    sourceEnvironmentId: environmentId,
    expectedGeneration: 1,
    sourceCredentialId: credentialId,
    sourcePublicKey: "source-key",
    sourceAllocationId: null,
  };
});
const fixture = Effect.fnUntraced(function* (
  state: "running" | "paused" = "running",
  enroll = true,
) {
  const f = yield* finalSaveCatalogFixture(state);
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at)
    VALUES('github.com/acme/test','repo','org','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
    VALUES('org',${f.input.actorUserId},'admin','now','now')`;
  yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=1 WHERE organization_id='org'`;
  const request = {
    allocationId: NodeCrypto.randomUUID(),
    threadId: ThreadId.make(NodeCrypto.randomUUID()),
    organizationId: RelayOrganizationId.make("org"),
    repositoryId: RelayRepositoryId.make("repo"),
    canonicalKey: "github.com/acme/test",
    branch: "main",
    revision: "a".repeat(40),
    initialState: {
      title: "Replacement test",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      createdAt: "2026-10-07T00:00:00.000Z",
    },
  };
  const input = {
    requestId: request.allocationId,
    threadId: request.threadId,
    organizationId: "org",
    repositoryId: "repo",
    ownerUserId: f.input.actorUserId,
    hostId: f.hostId,
    templateId: "template:build-verified",
    intent: yield* incomingMove(
      f.sql,
      request.threadId,
      request.allocationId,
      f.input.actorUserId,
      enroll,
    ),
  };
  const coordinator = makeThreadVmReplacementCoordinator(f.sql, f.objects);
  const selection = {
    requestId: input.requestId,
    ownerUserId: input.ownerUserId,
    victimAllocationId: f.input.allocationId,
  };
  const record = coordinator.record(input);
  const choose = Effect.gen(function* () {
    yield* record;
    const selected = yield* coordinator.select(selection);
    if (selected.finalSaveOperationId) f.input.operationId = selected.finalSaveOperationId;
    return selected;
  });
  const remove = Effect.gen(function* () {
    yield* f.freeze;
    yield* f.verifyBackup;
    yield* f.store.recordSaved(f.input.operationId);
    let destroyed = false;
    const worker = makeThreadVmFinalSaveDeletionWorker(
      f.sql,
      f.objects,
      {
        inspect: () => Effect.succeed(destroyed ? null : f.info),
        destroy: () =>
          Effect.sync(() => {
            destroyed = true;
          }),
      },
      f.hostId,
    );
    expect(yield* worker.runOne()).toBe(true);
    expect(destroyed).toBe(true);
    yield* f.sql`UPDATE relay_thread_vm_replacements SET checked_at=NULL WHERE request_id=${input.requestId}`;
  });
  return { ...f, request, replacementInput: input, coordinator, selection, record, choose, remove };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "quota replacement coordinator (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const state of ["running", "paused"] as const) {
        it.effect(
          `retains a ${state} VM and incoming request until verified physical absence`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture(state),
                  selected = yield* f.choose;
                expect(selected).toMatchObject({
                  phase: "waiting",
                  victimAllocationId: f.input.allocationId,
                });
                expect((yield* f.store.get(f.input.operationId))?.phase).toBe(
                  state === "paused" ? "frozen" : "draining",
                );
                expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe(state);
                yield* f.coordinator.runOne(f.hostId);
                expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
                expect(yield* f.coordinator.record(f.replacementInput)).toMatchObject({
                  phase: "waiting",
                  finalSaveOperationId: f.input.operationId,
                });
                expect(yield* f.coordinator.select(f.selection)).toMatchObject({
                  finalSaveOperationId: f.input.operationId,
                });
                yield* f.remove;
                expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
                yield* f.coordinator.runOne(f.hostId);
                expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe("admitted");
                expect((yield* f.allocations.get(f.request.allocationId))?.state).toBe("creating");
                expect(
                  (yield* makeThreadPlacementStore(f.sql).getMove({
                    threadId: f.request.threadId,
                    operationId: f.request.allocationId,
                  })).sourceEnvironmentId,
                ).toEqual(f.replacementInput.intent.sourceEnvironmentId);
                expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
                expect(yield* f.coordinator.runOne(f.hostId)).toBe(false);
              }),
            ),
        );
      }
      it.effect("a concurrent request cannot steal the physically freed replacement slot", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.choose;
            yield* f.remove;
            const unrelated = {
              ...f.request,
              allocationId: NodeCrypto.randomUUID(),
              threadId: ThreadId.make(NodeCrypto.randomUUID()),
              ownerUserId: f.input.actorUserId,
              templateId: "template:build-verified",
              hostId: f.hostId,
            };
            const results = yield* Effect.all(
              [
                Effect.result(makeThreadVmSetupStore(f.sql).enqueue(unrelated)),
                Effect.result(f.coordinator.runOne(f.hostId)),
              ],
              { concurrency: "unbounded" },
            );
            expect(results[0]).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ThreadVmQuotaExceeded" },
            });
            expect(results[1]).toMatchObject({ _tag: "Success" });
            expect(yield* f.allocations.get(unrelated.allocationId)).toBeNull();
            yield* f.coordinator.runOne(f.hostId);
            expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe("admitted");
          }),
        ),
      );
      it.effect("concurrent selection retries publish exactly one final-save operation", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.record;
            const results = yield* Effect.all(
              [f.coordinator.select(f.selection), f.coordinator.select(f.selection)],
              { concurrency: "unbounded" },
            );
            expect(results[0].finalSaveOperationId).toBe(results[1].finalSaveOperationId);
            expect(
              yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE allocation_id=${f.input.allocationId}`,
            ).toHaveLength(1);
          }),
        ),
      );
      it.effect(
        "a second incoming thread cannot select a victim already promised to another request",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.choose;
              const request = {
                ...f.request,
                allocationId: NodeCrypto.randomUUID(),
                threadId: ThreadId.make(NodeCrypto.randomUUID()),
              };
              yield* f.coordinator.record({
                ...f.replacementInput,
                requestId: request.allocationId,
                threadId: request.threadId,
                intent: yield* incomingMove(
                  f.sql,
                  request.threadId,
                  request.allocationId,
                  f.input.actorUserId,
                ),
              });
              expect(
                yield* Effect.flip(
                  f.coordinator.select({ ...f.selection, requestId: request.allocationId }),
                ),
              ).toMatchObject({ _tag: "ThreadVmReplacementConflict" });
            }),
          ),
      );
      it.effect(
        "selects an idle VM with exact stopped process evidence without releasing its admissions",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture(),
                placement = makeThreadPlacementStore(f.sql),
                activity = makeThreadVmActivityStore(f.sql);
              const workId = "terminal:closed";
              yield* placement.admit({ ...f.owner, workId });
              const revision = yield* activity.beginInspection(f.input.allocationId);
              yield* activity.finishInspection({
                allocationId: f.input.allocationId,
                revision,
                activity: "idle",
                inactiveWorkIds: [workId],
              });
              yield* f.record;
              const selected = yield* f.coordinator.select(f.selection);
              expect(selected.phase).toBe("waiting");
              expect(selected.finalSaveOperationId).not.toBeNull();
              expect(
                yield* f.sql`SELECT completed FROM relay_thread_execution_admissions WHERE thread_id=${f.threadId} AND work_id=${workId}`,
              ).toEqual([{ completed: false }]);
            }),
          ),
      );
      for (const problem of [
        "busy",
        "unknown",
        "stale",
        "foreign",
        "backup",
        "unfinished",
      ] as const) {
        it.effect(`rejects an unsafe replacement choice (${problem})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.record;
              if (problem === "busy" || problem === "unknown")
                yield* f.sql`UPDATE relay_thread_vm_activity SET activity=${problem},idle_since=NULL WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "stale")
                yield* f.sql`UPDATE relay_thread_vm_activity SET observed_at=clock_timestamp()-interval '3 minutes' WHERE allocation_id=${f.input.allocationId}`;
              if (problem === "foreign")
                yield* f.sql`UPDATE relay_thread_placements SET owner_user_id='someone-else' WHERE thread_id=${f.threadId}`;
              if (problem === "backup") yield* f.backup.enqueueDue(f.hostId);
              if (problem === "unfinished")
                yield* f.sql`INSERT INTO relay_thread_execution_admissions(thread_id,work_id,environment_id,generation,completed) VALUES(${f.threadId},'unfinished',${f.sourceEnvironmentId},1,false)`;
              expect((yield* Effect.result(f.coordinator.select(f.selection)))._tag).toBe(
                "Failure",
              );
              expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe(
                "awaiting_choice",
              );
              expect(yield* f.store.get(f.input.operationId)).toBeNull();
            }),
          ),
        );
      }
      it.effect(
        "uses a naturally freed quota slot without saving or deleting the selected VM",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.record;
              yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=2 WHERE organization_id='org'`;
              expect(yield* f.coordinator.select(f.selection)).toMatchObject({
                phase: "admitted",
                finalSaveOperationId: null,
              });
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
              expect((yield* f.allocations.get(f.request.allocationId))?.state).toBe("creating");
            }),
          ),
      );
      it.effect(
        "cancellation before saving prevents later admission and requests a safe source abort",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.choose;
              expect(yield* f.coordinator.cancel(f.selection)).toMatchObject({
                phase: "cancelled",
              });
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
              expect(yield* f.coordinator.runOne(f.hostId)).toBe(false);
              expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect(
        "cancellation after removal releases the incoming reservation and keeps recovery data",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.choose;
              yield* f.remove;
              expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
              yield* f.coordinator.cancel(f.selection);
              expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(0);
              expect(
                yield* f.sql`SELECT 1 FROM relay_thread_vm_saved_disks WHERE operation_id=${f.input.operationId} AND phase='available'`,
              ).toHaveLength(1);
              expect(yield* f.coordinator.runOne(f.hostId)).toBe(false);
            }),
          ),
      );
      it.effect("access removal cancels the waiting request before another VM is admitted", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.choose;
            yield* f.sql`DELETE FROM relay_organization_members WHERE user_id=${f.input.actorUserId}`;
            yield* f.coordinator.runOne(f.hostId);
            expect(yield* f.coordinator.get(f.request.allocationId)).toMatchObject({
              phase: "cancelled",
              errorCode: "access_or_placement_changed",
            });
            expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
            expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
          }),
        ),
      );
      it.effect("rejects changed request identity and another owner's read-modify actions", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.record;
            expect(
              (yield* Effect.result(
                f.coordinator.record({
                  ...f.replacementInput,
                  intent: { ...f.replacementInput.intent, sourcePublicKey: "other" },
                }),
              ))._tag,
            ).toBe("Failure");
            expect(
              (yield* Effect.result(f.coordinator.select({ ...f.selection, ownerUserId: "other" })))
                ._tag,
            ).toBe("Failure");
            expect(
              (yield* Effect.result(f.coordinator.cancel({ ...f.selection, ownerUserId: "other" })))
                ._tag,
            ).toBe("Failure");
          }),
        ),
      );
      it.effect(
        "admits the originally queued local-to-VM move once the victim is safely removed",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("running", false),
                environmentId = NodeCrypto.randomUUID(),
                credentialId = NodeCrypto.randomUUID();
              yield* makeThreadPlacementStore(f.sql).enroll({
                threadId: f.request.threadId,
                environmentId,
                projectId: "source-project",
                organizationId: "org",
                repositoryId: "repo",
                ownerUserId: f.input.actorUserId,
              });
              yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
        VALUES(${credentialId},${environmentId},'source-key',${credentialId},'now','now')`;
              yield* f.sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
        VALUES(${f.input.actorUserId},${environmentId},'source-key','https://source.test','wss://source.test','cloudflare','now','now')`;
              yield* f.coordinator.record({
                ...f.replacementInput,
                intent: {
                  kind: "move",
                  threadId: f.request.threadId,
                  operationId: f.request.allocationId,
                  actorUserId: f.input.actorUserId,
                  sourceEnvironmentId: environmentId,
                  expectedGeneration: 1,
                  sourceCredentialId: credentialId,
                  sourcePublicKey: "source-key",
                  sourceAllocationId: null,
                },
              });
              const selected = yield* f.coordinator.select(f.selection);
              f.input.operationId = selected.finalSaveOperationId!;
              expect(
                (yield* makeThreadPlacementStore(f.sql).get(f.request.threadId))?.operationId,
              ).toBeNull();
              yield* f.remove;
              yield* f.coordinator.runOne(f.hostId);
              expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe("admitted");
              const placements = makeThreadPlacementStore(f.sql);
              expect(
                yield* placements.getMove({
                  threadId: f.request.threadId,
                  operationId: f.request.allocationId,
                }),
              ).toMatchObject({
                phase: "preparing",
                sourceEnvironmentId: environmentId,
                expectedGeneration: 1,
                destinationEnvironmentId: `pending-vm:${f.request.allocationId}`,
              });
              expect(yield* placements.get(f.request.threadId)).toMatchObject({
                environmentId,
                generation: 1,
                operationId: f.request.allocationId,
              });
              expect((yield* f.allocations.get(f.request.allocationId))?.state).toBe("creating");
              expect(
                yield* makeThreadVmReplacementCoordinator(f.sql, f.objects).runOne(f.hostId),
              ).toBe(false);
            }),
          ),
      );
      for (const revoked of ["credential", "source-link", "generation"] as const) {
        it.effect(`never admits a moved request after its source changes (${revoked})`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture("running", false),
                environmentId = NodeCrypto.randomUUID(),
                credentialId = NodeCrypto.randomUUID();
              yield* makeThreadPlacementStore(f.sql).enroll({
                threadId: f.request.threadId,
                environmentId,
                projectId: "source-project",
                organizationId: "org",
                repositoryId: "repo",
                ownerUserId: f.input.actorUserId,
              });
              yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES(${credentialId},${environmentId},'source-key',${credentialId},'now','now')`;
              yield* f.sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
          VALUES(${f.input.actorUserId},${environmentId},'source-key','https://source.test','wss://source.test','cloudflare','now','now')`;
              yield* f.coordinator.record({
                ...f.replacementInput,
                intent: {
                  kind: "move",
                  threadId: f.request.threadId,
                  operationId: f.request.allocationId,
                  actorUserId: f.input.actorUserId,
                  sourceEnvironmentId: environmentId,
                  expectedGeneration: 1,
                  sourceCredentialId: credentialId,
                  sourcePublicKey: "source-key",
                  sourceAllocationId: null,
                },
              });
              const selected = yield* f.coordinator.select(f.selection);
              f.input.operationId = selected.finalSaveOperationId!;
              if (revoked === "credential")
                yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${credentialId}`;
              if (revoked === "source-link")
                yield* f.sql`UPDATE relay_environment_links SET revoked_at='now' WHERE environment_id=${environmentId}`;
              if (revoked === "generation")
                yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.request.threadId}`;
              yield* f.coordinator.runOne(f.hostId);
              expect(yield* f.coordinator.get(f.request.allocationId)).toMatchObject({
                phase: "cancelled",
                errorCode: "access_or_placement_changed",
              });
              expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("aborting");
            }),
          ),
        );
      }
      it.effect(
        "lowering quota holds the promised request until a policy edit permits admission",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const policies = makeThreadVmPolicyStore(f.sql);
              const original = yield* policies.get("org");
              const larger = yield* policies.update({
                organizationId: "org",
                expectedRevision: original.revision,
                policy: { ...original.policy, maxVmsPerUser: 2 },
              });
              yield* makeThreadVmSetupStore(f.sql).enqueue({
                ...f.request,
                allocationId: NodeCrypto.randomUUID(),
                threadId: ThreadId.make(NodeCrypto.randomUUID()),
                ownerUserId: f.input.actorUserId,
                hostId: f.hostId,
                templateId: "template:build-verified",
              });
              yield* f.choose;
              const smaller = yield* policies.update({
                organizationId: "org",
                expectedRevision: larger.revision,
                policy: { ...larger.policy, maxVmsPerUser: 1 },
              });
              yield* f.remove;
              yield* f.coordinator.runOne(f.hostId);
              expect(yield* f.coordinator.get(f.request.allocationId)).toMatchObject({
                phase: "waiting",
                errorCode: "quota_policy",
              });
              expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
              yield* policies.update({
                organizationId: "org",
                expectedRevision: smaller.revision,
                policy: { ...smaller.policy, maxVmsPerUser: 2 },
              });
              yield* f.coordinator.runOne(f.hostId);
              expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe("admitted");
            }),
          ),
      );
      it.effect("skips a busy owner's quota lock and advances another owner's request", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.record;
            const otherOwner = NodeCrypto.randomUUID(),
              request = {
                ...f.request,
                allocationId: NodeCrypto.randomUUID(),
                threadId: ThreadId.make(NodeCrypto.randomUUID()),
              };
            yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${otherOwner},'admin','now','now')`;
            yield* f.coordinator.record({
              ...f.replacementInput,
              requestId: request.allocationId,
              threadId: request.threadId,
              ownerUserId: otherOwner,
              intent: yield* incomingMove(
                f.sql,
                request.threadId,
                request.allocationId,
                otherOwner,
              ),
            });
            const acquired = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>();
            const held = yield* f.sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* f.sql`SELECT pg_advisory_xact_lock(hashtextextended(${f.input.actorUserId},721864))`;
                  yield* Deferred.succeed(acquired, undefined);
                  yield* Deferred.await(release);
                }),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(acquired);
            expect(yield* f.coordinator.runOne(f.hostId)).toBe(true);
            expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe(
              "awaiting_choice",
            );
            expect((yield* f.coordinator.get(request.allocationId))?.phase).toBe("admitted");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(held);
          }),
        ),
      );
      it.effect("reservation consumption cannot precede the final-save deletion receipt", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.choose;
            yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=2 WHERE organization_id='org'`;
            expect(
              yield* Effect.flip(
                makeThreadVmMoveDestinationStore(f.sql).enqueue({
                  ...f.replacementInput.intent,
                  templateId: "template:build-verified",
                  hostId: f.hostId,
                  cancelBeforeStart: false,
                  replacementRequestId: f.request.allocationId,
                }),
              ),
            ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
            expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
          }),
        ),
      );
      it.effect(
        "saved-only cancellation reconciles old compute removal without provisioning the incoming VM",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.choose;
              yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("deleting");
              yield* f.coordinator.cancel(f.selection);
              expect((yield* f.store.get(f.input.operationId))?.phase).toBe("deleting");
              let destroyed = false;
              yield* makeThreadVmFinalSaveDeletionWorker(
                f.sql,
                f.objects,
                {
                  inspect: () => Effect.succeed(destroyed ? null : f.info),
                  destroy: () =>
                    Effect.sync(() => {
                      destroyed = true;
                    }),
                },
                f.hostId,
              ).runOne();
              expect(destroyed).toBe(true);
              expect((yield* f.coordinator.get(f.request.allocationId))?.phase).toBe("cancelled");
              expect(yield* f.coordinator.runOne(f.hostId)).toBe(false);
              expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(0);
              expect(yield* f.allocations.get(f.request.allocationId)).toBeNull();
            }),
          ),
      );
      it.effect(
        "replacement status and choices stay private, and destructive selection is gated off",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              yield* f.record;
              const db = yield* PgDrizzle.makeWithDefaults();
              const authorized = <A, E, R>(
                effect: Effect.Effect<A, E, R>,
                userId: string = f.input.actorUserId,
              ) =>
                effect.pipe(
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
                  Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                  Effect.provideService(ThreadVmRuntimeConfiguration, { settings: undefined }),
                );
              expect(
                yield* authorized(getThreadVmReplacement(f.request.allocationId)),
              ).toMatchObject({ requestId: f.request.allocationId, phase: "awaiting_choice" });
              expect(
                yield* authorized(getThreadVmReplacementCandidates(f.request.allocationId)),
              ).toEqual([
                {
                  allocationId: f.input.allocationId,
                  threadId: f.threadId,
                  state: "running",
                  title: "Retained history",
                },
              ]);
              expect(
                yield* Effect.flip(
                  authorized(getThreadVmReplacement(f.request.allocationId), "someone-else"),
                ),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              expect(
                yield* Effect.flip(
                  authorized(
                    getThreadVmReplacementCandidates(f.request.allocationId),
                    "someone-else",
                  ),
                ),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              expect(
                yield* Effect.flip(authorized(selectThreadVmReplacement(f.selection))),
              ).toMatchObject({ _tag: "RelayInternalError", reason: "upstream_unavailable" });
              expect(
                yield* authorized(cancelThreadVmReplacement(f.request.allocationId)),
              ).toMatchObject({ phase: "cancelled" });
              expect(
                yield* authorized(getThreadVmReplacementCandidates(f.request.allocationId)),
              ).toEqual([]);
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect(
        "refuses legacy direct creation before selecting a victim and cancels retained requests",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const legacy = {
                ...f.replacementInput,
                intent: { kind: "create" as const, request: f.request },
              };
              expect(yield* Effect.flip(f.coordinator.record(legacy))).toMatchObject({
                message: "thread_vm_move_required",
              });
              const encode = Schema.encodeEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    kind: Schema.Literal("create"),
                    request: RelayThreadVmCreateRequest,
                  }),
                ),
              );
              yield* f.sql`INSERT INTO relay_thread_vm_replacements(request_id,thread_id,organization_id,repository_id,owner_user_id,host_id,template_id,intent_json,phase)
            VALUES(${legacy.requestId},${legacy.threadId},'org','repo',${legacy.ownerUserId},${legacy.hostId},${legacy.templateId},${yield* encode(legacy.intent)},'awaiting_choice')`;
              expect(yield* Effect.flip(f.coordinator.select(f.selection))).toMatchObject({
                message: "thread_vm_move_required",
              });
              expect(yield* f.store.get(f.input.operationId)).toBeNull();
              expect(yield* f.coordinator.runOne(f.hostId)).toBe(true);
              expect(yield* f.coordinator.get(legacy.requestId)).toMatchObject({
                phase: "cancelled",
                errorCode: "thread_vm_move_required",
              });
              expect(yield* f.allocations.get(legacy.requestId)).toBeNull();
              expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("running");
            }),
          ),
      );
      it.effect("host capacity waiting never chooses a replacement victim", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.record;
            yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=2 WHERE organization_id='org'`;
            yield* f.coordinator.runOne(f.hostId);
            expect(yield* f.coordinator.get(f.request.allocationId)).toMatchObject({
              phase: "admitted",
              victimAllocationId: null,
            });
            expect(
              yield* f.sql`SELECT 1 FROM relay_thread_vm_capacity WHERE allocation_id=${f.request.allocationId} AND state='waiting'`,
            ).toHaveLength(1);
            expect(
              yield* f.sql`SELECT 1 FROM relay_thread_vm_final_saves WHERE allocation_id=${f.input.allocationId}`,
            ).toHaveLength(0);
          }),
        ),
      );
    });
  },
);
