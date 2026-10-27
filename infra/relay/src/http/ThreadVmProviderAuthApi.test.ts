import * as NodeCrypto from "node:crypto";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { describe, expect, layer } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { RelayClientPrincipal, type ThreadVmProviderAuthControl } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayDb } from "../db.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import { finalSaveCatalogFixture } from "../threads/testUtils/finalSaveCatalog.ts";
import { readPendingThreadVmProviderAuth } from "../threads/ThreadVmPendingProviderAuth.ts";
import { getThreadVmStatus } from "./ThreadVmsApi.ts";
import { threadVmProviderAuth } from "./ThreadVmProviderAuthApi.ts";

const guest = vi.hoisted(() => ({
  calls: 0,
  after: undefined as (() => Effect.Effect<void>) | undefined,
}));
vi.mock("../machines/E2BThreadVmProviderAuth.ts", () => ({
  makeE2BThreadVmProviderAuth: () => (input: { control: ThreadVmProviderAuthControl }) =>
    Effect.gen(function* () {
      guest.calls++;
      if (guest.after) yield* guest.after();
      return {
        ...input.control.binding,
        requirement: "sign_in_required",
        auth: {
          instanceId: ProviderInstanceId.make("codex"),
          phase: "idle",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          interaction: null,
          message: null,
        },
      };
    }),
}));
const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(nativeCheckpointCatalogTestLayer),
);
const fixture = Effect.fnUntraced(function* () {
  const sql = (yield* RelayDb).$client;
  const threadId = NodeCrypto.randomUUID(),
    operationId = NodeCrypto.randomUUID(),
    allocationId = NodeCrypto.randomUUID(),
    owner = NodeCrypto.randomUUID(),
    organizationId = NodeCrypto.randomUUID(),
    repositoryId = NodeCrypto.randomUUID(),
    credentialId = NodeCrypto.randomUUID(),
    hostId = NodeCrypto.randomUUID(),
    environmentId = EnvironmentId.make(NodeCrypto.randomUUID());
  guest.calls = 0;
  guest.after = undefined;
  yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES(${organizationId},'Tests','now','now')`;
  yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES(${repositoryId},${organizationId},'Tests','now','now')`;
  yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES(${organizationId},${owner},'member','now','now')`;
  yield* sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at) VALUES(${repositoryId},${organizationId},${owner},'developer','now','now')`;
  yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id,generation,operation_id)
    VALUES(${threadId},${organizationId},${repositoryId},${owner},'local','project',1,${operationId})`;
  yield* sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase)
    VALUES(${operationId},${threadId},${owner},'local',1,${environmentId},${`vm:${threadId}`},'preparing')`;
  yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
    VALUES(${allocationId},${threadId},${organizationId},${owner},'template:build','running','sandbox-'||${allocationId})`;
  yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES(${allocationId},${operationId},2,'created')`;
  yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
    VALUES(${credentialId},${environmentId},'key',${credentialId},'now','now')`;
  yield* sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
    VALUES(${environmentId},${allocationId},${threadId},${repositoryId},2,'key',${credentialId})`;
  yield* sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,installed_at)
    VALUES(${allocationId},${operationId},${credentialId},clock_timestamp(),${environmentId},'key','sealed',${credentialId},clock_timestamp())`;
  yield* sql`INSERT INTO relay_thread_vm_hosts(host_id,max_running_vms) VALUES(${hostId},3)`;
  yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref)
    VALUES(${operationId},${allocationId},${hostId},'create','started','sandbox-'||${allocationId})`;
  const settings = {
    compute: {
      apiUrl: "http://e2b.test",
      sandboxUrl: "http://ingress.test",
      apiKey: Redacted.make("secret"),
      templateId: "template:build",
      hostAddresses: [],
      timeoutMs: 600000,
    },
    templateBuildId: "build",
    hostId,
    maxRunningVms: 3,
    publicRelayUrl: "https://relay.test",
    autoPauseEnabled: false,
    autoBackupEnabled: false,
    autoDeleteEnabled: false,
    replacementEnabled: false,
    restoreEnabled: false,
    resetEnabled: false,
  };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, userId = owner) =>
    effect.pipe(
      Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
      Effect.provideService(ThreadVmRuntimeConfiguration, { settings }),
    );
  return {
    sql,
    threadId,
    operationId,
    allocationId,
    owner,
    organizationId,
    repositoryId,
    credentialId,
    environmentId,
    request: { operationId, allocationId, generation: 2 },
    provide,
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "private pending VM sign-in (Postgres)",
  () => {
    layer(services)((it) => {
      it.effect(
        "discovers next-generation auth on a local source without contacting compute for status",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            const status = yield* f.provide(getThreadVmStatus(f.threadId));
            expect(status.pendingProviderAuth).toEqual({
              ...f.request,
              environmentId: f.environmentId,
              instanceId: "codex",
            });
            expect(guest.calls).toBe(0);
            const auth = yield* f.provide(threadVmProviderAuth(f.threadId, "status"));
            expect(auth?.requirement).toBe("sign_in_required");
            expect(guest.calls).toBe(1);
            const [placement] =
              yield* f.sql`SELECT environment_id,generation FROM relay_thread_placements WHERE thread_id=${f.threadId}`;
            expect(placement).toEqual({ environment_id: "local", generation: 1 });
          }),
      );
      it.effect("rejects other users, even organization administrators", () =>
        Effect.gen(function* () {
          const f = yield* fixture(),
            other = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES(${f.organizationId},${other},'admin','now','now')`;
          const error = yield* f
            .provide(threadVmProviderAuth(f.threadId, "start", f.request), other)
            .pipe(Effect.flip);
          expect(error._tag).toBe("RelayTenancyNotFoundError");
          expect(guest.calls).toBe(0);
        }),
      );
      it.effect("rejects stale mutation intent before touching the guest", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          for (const request of [
            { ...f.request, generation: 3 },
            { ...f.request, allocationId: "other" },
            { ...f.request, operationId: "other" },
          ]) {
            const error = yield* f
              .provide(threadVmProviderAuth(f.threadId, "start", request))
              .pipe(Effect.flip);
            expect(error._tag).toBe("RelayTenancyConflictError");
          }
          expect(guest.calls).toBe(0);
        }),
      );
      it.effect("rejects revoked repository access and revoked guest credentials", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.sql`DELETE FROM relay_repository_access WHERE repository_id=${f.repositoryId} AND user_id=${f.owner}`;
          expect(
            (yield* f.provide(threadVmProviderAuth(f.threadId, "status")).pipe(Effect.flip))._tag,
          ).toBe("RelayTenancyNotFoundError");
          yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at) VALUES(${f.repositoryId},${f.organizationId},${f.owner},'developer','now','now')`;
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.credentialId}`;
          expect(yield* f.provide(threadVmProviderAuth(f.threadId, "status"))).toBeNull();
          expect(guest.calls).toBe(0);
        }),
      );
      it.effect("stops discovery after cancellation or placement cutover", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.sql`UPDATE relay_thread_moves SET phase='aborting' WHERE operation_id=${f.operationId}`;
          expect(yield* f.provide(threadVmProviderAuth(f.threadId, "status"))).toBeNull();
          yield* f.sql`UPDATE relay_thread_moves SET phase='preparing' WHERE operation_id=${f.operationId}`;
          yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.threadId}`;
          expect(yield* f.provide(threadVmProviderAuth(f.threadId, "status"))).toBeNull();
          expect(guest.calls).toBe(0);
        }),
      );
      it.effect("rechecks the exact pending target after a guest reply", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          guest.after = () =>
            f.sql`UPDATE relay_thread_moves SET phase='aborting' WHERE operation_id=${f.operationId}`.pipe(
              Effect.asVoid,
              Effect.orDie,
            );
          expect(
            (yield* f
              .provide(threadVmProviderAuth(f.threadId, "start", f.request))
              .pipe(Effect.flip))._tag,
          ).toBe("RelayTenancyConflictError");
          expect(guest.calls).toBe(1);
        }),
      );
      for (const kind of ["reset", "restore"] as const) {
        it.effect(
          `discovers sign-in only during ${kind} import, then hides it after cancellation`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* finalSaveCatalogFixture();
                yield* f.store.begin(f.input);
                const point = yield* f.freeze;
                yield* f.verifyBackup;
                yield* f.store.recordSaved(f.input.operationId);
                const deletion = (yield* f.store.claimDeletion(f.hostId))!;
                yield* f.store.beginDeletion(deletion);
                yield* f.store.confirmDeleted(deletion);
                const op = NodeCrypto.randomUUID(),
                  allocation = NodeCrypto.randomUUID(),
                  credential = NodeCrypto.randomUUID(),
                  environment = NodeCrypto.randomUUID();
                yield* f.sql`UPDATE relay_thread_placements SET operation_id=${op},environment_id=${environment},generation=2 WHERE thread_id=${f.threadId}`;
                yield* f.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
          VALUES(${allocation},${f.threadId},'org',${f.input.actorUserId},'template:build','running',${`sandbox-${allocation}`})`;
                yield* f.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES(${allocation},${op},2,'created')`;
                yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES(${credential},${environment},'key',${credential},'now','now')`;
                yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
          VALUES(${environment},${allocation},${f.threadId},'repo',2,'key',${credential})`;
                yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,installed_at)
          VALUES(${allocation},${op},${credential},clock_timestamp(),${environment},'key','sealed',${credential},clock_timestamp())`;
                yield* f.sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref)
          VALUES(${op},${allocation},${f.hostId},'create','started',${`sandbox-${allocation}`})`;
                if (kind === "reset")
                  yield* f.sql`INSERT INTO relay_thread_vm_resets(operation_id,thread_id,allocation_id,actor_user_id,expected_generation,saved_disk_operation_id,native_checkpoint_operation_id,source_environment_id,source_sequence,host_id,template_id,canonical_key,branch,revision,phase)
          VALUES(${op},${f.threadId},${allocation},${f.input.actorUserId},1,${f.input.operationId},${point.native.header.operationId},${f.sourceEnvironmentId},0,${f.hostId},'template:build','github.com/acme/test','main',${"a".repeat(40)},'importing')`;
                else
                  yield* f.sql`INSERT INTO relay_thread_vm_restores(operation_id,saved_disk_operation_id,thread_id,allocation_id,actor_user_id,generation,host_id,native_checkpoint_operation_id,source_template_id,source_build_id,phase,serving_requested,boot_prepare_started_at,probe_removed_at,prepared_receipt,boot_receipt,committed_at)
          VALUES(${op},${f.input.operationId},${f.threadId},${allocation},${f.input.actorUserId},1,${f.hostId},${point.native.header.operationId},'template',${NodeCrypto.randomUUID()},'importing',true,clock_timestamp(),clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp())`;
                const pending = yield* readPendingThreadVmProviderAuth(f.sql, f.threadId);
                expect(pending?.binding).toEqual({
                  operationId: op,
                  allocationId: allocation,
                  environmentId: environment,
                  generation: 2,
                  instanceId: "codex",
                });
                if (kind === "reset")
                  yield* f.sql`UPDATE relay_thread_vm_resets SET phase='cancelling' WHERE operation_id=${op}`;
                else
                  yield* f.sql`UPDATE relay_thread_vm_restores SET phase='aborting',committed_at=NULL WHERE operation_id=${op}`;
                expect(yield* readPendingThreadVmProviderAuth(f.sql, f.threadId)).toBeNull();
              }),
            ),
        );
      }
    });
  },
);
