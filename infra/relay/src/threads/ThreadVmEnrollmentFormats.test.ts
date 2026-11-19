import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadTransferFormat } from "@t3tools/contracts/relay";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { THREAD_TRANSFER_SUPPORTED_FORMATS } from "@t3tools/shared/threadTransferEncoding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { selectPortableThreadMoveEncoding } from "../http/ThreadMovesApi.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmBindingStore } from "./ThreadVmBindingStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmEnrollmentStore } from "./ThreadVmEnrollmentStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { nativeRestoreTestLayer } from "./testUtils/nativeRestoreCatalog.ts";

const fixture = Effect.fnUntraced(function* (formats?: readonly ThreadTransferFormat[]) {
  const sql = yield* PgClient.PgClient;
  const box = yield* RelaySecretBox;
  const threadId = NodeCrypto.randomUUID(),
    allocationId = NodeCrypto.randomUUID(),
    operationId = NodeCrypto.randomUUID(),
    organizationId = NodeCrypto.randomUUID(),
    ownerUserId = NodeCrypto.randomUUID(),
    hostId = NodeCrypto.randomUUID();
  const sourceEnvironmentId = `source-${threadId}`,
    repositoryId = NodeCrypto.randomUUID();
  yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at)
    VALUES(${organizationId},'Enrollment formats','now','now')`;
  yield* makeThreadPlacementStore(sql).enroll({
    threadId,
    environmentId: sourceEnvironmentId,
    projectId: "project",
    organizationId,
    repositoryId,
    ownerUserId,
  });
  yield* makeThreadVmAllocationStore(sql).reserve({
    allocationId,
    threadId,
    organizationId,
    ownerUserId,
    templateId: "template",
  });
  const capacity = makeThreadVmCapacityStore(sql),
    provisions = makeThreadVmProvisionStore(sql);
  yield* capacity.configure(hostId, 10);
  const intent = { allocationId, operationId, hostId, generation: 2 };
  yield* provisions.enqueue(intent);
  yield* capacity.admitNext(hostId);
  const claimId = NodeCrypto.randomUUID();
  expect(yield* provisions.claim(claimId, hostId)).not.toBeNull();
  const claim = { allocationId, claimId, computeRef: `vm-${allocationId}` };
  yield* provisions.beginCreate({ ...claim, templateId: "template" });
  yield* provisions.recordObserved(claim);
  yield* provisions.recordCreated({
    ...claim,
    sealedTrafficAccessToken: yield* box.seal("private test ingress"),
  });
  const store = makeThreadVmEnrollmentStore(sql),
    seed = yield* store.prepare(intent);
  const input = {
    ...intent,
    seed,
    environmentId: `vm-${allocationId}`,
    environmentPublicKey: "test-key",
    ...(formats === undefined ? {} : { threadTransferFormats: formats }),
  };
  const credentialId = NodeCrypto.randomUUID();
  const response = Redacted.make(`private response ${credentialId}`);
  const bindings = makeThreadVmBindingStore(sql);
  let issues = 0;
  const issue = Effect.gen(function* () {
    issues++;
    yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
      VALUES(${credentialId},${input.environmentId},${input.environmentPublicKey},${credentialId},'now','now')`;
    yield* bindings.bind({ ...input, credentialId });
    return { credentialId, response };
  });
  const receipt = {
    enrolled: true as const,
    environmentId: EnvironmentId.make(input.environmentId),
    threadId: ThreadId.make(threadId),
    allocationId,
    operationId,
    generation: 2,
    ...(formats === undefined ? {} : { threadTransferFormats: formats }),
  };
  return {
    sql,
    store,
    input,
    issue,
    response,
    receipt,
    bindings,
    issues: () => issues,
    ownerUserId,
    organizationId,
    repositoryId,
    sourceEnvironmentId,
    threadId,
  };
});

