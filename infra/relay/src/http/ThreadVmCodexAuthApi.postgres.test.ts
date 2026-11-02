import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayClientPrincipal,
  RelayEnvironmentPrincipal,
  RelayThreadVmProviderAuth,
  RelayThreadVmProviderAuthBinding,
  RelayThreadVmSetupReceipt,
  RelayThreadVmRestoreImportReceipt,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { CodexVmOAuth, CodexVmTokenBundle } from "../tenancy/CodexVmOAuth.ts";
import {
  databaseUrl,
  organizationId,
  userId,
  withDatabase,
  connect,
} from "../tenancy/CodexVmConnections.test-fixture.ts";
import { makeThreadVmCodexAuthStore } from "../threads/ThreadVmCodexAuthStore.ts";
import { makeThreadVmBindingStore } from "../threads/ThreadVmBindingStore.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { readPendingThreadVmProviderAuth } from "../threads/ThreadVmPendingProviderAuth.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import type { ThreadVmProviderAuthControl } from "@t3tools/contracts/relay";
import { threadVmProviderAuth } from "./ThreadVmProviderAuthApi.ts";
import {
  activatePortableThreadMove,
  commitPortableThreadMove,
  readyPortableThreadMove,
  reportPortableThreadMoveFailure,
} from "./ThreadMovesApi.ts";
import { confirmInitialVmActivation } from "./ThreadEnvironmentApi.ts";
import { confirmThreadVmRestoreActivation } from "./ThreadVmRestoreRecoveryApi.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import * as ProviderAccounts from "../tenancy/ProviderAccounts.ts";
import { Machines } from "../machines/Machines.ts";
import { openProviderAccountsForExecutor } from "./ProviderAccountsApi.ts";
import {
  getEnvironmentThreadVmCodexAuthSource,
  getEnvironmentThreadVmCodexAuthToken,
  getThreadVmCodexAuthSource,
  selectThreadVmCodexAuthSource,
} from "./ThreadVmCodexAuthApi.ts";

const guest = vi.hoisted(() => ({
  calls: 0,
  ready: true,
  mode: "organization" as "organization" | "personal",
  connectionId: "",
  after: undefined as Effect.Effect<void> | undefined,
}));
vi.mock("../machines/E2BThreadVmProviderAuth.ts", () => ({
  makeE2BThreadVmProviderAuth: () => (input: { control: ThreadVmProviderAuthControl }) =>
    Effect.gen(function* () {
      guest.calls++;
      if (guest.after) yield* guest.after;
      return {
        ...input.control.binding,
        requirement: guest.ready ? "authenticated" : "provider_unavailable",
        auth: {
          instanceId: "codex",
          phase: guest.ready ? "succeeded" : "failed",
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: guest.ready ? null : "Codex is unavailable.",
        },
        authSource:
          guest.mode === "personal"
            ? { mode: "personal" }
            : {
                mode: "organization",
                connectionId: guest.connectionId,
                connection: {
                  connectionId: guest.connectionId,
                  label: "Organization Codex",
                  status: "connected",
                  epoch: 1,
                  tokenRevision: 1,
                  errorCode: null,
                  refreshing: false,
                },
              },
      };
    }),
}));

const threadId = ThreadId.make("vm-codex-thread"),
  repositoryId = "vm-codex-repo",
  allocationId = "vm-allocation",
  operationId = "7bf40eb2-47e6-40f1-bca2-aae3f988dc22",
  environmentId = EnvironmentId.make("vm-environment"),
  credentialId = "vm-credential";
const identity = { organizationId, threadId, allocationId, environmentId, generation: 2 };
const owner = { threadId, environmentId, generation: 2 };
const binding = { operationId, allocationId, generation: 2 };
const readyInput = {
  ...owner,
  operationId,
  sourceCursor: 0,
  manifestSha256: "a".repeat(64),
  attempt: 1,
};
const principal = {
  environmentId,
  credentialId,
  environmentPublicKey: "vm-public-key",
  threadVm: { allocationId, threadId, repositoryId, generation: 2 },
};
const bundle = {
  accessToken: "access-canary",
  refreshToken: "renewable-secret-canary",
  idToken: "identity-secret-canary",
  tokenType: "Bearer" as const,
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    "chatgpt.tokens.use.direct",
  ],
  obtainedAt: 0,
  expiresAt: 3_600_000,
  earliestRefreshAt: null,
};
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(CodexVmTokenBundle));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeSetupReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));
const encodeImportReceipt = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmRestoreImportReceipt),
);
const decodeLegacyProviderAuth = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...RelayThreadVmProviderAuthBinding.fields,
    requirement: RelayThreadVmProviderAuth.fields.requirement,
    auth: RelayThreadVmProviderAuth.fields.auth,
  }),
);

const nativeRestoreReceipts = (generation: number, sourceGeneration = 1) => {
  const sourceTemplateId = "template",
    sourceBuildId = operationId;
  const boot = { version: 1 as const, operationId, allocationId, threadId, generation };
  return {
    prepared: { version: 1, kind: "native-restore-catalog-v1", sourceTemplateId, sourceBuildId },
    boot: {
      ...boot,
      kind: "native-restore-boot-v1",
      bootAttempt: 0,
      sandboxId: "sandbox",
      sourceTemplateId,
      sourceBuildId,
    },
    bootstrap: {
      version: 1,
      kind: "native-warm-restore-bootstrap-v1",
      boot,
      source: {
        allocationId,
        operationId,
        threadId,
        generation: sourceGeneration,
        bootId: operationId,
        captureOperationId: operationId,
        sealEpoch: 1,
      },
      targetSealEpoch: 2,
      coordinatorStopped: true,
      sealRebound: true,
    },
  };
};

