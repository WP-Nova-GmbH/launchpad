import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { RelayDb } from "../db.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmBackupRetentionWorker } from "./ThreadVmBackupRetentionWorker.ts";
import { makeThreadVmActivityWorker } from "./ThreadVmActivityWorker.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { threadVmQuotaUsage } from "./ThreadVmQuota.ts";
import { confirmThreadVmCleanupIdentity } from "./ThreadVmCleanupIdentity.ts";
import { finalSaveCatalogFixture } from "./testUtils/finalSaveCatalog.ts";
import { nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";

const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(nativeRestoreTestLayer),
);
const never = () => Effect.die("A legacy VM must not reach any native SDK or guest operation");
const migration = new URL(
  "../../migrations/postgres/20261028221922_thread_vm_runtime_protocol/migration.sql",
  import.meta.url,
);

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "stock runtime protocol preservation (Postgres)",
  () => {
    layer(services)((it) => {
      it.effect(
        "backfills existing allocations as legacy without changing their data, then defaults only new rows to native",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture("paused");
              const [before] = yield* f.sql<{
                value: unknown;
              }>`SELECT to_jsonb(a)-'runtime_protocol' AS value FROM relay_thread_vm_allocations a WHERE allocation_id=${f.input.allocationId}`;
              // This test owns a disposable database. Reproduce the pre-upgrade table shape.
              yield* f.sql`ALTER TABLE relay_thread_vm_allocations DROP COLUMN runtime_protocol`;
              const fs = yield* FileSystem.FileSystem,
                path = yield* Path.Path;
              const ddl = yield* fs.readFileString(yield* path.fromFileUrl(migration));
              for (const statement of ddl.split("--> statement-breakpoint"))
                if (statement.trim()) yield* f.sql.unsafe(statement);
              const [old] = yield* f.sql<{
                protocol: string;
                value: unknown;
              }>`SELECT runtime_protocol AS protocol,to_jsonb(a)-'runtime_protocol' AS value FROM relay_thread_vm_allocations a WHERE allocation_id=${f.input.allocationId}`;
              expect(old?.protocol).toBe("legacy");
              expect(old?.value).toEqual(before?.value);
              expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
              const threadId = NodeCrypto.randomUUID(),
                allocationId = NodeCrypto.randomUUID();
              yield* f.sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id)
        SELECT ${threadId},organization_id,repository_id,owner_user_id,environment_id,'new-project' FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
              yield* f.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state)
        VALUES(${allocationId},${threadId},'org',${f.input.actorUserId},'new-template','creating')`;
              expect((yield* f.allocations.get(allocationId))?.runtimeProtocol).toBe("native-v1");
            }),
          ),
      );
      it.effect(
        "legacy paused VMs keep quota, credentials and snapshots while all native workers and explicit actions refuse them",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* finalSaveCatalogFixture("paused");
              yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${f.input.allocationId}`;
              const before =
                yield* f.sql`SELECT to_jsonb(a) AS value FROM relay_thread_vm_allocations a WHERE allocation_id=${f.input.allocationId}`;
              const snapshots =
                yield* f.sql`SELECT to_jsonb(x) AS value FROM relay_thread_vm_backups x WHERE allocation_id=${f.input.allocationId}`;
              expect(
                yield* makeThreadVmPauseWorker(
                  f.sql,
                  { inspect: never, pause: never },
                  { seal: never, reopen: never },
                  f.hostId,
                ).runOne(),
              ).toBe(false);
              expect(
                yield* makeThreadVmBackupWorker(
                  f.sql,
                  {
                    inspect: never,
                    snapshot: never,
                    findSnapshot: never,
                    restore: { resolveNamedSnapshot: never, resolveFailedNamedSnapshot: never },
                  },
                  f.hostId,
                ).runOne(),
              ).toBe(false);
              expect(
                yield* makeThreadVmBackupRetentionWorker(
                  f.sql,
                  { deleteSnapshot: never },
                  f.hostId,
                ).runOne(),
              ).toBe(false);
              expect(yield* makeThreadVmActivityWorker(f.sql, never, f.hostId).runOne()).toBe(
                false,
              );
              expect(
                yield* makeThreadVmLeaseWorker(f.sql, never, f.hostId, { inspect: never }).runOne(),
              ).toBe(false);
              expect(
                yield* confirmThreadVmCleanupIdentity(
                  f.sql,
                  { inspect: never },
                  {
                    allocationId: f.input.allocationId,
                    threadId: f.threadId,
                    operationId: f.input.allocationId,
                    generation: 1,
                    computeRef: f.computeRef,
                  },
                ),
              ).toBe(false);
              yield* Effect.flip(makeThreadVmResumeStore(f.sql).request(f.threadId));
              yield* Effect.flip(f.store.begin(f.input));
              yield* Effect.flip(f.allocations.requestDeletion(f.input.allocationId));
              yield* Effect.flip(
                f.allocations.confirmDeleted({
                  allocationId: f.input.allocationId,
                  computeRef: f.computeRef,
                }),
              );
              yield* Effect.flip(
                makeThreadPlacementStore(f.sql).beginMove({
                  threadId: f.threadId,
                  operationId: NodeCrypto.randomUUID(),
                  actorUserId: f.input.actorUserId,
                  sourceEnvironmentId: f.sourceEnvironmentId,
                  expectedGeneration: 1,
                  destinationEnvironmentId: "local",
                  destinationProjectId: "original",
                }),
              );
              expect(
                yield* f.sql`SELECT to_jsonb(a) AS value FROM relay_thread_vm_allocations a WHERE allocation_id=${f.input.allocationId}`,
              ).toEqual(before);
              expect(
                yield* f.sql`SELECT to_jsonb(x) AS value FROM relay_thread_vm_backups x WHERE allocation_id=${f.input.allocationId}`,
              ).toEqual(snapshots);
              expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
            }),
          ),
      );
      it.effect("legacy pending creates cannot be claimed, started or silently cancelled", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* finalSaveCatalogFixture();
            yield* f.sql`UPDATE relay_thread_vm_provisions SET phase='pending' WHERE allocation_id=${f.input.allocationId}`;
            yield* f.sql`UPDATE relay_thread_vm_capacity SET state='reserved',compute_ref=NULL WHERE allocation_id=${f.input.allocationId}`;
            yield* f.sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy',state='creating',compute_ref=NULL,sealed_traffic_access_token=NULL WHERE allocation_id=${f.input.allocationId}`;
            const before =
              yield* f.sql`SELECT to_jsonb(p) AS value FROM relay_thread_vm_provisions p WHERE allocation_id=${f.input.allocationId}`;
            expect(
              yield* makeThreadVmProvisionWorker(
                f.sql,
                { create: never, recoverIngress: never, findOperation: never },
                "template:build-verified",
                f.hostId,
              ).runOne(),
            ).toBe(false);
            yield* Effect.flip(
              makeThreadVmProvisionStore(f.sql).enqueue({
                allocationId: f.input.allocationId,
                operationId: f.input.allocationId,
                generation: 1,
                hostId: f.hostId,
              }),
            );
            expect(
              yield* f.sql`SELECT to_jsonb(p) AS value FROM relay_thread_vm_provisions p WHERE allocation_id=${f.input.allocationId}`,
            ).toEqual(before);
            expect((yield* f.allocations.get(f.input.allocationId))?.state).toBe("creating");
            expect(yield* threadVmQuotaUsage(f.sql, f.input.actorUserId)).toBe(1);
          }),
        ),
      );
    });
  },
);
