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
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import {
  getPortableThreadHistory,
  listPortableThreads,
  readPortableThreadAttachment,
} from "./ThreadHistoryApi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "private portable thread discovery (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
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
            yield* enroll(foreign);
            yield* sql`INSERT INTO relay_thread_deletions(thread_id,operation_id,owner_user_id,generation,host_id,phase)
        VALUES(${ids[2]},${NodeCrypto.randomUUID()},${owner},1,'host','stopping')`;
            yield* sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id,phase)
        VALUES(${ids[3]},${NodeCrypto.randomUUID()},'aborted')`;
            const first = yield* listAs(owner, undefined, 1);
            expect(first.entries.map((x) => x.placement.threadId)).toEqual([ids[0]]);
            expect(first.next).toBe(ids[0]);
            const second = yield* listAs(owner, first.next!, 1);
            expect(second.entries.map((x) => x.placement.threadId)).toEqual([ids[1]]);
            expect(second.next).toBeNull();
            expect((yield* listAs(foreign)).entries.map((x) => x.placement.ownerUserId)).toEqual([
              foreign,
            ]);
            yield* sql`DELETE FROM relay_repository_access WHERE user_id=${owner}`;
            expect(yield* listAs(owner)).toEqual({ entries: [], next: null });
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
              createdAt: at,
              updatedAt: at,
            });
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