const fixture = Effect.fnUntraced(function* (connectionId: string) {
  const db = yield* PgDrizzle.makeWithDefaults(),
    sql = db.$client;
  guest.calls = 0;
  guest.ready = true;
  guest.mode = "organization";
  guest.connectionId = connectionId;
  guest.after = undefined;
  yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES(${repositoryId},${organizationId},'Test','now','now')`;
  yield* sql`INSERT INTO relay_thread_placements(thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id,generation,operation_id)
    VALUES(${threadId},${organizationId},${repositoryId},${userId},'local','project',1,${operationId})`;
  yield* sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase)
    VALUES(${operationId},${threadId},${userId},'local',1,${environmentId},'vm-project','preparing')`;
  yield* sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
    VALUES(${allocationId},${threadId},${organizationId},${userId},'template:build','running','sandbox')`;
  yield* sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES(${allocationId},${operationId},2,'created')`;
  yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
    VALUES(${credentialId},${environmentId},'vm-public-key',${credentialId},'now','now')`;
  yield* sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
    VALUES(${environmentId},${allocationId},${threadId},${repositoryId},2,'vm-public-key',${credentialId})`;
  yield* sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,installed_at)
    VALUES(${allocationId},${operationId},'seed',clock_timestamp(),${environmentId},'vm-public-key','sealed',${credentialId},clock_timestamp())`;
  yield* sql`INSERT INTO relay_thread_vm_hosts(host_id,max_running_vms) VALUES('host',3)`;
  yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref) VALUES(${operationId},${allocationId},'host','create','started','sandbox')`;
  const encoded = yield* encodeBundle(bundle);
  yield* sql`UPDATE relay_codex_vm_connections SET payload_sealed=${encoded} WHERE organization_id=${organizationId}`;
  let refresh: CodexVmOAuth["Service"]["refresh"] = () => Effect.succeed(bundle);
  const oauth = CodexVmOAuth.of({
    createAttempt: () => Effect.die("unexpected sign-in"),
    completeAuthorization: () => Effect.die("unexpected exchange"),
    refresh: (input) => refresh(input),
    revoke: () => Effect.succeed({ confirmed: true }),
  });
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    user = userId,
    environment = principal,
  ) =>
    effect.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(RelayClientPrincipal, { userId: user, token: "test" }),
      Effect.provideService(RelayEnvironmentPrincipal, environment),
      Effect.provideService(ThreadVmRuntimeConfiguration, {
        settings: {
          compute: {
            apiUrl: "https://compute.test",
            sandboxUrl: "https://sandbox.test",
            apiKey: Redacted.make("test"),
            templateId: "template:build",
            hostAddresses: [],
            timeoutMs: 600000,
          },
          templateBuildId: "build",
          hostId: "host",
          maxRunningVms: 3,
          publicRelayUrl: "https://relay.test",
          autoPauseEnabled: false,
          autoBackupEnabled: false,
          autoDeleteEnabled: false,
          replacementEnabled: false,
          restoreEnabled: false,
          resetEnabled: false,
        },
      }),
      Effect.provideService(CodexVmOAuth, oauth),
      Effect.provideService(RelaySecretBox, { seal: Effect.succeed, open: Effect.succeed }),
      Effect.provideService(ThreadArtifactObjectStorage, {
        put: () => Effect.die("unexpected artifact upload"),
        verify: () => Effect.die("unexpected artifact verification"),
        read: () => Effect.die("unexpected artifact read"),
        remove: () => Effect.die("unexpected artifact removal"),
      }),
    );
  const select = (
    source: { mode: "personal" } | { mode: "organization"; connectionId: string } = {
      mode: "organization",
      connectionId,
    },
  ) => provide(selectThreadVmCodexAuthSource(threadId, { ...binding, source }));
  const ready = Effect.gen(function* () {
    yield* sql`UPDATE relay_thread_placements SET environment_id=${environmentId},generation=2,operation_id=NULL WHERE thread_id=${threadId}`;
    yield* sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
      VALUES(${allocationId},'github.com/test/repo','main',${"a".repeat(40)},'ready',${environmentId},${"b".repeat(64)})`;
  });
  const freezeMove = Effect.gen(function* () {
    yield* sql`UPDATE relay_thread_moves SET phase='frozen',source_cursor=${readyInput.sourceCursor},manifest_sha256=${readyInput.manifestSha256} WHERE operation_id=${operationId}`;
    const artifactId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    yield* sql`INSERT INTO relay_thread_artifacts
      (artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
      VALUES(${artifactId},${threadId},${operationId},'manifest',${`thread-artifacts/v1/${artifactId}`},${readyInput.manifestSha256},0,'complete')`;
    yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id)
      VALUES(${artifactId},${operationId}),(${artifactId},${`move-recovery:${operationId}`})`;
    yield* sql`INSERT INTO relay_thread_move_artifacts(operation_id,manifest_artifact_id) VALUES(${operationId},${artifactId})`;
    yield* sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,artifact_count)
      VALUES(${operationId},${threadId},${artifactId},1)`;
  });
  return {
    db,
    sql,
    provide,
    select,
    ready,
    freezeMove,
    connectionId,
    setRefresh: (next: typeof refresh) => {
      refresh = next;
    },
  };
});

describe.skipIf(!databaseUrl)("generation-bound VM Codex authentication (PostgreSQL)", () => {
  it.effect(
    "keeps managed renewable sessions out of the real legacy executor account delivery",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          yield* connect(request);
          yield* request((_store, sql) =>
            Effect.gen(function* () {
              const db = yield* PgDrizzle.makeWithDefaults();
              const accounts = yield* ProviderAccounts.make.pipe(
                Effect.provideService(RelayDb, db),
              );
              const opened: string[] = [];
              const secrets = RelaySecretBox.of({
                seal: (value) => Effect.succeed(`test-sealed:${value}`),
                open: (value) =>
                  Effect.sync(() => {
                    opened.push(value);
                    return value.slice("test-sealed:".length);
                  }),
              });
              const legacy = {
                kind: "auth_store",
                files: [
                  {
                    path: "auth.json",
                    content: '{"tokens":{"refresh_token":"legacy-machine-refresh-canary"}}',
                  },
                ],
              } as const;
              const legacySealed = yield* secrets.seal(yield* encodeJson(legacy));
              const managedSealed = yield* secrets.seal(yield* encodeBundle(bundle));
              yield* sql`UPDATE relay_codex_vm_connections SET payload_sealed=${managedSealed} WHERE organization_id=${organizationId}`;
              const saved = yield* accounts.save({
                organizationId,
                provider: "codex",
                kind: "auth_store",
                label: "Legacy machine account",
                payloadSealed: legacySealed,
                userId,
              });
              const result = yield* openProviderAccountsForExecutor({
                environmentId: "legacy-executor",
              }).pipe(
                Effect.provideService(ProviderAccounts.ProviderAccounts, accounts),
                Effect.provideService(RelaySecretBox, secrets),
                Effect.provideService(RelayEnvironmentPrincipal, {
                  environmentId: "legacy-executor",
                  environmentPublicKey: "legacy-key",
                }),
                Effect.provide(
                  Layer.mock(Machines)({
                    getActiveByEnvironmentId: () =>
                      Effect.succeed({
                        machineId: "legacy-machine",
                        organizationId,
                        role: "agent_executor",
                        label: "Legacy executor",
                        computeKind: "self_hosted",
                        computeRef: null,
                        seedExpiresAt: "2099-01-01T00:00:00.000Z",
                        environmentId: "legacy-executor",
                        environmentPublicKey: "legacy-key",
                        endpointHttpBaseUrl: null,
                        endpointWsBaseUrl: null,
                        endpointProviderKind: null,
                        createdByUserId: userId,
                        enrolledAt: "2026-10-28T00:00:00.000Z",
                        deprovisionedAt: null,
                        createdAt: "2026-10-28T00:00:00.000Z",
                      }),
                  }),
                ),
              );
              expect(result.accounts).toEqual([
                {
                  provider: "codex",
                  label: "Legacy machine account",
                  version: saved.version,
                  payload: legacy,
                },
              ]);
              expect(opened).toEqual([legacySealed]);
              const delivered = yield* encodeJson(result.accounts);
              expect(delivered).toContain("legacy-machine-refresh-canary");
              for (const canary of [
                bundle.accessToken,
                bundle.refreshToken,
                bundle.idToken,
                managedSealed,
              ])
                expect(delivered).not.toContain(canary);
            }),
          );
        }),
      ),
  );
  for (const kind of ["reset", "restore"] as const)
    it.effect(
      `checks managed guest acknowledgement before accepting a stored ${kind} activation receipt`,
      () =>
        withDatabase((request) =>
          Effect.gen(function* () {
            const connected = yield* connect(request);
            yield* request(() =>
              Effect.gen(function* () {
                const vm = yield* fixture(connected.connectionId);
                yield* vm.select();
                yield* vm.ready;
                const sha = "a".repeat(64);
                const receipt = {
                  version: 1 as const,
                  operationId,
                  environmentId,
                  scope: principal.threadVm,
                  projectId: ProjectId.make(`vm:${threadId}`),
                  workspaceRoot: "/workspace/project",
                  checkoutPath: "/workspace/project",
                  branch: "main",
                  revision: "a".repeat(40),
                  manifestSha256: sha,
                  sourceEnvironmentId: EnvironmentId.make("local"),
                  sourceSequence: 0,
                  nativeManifestArtifactId: "7bf40eb2-47e6-40f1-bca2-aae3f988dc23",
                  attachmentManifestArtifactId: "7bf40eb2-47e6-40f1-bca2-aae3f988dc24",
                  repositoryBundleSha256: sha,
                  sequence: 1,
                  execution: "frozen" as const,
                };
                const encoded = yield* encodeImportReceipt(receipt);
                yield* vm.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES('github.com/test/repo',${repositoryId},${organizationId},'now')`;
                yield* vm.sql`INSERT INTO relay_thread_artifacts(artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
            VALUES('native-manifest',${threadId},'native-point','manifest','manifest-key',${sha},1,'pending')`;
                yield* vm.sql`INSERT INTO relay_thread_native_checkpoints(operation_id,thread_id,turn_id,source_environment_id,generation,source_sequence,native_thread_id,native_manifest_sha256,archive_sha256,manifest_artifact_id,manifest_sha256,artifact_count)
            VALUES('native-point',${threadId},'turn','local',1,0,'native-thread',${sha},${sha},'native-manifest',${sha},1)`;
                yield* vm.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase)
            VALUES('backup-point',${allocationId},1,'sandbox','snapshot','verified')`;
                yield* vm.sql`INSERT INTO relay_thread_vm_final_saves(operation_id,thread_id,allocation_id,actor_user_id,environment_id,generation,host_id,compute_ref,original_state,reason,activity_revision,idle_since,source_sequence,native_checkpoint_operation_id,backup_operation_id,phase,frozen_at,completed_at)
            VALUES('saved-point',${threadId},${allocationId},${userId},'local',1,'host','sandbox','running','idle',1,clock_timestamp(),0,'native-point','backup-point','completed',clock_timestamp(),clock_timestamp())`;
                yield* vm.sql`INSERT INTO relay_thread_vm_saved_disks(operation_id,thread_id,backup_operation_id,generation,host_id,phase)
            VALUES('saved-point',${threadId},'backup-point',1,'host','available')`;
                if (kind === "reset") {
                  const upload = yield* encodeJson({
                    operationId: "repository-upload",
                    threadId,
                    sourceEnvironmentId: "local",
                    generation: 1,
                    branch: "main",
                    revision: receipt.revision,
                    objectFormat: "sha1",
                    bundle: { sha256: sha, sizeBytes: 0, chunks: [] },
                  });
                  yield* vm.sql`INSERT INTO relay_thread_vm_resets(operation_id,thread_id,allocation_id,actor_user_id,expected_generation,saved_disk_operation_id,native_checkpoint_operation_id,source_environment_id,source_sequence,host_id,template_id,canonical_key,branch,revision,repository_upload,import_receipt,phase)
              VALUES(${operationId},${threadId},${allocationId},${userId},1,'saved-point','native-point','local',0,'host','template:build','github.com/test/repo','main',${receipt.revision},${upload}::jsonb,${encoded}::jsonb,'completed')`;
                } else {
                  const native = nativeRestoreReceipts(2);
                  yield* vm.sql`INSERT INTO relay_thread_vm_restores(operation_id,saved_disk_operation_id,thread_id,allocation_id,actor_user_id,generation,source_generation,target_generation,host_id,native_checkpoint_operation_id,source_template_id,source_build_id,phase,serving_requested,prepared_receipt,boot_create_started_at,boot_receipt,bootstrap_receipt,committed_at,import_receipt)
              VALUES(${operationId},'saved-point',${threadId},${allocationId},${userId},1,1,2,'host','native-point','template',${operationId},'completed',true,${vm.sql.json(native.prepared)},clock_timestamp(),${vm.sql.json(native.boot)},${vm.sql.json(native.bootstrap)},clock_timestamp(),${encoded}::jsonb)`;
                }
                const activate = vm.provide(confirmThreadVmRestoreActivation(owner, receipt));
                expect(yield* activate.pipe(Effect.flip)).toMatchObject({
                  reason: "vm_update_required",
                });
                yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
                expect(yield* activate).toEqual({ ready: true });
                yield* makeThreadVmCodexAuthStore(vm.sql).select(identity, { mode: "personal" });
                expect(yield* activate).toEqual({ ready: true });
                if (kind === "restore") {
                  // Stock restores reserve their target separately from the historical disk generation.
                  const native = nativeRestoreReceipts(6);
                  yield* vm.sql`UPDATE relay_thread_vm_restores SET generation=4,target_generation=6,phase='importing',boot_receipt=${vm.sql.json(native.boot)},bootstrap_receipt=${vm.sql.json(native.bootstrap)} WHERE operation_id=${operationId}`;
                  yield* vm.sql`UPDATE relay_thread_placements SET generation=6,operation_id=${operationId} WHERE thread_id=${threadId}`;
                  yield* vm.sql`UPDATE relay_thread_vm_bindings SET generation=6 WHERE allocation_id=${allocationId}`;
                  yield* vm.sql`UPDATE relay_thread_vm_provisions SET generation=6 WHERE allocation_id=${allocationId}`;
                  expect(
                    (yield* readPendingThreadVmProviderAuth(vm.sql, threadId))?.binding,
                  ).toEqual({
                    operationId,
                    allocationId,
                    environmentId,
                    generation: 6,
                    instanceId: "codex",
                  });
                  yield* vm.sql`UPDATE relay_thread_vm_restores SET boot_ingress_recovery_claim_id='recovering' WHERE operation_id=${operationId}`;
                  expect(yield* readPendingThreadVmProviderAuth(vm.sql, threadId)).toBeNull();
                  yield* vm.sql`UPDATE relay_thread_vm_restores SET boot_ingress_recovery_claim_id=NULL,boot_recovery_started_at=clock_timestamp() WHERE operation_id=${operationId}`;
                  expect(yield* readPendingThreadVmProviderAuth(vm.sql, threadId)).toBeNull();
                }
              }),
            );
          }),
        ),
    );

  it.effect(
    "keeps legacy personal move readiness but blocks managed activation until the guest observes its selection",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              const ready = vm.provide(
                readyPortableThreadMove({
                  ...owner,
                  operationId,
                  sourceCursor: 0,
                  manifestSha256: "a".repeat(64),
                }),
              );
              yield* vm.sql`UPDATE relay_thread_moves SET phase='frozen',source_cursor=0,manifest_sha256=${"a".repeat(64)} WHERE operation_id=${operationId}`;
              expect((yield* ready).phase).toBe("ready");
              yield* vm.sql`UPDATE relay_thread_moves SET phase='frozen' WHERE operation_id=${operationId}`;
              expect(yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner))).toEqual({
                mode: "personal",
              });
              yield* vm.select();
              // A private browser read, or a guest lookup before selection, is not a capability receipt.
              yield* vm.provide(getThreadVmCodexAuthSource(threadId));
              expect(yield* ready.pipe(Effect.flip)).toMatchObject({
                reason: "vm_update_required",
              });
              const [held] = yield* vm.sql<{
                phase: string;
              }>`SELECT phase FROM relay_thread_moves WHERE operation_id=${operationId}`;
              expect(held?.phase).toBe("frozen");
              // Independent request scopes exercise simultaneous first acknowledgements without lock upgrades.
              yield* Effect.all(
                [0, 1].map(() =>
                  request(() =>
                    Effect.gen(function* () {
                      const db = yield* PgDrizzle.makeWithDefaults();
                      yield* getEnvironmentThreadVmCodexAuthSource(owner).pipe(
                        Effect.provideService(RelayDb, db),
                        Effect.provideService(RelayEnvironmentPrincipal, principal),
                      );
                    }),
                  ),
                ),
                { concurrency: "unbounded" },
              );
              expect((yield* ready).phase).toBe("ready");
            }),
          );
        }),
      ),
  );

  for (const unavailable of ["disconnected", "reconnect_required", "replaced", "deleted"] as const)
    it.effect(`recovers accepted move readiness after its Codex connection is ${unavailable}`, () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              yield* vm.freezeMove;
              yield* vm.select();
              yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
              // The relay committed readiness, but the destination never received its reply.
              yield* vm.provide(readyPortableThreadMove(readyInput));
              if (unavailable === "deleted")
                yield* vm.sql`DELETE FROM relay_codex_vm_connections WHERE organization_id=${organizationId}`;
              else if (unavailable === "replaced")
                yield* vm.sql`UPDATE relay_codex_vm_connections SET connection_id='replacement-connection' WHERE organization_id=${organizationId}`;
              else
                yield* vm.sql`UPDATE relay_codex_vm_connections SET status=${unavailable},payload_sealed=NULL WHERE organization_id=${organizationId}`;
              const accountBefore =
                yield* vm.sql`SELECT * FROM relay_codex_vm_connections WHERE organization_id=${organizationId}`;
              const selectionBefore =
                yield* vm.sql`SELECT * FROM relay_thread_vm_codex_auth WHERE allocation_id=${allocationId}`;
              expect(yield* readPendingThreadVmProviderAuth(vm.sql, threadId)).toBeNull();
              expect(
                yield* vm.provide(readyPortableThreadMove({ ...readyInput, attempt: 2 })),
              ).toMatchObject({ phase: "ready", recoveryVerified: true });
              expect(yield* vm.provide(commitPortableThreadMove(readyInput))).toMatchObject({
                phase: "committed",
              });
              yield* vm.provide(readyPortableThreadMove(readyInput)).pipe(Effect.flip);
              expect(yield* vm.provide(activatePortableThreadMove(readyInput))).toMatchObject({
                phase: "completed",
              });
              expect(yield* makeThreadPlacementStore(vm.sql).get(threadId)).toMatchObject({
                environmentId,
                generation: 2,
                operationId: null,
              });
              yield* vm.provide(readyPortableThreadMove(readyInput)).pipe(Effect.flip);
              expect(
                yield* vm.sql`SELECT * FROM relay_codex_vm_connections WHERE organization_id=${organizationId}`,
              ).toEqual(accountBefore);
              expect(
                yield* vm.sql`SELECT * FROM relay_thread_vm_codex_auth WHERE allocation_id=${allocationId}`,
              ).toEqual(selectionBefore);
              expect(guest.calls).toBe(0);
            }),
          );
        }),
      ),
    );

  it.effect("requires a live, acknowledged selection before first move readiness", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.freezeMove;
            yield* vm.select();
            const ready = vm.provide(readyPortableThreadMove(readyInput));
            expect(yield* ready.pipe(Effect.flip)).toMatchObject({
              reason: "vm_update_required",
            });
            yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
            yield* vm.sql`UPDATE relay_codex_vm_connections SET status='disconnected',payload_sealed=NULL WHERE organization_id=${organizationId}`;
            expect(yield* ready.pipe(Effect.flip)).toMatchObject({ reason: "not_connected" });
            yield* vm.sql`UPDATE relay_codex_vm_connections SET status='connected',payload_sealed=${yield* encodeBundle(bundle)},connection_id='replacement-connection' WHERE organization_id=${organizationId}`;
            expect(yield* ready.pipe(Effect.flip)).toMatchObject({ reason: "not_connected" });
            expect(yield* makeThreadPlacementStore(vm.sql).getMove(readyInput)).toMatchObject({
              phase: "frozen",
            });
            expect(yield* makeThreadPlacementStore(vm.sql).get(threadId)).toMatchObject({
              environmentId: "local",
              generation: 1,
              operationId,
            });
          }),
        );
      }),
    ),
  );

  it.effect("validates ready replay evidence and current access before resolving failures", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.freezeMove;
            yield* vm.select();
            yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
            yield* vm.provide(readyPortableThreadMove(readyInput));
            yield* vm.provide(
              reportPortableThreadMoveFailure({ ...readyInput, attempt: 2, detail: "Keep me" }),
            );
            const store = makeThreadPlacementStore(vm.sql);
            const before = yield* store.getMove(readyInput);
            const replay = { ...readyInput, attempt: 3 };
            for (const change of [
              { operationId: "00000000-0000-4000-8000-000000000001" },
              { environmentId: "local" },
              { generation: 1 },
              { manifestSha256: "b".repeat(64) },
              { sourceCursor: 1 },
              { attempt: 0 },
            ]) {
              yield* vm
                .provide(readyPortableThreadMove({ ...replay, ...change }))
                .pipe(Effect.flip);
              expect(yield* store.getMove(readyInput)).toEqual(before);
            }
            for (const scope of [
              { ...principal.threadVm, allocationId: "wrong-allocation" },
              { ...principal.threadVm, repositoryId: "wrong-repository" },
              { ...principal.threadVm, generation: 3 },
            ]) {
              expect(
                yield* vm
                  .provide(readyPortableThreadMove(replay), userId, {
                    ...principal,
                    threadVm: scope,
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ reason: "thread_not_found" });
              expect(yield* store.getMove(readyInput)).toEqual(before);
            }
            yield* vm.sql`UPDATE relay_thread_vm_bindings SET revoked_at=clock_timestamp() WHERE allocation_id=${allocationId}`;
            expect(
              yield* vm.provide(readyPortableThreadMove(replay)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_not_found" });
            yield* vm.sql`UPDATE relay_thread_vm_bindings SET revoked_at=NULL WHERE allocation_id=${allocationId}`;
            yield* vm.sql`UPDATE relay_environment_credentials SET revoked_at=clock_timestamp() WHERE credential_id=${credentialId}`;
            expect(
              yield* vm.provide(readyPortableThreadMove(replay)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_not_found" });
            yield* vm.sql`UPDATE relay_environment_credentials SET revoked_at=NULL WHERE credential_id=${credentialId}`;
            yield* vm.sql`DELETE FROM relay_organization_members WHERE organization_id=${organizationId} AND user_id=${userId}`;
            expect(
              yield* vm.provide(readyPortableThreadMove(replay)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_not_found" });
            expect(yield* store.getMove(readyInput)).toEqual(before);
            expect(yield* store.get(threadId)).toMatchObject({
              environmentId: "local",
              generation: 1,
            });
          }),
        );
      }),
    ),
  );

  it.effect("does not reopen cancelled move readiness", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.freezeMove;
            yield* vm.provide(readyPortableThreadMove(readyInput));
            const store = makeThreadPlacementStore(vm.sql);
            yield* store.requestAbort(readyInput);
            expect(
              yield* vm.provide(readyPortableThreadMove(readyInput)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_placement_changed" });
            yield* store.destinationRemoved(readyInput);
            expect(
              yield* vm.provide(readyPortableThreadMove(readyInput)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_placement_changed" });
            expect(yield* store.getMove(readyInput)).toMatchObject({ phase: "aborted" });
            expect(yield* store.get(threadId)).toMatchObject({
              environmentId: "local",
              generation: 1,
            });
          }),
        );
      }),
    ),
  );

  it.effect("ready replays resolve only older failures from the same destination", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.freezeMove;
            yield* vm.provide(readyPortableThreadMove(readyInput));
            const failure = { ...readyInput, attempt: 3, detail: "Current destination failure" };
            yield* vm.provide(reportPortableThreadMoveFailure(failure));
            for (const attempt of [2, 3]) {
              expect(
                yield* vm.provide(readyPortableThreadMove({ ...readyInput, attempt })),
              ).toMatchObject({ failureDetail: failure.detail });
              expect(
                yield* vm.provide(commitPortableThreadMove(readyInput)).pipe(Effect.flip),
              ).toMatchObject({ reason: "thread_placement_changed" });
            }
            expect(
              yield* vm.provide(readyPortableThreadMove({ ...readyInput, attempt: 4 })),
            ).toMatchObject({ failureDetail: null });
            expect(yield* vm.provide(reportPortableThreadMoveFailure(failure))).toMatchObject({
              failureDetail: null,
            });
            yield* makeThreadPlacementStore(vm.sql).reportFailure({
              ...readyInput,
              environmentId: "local",
              generation: 1,
              attempt: 1,
              detail: "Unresolved source failure",
            });
            expect(
              yield* vm.provide(readyPortableThreadMove({ ...readyInput, attempt: 5 })),
            ).toMatchObject({ failureDetail: "Unresolved source failure" });
            expect(
              yield* vm.provide(commitPortableThreadMove(readyInput)).pipe(Effect.flip),
            ).toMatchObject({ reason: "thread_placement_changed" });
          }),
        );
      }),
    ),
  );

  it.effect(
    "invalidates guest acknowledgement on every selection and fresh identity transfer",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              const auth = makeThreadVmCodexAuthStore(vm.sql);
              yield* vm.select();
              yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
              yield* auth.requireAcknowledged(identity);
              yield* vm.select();
              expect(yield* auth.requireAcknowledged(identity).pipe(Effect.flip)).toMatchObject({
                reason: "vm_update_required",
              });
              yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
              const target = {
                ...identity,
                environmentId: "fresh-ack-environment",
                generation: 3,
              };
              yield* auth.transfer({
                ...target,
                sourceEnvironmentId: environmentId,
                sourceGeneration: 2,
              });
              expect(yield* auth.requireAcknowledged(target).pipe(Effect.flip)).toMatchObject({
                reason: "vm_update_required",
              });
              yield* vm.sql`UPDATE relay_codex_vm_connections SET connection_id='replacement-connection' WHERE organization_id=${organizationId}`;
              yield* vm.select({ mode: "organization", connectionId: "replacement-connection" });
              expect(yield* auth.requireAcknowledged(identity).pipe(Effect.flip)).toMatchObject({
                reason: "vm_update_required",
              });
              yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner));
              yield* auth.requireAcknowledged(identity);
              yield* vm.sql`UPDATE relay_codex_vm_connections SET status='disconnected',payload_sealed=NULL WHERE organization_id=${organizationId}`;
              expect(yield* auth.requireAcknowledged(identity).pipe(Effect.flip)).toMatchObject({
                reason: "not_connected",
              });
            }),
          );
        }),
      ),
  );

  it.effect("requires managed source acknowledgement even for a valid initial setup receipt", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            const first = { ...identity, generation: 1 };
            const firstPrincipal = {
              ...principal,
              threadVm: { ...principal.threadVm, generation: 1 },
            };
            const receipt = {
              version: 1 as const,
              operationId,
              environmentId,
              projectId: ProjectId.make(`vm:${threadId}`),
              scope: firstPrincipal.threadVm,
              workspaceRoot: "/workspace/project",
              revision: "a".repeat(40),
              sequence: 1,
              execution: "frozen" as const,
            };
            const encoded = yield* encodeSetupReceipt(receipt);
            const hash = Array.from(
              new Uint8Array(
                yield* (yield* Crypto.Crypto).digest("SHA-256", new TextEncoder().encode(encoded)),
              ),
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            yield* vm.sql`UPDATE relay_thread_vm_bindings SET generation=1 WHERE allocation_id=${allocationId}`;
            yield* vm.sql`UPDATE relay_thread_vm_provisions SET generation=1 WHERE allocation_id=${allocationId}`;
            yield* vm.sql`UPDATE relay_thread_placements SET environment_id=${environmentId},generation=1,operation_id=NULL,project_id=${receipt.projectId} WHERE thread_id=${threadId}`;
            yield* vm.sql`INSERT INTO relay_thread_vm_setups(allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
          VALUES(${allocationId},'github.com/test/repo','main',${receipt.revision},'ready',${environmentId},${hash})`;
            yield* vm.sql`INSERT INTO relay_thread_history(thread_id,cursor,environment_id,source_sequence,event_json) VALUES(${threadId},1,${environmentId},1,'{"type":"thread.created"}'::jsonb)`;
            const activate = vm.provide(
              confirmInitialVmActivation({ ...owner, receipt }),
              userId,
              firstPrincipal,
            );
            expect(yield* activate).toEqual({ ready: true });
            yield* makeThreadVmCodexAuthStore(vm.sql).select(first, {
              mode: "organization",
              connectionId: connected.connectionId,
            });
            expect(yield* activate.pipe(Effect.flip)).toMatchObject({
              reason: "vm_update_required",
            });
            yield* vm.provide(
              getEnvironmentThreadVmCodexAuthSource({ ...owner, generation: 1 }),
              userId,
              firstPrincipal,
            );
            expect(yield* activate).toEqual({ ready: true });
          }),
        );
      }),
    ),
  );

  it.effect(
    "allows a personal guest control to reenter relay source authorization on a separate connection",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              guest.mode = "personal";
              guest.after = request(() =>
                Effect.gen(function* () {
                  const nestedDb = yield* PgDrizzle.makeWithDefaults();
                  expect(
                    yield* getEnvironmentThreadVmCodexAuthSource(owner).pipe(
                      Effect.provideService(RelayDb, nestedDb),
                      Effect.provideService(RelayEnvironmentPrincipal, principal),
                    ),
                  ).toEqual({ mode: "personal" });
                }),
              ).pipe(Effect.orDie);
              expect(
                yield* vm.provide(threadVmProviderAuth(threadId, "start", binding)),
              ).toMatchObject({ requirement: "authenticated", authSource: { mode: "personal" } });
              expect(guest.calls).toBe(1);
            }),
          );
        }),
      ),
  );

  for (const origin of ["saved_disk", "backup_recovery"] as const)
    it.effect(
      `inherits managed selection from the ${origin} source generation on a repeated restore`,
      () =>
        withDatabase((request) =>
          Effect.gen(function* () {
            const connected = yield* connect(request);
            yield* request(() =>
              Effect.gen(function* () {
                const vm = yield* fixture(connected.connectionId);
                yield* vm.select();
                const sha = "a".repeat(64);
                yield* vm.sql`INSERT INTO relay_thread_artifacts(artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
        VALUES('native-manifest',${threadId},'native-point','manifest','manifest-key',${sha},1,'pending')`;
                yield* vm.sql`INSERT INTO relay_thread_native_checkpoints(operation_id,thread_id,turn_id,source_environment_id,generation,source_sequence,native_thread_id,native_manifest_sha256,archive_sha256,manifest_artifact_id,manifest_sha256,artifact_count)
        VALUES('native-point',${threadId},'turn',${environmentId},2,0,'native-thread',${sha},${sha},'native-manifest',${sha},1)`;
                yield* vm.sql`INSERT INTO relay_thread_vm_backups(operation_id,allocation_id,generation,compute_ref,snapshot_name,phase)
        VALUES('backup-point',${allocationId},2,'sandbox','snapshot','verified')`;
                yield* vm.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at='now' WHERE allocation_id=${allocationId}`;
                yield* vm.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
        VALUES('restored-allocation',${threadId},${organizationId},${userId},'template:build','running','restored-sandbox')`;
                if (origin === "saved_disk") {
                  yield* vm.sql`INSERT INTO relay_thread_vm_final_saves(operation_id,thread_id,allocation_id,actor_user_id,environment_id,generation,host_id,compute_ref,original_state,reason,activity_revision,idle_since,source_sequence,native_checkpoint_operation_id,backup_operation_id,phase,frozen_at,completed_at)
          VALUES('saved-point',${threadId},${allocationId},${userId},${environmentId},2,'host','sandbox','running','idle',1,clock_timestamp(),0,'native-point','backup-point','completed',clock_timestamp(),clock_timestamp())`;
                  yield* vm.sql`INSERT INTO relay_thread_vm_saved_disks(operation_id,thread_id,backup_operation_id,generation,host_id,phase)
          VALUES('saved-point',${threadId},'backup-point',2,'host','available')`;
                } else
                  yield* vm.sql`INSERT INTO relay_thread_vm_backup_recoveries(operation_id,thread_id,allocation_id,source_allocation_id,actor_user_id,environment_id,generation,host_id,compute_ref,source_operation_id,backup_operation_id,captured_at,native_checkpoint_operation_id,native_relay_cursor,through_relay_cursor,through_command_position,source_template_id,source_build_id,phase)
        VALUES('restore-operation',${threadId},'restored-allocation',${allocationId},${userId},${environmentId},2,'host','sandbox',${operationId},'backup-point',clock_timestamp(),'native-point',0,0,0,'template','build','pending')`;
                yield* vm.sql`INSERT INTO relay_thread_vm_restores(operation_id,saved_disk_operation_id,backup_recovery_operation_id,thread_id,allocation_id,actor_user_id,generation,source_generation,target_generation,host_id,native_checkpoint_operation_id,source_template_id,source_build_id,phase)
        VALUES('restore-operation',${origin === "saved_disk" ? "saved-point" : null},${origin === "backup_recovery" ? "restore-operation" : null},${threadId},'restored-allocation',${userId},4,2,6,'host','native-point','template','build','pending')`;
                yield* vm.sql`UPDATE relay_thread_placements SET environment_id='pending-restore:restored-allocation',generation=5,operation_id='restore-operation' WHERE thread_id=${threadId}`;
                const target = {
                  ...identity,
                  allocationId: "restored-allocation",
                  environmentId: "restored-environment",
                  generation: 6,
                };
                const auth = makeThreadVmCodexAuthStore(vm.sql);
                yield* auth.inheritBinding(target);
                expect(yield* auth.read(target)).toEqual({
                  mode: "organization",
                  connectionId: connected.connectionId,
                });
              }),
            );
          }),
        ),
    );

  it.effect("selects explicitly and confirms pending managed readiness through the guest", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            expect(yield* vm.provide(getThreadVmCodexAuthSource(threadId))).toEqual({
              mode: "personal",
            });
            expect(yield* vm.select()).toMatchObject({
              mode: "organization",
              connectionId: connected.connectionId,
              connection: { status: "connected" },
            });
            expect(yield* vm.provide(getThreadVmCodexAuthSource(threadId))).toMatchObject({
              mode: "organization",
            });
            expect(guest.calls).toBe(0);
            expect(yield* vm.provide(threadVmProviderAuth(threadId, "status"))).toMatchObject({
              requirement: "authenticated",
              authSource: { mode: "organization" },
            });
            expect(guest.calls).toBe(1);
            guest.ready = false;
            expect(yield* vm.provide(threadVmProviderAuth(threadId, "status"))).toMatchObject({
              requirement: "provider_unavailable",
            });
            guest.ready = true;
            guest.mode = "personal";
            expect(yield* vm.provide(threadVmProviderAuth(threadId, "status"))).toMatchObject({
              requirement: "provider_unavailable",
            });
            const beforeUnsupportedActions = guest.calls;
            for (const action of ["start", "cancel"] as const) {
              const response = yield* vm.provide(threadVmProviderAuth(threadId, action, binding));
              expect(yield* decodeLegacyProviderAuth(response)).toMatchObject({
                requirement: "provider_unavailable",
                auth: {
                  phase: "failed",
                  message: expect.stringContaining("organization's Codex account"),
                },
              });
            }
            expect(guest.calls).toBe(beforeUnsupportedActions);
            yield* vm.select({ mode: "personal" });
            expect(yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner))).toEqual({
              mode: "personal",
            });
          }),
        );
      }),
    ),
  );

  it.effect(
    "rejects nonowners, stale preparation requests and unknown organization connections",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              expect(
                yield* vm
                  .provide(
                    selectThreadVmCodexAuthSource(threadId, {
                      ...binding,
                      source: { mode: "organization", connectionId: connected.connectionId },
                    }),
                    "second-admin",
                  )
                  .pipe(Effect.flip),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              expect(
                yield* vm
                  .provide(
                    selectThreadVmCodexAuthSource(threadId, {
                      ...binding,
                      generation: 3,
                      source: { mode: "personal" },
                    }),
                  )
                  .pipe(Effect.flip),
              ).toMatchObject({ _tag: "RelayTenancyConflictError" });
              expect(
                yield* vm
                  .select({ mode: "organization", connectionId: "foreign-connection" })
                  .pipe(Effect.flip),
              ).toMatchObject({ reason: "not_connected" });
              yield* vm.select();
              yield* vm.ready;
              expect(yield* vm.select({ mode: "personal" }).pipe(Effect.flip)).toMatchObject({
                _tag: "RelayTenancyConflictError",
              });
            }),
          );
        }),
      ),
  );

  it.effect(
    "delivers access tokens only to the exact selected pending or current VM identity",
    () =>
      withDatabase((request) =>
        Effect.gen(function* () {
          const connected = yield* connect(request);
          yield* request(() =>
            Effect.gen(function* () {
              const vm = yield* fixture(connected.connectionId);
              yield* vm.select();
              const token = yield* vm.provide(
                getEnvironmentThreadVmCodexAuthToken({
                  ...owner,
                  connectionId: connected.connectionId,
                }),
              );
              expect(token).toMatchObject({ status: "ready", token: "access-canary" });
              expect(yield* encodeJson(token)).not.toContain("secret-canary");
              for (const environment of [
                { ...principal, credentialId: "stale-credential" },
                { ...principal, environmentPublicKey: "wrong-public-key" },
                { ...principal, threadVm: { ...principal.threadVm, generation: 1 } },
                {
                  ...principal,
                  threadVm: { ...principal.threadVm, allocationId: "foreign-allocation" },
                },
              ])
                expect(
                  yield* vm
                    .provide(getEnvironmentThreadVmCodexAuthSource(owner), userId, environment)
                    .pipe(Effect.flip),
                ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
              yield* vm.ready;
              expect(
                yield* vm.provide(
                  getEnvironmentThreadVmCodexAuthToken({
                    ...owner,
                    connectionId: connected.connectionId,
                  }),
                ),
              ).toMatchObject({ status: "ready" });
              yield* vm.sql`UPDATE relay_thread_vm_allocations SET state='paused' WHERE allocation_id=${allocationId}`;
              expect(yield* vm.provide(getThreadVmCodexAuthSource(threadId))).toMatchObject({
                mode: "organization",
              });
              expect(
                yield* vm.provide(getEnvironmentThreadVmCodexAuthSource(owner)).pipe(Effect.flip),
              ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
            }),
          );
        }),
      ),
  );

  it.effect("rechecks owner access after renewal before returning any token", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.select();
            const expired = yield* encodeBundle({ ...bundle, expiresAt: 0 });
            yield* vm.sql`UPDATE relay_codex_vm_connections SET expires_at='1970-01-01T00:00:00.000Z',payload_sealed=${expired} WHERE organization_id=${organizationId}`;
            const entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<typeof bundle>();
            vm.setRefresh(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            const pending = yield* vm
              .provide(
                getEnvironmentThreadVmCodexAuthToken({
                  ...owner,
                  connectionId: connected.connectionId,
                }),
              )
              .pipe(Effect.flip, Effect.forkChild);
            yield* Deferred.await(entered);
            yield* vm.sql`DELETE FROM relay_organization_members WHERE organization_id=${organizationId} AND user_id=${userId}`;
            yield* Deferred.succeed(release, bundle);
            expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          }),
        );
      }),
    ),
  );

  it.effect("retains invalid managed selections through transfer and permits explicit repair", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.select();
            const store = makeThreadVmCodexAuthStore(vm.sql);
            const target = { ...identity, environmentId: "new-environment", generation: 3 };
            yield* vm.sql`UPDATE relay_codex_vm_connections SET status='disconnected',payload_sealed=NULL WHERE organization_id=${organizationId}`;
            yield* store.transfer({
              ...target,
              sourceEnvironmentId: environmentId,
              sourceGeneration: 2,
            });
            expect(yield* store.connection(target)).toMatchObject({
              selection: { mode: "organization", connectionId: connected.connectionId },
              connection: { status: "disconnected" },
            });
            const missing = { ...target, environmentId: "unknown-origin", generation: 4 };
            expect(
              yield* store.transfer({
                ...missing,
                sourceEnvironmentId: "missing-source",
                sourceGeneration: 3,
              }),
            ).toBe(null);
            expect(yield* store.read(missing).pipe(Effect.flip)).toMatchObject({
              reason: "source_unavailable",
            });
            yield* store.select(missing, { mode: "personal" });
            expect(yield* store.read(missing)).toEqual({ mode: "personal" });
          }),
        );
      }),
    ),
  );

  it.effect("inherits the exact prior generation when a fresh reset or move guest binds", () =>
    withDatabase((request) =>
      Effect.gen(function* () {
        const connected = yield* connect(request);
        yield* request(() =>
          Effect.gen(function* () {
            const vm = yield* fixture(connected.connectionId);
            yield* vm.select();
            yield* vm.sql`UPDATE relay_thread_placements SET environment_id=${environmentId},generation=2 WHERE thread_id=${threadId}`;
            yield* vm.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at='now' WHERE allocation_id=${allocationId}`;
            yield* vm.sql`INSERT INTO relay_thread_vm_allocations(allocation_id,thread_id,organization_id,owner_user_id,template_id,state,compute_ref)
        VALUES('next-allocation',${threadId},${organizationId},${userId},'template:build','running','next-sandbox')`;
            yield* vm.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase) VALUES('next-allocation','next-operation',3,'created')`;
            yield* vm.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
        VALUES('next-credential','next-environment','next-public-key','next-credential','now','now')`;
            yield* makeThreadVmBindingStore(vm.sql).bind({
              allocationId: "next-allocation",
              operationId: "next-operation",
              environmentId: "next-environment",
              environmentPublicKey: "next-public-key",
              credentialId: "next-credential",
            });
            expect(
              yield* makeThreadVmCodexAuthStore(vm.sql).read({
                ...identity,
                allocationId: "next-allocation",
                environmentId: "next-environment",
                generation: 3,
              }),
            ).toEqual({ mode: "organization", connectionId: connected.connectionId });
          }),
        );
      }),
    ),
  );
});