const noNetwork = EnvironmentConnector.of({
  resolveAccess: () => Effect.die("Fresh-VM selection must not probe an unstarted environment"),
  status: () => Effect.die("Fresh-VM selection must not probe an unstarted environment"),
  connect: () => Effect.die("Fresh-VM selection must not connect a server"),
  dispatchJob: () => Effect.die("Fresh-VM selection must not dispatch work"),
});
const noObjects = ThreadArtifactObjectStorage.of({
  put: () => Effect.die("Selection must not upload artifacts"),
  read: () => Effect.die("Selection must not read artifacts"),
  verify: () => Effect.die("Selection must not verify artifacts"),
  remove: () => Effect.die("Selection must not delete artifacts"),
});
const selectionFixture = Effect.fnUntraced(function* (formats?: readonly ThreadTransferFormat[]) {
  const f = yield* fixture(formats);
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
    VALUES(${f.organizationId},${f.ownerUserId},'admin','now','now')`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at)
    VALUES(${f.repositoryId},${f.organizationId},'Enrollment test repository','now','now')`;
  const principal = {
    environmentId: f.sourceEnvironmentId,
    environmentPublicKey: "source-key",
    credentialId: NodeCrypto.randomUUID(),
  };
  yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
    VALUES(${principal.credentialId},${principal.environmentId},${principal.environmentPublicKey},${principal.credentialId},'now','now')`;
  yield* f.sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
    VALUES(${f.ownerUserId},${principal.environmentId},${principal.environmentPublicKey},'https://source.invalid','wss://source.invalid','manual','now','now')`;
  const placements = makeThreadPlacementStore(f.sql);
  yield* placements.beginMove({
    threadId: f.threadId,
    operationId: f.input.operationId,
    actorUserId: f.ownerUserId,
    sourceEnvironmentId: f.sourceEnvironmentId,
    expectedGeneration: 1,
    destinationEnvironmentId: `pending-vm:${f.input.operationId}`,
    destinationProjectId: `vm:${f.threadId}`,
    sourceThreadTransferFormats: THREAD_TRANSFER_SUPPORTED_FORMATS,
  });
  yield* f.sql`INSERT INTO relay_thread_vm_move_destinations(operation_id,allocation_id)
    VALUES(${f.input.operationId},${f.input.allocationId})`;
  const db = yield* PgDrizzle.makeWithDefaults();
  const select = selectPortableThreadMoveEncoding({
    threadId: f.threadId,
    operationId: f.input.operationId,
    environmentId: f.sourceEnvironmentId,
    generation: 1,
  }).pipe(
    Effect.provideService(RelayDb, db),
    Effect.provideService(RelayEnvironmentPrincipal, principal),
    Effect.provideService(EnvironmentConnector, noNetwork),
    Effect.provideService(ThreadArtifactObjectStorage, noObjects),
  );
  return { ...f, placements, select };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "authenticated VM transfer formats (Postgres)",
  () => {
    layer(nativeRestoreTestLayer)((it) => {
      it.effect(
        "selects fresh-VM v2 after authenticated exchange without requiring installation, artifacts or a running server",
        () =>
          Effect.gen(function* () {
            const f = yield* selectionFixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            expect((yield* f.select).transferEncodingPolicy).toBeNull();
            yield* f.store.exchange(f.input, f.issue);
            const [admitted] =
              yield* f.sql`SELECT installed_at FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
            expect(admitted?.installed_at).toBeNull();
            expect((yield* f.select).transferEncodingPolicy).toBe("workspace-raw-v2-8MiB");
            const [artifacts] = yield* f.sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM relay_thread_artifacts WHERE thread_id=${f.threadId}`;
            expect(artifacts?.count).toBe(0);
          }),
      );
      it.effect(
        "selects v1 for a consumed legacy enrollment rather than treating its missing formats as an unfinished handshake",
        () =>
          Effect.gen(function* () {
            const f = yield* selectionFixture();
            yield* f.store.exchange(f.input, f.issue);
            yield* f.sql`UPDATE relay_thread_vm_enrollments SET thread_transfer_formats_json=NULL WHERE allocation_id=${f.input.allocationId}`;
            expect((yield* f.select).transferEncodingPolicy).toBe("v1-64MiB");
          }),
      );
      for (const mismatch of ["revoked binding", "changed key"] as const)
        it.effect(`does not trust admitted guest capabilities after ${mismatch}`, () =>
          Effect.gen(function* () {
            const f = yield* selectionFixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            yield* f.store.exchange(f.input, f.issue);
            if (mismatch === "revoked binding") yield* f.bindings.revoke(f.input.allocationId);
            else
              yield* f.sql`UPDATE relay_thread_vm_enrollments SET environment_public_key='changed-key' WHERE allocation_id=${f.input.allocationId}`;
            expect((yield* Effect.flip(f.select))._tag).toBe("RelayTenancyNotFoundError");
            expect(
              (yield* f.placements.getMove({
                threadId: f.threadId,
                operationId: f.input.operationId,
              })).transferEncodingPolicy,
            ).toBeNull();
          }),
        );
      it.effect(
        "persists signed enrollment capabilities before server installation and binds lost-reply retries to the normalized set",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            const [before] =
              yield* f.sql`SELECT environment_id,thread_transfer_formats_json FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
            expect(before?.environment_id).toBeNull();
            expect(before?.thread_transfer_formats_json).toBeNull();
            expect(Redacted.value(yield* f.store.exchange(f.input, f.issue))).toBe(
              Redacted.value(f.response),
            );
            const [admitted] =
              yield* f.sql`SELECT thread_transfer_formats_json,installed_at FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
            expect(admitted?.thread_transfer_formats_json).toEqual(
              THREAD_TRANSFER_SUPPORTED_FORMATS,
            );
            expect(admitted?.installed_at).toBeNull();
            expect(
              Redacted.value(
                yield* f.store.exchange(
                  {
                    ...f.input,
                    threadTransferFormats: [...THREAD_TRANSFER_SUPPORTED_FORMATS].toReversed(),
                  },
                  f.issue,
                ),
              ),
            ).toBe(Redacted.value(f.response));
            for (const threadTransferFormats of [
              undefined,
              ["launchpad-thread-chunks-v1"],
              ["launchpad-thread-chunks-v2"],
            ] as const) {
              const input = { ...f.input };
              if (threadTransferFormats === undefined) delete input.threadTransferFormats;
              else input.threadTransferFormats = threadTransferFormats;
              expect((yield* Effect.flip(f.store.exchange(input, f.issue)))._tag).toBe(
                "ThreadVmEnrollmentInvalid",
              );
            }
            expect(f.issues()).toBe(1);
          }),
      );
      it.effect("does not accept a receipt that changes or omits admitted capabilities", () =>
        Effect.gen(function* () {
          const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
          yield* f.store.exchange(f.input, f.issue);
          for (const threadTransferFormats of [
            undefined,
            ["launchpad-thread-chunks-v1"],
            ["launchpad-thread-chunks-v2"],
          ] as const) {
            const receipt = { ...f.receipt };
            if (threadTransferFormats === undefined) delete receipt.threadTransferFormats;
            else receipt.threadTransferFormats = threadTransferFormats;
            expect((yield* Effect.flip(f.store.confirmInstalled(receipt)))._tag).toBe(
              "ThreadVmEnrollmentInvalid",
            );
          }
          const [uninstalled] =
            yield* f.sql`SELECT installed_at,sealed_seed FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
          expect(uninstalled?.installed_at).toBeNull();
          expect(uninstalled?.sealed_seed).not.toBeNull();
          yield* f.store.confirmInstalled({
            ...f.receipt,
            threadTransferFormats: [...THREAD_TRANSFER_SUPPORTED_FORMATS].toReversed(),
          });
          yield* f.store.confirmInstalled(f.receipt);
          const [installed] =
            yield* f.sql`SELECT installed_at,sealed_seed FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
          expect(installed?.installed_at).not.toBeNull();
          expect(installed?.sealed_seed).toBeNull();
          yield* f.bindings.revoke(f.input.allocationId);
          expect((yield* Effect.flip(f.store.confirmInstalled(f.receipt)))._tag).toBe(
            "ThreadVmEnrollmentInvalid",
          );
        }),
      );
      it.effect(
        "keeps omitted and legacy consumed-null capability claims on v1 without upgrading their identity",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.store.exchange(f.input, f.issue);
            const [admitted] =
              yield* f.sql`SELECT thread_transfer_formats_json FROM relay_thread_vm_enrollments WHERE allocation_id=${f.input.allocationId}`;
            expect(admitted?.thread_transfer_formats_json).toEqual(["launchpad-thread-chunks-v1"]);
            // A consumed enrollment created before this migration has a sealed reply but no format column value.
            yield* f.sql`UPDATE relay_thread_vm_enrollments SET thread_transfer_formats_json=NULL WHERE allocation_id=${f.input.allocationId}`;
            expect(Redacted.value(yield* f.store.exchange(f.input, f.issue))).toBe(
              Redacted.value(f.response),
            );
            expect(
              (yield* Effect.flip(
                f.store.exchange(
                  { ...f.input, threadTransferFormats: THREAD_TRANSFER_SUPPORTED_FORMATS },
                  f.issue,
                ),
              ))._tag,
            ).toBe("ThreadVmEnrollmentInvalid");
            yield* f.store.confirmInstalled(f.receipt);
            expect(f.issues()).toBe(1);
          }),
      );
      it.effect(
        "migrates pre-existing moves to their original v1 policy while unfinished enrollments remain unknown",
        () =>
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient,
              fs = yield* FileSystem.FileSystem,
              path = yield* Path.Path;
            const migration = yield* fs.readFileString(
              yield* path.fromFileUrl(
                new URL(
                  "../../migrations/postgres/20261030140128_thread_transfer_encoding/migration.sql",
                  import.meta.url,
                ),
              ),
            );
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`CREATE TEMP TABLE relay_thread_moves(operation_id text PRIMARY KEY) ON COMMIT DROP`;
                yield* sql`CREATE TEMP TABLE relay_thread_vm_enrollments(allocation_id text PRIMARY KEY,environment_id text) ON COMMIT DROP`;
                yield* sql`INSERT INTO relay_thread_moves VALUES('old-pending-move')`;
                yield* sql`INSERT INTO relay_thread_vm_enrollments VALUES('unconsumed',NULL),('legacy-consumed','environment')`;
                for (const statement of migration.split("--> statement-breakpoint"))
                  yield* sql.unsafe(statement);
                const [move] =
                  yield* sql`SELECT source_formats_json,transfer_encoding_policy FROM relay_thread_moves`;
                expect(move?.source_formats_json).toEqual(["launchpad-thread-chunks-v1"]);
                expect(move?.transfer_encoding_policy).toBe("v1-64MiB");
                const enrollments =
                  yield* sql`SELECT thread_transfer_formats_json FROM relay_thread_vm_enrollments`;
                expect(enrollments.map((row) => row.thread_transfer_formats_json)).toEqual([
                  null,
                  null,
                ]);
              }),
            );
          }),
      );
    });
  },
);
