import { CommandId, OrchestrationEvent } from "@t3tools/contracts";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import * as NodeCrypto from "node:crypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { describe, expect, layer } from "@effect/vitest";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Stream from "effect/Stream";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import { RelayDb } from "../db.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { makeThreadVmSavedDiskStore } from "../threads/ThreadVmSavedDiskStore.ts";
import { makeThreadVmRestoreStore } from "../threads/ThreadVmRestoreStore.ts";
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import {
  getPortableThreadHistory,
  getPortableThreadCurrentQueue,
  getPortableThreadPlacement,
  listPortableThreads,
  readPortableThreadAttachment,
} from "./ThreadHistoryApi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const at = "2026-10-07T12:00:00.000Z";
const membership = Effect.fnUntraced(function* (userId: string, role = "admin") {
  const sql = yield* PgClient.PgClient;
  yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at)
    VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at)
    VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
    VALUES('org',${userId},${role},'now','now')`;
});
const listAs = Effect.fnUntraced(function* (userId: string, after?: string, limit = 100) {
  const db = yield* PgDrizzle.makeWithDefaults();
  return yield* listPortableThreads({ limit, ...(after === undefined ? {} : { after }) }).pipe(
    Effect.provideService(RelayDb, db),
    Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
  );
});
const enroll = Effect.fnUntraced(function* (
  ownerUserId: string,
  threadId = NodeCrypto.randomUUID(),
) {
  const sql = yield* PgClient.PgClient;
  yield* makeThreadPlacementStore(sql).enroll({
    threadId,
    ownerUserId,
    organizationId: "org",
    repositoryId: "repo",
    environmentId: `offline-${threadId}`,
    projectId: "project",
  });
  return threadId;
});
const savedThread = Effect.fnUntraced(function* () {
  const f = yield* finalSaveCatalogFixture();
  yield* membership(f.input.actorUserId);
  yield* f.store.begin(f.input);
  const point = yield* f.freeze;
  yield* f.verifyBackup;
  yield* f.store.recordSaved(f.input.operationId);
  const deletion = (yield* f.store.claimDeletion(f.hostId))!;
  yield* f.store.beginDeletion(deletion);
  yield* f.store.confirmDeleted(deletion);
  return { ...f, point, saved: makeThreadVmSavedDiskStore(f.sql) };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "private portable thread discovery (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "shows an active reset before its expired disk until cancellation or completion",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* savedThread(),
                operationId = NodeCrypto.randomUUID(),
                allocationId = NodeCrypto.randomUUID(),
                owner = f.input.actorUserId;
              yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.operationId}`;
              expect(yield* f.saved.completeExpiry((yield* f.saved.claimExpired(f.hostId))!)).toBe(
                true,
              );
              const summary = () => Effect.map(listAs(owner), (page) => page.entries[0]?.vm);
              expect((yield* summary())?.state).toBe("expired");
              yield* f.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state)
              VALUES(${allocationId},${f.threadId},'org',${owner},'template','creating')`;
              yield* f.sql`INSERT INTO relay_thread_vm_resets(operation_id,thread_id,allocation_id,actor_user_id,expected_generation,saved_disk_operation_id,native_checkpoint_operation_id,source_environment_id,source_sequence,host_id,template_id,canonical_key,branch,revision)
              VALUES(${operationId},${f.threadId},${allocationId},${owner},1,${f.input.operationId},${f.point.native.header.operationId},${f.sourceEnvironmentId},${f.point.native.header.sourceSequence},${f.hostId},'template','github.com/acme/test','main',${"a".repeat(40)})`;
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=${operationId} WHERE thread_id=${f.threadId}`;
              for (const phase of ["pending", "creating", "cancelling"]) {
                yield* f.sql`UPDATE relay_thread_vm_resets SET phase=${phase},error_code='retry_pending' WHERE operation_id=${operationId}`;
                expect(yield* summary()).toMatchObject({
                  state: "preparing",
                  savedDiskOperationId: f.input.operationId,
                });
              }
              // A journal that no longer owns this placement cannot hide its expired disk.
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
              expect((yield* summary())?.state).toBe("expired");
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=${operationId} WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_thread_vm_resets SET phase='cancelled' WHERE operation_id=${operationId}`;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp() WHERE allocation_id=${allocationId}`;
              expect((yield* summary())?.state).toBe("expired");
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
              expect((yield* summary())?.state).toBe("expired");
              // Reset import holds the next generation until setup/conversation recovery finishes.
              yield* f.sql`UPDATE relay_thread_vm_resets SET phase='importing' WHERE operation_id=${operationId}`;
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state='paused',deleted_at=NULL,compute_ref=${`replacement-${allocationId}`} WHERE allocation_id=${allocationId}`;
              yield* f.sql`UPDATE relay_thread_placements SET generation=2,environment_id='replacement-vm',operation_id=${operationId} WHERE thread_id=${f.threadId}`;
              expect((yield* summary())?.state).toBe("preparing");
              yield* f.sql`UPDATE relay_thread_placements SET generation=3 WHERE thread_id=${f.threadId}`;
              expect((yield* summary())?.state).toBe("paused");
              yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_thread_vm_resets SET phase='completed' WHERE operation_id=${operationId}`;
              expect((yield* summary())?.state).toBe("paused");
              yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
              expect((yield* summary())?.state).toBe("paused");
            }),
          ),
      );
      it.effect("shows restore preparation instead of saved until abort or completed import", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* savedThread(),
              operationId = NodeCrypto.randomUUID(),
              allocationId = NodeCrypto.randomUUID(),
              owner = f.input.actorUserId;
            const summary = () => Effect.map(listAs(owner), (page) => page.entries[0]?.vm);
            expect((yield* summary())?.state).toBe("saved");
            yield* makeThreadVmRestoreStore(f.sql, f.objects).begin({
              operationId,
              allocationId,
              threadId: f.threadId,
              savedDiskOperationId: f.input.operationId,
              actorUserId: owner,
              expectedGeneration: 1,
              serving: true,
            });
            for (const phase of [
              "pending",
              "preparing",
              "prepared",
              "boot_preparing",
              "boot_prepared",
              "aborting",
            ]) {
              yield* f.sql`UPDATE relay_thread_vm_restores SET phase=${phase},prepare_started_at=clock_timestamp(),prepared_receipt='{}'::jsonb,probe_removed_at=clock_timestamp(),boot_prepare_started_at=clock_timestamp(),boot_receipt='{}'::jsonb,error_code='retry_pending' WHERE operation_id=${operationId}`;
              expect(yield* summary()).toMatchObject({
                state: "preparing",
                savedDiskOperationId: f.input.operationId,
              });
            }
            yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
            expect((yield* summary())?.state).toBe("saved");
            yield* f.sql`UPDATE relay_thread_placements SET operation_id=${operationId} WHERE thread_id=${f.threadId}`;
            yield* f.sql`UPDATE relay_thread_vm_restores SET phase='aborted' WHERE operation_id=${operationId}`;
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET phase='available' WHERE operation_id=${f.input.operationId}`;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at=clock_timestamp() WHERE allocation_id=${allocationId}`;
            expect((yield* summary())?.state).toBe("saved");
            yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
            expect((yield* summary())?.state).toBe("saved");
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state='paused',deleted_at=NULL,compute_ref=${`replacement-${allocationId}`} WHERE allocation_id=${allocationId}`;
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET phase='restoring' WHERE operation_id=${f.input.operationId}`;
            yield* f.sql`UPDATE relay_thread_placements SET generation=2,environment_id='replacement-vm',operation_id=${operationId} WHERE thread_id=${f.threadId}`;
            for (const phase of ["committed", "booted", "importing"]) {
              yield* f.sql`UPDATE relay_thread_vm_restores SET phase=${phase},committed_at=clock_timestamp() WHERE operation_id=${operationId}`;
              expect((yield* summary())?.state).toBe("preparing");
            }
            yield* f.sql`UPDATE relay_thread_placements SET generation=3 WHERE thread_id=${f.threadId}`;
            expect((yield* summary())?.state).toBe("saved");
            yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.threadId}`;
            yield* f.sql`UPDATE relay_thread_vm_restores SET phase='completed' WHERE operation_id=${operationId}`;
            yield* f.sql`UPDATE relay_thread_vm_saved_disks SET phase='restored' WHERE operation_id=${f.input.operationId}`;
            expect((yield* summary())?.state).toBe("paused");
            yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
            expect((yield* summary())?.state).toBe("paused");
          }),
        ),
      );
      it.effect(
        "reads the applied queue beyond history pages and updates it with the journal transaction",
        () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient,
              owner = NodeCrypto.randomUUID();
            yield* membership(owner);
            const threadId = yield* enroll(owner),
              environmentId = `offline-${threadId}`;
            const db = yield* PgDrizzle.makeWithDefaults();
            const queueEvent = (
              sequence: number,
              revision: number,
              enabled: boolean,
              commandId: CommandId | null = null,
            ) =>
              decodeEvent({
                type: "thread.prompt-queue-changed",
                eventId: `queue-${threadId}-${sequence}`,
                sequence,
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt: at,
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId,
                  control: { enabled, revision, pauseReason: null },
                  updatedAt: at,
                },
              });
            const read = (commandId?: CommandId) =>
              getPortableThreadCurrentQueue(threadId, commandId).pipe(
                Effect.provideService(RelayDb, db),
                Effect.provideService(RelayClientPrincipal, { userId: owner, token: "test" }),
              );
            const commandId = CommandId.make(`control-${threadId}`);
            expect(yield* read(commandId)).toMatchObject({ cursor: 0, appliedCommandId: null });
            for (let cursor = 1; cursor <= 201; cursor++)
              yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json) VALUES(${threadId},${cursor},${environmentId},${cursor},${encodeJson({ type: "thread.message-sent", payload: { text: "Not needed by the queue" } })}::jsonb)`;
            yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json) VALUES(${threadId},202,${environmentId},202,${encodeJson(queueEvent(202, 3, false))}::jsonb)`;
            expect(yield* read()).toMatchObject({
              threadId,
              generation: 1,
              cursor: 202,
              appliedCommandId: null,
              queue: { revision: 3, enabled: false },
            });
            const journal = makeThreadJournalStore(sql);
            expect((yield* read(commandId)).appliedCommandId).toBeNull();
            const event = queueEvent(203, 4, true, commandId);
            yield* journal.append({ threadId, environmentId, generation: 1, event });
            yield* journal.append({ threadId, environmentId, generation: 1, event });
            expect(yield* read()).toMatchObject({
              cursor: 203,
              appliedCommandId: null,
              queue: { revision: 4, enabled: true },
            });
            expect((yield* read(commandId)).appliedCommandId).toBe(commandId);
            expect((yield* read(CommandId.make("different-request"))).appliedCommandId).toBeNull();
            // A copied older source delta cannot re-enable or overwrite a newer applied revision.
            yield* journal.append({
              threadId,
              environmentId,
              generation: 1,
              event: queueEvent(204, 2, false),
            });
            expect(yield* read()).toMatchObject({
              cursor: 204,
              appliedCommandId: null,
              queue: { revision: 4, enabled: true },
            });
            const added = decodeEvent({
              ...queueEvent(205, 4, true),
              eventId: `entry-${threadId}`,
              payload: {
                threadId,
                entry: {
                  kind: "move",
                  messageId: `move-${threadId}`,
                  destination: { kind: "vm" },
                  revision: 1,
                  acceptedSequence: 205,
                  createdAt: at,
                  state: "pending",
                },
                updatedAt: at,
              },
            });
            yield* journal.append({ threadId, environmentId, generation: 1, event: added });
            expect((yield* read()).queue.entries).toHaveLength(1);
            yield* journal.append({
              threadId,
              environmentId,
              generation: 1,
              event: decodeEvent({
                ...queueEvent(206, 4, true),
                payload: { threadId, removedMessageId: `move-${threadId}`, updatedAt: at },
              }),
            });
            yield* journal.append({
              threadId,
              environmentId,
              generation: 1,
              event: { ...added, sequence: 207 },
            });
            expect((yield* read()).queue.entries).toEqual([]);
            const foreignThreadId = yield* enroll(owner),
              foreignCommandId = CommandId.make(`foreign-control-${threadId}`),
              nonQueueCommandId = CommandId.make(`message-only-${threadId}`);
            yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json)
              VALUES(${foreignThreadId},1,'foreign-environment',1,${encodeJson({
                ...queueEvent(1, 1, true, foreignCommandId),
                aggregateId: foreignThreadId,
                payload: { ...queueEvent(1, 1, true).payload, threadId: foreignThreadId },
              })}::jsonb)`;
            yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json)
              VALUES(${threadId},208,${environmentId},500,${encodeJson({ type: "thread.message-sent", commandId: nonQueueCommandId })}::jsonb)`;
            expect((yield* read(foreignCommandId)).appliedCommandId).toBeNull();
            expect((yield* read(nonQueueCommandId)).appliedCommandId).toBeNull();
            // Exact proof remains valid after the placement changes; no sequence/generation shortcut.
            const newEnvironmentId = `replacement-${threadId}`,
              newCommandId = CommandId.make(`new-vm-control-${threadId}`);
            yield* sql`UPDATE relay_thread_placements SET generation=2,environment_id=${newEnvironmentId}
              WHERE thread_id=${threadId}`;
            expect(yield* read(commandId)).toMatchObject({
              generation: 2,
              appliedCommandId: commandId,
            });
            expect((yield* read(newCommandId)).appliedCommandId).toBeNull();
            yield* journal.append({
              threadId,
              environmentId: newEnvironmentId,
              generation: 2,
              event: queueEvent(1, 5, false, newCommandId),
            });
            expect(yield* read(newCommandId)).toMatchObject({
              generation: 2,
              appliedCommandId: newCommandId,
              queue: { revision: 5, enabled: false },
            });
            const denied = yield* Effect.flip(
              getPortableThreadCurrentQueue(threadId).pipe(
                Effect.provideService(RelayDb, db),
                Effect.provideService(RelayClientPrincipal, { userId: "foreign", token: "test" }),
              ),
            );
            expect(denied._tag).toBe("RelayTenancyNotFoundError");
          }),
      );
      it.effect("exposes authenticated previous locations only from completed older moves", () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient,
            owner = NodeCrypto.randomUUID();
          yield* membership(owner);
          const threadId = yield* enroll(owner),
            foreignId = yield* enroll(owner);
          yield* sql`UPDATE relay_thread_placements SET generation=3,environment_id='current-vm' WHERE thread_id=${threadId}`;
          for (const [id, generation, phase, source] of [
            [threadId, 1, "completed", "old-local"],
            [threadId, 2, "aborted", "not-committed"],
            [threadId, 3, "completed", "not-older"],
            [foreignId, 1, "completed", "other-thread"],
          ] as const)
            yield* sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256) VALUES(${NodeCrypto.randomUUID()},${id},${owner},${source},${generation},'current-vm','project',${phase},0,${"a".repeat(64)})`;
          const page = yield* listAs(owner);
          expect(
            page.entries.find((entry) => entry.placement.threadId === threadId)?.placement
              .previousLocations,
          ).toEqual([{ environmentId: "old-local", generation: 1 }]);
          const db = yield* PgDrizzle.makeWithDefaults();
          const read = (userId: string) =>
            getPortableThreadPlacement(threadId).pipe(
              Effect.provideService(RelayDb, db),
              Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
            );
          expect((yield* read(owner)).previousLocations).toEqual([
            { environmentId: "old-local", generation: 1 },
          ]);
          expect((yield* Effect.flip(read("foreign")))._tag).toBe("RelayTenancyNotFoundError");
          yield* sql`DELETE FROM relay_organization_members WHERE user_id=${owner}`;
          expect((yield* listAs(owner)).entries).toEqual([]);
          expect((yield* Effect.flip(read(owner)))._tag).toBe("RelayTenancyNotFoundError");
        }),
      );
      it.effect(
        "lists and reads the full conversation after compute deletion and saved disk expiry",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture();
              const owner = f.input.actorUserId;
              yield* membership(owner);
              yield* f.store.begin(f.input);
              const packed = yield* f.freeze;
              yield* f.verifyBackup;
              yield* f.store.recordSaved(f.input.operationId);
              const deletion = (yield* f.store.claimDeletion(f.hostId))!;
              yield* f.store.beginDeletion(deletion);
              yield* f.store.confirmDeleted(deletion);
              yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days' WHERE operation_id=${f.input.operationId}`;
              const saved = makeThreadVmSavedDiskStore(f.sql),
                expiry = (yield* saved.claimExpired(f.hostId))!;
              expect(yield* saved.completeExpiry(expiry)).toBe(true);
              const page = yield* listAs(owner);
              expect(page.next).toBeNull();
              expect(page.entries).toHaveLength(1);
              expect(page.entries[0]).toMatchObject({
                vm: { state: "expired", activity: "unknown" },
                title: "Retained history",
                modelSelection: { instanceId: "codex", model: "gpt-5" },
                placement: {
                  threadId: f.threadId,
                  environmentId: f.sourceEnvironmentId,
                  generation: 1,
                },
              });
              const db = yield* PgDrizzle.makeWithDefaults();
              const history = yield* getPortableThreadHistory({
                threadId: f.threadId,
                after: 0,
                limit: 200,
              }).pipe(
                Effect.provideService(RelayDb, db),
                Effect.provideService(RelayClientPrincipal, { userId: owner, token: "test" }),
              );
              expect(history.entries.map((entry) => entry.event)).toEqual(packed.history);
              const before = yield* f.sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins WHERE expires_at IS NOT NULL`;
              const read = () =>
                readPortableThreadAttachment({
                  threadId: f.threadId,
                  attachmentId: packed.attachments.header.attachments.files[0]!.attachment.id,
                }).pipe(
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(RelayClientPrincipal, { userId: owner, token: "test" }),
                  Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                );
              const body = yield* read();
              const bytes = yield* Stream.runCollect(body);
              expect(
                new TextDecoder().decode(
                  Uint8Array.from(Array.from(bytes).flatMap((part) => Array.from(part))),
                ),
              ).toBe("notes");
              expect(
                (yield* f.sql<{
                  count: number;
                }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins WHERE expires_at IS NOT NULL`)[0]
                  ?.count,
              ).toBe(before[0]?.count);
              const foreign = NodeCrypto.randomUUID();
              yield* membership(foreign);
              const denial = yield* Effect.flip(
                readPortableThreadAttachment({
                  threadId: f.threadId,
                  attachmentId: packed.attachments.header.attachments.files[0]!.attachment.id,
                }).pipe(
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(RelayClientPrincipal, { userId: foreign, token: "test" }),
                  Effect.provideService(ThreadArtifactObjectStorage, f.objects),
                ),
              );
              expect(denial).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              const [stored] = yield* f.sql<{
                storageKey: string;
              }>`SELECT storage_key AS "storageKey" FROM relay_thread_artifacts
              WHERE operation_id=${packed.attachments.header.operationId} AND kind='attachment' AND sha256=${packed.attachments.header.attachments.files[0]!.sha256} LIMIT 1`;
              expect(stored).toBeDefined();
              yield* f.objects.remove(stored!.storageKey);
              expect(yield* Effect.flip(read())).toMatchObject({ _tag: "RelayInternalError" });
              expect(
                (yield* f.sql<{
                  count: number;
                }>`SELECT count(*)::int AS count FROM relay_thread_artifact_pins WHERE expires_at IS NOT NULL`)[0]
                  ?.count,
              ).toBe(before[0]?.count);

              expect(
                history.entries.find((entry) => entry.event.type === "thread.message-sent")?.event
                  .payload,
              ).toMatchObject({ attachments: [{ name: "notes.txt" }] });
              // Returning to a machine must not inherit a previous generation's expired disk.
              yield* f.sql`UPDATE relay_thread_placements SET environment_id='returned-local',generation=2 WHERE thread_id=${f.threadId}`;
              expect((yield* listAs(owner)).entries[0]).toMatchObject({
                placement: { generation: 2, environmentId: "returned-local" },
                vm: { state: "on_machine", lastWorkAt: null, savedDiskExpiresAt: null },
              });
            }),
          ),
      );
      it.effect(
        "paginates only the private owner's currently accessible threads and hides tombstones and aborted enrollments",
        () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient,
              owner = NodeCrypto.randomUUID(),
              foreign = NodeCrypto.randomUUID();
            yield* membership(owner, "member");
            yield* membership(foreign);
            yield* sql`INSERT INTO relay_repository_access(organization_id,repository_id,user_id,role,created_at,updated_at)
        VALUES('org','repo',${owner},'developer','now','now')`;
            const prefix = NodeCrypto.randomUUID(),
              ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`, `${prefix}-d`];
            for (const id of ids) yield* enroll(owner, id);
            for (const [index, id] of ids.slice(0, 2).entries())
              yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,compute_ref,state)
              VALUES(${NodeCrypto.randomUUID()},${id},'org',${owner},'template',${`compute-${id}`},${index === 1 ? "paused" : "creating"})`;
            yield* enroll(foreign);
            yield* sql`INSERT INTO relay_thread_deletions(thread_id,operation_id,owner_user_id,generation,host_id,phase)
        VALUES(${ids[2]},${NodeCrypto.randomUUID()},${owner},1,'host','stopping')`;
            yield* sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id,phase)
        VALUES(${ids[3]},${NodeCrypto.randomUUID()},'aborted')`;
            const first = yield* listAs(owner, undefined, 1);
            expect(first.entries.map((x) => x.placement.threadId)).toEqual([ids[0]]);
            expect(first.next).toBe(ids[0]);
            expect(first.allowance).toEqual({ used: 2, limit: 3 });
            const second = yield* listAs(owner, first.next!, 1);
            expect(second.entries.map((x) => x.placement.threadId)).toEqual([ids[1]]);
            expect(second.next).toBeNull();
            expect(second.entries[0]?.vm?.state).toBe("paused");
            expect(second.allowance).toEqual({ used: 2, limit: 3 });
            expect((yield* listAs(foreign)).entries.map((x) => x.placement.ownerUserId)).toEqual([
              foreign,
            ]);
            yield* sql`DELETE FROM relay_repository_access WHERE user_id=${owner}`;
            expect(yield* listAs(owner)).toEqual({
              entries: [],
              allowance: { used: 2, limit: 3 },
              next: null,
            });
            yield* sql`DELETE FROM relay_organization_members WHERE user_id=${foreign}`;
            expect(yield* listAs(foreign)).toEqual({ entries: [], next: null });
          }),
      );
      it.effect(
        "shows initial VM metadata before setup and orders later renames by relay cursor across moves",
        () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient,
              owner = NodeCrypto.randomUUID(),
              allocation = NodeCrypto.randomUUID();
            yield* membership(owner);
            const threadId = yield* enroll(owner);
            yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state)
        VALUES(${allocation},${threadId},'org',${owner},'template','creating')`;
            const initial = encodeJson({
              title: "Preparing a VM",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              createdAt: at,
            });
            yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,initial_state)
        VALUES(${allocation},'github.com/acme/test','main',${"a".repeat(40)},'pending',${initial})`;
            expect((yield* listAs(owner)).entries[0]).toMatchObject({
              title: "Preparing a VM",
              vm: { state: "preparing", activity: "unknown", projectName: "Tests" },
              createdAt: at,
              updatedAt: at,
            });
            expect((yield* listAs(owner)).allowance).toEqual({ used: 1, limit: 3 });
            for (const [cursor, sequence, title] of [
              [1, 99, "First title"],
              [2, 1, "Latest title"],
            ] as const) {
              const event = encodeJson({
                type: "thread.meta-updated",
                occurredAt: at,
                payload: { threadId, title, updatedAt: at },
              });
              yield* sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json)
          VALUES(${threadId},${cursor},${`source-${cursor}`},${sequence},${event}::jsonb)`;
            }
            expect((yield* listAs(owner)).entries[0]).toMatchObject({
              title: "Latest title",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            });
          }),
      );
    });
  },
);
