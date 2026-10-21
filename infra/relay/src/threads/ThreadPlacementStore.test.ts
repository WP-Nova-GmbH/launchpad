import { getThreadVmRepositoryBinding } from "../http/ThreadVmRepositoryApi.ts";
import {
  abortLocalThreadEnrollment,
  prepareLocalThreadEnrollment,
  receiveLocalEnrollmentReceipts,
  confirmLocalThreadEnrollment,
} from "../http/ThreadLocalEnrollmentApi.ts";
import { makeThreadVmMoveServerWorker } from "./ThreadVmMoveServerWorker.ts";
import { threadVmMoveServerDigest } from "@t3tools/shared/threadVmServerStart";
import { makeThreadVmMoveDestinationStore } from "./ThreadVmMoveDestinationStore.ts";
import { makeThreadVmMoveCleanupWorker } from "./ThreadVmMoveCleanupWorker.ts";
import {
  beginPortableThreadVmMove,
  beginPortableThreadMove,
  getPortableThreadMove,
  pendingPortableThreadMoves,
  freezePortableThreadMove,
  readyPortableThreadMove,
  commitPortableThreadMove,
  activatePortableThreadMove,
  abortPortableThreadMove,
  confirmPortableThreadMoveDestinationRemoved,
} from "../http/ThreadMovesApi.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Etag from "effect/unstable/http/Etag";
import { RelayApi, RelayEnvironmentAuth } from "@t3tools/contracts/relay";
import { threadArtifactsApi } from "../http/ThreadArtifactsApi.ts";
import { RELAY_HTTP_ROUTER_CONFIG } from "../http/Api.ts";
import { uploadPortableThreadArtifact } from "../http/ThreadArtifactsApi.ts";
import { recoverThreadVmEndpoint, releaseThreadVmEndpoint } from "../http/ThreadEnvironmentApi.ts";
import { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
import {
  ManagedEndpointAllocations,
  make as makeManagedEndpointAllocations,
} from "../environments/ManagedEndpointAllocations.ts";
import { connectThreadVmIfBound, getThreadVmStatusIfBound } from "./ThreadVmClientConnection.ts";
import {
  decodeRelayJwt,
  RELAY_MINT_RESPONSE_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
} from "@t3tools/shared/relayJwt";
import {
  RelayCloudMintCredentialProofPayload,
  RelayCloudEnvironmentHealthProofPayload,
} from "@t3tools/contracts/relay";
import { authorizeThreadVmConnection } from "./ThreadVmConnectionAccess.ts";
import { checkThreadVmClientAccess } from "../http/ThreadEnvironmentApi.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeThreadVmServerWorker } from "./ThreadVmServerWorker.ts";
import * as Schema from "effect/Schema";
import { confirmInitialVmActivation } from "../http/ThreadEnvironmentApi.ts";
import { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import { makeThreadVmSetupWorker } from "./ThreadVmSetupWorker.ts";
import type { RelayThreadVmSetupReply } from "@t3tools/contracts/relay";
import { ProjectId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  cancelInitialThreadVmSetup,
  createThreadVm,
  getThreadVmSetup,
  getThreadVmStatus,
  resumeThreadVm,
} from "../http/ThreadVmsApi.ts";
import { ThreadVmRuntimeConfiguration } from "./ThreadVmRuntime.ts";
import { RelayOrganizationId, RelayRepositoryId } from "@t3tools/contracts/relay";
import { makeThreadVmSetupStore } from "./ThreadVmSetupStore.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import { mintThreadVmRepositoryToken } from "../http/ThreadEnvironmentApi.ts";
import { reconcileThreadVmProvisioning } from "./ThreadVmRuntime.ts";
import { Template, Sandbox } from "e2b";
import { vi } from "vite-plus/test";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import * as Crypto from "effect/Crypto";
import { makeThreadVmEnrollmentWorker } from "./ThreadVmEnrollmentWorker.ts";
import { enrollThreadVm } from "../http/ThreadVmEnrollmentApi.ts";
import { signRelayJwt, RELAY_THREAD_VM_ENROLL_PROOF_TYP } from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import { makeThreadVmEnrollmentStore } from "./ThreadVmEnrollmentStore.ts";
import * as SecretBox from "../auth/SecretBox.ts";
import * as RelayConfiguration from "../Config.ts";
import { makeThreadVmBindingStore } from "./ThreadVmBindingStore.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as Option from "effect/Option";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { ThreadVmComputeError, type ThreadVmCreateInput } from "../machines/E2BThreadVmCompute.ts";
import {
  nextPortableThreadCommand,
  acknowledgePortableThreadCommand,
  appendPortableThreadHistory,
  confirmPortableThreadHistoryThrough,
  admitPortableThreadWork,
  completePortableThreadWork,
} from "../http/ThreadEnvironmentApi.ts";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import {
  stagePortableThreadCommand,
  getPortableThreadCommandReceipt,
  getPendingPortableThreadCommands,
} from "../http/ThreadCommandsApi.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { getPortableThreadPlacement, getPortableThreadHistory } from "../http/ThreadHistoryApi.ts";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import { DEFAULT_THREAD_VM_POLICY, RelayClientPrincipal } from "@t3tools/contracts/relay";
import { RelayDb } from "../db.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import { getThreadVmPolicy, updateThreadVmPolicy } from "../http/ThreadVmPolicyApi.ts";
import * as NodeCrypto from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  EnvironmentId,
  ClientOrchestrationCommand,
  CommandId,
  EventId,
  ThreadId,
  OrchestrationEvent,
  MessageId,
} from "@t3tools/contracts";
import { makeThreadJournalStore } from "./ThreadJournalStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmActivityStore } from "./ThreadVmActivityStore.ts";
import { makeThreadVmActivityWorker } from "./ThreadVmActivityWorker.ts";
import { makeThreadVmPauseWorker } from "./ThreadVmPauseWorker.ts";
import { makeThreadVmPauseStore } from "./ThreadVmPauseStore.ts";
import { makeThreadVmStatusStore } from "./ThreadVmStatusStore.ts";
import { makeThreadVmResumeStore } from "./ThreadVmResumeStore.ts";
import { makeThreadVmPauseRecoveryStore } from "./ThreadVmPauseRecoveryStore.ts";
import { makeThreadVmResumeWorker } from "./ThreadVmResumeWorker.ts";
import { makeThreadVmLeaseWorker } from "./ThreadVmLeaseWorker.ts";
import { makeThreadVmReplacementStore } from "./ThreadVmReplacementStore.ts";
import { makeThreadVmBackupStore } from "./ThreadVmBackupStore.ts";
import { makeThreadVmBackupWorker } from "./ThreadVmBackupWorker.ts";
import { makeThreadVmBackupRetentionStore } from "./ThreadVmBackupRetentionStore.ts";
import { makeThreadVmBackupRetentionWorker } from "./ThreadVmBackupRetentionWorker.ts";
import { makeThreadVmSavedDiskStore } from "./ThreadVmSavedDiskStore.ts";
import { makeThreadVmSavedDiskWorker } from "./ThreadVmSavedDiskWorker.ts";
import { makeThreadVmCancelledSetupCleanupWorker } from "./ThreadVmCancelledSetupCleanupWorker.ts";
import { makeThreadArtifactStore } from "./ThreadArtifactStore.ts";
import { makeThreadArtifactTransfer } from "./ThreadArtifactTransfer.ts";
import { makeThreadMoveArtifactStore } from "./ThreadMoveArtifactStore.ts";
import { ThreadTransferChunkManifest } from "@t3tools/contracts/relay";
import { makeLocalThreadArtifactObjects } from "./ThreadArtifactLocalObjects.ts";
import { ThreadArtifactObjectStorage, ThreadArtifactObjectError } from "./ThreadArtifactObjects.ts";
import type { SandboxInfo } from "e2b";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";

// Opt-in real Postgres coverage. The runner must create a dedicated disposable database.
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeMoveHistoryEvent = Schema.decodeEffect(OrchestrationEvent);
const decodeEndpointRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ proof: Schema.String })),
);
const decodeMintRequest = Schema.decodeUnknownSync(RelayCloudMintCredentialProofPayload);
const decodeHealthRequest = Schema.decodeUnknownSync(RelayCloudEnvironmentHealthProofPayload);
const encodeEndpointJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeChunkManifest = Schema.encodeSync(Schema.fromJsonString(ThreadTransferChunkManifest));
const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) {
      return yield* Effect.die("Tests require a dedicated launchpad_vm_test_* database");
    }
    const sql = yield* PgClient.PgClient;
    const fs = yield* FileSystem.FileSystem;
    const migrationRoot = new URL("../../migrations/postgres/", import.meta.url).pathname;
    for (const directory of (yield* fs.readDirectory(migrationRoot)).toSorted()) {
      const migration = yield* fs.readFileString(
        new URL(`../../migrations/postgres/${directory}/migration.sql`, import.meta.url).pathname,
      );
      yield* sql.withTransaction(
        Effect.forEach(migration.split("--> statement-breakpoint"), (statement) =>
          sql.unsafe(statement),
        ),
      );
    }
  }),
).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl ?? "") })),
);
const run = <A, E>(
  f: (
    store: ReturnType<typeof makeThreadPlacementStore>,
    sql: Parameters<typeof makeThreadPlacementStore>[0],
  ) => Effect.Effect<A, E>,
) => Effect.flatMap(PgClient.PgClient, (sql) => f(makeThreadPlacementStore(sql), sql));
const runAllocation = <A, E>(
  f: (store: ReturnType<typeof makeThreadVmAllocationStore>) => Effect.Effect<A, E>,
) => Effect.flatMap(PgClient.PgClient, (sql) => f(makeThreadVmAllocationStore(sql)));
const runJournal = <A, E, R>(
  f: (store: ReturnType<typeof makeThreadJournalStore>) => Effect.Effect<A, E, R>,
) => Effect.flatMap(PgClient.PgClient, (sql) => f(makeThreadJournalStore(sql)));
const parallel = <A, E, R>(effects: Iterable<Effect.Effect<A, E, R>>) =>
  Effect.all(effects, { concurrency: "unbounded" });

describe.skipIf(!databaseUrl)("portable thread ownership (Postgres)", () => {
  const services = Organizations.layer.pipe(
    Layer.provideMerge(
      Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(Layer.provideMerge(migrated)),
    ),
    Layer.provideMerge(NodeEffectCrypto.layer),
    Layer.provideMerge(
      Layer.effect(
        ThreadArtifactObjectStorage,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return makeLocalThreadArtifactObjects(
            fs,
            yield* fs.makeTempDirectoryScoped({ prefix: "placement-objects-" }),
          );
        }),
      ).pipe(Layer.provide(NodeFileSystem.layer)),
    ),
    Layer.provideMerge(
      SecretBox.layer.pipe(
        Layer.provideMerge(
          RelayConfiguration.layer({
            relayIssuer: "https://relay.test",
            apns: null,
            clerkSecretKey: Redacted.make("test"),
            clerkPublishableKey: "test",
            clerkJwtAudience: "test",
            apnsDeliveryJobSigningSecret: Redacted.make("test"),
            cloudMintPrivateKey: Redacted.make("enrollment-test-key"),
            cloudMintPublicKey: "test",
            managedEndpointBaseDomain: undefined,
            managedEndpointNamespace: undefined,
          }),
        ),
      ),
    ),
  );
  layer(services)((it) => {
    const publishMoveFixture = (
      sql: Parameters<typeof makeThreadPlacementStore>[0],
      move: { threadId: string; operationId: string },
    ) =>
      Effect.gen(function* () {
        const artifactId = NodeCrypto.randomUUID();
        yield* sql`INSERT INTO relay_thread_artifacts
          (artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
          VALUES (${artifactId},${move.threadId},${move.operationId},'manifest',
            ${`thread-artifacts/v1/${artifactId}`},${"a".repeat(64)},0,'complete')`;
        yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id)
          VALUES (${artifactId},${move.operationId})`;
        yield* sql`INSERT INTO relay_thread_move_artifacts (operation_id,manifest_artifact_id)
          VALUES (${move.operationId},${artifactId})`;
        yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id) VALUES (${artifactId},${`move-recovery:${move.operationId}`})`;
        yield* sql`INSERT INTO relay_thread_move_checkpoints (operation_id,thread_id,manifest_artifact_id,artifact_count) VALUES (${move.operationId},${move.threadId},${artifactId},1)`;
      });
    function fixture() {
      const threadId = NodeCrypto.randomUUID();
      const owner = { threadId, environmentId: "local", generation: 1 };
      const enrollment = {
        threadId,
        environmentId: "local",
        projectId: "local-project",
        organizationId: "org",
        repositoryId: "repo",
        ownerUserId: "user",
      };
      const move = {
        threadId,
        operationId: NodeCrypto.randomUUID(),
        actorUserId: "user",
        sourceEnvironmentId: "local",
        expectedGeneration: 1,
        destinationEnvironmentId: "vm",
        destinationProjectId: "vm-project",
      };
      const manifest = { sourceCursor: 31, manifestSha256: "a".repeat(64) };
      const prepare = (
        store: ReturnType<typeof makeThreadPlacementStore>,
        sql: Parameters<typeof makeThreadPlacementStore>[0],
      ) =>
        Effect.gen(function* () {
          yield* store.enroll(enrollment);
          yield* store.beginMove(move);
          yield* makeThreadJournalStore(sql).confirmThrough({
            ...owner,
            sourceSequence: manifest.sourceCursor,
          });
          yield* store.sourceFrozen({ ...move, ...owner, ...manifest });
          yield* publishMoveFixture(sql, move);
          yield* store.destinationReady({ ...move, environmentId: "vm", ...manifest });
        });
      return { owner, enrollment, move, manifest, prepare };
    }

    const makeProvisionFixture = (
      identity: { organizationId?: string; repositoryId?: string } = {},
      capacityHostId?: string,
    ) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const enrollment = { ...fixture().enrollment, ...identity };
        const ownerUserId = NodeCrypto.randomUUID();
        yield* sql`INSERT INTO relay_organizations (organization_id,name,created_at,updated_at)
          VALUES (${enrollment.organizationId},'Provision test','now','now') ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at)
          VALUES (${enrollment.organizationId},${ownerUserId},'admin','now','now')`;
        yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
          VALUES (${enrollment.repositoryId},${enrollment.organizationId},'Provision repository','now','now') ON CONFLICT DO NOTHING`;
        yield* makeThreadPlacementStore(sql).enroll({ ...enrollment, ownerUserId });
        const allocationId = NodeCrypto.randomUUID(),
          operationId = NodeCrypto.randomUUID();
        const allocations = makeThreadVmAllocationStore(sql);
        yield* allocations.reserve({
          allocationId,
          threadId: enrollment.threadId,
          ownerUserId,
          organizationId: enrollment.organizationId,
          templateId: "template:immutable-build",
        });
        const provisions = makeThreadVmProvisionStore(sql);
        const capacity = makeThreadVmCapacityStore(sql);
        const hostId = capacityHostId ?? NodeCrypto.randomUUID();
        yield* capacity.configure(hostId, 100);
        const intent = { allocationId, operationId, generation: 2, hostId };
        yield* provisions.enqueue(intent);
        const matches = [] as Array<{ sandboxId: string; metadata: Record<string, string> }>;
        let creates = 0;
        const compute = {
          create: (input: ThreadVmCreateInput) =>
            Effect.sync(() => {
              creates++;
              expect(input.environment).toEqual({});
              const resource = {
                sandboxId: `vm-${allocationId}`,
                metadata: {
                  "launchpad.managed": "thread-vm-v1",
                  "launchpad.operation_id": operationId,
                  "launchpad.allocation_id": allocationId,
                  "launchpad.thread_id": enrollment.threadId,
                  "launchpad.generation": String(input.generation),
                },
              };
              matches.push(resource);
              return resource;
            }),
          cancelCreate: () =>
            Effect.succeed({
              operationId,
              computeRef: matches[0]?.sandboxId ?? null,
              metadata: matches[0]?.metadata ?? {},
            }),
          findOperation: () => Effect.sync(() => [...matches]),
        };
        const worker = (
          client: Parameters<typeof makeThreadVmProvisionWorker>[1] = compute,
          template = "template:immutable-build",
        ) => makeThreadVmProvisionWorker(sql, client, template, hostId);
        const eligible = sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() WHERE allocation_id = ${allocationId}`;
        return {
          sql,
          provisions,
          hostId,
          allocations,
          allocationId,
          operationId,
          intent,
          compute,
          matches,
          worker,
          eligible,
          creates: () => creates,
        };
      });

    const provisionFixture = makeProvisionFixture();

    it.effect("reserves host slots in FIFO order under concurrent relay admissions", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const first = yield* makeProvisionFixture({}, hostId);
        const second = yield* makeProvisionFixture({}, hostId);
        const capacity = makeThreadVmCapacityStore(first.sql);
        yield* capacity.configure(hostId, 1);
        const results = yield* parallel(
          Array.from({ length: 8 }, () => capacity.admitNext(hostId)),
        );
        expect(results.filter(Boolean).map((row) => row?.operationId)).toEqual([first.operationId]);
        yield* first.worker().runOne();
        expect(first.creates()).toBe(1);
        expect(yield* second.worker().runOne()).toBe(false);
        expect(second.creates()).toBe(0);
        yield* first.allocations.recordPowerState({
          capacityOperationId: first.operationId,
          allocationId: first.allocationId,
          computeRef: `vm-${first.allocationId}`,
          state: "paused",
        });
        expect((yield* first.allocations.get(first.allocationId))?.deletedAt).toBeNull();
        yield* second.worker().runOne();
        expect(second.creates()).toBe(1);
        expect((yield* capacity.get(first.operationId))?.state).toBe("released");
        expect((yield* capacity.get(second.operationId))?.state).toBe("started");
      }),
    );

    it.effect("uses the current image when a queued VM request gets capacity", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const first = yield* makeProvisionFixture({}, hostId);
        const queued = yield* makeProvisionFixture({}, hostId);
        const capacity = makeThreadVmCapacityStore(first.sql);
        yield* capacity.configure(hostId, 1);
        yield* first.worker().runOne();
        const templateId = "template:build-current";
        expect(yield* queued.worker(queued.compute, templateId).runOne()).toBe(false);
        expect(queued.creates()).toBe(0);
        yield* first.allocations.recordPowerState({
          capacityOperationId: first.operationId,
          allocationId: first.allocationId,
          computeRef: `vm-${first.allocationId}`,
          state: "paused",
        });
        // A request deferred by the previous relay also recovers without being requeued.
        yield* queued.sql`UPDATE relay_thread_vm_provisions SET error_code='template_changed'
          WHERE allocation_id=${queued.allocationId}`;
        yield* queued
          .worker(
            {
              ...queued.compute,
              create: (input) =>
                Effect.gen(function* () {
                  const allocation = yield* queued.allocations
                    .get(queued.allocationId)
                    .pipe(Effect.orDie);
                  expect(allocation?.templateId).toBe(templateId);
                  return yield* queued.compute.create(input);
                }),
            },
            templateId,
          )
          .runOne();
        expect(queued.creates()).toBe(1);
        expect(yield* queued.provisions.get(queued.allocationId)).toMatchObject({
          phase: "created",
          templateId,
          errorCode: null,
        });
        expect((yield* capacity.get(queued.operationId))?.state).toBe("started");
        expect((yield* first.allocations.get(first.allocationId))?.templateId).toBe(
          "template:immutable-build",
        );
      }),
    );

    it.effect(
      "keeps physical capacity after a lost create and rejects false deletion confirmation",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const first = yield* makeProvisionFixture({}, hostId);
          const second = yield* makeProvisionFixture({}, hostId);
          const capacity = makeThreadVmCapacityStore(first.sql);
          yield* capacity.configure(hostId, 1);
          yield* first
            .worker({
              ...first.compute,
              create: (input) =>
                first.compute
                  .create(input)
                  .pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ThreadVmComputeError({ operation: "create", message: "lost reply" }),
                      ),
                    ),
                  ),
            })
            .runOne();
          expect(yield* capacity.admitNext(hostId)).toBeNull();
          expect((yield* capacity.get(first.operationId))?.state).toBe("started");
          yield* first.allocations.requestDeletion(first.allocationId);
          expect(
            yield* Effect.flip(
              first.allocations.confirmDeleted({
                allocationId: first.allocationId,
                computeRef: null,
              }),
            ),
          ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
          expect(yield* Effect.flip(capacity.cancelUnstarted(first.operationId))).toMatchObject({
            _tag: "ThreadVmCapacityConflict",
          });
          yield* first.eligible;
          yield* first.worker().runOne();
          expect(first.creates()).toBe(1);
          yield* first.allocations.confirmDeleted({
            allocationId: first.allocationId,
            computeRef: `vm-${first.allocationId}`,
          });
          yield* second.worker().runOne();
          expect(second.creates()).toBe(1);
        }),
    );

    it.effect(
      "cancels a capacity waiter without a later create and preserves immutable request identities",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const first = yield* makeProvisionFixture({}, hostId);
          const cancelled = yield* makeProvisionFixture({}, hostId);
          const last = yield* makeProvisionFixture({}, hostId);
          const capacity = makeThreadVmCapacityStore(first.sql);
          yield* capacity.configure(hostId, 1);
          yield* first.worker().runOne();
          yield* cancelled.allocations.requestDeletion(cancelled.allocationId);
          yield* cancelled.worker().runOne();
          expect(cancelled.creates()).toBe(0);
          expect((yield* capacity.get(cancelled.operationId))?.state).toBe("released");
          expect(
            yield* Effect.flip(
              capacity.request({
                ...cancelled.intent,
                allocationId: last.allocationId,
                kind: "create",
              }),
            ),
          ).toMatchObject({ _tag: "ThreadVmCapacityConflict" });
          yield* first.allocations.requestDeletion(first.allocationId);
          yield* first.allocations.confirmDeleted({
            allocationId: first.allocationId,
            computeRef: `vm-${first.allocationId}`,
          });
          yield* last.worker().runOne();
          expect(last.creates()).toBe(1);
          expect(cancelled.creates()).toBe(0);
        }),
    );

    it.effect(
      "lowers host limits without evicting running VMs and admits again only below the limit",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const first = yield* makeProvisionFixture({}, hostId);
          const second = yield* makeProvisionFixture({}, hostId);
          const waiting = yield* makeProvisionFixture({}, hostId);
          const capacity = makeThreadVmCapacityStore(first.sql);
          yield* capacity.configure(hostId, 2);
          yield* first.worker().runOne();
          yield* second.worker().runOne();
          yield* capacity.configure(hostId, 1);
          expect(yield* capacity.admitNext(hostId)).toBeNull();
          for (const f of [first, second]) {
            expect((yield* f.allocations.get(f.allocationId))?.state).toBe("running");
          }
          yield* first.allocations.requestDeletion(first.allocationId);
          yield* first.allocations.confirmDeleted({
            allocationId: first.allocationId,
            computeRef: `vm-${first.allocationId}`,
          });
          expect(yield* capacity.admitNext(hostId)).toBeNull();
          yield* second.allocations.requestDeletion(second.allocationId);
          yield* second.allocations.confirmDeleted({
            allocationId: second.allocationId,
            computeRef: `vm-${second.allocationId}`,
          });
          expect((yield* capacity.admitNext(hostId))?.operationId).toBe(waiting.operationId);
          yield* waiting.allocations.requestDeletion(waiting.allocationId);
          expect(yield* Effect.flip(capacity.beginExecution(waiting.operationId))).toMatchObject({
            _tag: "ThreadVmCapacityConflict",
          });
          yield* waiting.worker().runOne();
          expect(waiting.creates()).toBe(0);
        }),
    );

    it.effect("requires a fresh FIFO reservation to resume a paused allocation", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        const capacity = makeThreadVmCapacityStore(f.sql);
        yield* capacity.configure(f.hostId, 1);
        yield* f.worker().runOne();
        const power = { allocationId: f.allocationId, computeRef: `vm-${f.allocationId}` };
        yield* f.allocations.recordPowerState({
          ...power,
          state: "paused",
          capacityOperationId: f.operationId,
        });
        expect(
          yield* Effect.flip(f.allocations.recordPowerState({ ...power, state: "running" })),
        ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
        const operationId = NodeCrypto.randomUUID();
        const otherHost = NodeCrypto.randomUUID();
        yield* capacity.configure(otherHost, 1);
        expect(
          yield* Effect.flip(
            capacity.request({
              operationId,
              allocationId: f.allocationId,
              hostId: otherHost,
              kind: "resume",
            }),
          ),
        ).toMatchObject({ _tag: "ThreadVmCapacityConflict" });
        yield* capacity.request({
          operationId,
          allocationId: f.allocationId,
          hostId: f.hostId,
          kind: "resume",
        });
        expect((yield* capacity.admitNext(f.hostId))?.operationId).toBe(operationId);
        yield* capacity.beginExecution(operationId);
        yield* capacity.recordCreated(operationId, power.computeRef);
        yield* f.allocations.recordPowerState({
          ...power,
          state: "running",
          capacityOperationId: operationId,
        });
        expect(
          yield* Effect.flip(
            f.allocations.recordPowerState({
              ...power,
              state: "paused",
              capacityOperationId: f.operationId,
            }),
          ),
        ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
        expect((yield* capacity.get(operationId))?.state).toBe("started");
        expect(yield* capacity.admitNext(f.hostId)).toBeNull();
        expect(yield* Effect.flip(capacity.beginExecution(operationId))).toMatchObject({
          _tag: "ThreadVmCapacityConflict",
        });
      }),
    );

    it.effect(
      "does not contact compute while idle and blocks provisioning on incompatible runtime or changed runner",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const settings = {
            hostId: NodeCrypto.randomUUID(),
            maxRunningVms: 1,
            publicRelayUrl: "https://relay.test",
            autoPauseEnabled: false,
            autoBackupEnabled: false,
            autoDeleteEnabled: false,
            replacementEnabled: false,
            restoreEnabled: false,
            resetEnabled: false,
            templateBuildId: "expected-build",
            compute: {
              apiUrl: "https://compute.test",
              sandboxUrl: "https://proxy.test",
              apiKey: Redacted.make("secret"),
              templateId: "template:immutable-build",
              timeoutMs: 600000,
              hostAddresses: ["192.0.2.1"],
            },
          };
          const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({
              version: 1,
              diskRestore: true,
              quiescedSnapshots: true,
              renewableLifetime: false,
            }),
          );
          const tags = vi.spyOn(Template, "getTags").mockResolvedValue([]);
          const create = vi
            .spyOn(Sandbox, "create")
            .mockRejectedValue(new Error("Creation must stay blocked"));
          try {
            yield* reconcileThreadVmProvisioning(undefined);
            yield* reconcileThreadVmProvisioning(settings);
            expect(transport).not.toHaveBeenCalled();
            expect(tags).not.toHaveBeenCalled();
            const f = yield* makeProvisionFixture({}, settings.hostId);
            expect(yield* Effect.flip(reconcileThreadVmProvisioning(settings))).toMatchObject({
              _tag: "ThreadVmRuntimeConfigurationError",
            });
            expect(tags).not.toHaveBeenCalled();
            transport.mockImplementation(async () =>
              Response.json({
                version: 1,
                diskRestore: true,
                quiescedSnapshots: true,
                renewableLifetime: true,
                durableCreationIdentity: true,
              }),
            );
            expect(yield* Effect.flip(reconcileThreadVmProvisioning(settings))).toMatchObject({
              _tag: "ThreadVmRuntimeConfigurationError",
            });
            expect(tags).toHaveBeenCalledTimes(1);
            expect(create).not.toHaveBeenCalled();
            expect((yield* f.provisions.get(f.allocationId))?.phase).toBe("pending");
            expect((yield* makeThreadVmCapacityStore(sql).get(f.operationId))?.state).toBe(
              "waiting",
            );
            // Another worker holds the only slot. A younger capacity waiter does
            // not make the idle reconciler poll the external runtime every tick.
            yield* makeThreadVmCapacityStore(sql).admitNext(settings.hostId);
            yield* f.provisions.claim("in-flight-worker", settings.hostId);
            yield* makeProvisionFixture({}, settings.hostId);
            transport.mockClear();
            tags.mockClear();
            yield* reconcileThreadVmProvisioning(settings);
            expect(transport).not.toHaveBeenCalled();
            expect(tags).not.toHaveBeenCalled();
          } finally {
            transport.mockRestore();
            tags.mockRestore();
            create.mockRestore();
          }
        }),
    );

    it.effect(
      "rechecks queued owner access before creating compute and releases a denied unused reservation",
      () =>
        Effect.gen(function* () {
          const f = yield* provisionFixture;
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id = ${allocation.organizationId} AND user_id = ${allocation.ownerUserId}`;
          yield* f.worker().runOne();
          expect(f.creates()).toBe(0);
          expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
            phase: "cancelled",
            errorCode: "access_denied",
            allocationState: "deleted",
          });
          expect((yield* makeThreadVmCapacityStore(f.sql).get(f.operationId))?.state).toBe(
            "released",
          );
          expect((yield* f.allocations.get(f.allocationId))?.deletedAt).not.toBeNull();
        }),
    );

    it.effect("creates only once across concurrent relay workers and preserves its receipt", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        yield* parallel(Array.from({ length: 6 }, () => f.worker().runOne()));
        expect(f.creates()).toBe(1);
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "created",
          computeRef: `vm-${f.allocationId}`,
          claimId: null,
        });
        expect(yield* f.provisions.enqueue(f.intent)).toMatchObject({ phase: "created" });
        expect(
          yield* Effect.flip(f.provisions.enqueue({ ...f.intent, generation: 3 })),
        ).toMatchObject({ _tag: "ThreadVmProvisionConflict" });
        expect(yield* f.worker().runOne()).toBe(false);
      }),
    );

    it.effect("reconciles a lost create reply after restart without starting another VM", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        const worker = makeThreadVmProvisionWorker(
          f.sql,
          {
            ...f.compute,
            create: (input) =>
              f.compute
                .create(input)
                .pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ThreadVmComputeError({ operation: "create", message: "response lost" }),
                    ),
                  ),
                ),
          },
          "template:immutable-build",
          f.hostId,
        );
        yield* worker.runOne();
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "creating",
          computeRef: null,
          errorCode: "compute_unavailable",
        });
        yield* f.eligible;
        // Changed configuration must not prevent discovering the old immutable operation.
        yield* f.worker(f.compute, "new-template").runOne();
        expect(f.creates()).toBe(1);
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "created",
          computeRef: `vm-${f.allocationId}`,
          templateId: "template:immutable-build",
        });
      }),
    );

    it.effect("retains quota when a worker dies before the external create result is known", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
        const first = yield* f.provisions.claim("old-worker", f.hostId);
        expect(first?.allocationId).toBe(f.allocationId);
        yield* f.provisions.beginCreate({
          allocationId: f.allocationId,
          claimId: "old-worker",
          templateId: "template:immutable-build",
        });
        yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
        yield* f.worker().runOne();
        expect(f.creates()).toBe(0);
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "creating",
          errorCode: "create_uncertain",
          allocationState: "creating",
        });
        expect(
          yield* Effect.flip(
            f.provisions.recordCreated({
              allocationId: f.allocationId,
              claimId: "old-worker",
              computeRef: "stale-reply",
            }),
          ),
        ).toMatchObject({ _tag: "ThreadVmProvisionConflict" });
        expect(yield* f.allocations.get(f.allocationId)).toMatchObject({
          deletedAt: null,
          computeRef: null,
        });
        yield* f.eligible;
        yield* f.worker().runOne();
        expect(f.creates()).toBe(0);
        // Keep this independent test out of later claims without releasing its reservation.
        yield* f.sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() + interval '1 day' WHERE allocation_id = ${f.allocationId}`;
      }),
    );

    it.effect(
      "releases a cancelled unstarted allocation but retains a late-created VM for deletion",
      () =>
        Effect.gen(function* () {
          const f = yield* provisionFixture;
          yield* f.allocations.requestDeletion(f.allocationId);
          yield* f.worker().runOne();
          expect(f.creates()).toBe(0);
          expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
            phase: "cancelled",
            allocationState: "deleted",
          });
          const late = yield* provisionFixture;
          const worker = makeThreadVmProvisionWorker(
            late.sql,
            {
              ...late.compute,
              create: (input) =>
                Effect.gen(function* () {
                  const resource = yield* late.compute.create(input);
                  yield* late.allocations.requestDeletion(late.allocationId).pipe(Effect.orDie);
                  return resource;
                }),
            },
            "template:immutable-build",
            late.hostId,
          );
          yield* worker.runOne();
          expect(yield* late.provisions.get(late.allocationId)).toMatchObject({
            phase: "created",
            allocationState: "deleting",
            computeRef: `vm-${late.allocationId}`,
          });
          expect(yield* late.allocations.get(late.allocationId)).toMatchObject({ deletedAt: null });
        }),
    );

    it.effect("frees capacity only after a failed creation is sealed and positively stopped", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        let creates = 0;
        let cancels = 0;
        const failed = {
          ...f.compute,
          create: () => {
            creates++;
            return Effect.fail(
              new ThreadVmComputeError({
                operation: "create",
                message: "Boot failed before routing",
              }),
            );
          },
          cancelCreate: (operationId: string) => {
            cancels++;
            return Effect.succeed({
              operationId,
              computeRef: "failed-boot",
              metadata: {
                "launchpad.managed": "thread-vm-v1",
                "launchpad.operation_id": operationId,
                "launchpad.allocation_id": f.allocationId,
                "launchpad.thread_id": "unused",
                "launchpad.generation": "2",
              },
            });
          },
        };
        yield* f.worker(failed).runOne();
        const row = (yield* f.provisions.get(f.allocationId))!;
        expect(row).toMatchObject({
          phase: "creating",
          creationIdentityFenced: true,
          computeRef: null,
        });
        yield* f.allocations.requestDeletion(f.allocationId);
        yield* f.eligible;
        const valid = {
          ...failed,
          cancelCreate: (operationId: string) => {
            cancels++;
            return Effect.succeed({
              operationId,
              computeRef: "failed-boot",
              metadata: {
                "launchpad.managed": "thread-vm-v1",
                "launchpad.operation_id": operationId,
                "launchpad.allocation_id": f.allocationId,
                "launchpad.thread_id": row.threadId,
                "launchpad.generation": "2",
              },
            });
          },
        };
        yield* f
          .worker({
            ...valid,
            cancelCreate: () =>
              Effect.fail(
                new ThreadVmComputeError({ operation: "cancel create", message: "Reply lost" }),
              ),
          })
          .runOne();
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.operationId))?.state).toBe("started");
        expect((yield* f.allocations.get(f.allocationId))?.deletedAt).toBeNull();
        yield* f.eligible;
        // A positive receipt for the wrong thread is still not this allocation's proof.
        yield* f.worker(failed).runOne();
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.operationId))?.state).toBe("started");
        expect((yield* f.allocations.get(f.allocationId))?.deletedAt).toBeNull();
        yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
        yield* f.eligible;
        yield* f.worker(valid).runOne();
        expect(creates).toBe(1);
        expect(cancels).toBe(2);
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "cancelled",
          allocationState: "deleted",
          computeRef: "failed-boot",
        });
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.operationId))?.state).toBe(
          "released",
        );
      }),
    );

    it.effect(
      "seals a lost pre-send creation and refuses to release legacy or foreign identities",
      () =>
        Effect.gen(function* () {
          for (const mode of ["new", "foreign", "legacy"] as const) {
            const f = yield* provisionFixture;
            yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
            yield* f.provisions.claim("creator", f.hostId);
            yield* f.provisions.beginCreate({
              allocationId: f.allocationId,
              claimId: "creator",
              templateId: "template:immutable-build",
            });
            yield* f.provisions.defer({
              allocationId: f.allocationId,
              claimId: "creator",
              errorCode: "create_uncertain",
            });
            if (mode === "legacy")
              yield* f.sql`UPDATE relay_thread_vm_provisions SET creation_identity_fenced = false WHERE allocation_id = ${f.allocationId}`;
            yield* f.allocations.requestDeletion(f.allocationId);
            yield* f.eligible;
            let cancels = 0;
            yield* f
              .worker({
                ...f.compute,
                cancelCreate: () => {
                  cancels++;
                  return Effect.succeed({
                    operationId: mode === "foreign" ? "wrong-operation" : f.operationId,
                    computeRef: null,
                    metadata: {},
                  });
                },
              })
              .runOne();
            expect(f.creates()).toBe(0);
            expect(cancels).toBe(mode === "legacy" ? 0 : 1);
            expect((yield* makeThreadVmCapacityStore(f.sql).get(f.operationId))?.state).toBe(
              mode === "new" ? "released" : "started",
            );
            expect((yield* f.allocations.get(f.allocationId))?.deletedAt === null).toBe(
              mode !== "new",
            );
            yield* f.sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() + interval '1 day' WHERE allocation_id = ${f.allocationId}`;
          }
        }),
    );

    it.effect("rejects foreign or duplicate compute matches and keeps the reservation", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        yield* makeThreadVmCapacityStore(f.sql).admitNext(f.hostId);
        yield* f.provisions.claim("initial", f.hostId);
        yield* f.provisions.beginCreate({
          allocationId: f.allocationId,
          claimId: "initial",
          templateId: "template:immutable-build",
        });
        yield* f.provisions.defer({
          allocationId: f.allocationId,
          claimId: "initial",
          errorCode: "create_uncertain",
        });
        yield* f.compute.create({
          allocationId: f.allocationId,
          operationId: f.operationId,
          threadId: "not-used",
          generation: 2,
          environment: {},
        });
        f.matches[0]!.metadata["launchpad.allocation_id"] = "another-allocation";
        yield* f.eligible;
        yield* f.worker().runOne();
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "creating",
          errorCode: "identity_conflict",
          computeRef: null,
        });
        f.matches[0]!.metadata["launchpad.allocation_id"] = f.allocationId;
        f.matches.push({ ...f.matches[0]!, sandboxId: "duplicate-vm" });
        yield* f.eligible;
        yield* f.worker().runOne();
        expect(yield* f.provisions.get(f.allocationId)).toMatchObject({
          phase: "creating",
          errorCode: "identity_conflict",
          computeRef: null,
        });
        expect(f.creates()).toBe(1);
        yield* f.sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() + interval '1 day' WHERE allocation_id = ${f.allocationId}`;
      }),
    );

    it.effect("renews created VMs while enrollment is still pending", () =>
      Effect.gen(function* () {
        const f = yield* makeProvisionFixture();
        yield* f.worker().runOne();
        const allocation = (yield* f.allocations.get(f.allocationId))!;
        const placement = (yield* makeThreadPlacementStore(f.sql).get(allocation.threadId))!;
        let renewals = 0;
        const lease = makeThreadVmLeaseWorker(
          f.sql,
          (sandbox, identity) =>
            Effect.sync(() => {
              expect(sandbox).toBe(allocation.computeRef);
              expect(identity).toEqual({
                operationId: f.operationId,
                templateId: allocation.templateId,
                scope: {
                  allocationId: f.allocationId,
                  threadId: allocation.threadId,
                  repositoryId: placement.repositoryId,
                  generation: f.intent.generation,
                },
              });
              renewals++;
            }),
          f.hostId,
        );
        expect(yield* lease.runOne()).toBe(true);
        expect(renewals).toBe(1);
        expect(yield* lease.runOne()).toBe(false);
        const [receipt] =
          yield* f.sql`SELECT renewed_at FROM relay_thread_vm_leases WHERE allocation_id=${f.allocationId}`;
        expect(receipt?.renewed_at).not.toBeNull();
        yield* f.sql`UPDATE relay_thread_vm_leases SET renewed_at=clock_timestamp()-interval '5 minutes',attempted_at=clock_timestamp()-interval '2 minutes' WHERE allocation_id=${f.allocationId}`;
        yield* f.allocations.requestDeletion(f.allocationId);
        expect(yield* lease.runOne()).toBe(false);
        expect(renewals).toBe(1);
      }),
    );

    it.effect("does not record a lease when deletion races its renewal", () =>
      Effect.gen(function* () {
        const f = yield* makeProvisionFixture();
        yield* f.worker().runOne();
        const lease = makeThreadVmLeaseWorker(
          f.sql,
          () => f.allocations.requestDeletion(f.allocationId).pipe(Effect.asVoid, Effect.orDie),
          f.hostId,
        );
        expect(yield* lease.runOne()).toBe(true);
        const [receipt] =
          yield* f.sql`SELECT renewed_at FROM relay_thread_vm_leases WHERE allocation_id=${f.allocationId}`;
        expect(receipt?.renewed_at).toBeNull();
        expect((yield* f.allocations.get(f.allocationId))?.state).toBe("deleting");
      }),
    );

    const makeEnrollmentFixture = (
      identity: { organizationId?: string; repositoryId?: string } = {},
    ) =>
      Effect.gen(function* () {
        const f = yield* makeProvisionFixture(identity);
        yield* f.worker().runOne();
        const store = makeThreadVmEnrollmentStore(f.sql);
        const seed = yield* store.prepare(f.intent);
        const input = {
          ...f.intent,
          seed,
          environmentId: `enrollment-${f.allocationId}`,
          environmentPublicKey: "enrollment-test-key",
        };
        const credentialId = NodeCrypto.randomUUID();
        const response = Redacted.make(`credential-${credentialId}`);
        const bindings = makeThreadVmBindingStore(f.sql);
        let issued = 0;
        const issue = Effect.gen(function* () {
          issued++;
          yield* f.sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES (${credentialId},${input.environmentId},${input.environmentPublicKey},${credentialId},'now','now')`;
          yield* bindings.bind({ ...input, credentialId });
          return { credentialId, response };
        });
        return {
          ...f,
          store,
          seed,
          input,
          credentialId,
          response,
          bindings,
          issue,
          issued: () => issued,
        };
      });

    const enrollmentFixture = makeEnrollmentFixture();
    const encodeInitialReceipt = Schema.encodeEffect(
      Schema.fromJsonString(RelayThreadVmSetupReceipt),
    );
    const initialSetupFixture = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const setup = makeThreadVmSetupStore(sql);
      const input = {
        allocationId: NodeCrypto.randomUUID(),
        threadId: NodeCrypto.randomUUID(),
        organizationId: NodeCrypto.randomUUID(),
        repositoryId: NodeCrypto.randomUUID(),
        ownerUserId: NodeCrypto.randomUUID(),
        hostId: NodeCrypto.randomUUID(),
        canonicalKey: `github.com/acme/project-${NodeCrypto.randomUUID()}`,
        branch: "main",
        revision: "a".repeat(40),
        initialState: {
          title: "VM test",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          createdAt: "2026-10-05T10:00:00.000Z",
        },
        templateId: "template:build-verified",
      };
      yield* sql`INSERT INTO relay_organizations (organization_id,name,created_at,updated_at) VALUES (${input.organizationId},'Setup test','now','now')`;
      yield* sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (${input.organizationId},${input.ownerUserId},'admin','now','now')`;
      yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at) VALUES (${input.repositoryId},${input.organizationId},'Setup repository','now','now')`;
      const capacity = makeThreadVmCapacityStore(sql);
      yield* capacity.configure(input.hostId, 1);
      const provisions = makeThreadVmProvisionStore(sql);
      const environmentId = `initial-vm-${input.allocationId}`;
      const credentialId = NodeCrypto.randomUUID();
      const prepare = Effect.gen(function* () {
        yield* setup.enqueue(input);
        yield* capacity.admitNext(input.hostId);
        yield* provisions.claim("setup-test", input.hostId);
        yield* provisions.beginCreate({
          allocationId: input.allocationId,
          claimId: "setup-test",
          templateId: input.templateId,
        });
        yield* provisions.recordCreated({
          allocationId: input.allocationId,
          claimId: "setup-test",
          computeRef: `compute-${input.allocationId}`,
        });
        const enrollments = makeThreadVmEnrollmentStore(sql);
        const intent = { allocationId: input.allocationId, operationId: input.allocationId };
        const seed = yield* enrollments.prepare(intent);
        const receipt = {
          enrolled: true as const,
          ...intent,
          environmentId: EnvironmentId.make(environmentId),
          threadId: ThreadId.make(input.threadId),
          generation: 1,
        };
        yield* enrollments.exchange(
          { ...intent, seed, environmentId, environmentPublicKey: "setup-key" },
          Effect.gen(function* () {
            yield* sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
            VALUES (${credentialId},${environmentId},'setup-key',${credentialId},'now','now')`;
            yield* makeThreadVmBindingStore(sql).bind({
              ...intent,
              environmentId,
              environmentPublicKey: "setup-key",
              credentialId,
            });
            return { credentialId, response: Redacted.make("setup-response") };
          }),
        );
        yield* enrollments.confirmInstalled(receipt);
      });
      return {
        sql,
        setup,
        input,
        prepare,
        environmentId,
        credentialId,
        owner: { environmentId, threadId: input.threadId, generation: 1 },
      };
    });

    it.effect("releases a cancelled first setup only after a matching physical stop receipt", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        const allocations = makeThreadVmAllocationStore(f.sql);
        const allocation = (yield* allocations.get(f.input.allocationId))!;
        const cancel = (userId: string) =>
          cancelInitialThreadVmSetup(f.input.threadId).pipe(
            Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
          );
        expect(yield* Effect.flip(cancel(NodeCrypto.randomUUID()))).toMatchObject({
          _tag: "RelayTenancyNotFoundError",
        });
        expect(yield* cancel(f.input.ownerUserId)).toEqual({
          allocationId: f.input.allocationId,
          status: "pending_cleanup",
        });
        expect(yield* cancel(f.input.ownerUserId)).toEqual({
          allocationId: f.input.allocationId,
          status: "pending_cleanup",
        });
        const info: SandboxInfo = {
          sandboxId: allocation.computeRef!,
          templateId: f.input.templateId,
          metadata: {
            "launchpad.managed": "thread-vm-v1",
            "launchpad.allocation_id": f.input.allocationId,
            "launchpad.operation_id": f.input.allocationId,
            "launchpad.thread_id": f.input.threadId,
            "launchpad.generation": "1",
          },
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          endAt: DateTime.toDateUtc(DateTime.makeUnsafe(900_000)),
          state: "running",
          cpuCount: 2,
          memoryMB: 4096,
          envdVersion: "test",
        };
        let stops = 0;
        let validIdentity = false;
        const worker = makeThreadVmCancelledSetupCleanupWorker(
          f.sql,
          {
            inspect: () =>
              Effect.succeed({
                ...info,
                metadata: {
                  ...info.metadata,
                  "launchpad.thread_id": validIdentity ? f.input.threadId : "another-thread",
                },
              }),
            destroy: () =>
              Effect.gen(function* () {
                stops++;
                if (stops === 1)
                  return yield* new ThreadVmComputeError({
                    operation: "destroy",
                    message: "Physical stop reply was lost",
                  });
              }),
          },
          f.input.hostId,
        );
        expect(yield* worker.runOne()).toBe(true);
        expect(stops).toBe(0);
        validIdentity = true;
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* allocations.get(f.input.allocationId))?.state).toBe("deleting");
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "started",
        );
        expect(yield* worker.runOne()).toBe(true);
        expect(stops).toBe(2);
        expect((yield* allocations.get(f.input.allocationId))?.state).toBe("deleted");
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "released",
        );
        const [credential] = yield* f.sql<{
          revoked: boolean;
        }>`SELECT revoked_at IS NOT NULL AS revoked
          FROM relay_environment_credentials WHERE credential_id = ${f.credentialId}`;
        expect(credential?.revoked).toBe(true);
        expect(yield* worker.runOne()).toBe(false);
        expect(yield* cancel(f.input.ownerUserId)).toEqual({
          allocationId: f.input.allocationId,
          status: "deleted",
        });
      }),
    );

    it.effect("does not cancel an activated VM through initial-setup cleanup", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        yield* f.setup.begin({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
        });
        yield* f.setup.finish({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
          receiptSha256: "a".repeat(64),
        });
        expect(
          yield* Effect.flip(
            cancelInitialThreadVmSetup(f.input.threadId).pipe(
              Effect.provideService(RelayClientPrincipal, {
                userId: f.input.ownerUserId,
                token: "test",
              }),
            ),
          ),
        ).toMatchObject({ _tag: "RelayTenancyConflictError" });
        expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "running",
        );
      }),
    );

    it.effect("inspects only the current ready VM and rejects a report raced by work", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        const activity = makeThreadVmActivityStore(f.sql);
        let inspections = 0;
        const inactiveWorkIds: string[] = [];
        const worker = makeThreadVmActivityWorker(
          f.sql,
          (sandbox, identity) =>
            Effect.gen(function* () {
              inspections++;
              expect(sandbox).toBe(`compute-${f.input.allocationId}`);
              expect(identity.scope).toMatchObject({
                allocationId: f.input.allocationId,
                threadId: f.input.threadId,
                repositoryId: f.input.repositoryId,
                generation: 1,
              });
              if (inspections === 1)
                yield* activity.recordWork(f.input.allocationId).pipe(Effect.orDie);
              return inactiveWorkIds.length
                ? { activity: "idle" as const, inactiveWorkIds }
                : ("idle" as const);
            }),
          f.input.hostId,
        );
        expect(yield* worker.runOne()).toBe(false);
        yield* f.setup.begin({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
        });
        yield* f.setup.finish({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
          receiptSha256: "a".repeat(64),
        });
        expect(yield* worker.runOne()).toBe(true);
        expect(yield* activity.get(f.input.allocationId)).toMatchObject({
          activity: "unknown",
          idleSince: null,
        });
        const placement = makeThreadPlacementStore(f.sql);
        yield* placement.admit({ ...f.owner, workId: "turn" });
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* activity.get(f.input.allocationId))?.activity).toBe("busy");
        yield* placement.completeWork({ ...f.owner, workId: "turn" });
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* activity.get(f.input.allocationId))?.activity).toBe("idle");
        expect(inspections).toBe(3);
        expect(yield* worker.runOne()).toBe(false);
        for (const kind of ["provider", "terminal", "setup"]) {
          const workId = `${kind}:idle`;
          yield* placement.admit({ ...f.owner, workId });
          expect(
            yield* f.sql`SELECT inactive_work_ids AS evidence FROM relay_thread_vm_activity WHERE allocation_id=${f.input.allocationId}`,
          ).toEqual([{ evidence: [] }]);
          inactiveWorkIds.push(workId);
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* activity.get(f.input.allocationId))?.activity).toBe("idle");
        }
        // A remote reservation missing from the guest's exact report stays busy.
        yield* placement.admit({ ...f.owner, workId: "provider:lost-reply" });
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* activity.get(f.input.allocationId))?.activity).toBe("busy");
        yield* placement.completeWork({ ...f.owner, workId: "provider:lost-reply" });
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* activity.get(f.input.allocationId))?.activity).toBe("idle");
        // Even an incorrect inspector cannot supersede an unfinished workspace write.
        yield* placement.admit({ ...f.owner, workId: "workspace:write" });
        inactiveWorkIds.push("workspace:write");
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* activity.get(f.input.allocationId))?.activity).toBe("busy");
        yield* placement.completeWork({ ...f.owner, workId: "workspace:write" });
        for (const workId of inactiveWorkIds.filter((id) => id !== "workspace:write"))
          yield* placement.completeWork({ ...f.owner, workId });
        yield* placement.admit({ ...f.owner, workId: "stopping-turn" });
        yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'paused'
          WHERE allocation_id = ${f.input.allocationId}`;
        yield* placement.completeWork({ ...f.owner, workId: "stopping-turn" });
        expect(
          yield* Effect.flip(placement.admit({ ...f.owner, workId: "paused-turn" })),
        ).toMatchObject({ _tag: "ThreadPlacementConflict" });
      }),
    );

    it.effect(
      "completed VM moves participate in lifecycle and private connections without initial setup",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.sql`DELETE FROM relay_thread_vm_setups WHERE allocation_id=${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_placements SET generation=2, environment_id=${f.environmentId}, project_id=${`vm:${f.input.threadId}`}, operation_id=${f.input.allocationId} WHERE thread_id=${f.input.threadId}`;
          yield* f.sql`UPDATE relay_thread_vm_provisions SET generation=2 WHERE allocation_id=${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_vm_bindings SET generation=2 WHERE allocation_id=${f.input.allocationId}`;
          yield* f.sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256)
          VALUES(${f.input.allocationId},${f.input.threadId},${f.input.ownerUserId},'previous-local-owner',1,${f.environmentId},${`vm:${f.input.threadId}`},'ready',10,${"b".repeat(64)})`;
          yield* f.sql`INSERT INTO relay_thread_vm_move_destinations(operation_id,allocation_id) VALUES(${f.input.allocationId},${f.input.allocationId})`;
          yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${f.input.canonicalKey},${f.input.repositoryId},${f.input.organizationId},'now')`;
          yield* f.sql`INSERT INTO relay_thread_artifacts(artifact_id,thread_id,operation_id,kind,sha256,size_bytes,storage_key,state) VALUES(${f.input.allocationId},${f.input.threadId},${f.input.allocationId},'manifest',${"b".repeat(64)},1,'test-manifest','complete')`;
          yield* f.sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,artifact_count,workspace_branch,workspace_revision) VALUES(${f.input.allocationId},${f.input.threadId},${f.input.allocationId},1,'topic',${"c".repeat(40)})`;
          let inspections = 0;
          const activity = makeThreadVmActivityWorker(
            f.sql,
            () =>
              Effect.sync(() => {
                inspections++;
                return "idle" as const;
              }),
            f.input.hostId,
          );
          expect(yield* activity.runOne()).toBe(false);
          expect(
            (yield* makeThreadVmStatusStore(f.sql).read(f.input.threadId, 2)).repository,
          ).toBeNull();
          yield* authorizeThreadVmConnection(
            f.input.ownerUserId,
            ThreadId.make(f.input.threadId),
          ).pipe(Effect.flip);
          yield* f.sql`UPDATE relay_thread_moves SET phase='completed' WHERE operation_id=${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.input.threadId}`;
          expect(yield* activity.runOne()).toBe(true);
          expect(inspections).toBe(1);
          expect((yield* makeThreadVmStatusStore(f.sql).read(f.input.threadId, 2)).setupPhase).toBe(
            "ready",
          );
          expect(
            (yield* makeThreadVmStatusStore(f.sql).read(f.input.threadId, 2)).repository,
          ).toEqual({
            canonicalKey: f.input.canonicalKey,
            branch: "topic",
            revision: "c".repeat(40),
          });
          yield* f.sql`UPDATE relay_thread_move_checkpoints SET workspace_branch=NULL WHERE operation_id=${f.input.allocationId}`;
          expect(
            (yield* makeThreadVmStatusStore(f.sql).read(f.input.threadId, 2)).repository?.branch,
          ).toBe("");
          yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${f.input.canonicalKey + "-other"},${f.input.repositoryId},${f.input.organizationId},'now')`;
          expect(
            (yield* makeThreadVmStatusStore(f.sql).read(f.input.threadId, 2)).repository,
          ).toBeNull();
          expect(
            yield* authorizeThreadVmConnection(
              f.input.ownerUserId,
              ThreadId.make(f.input.threadId),
            ),
          ).toMatchObject({
            environmentId: f.environmentId,
            identity: { scope: { allocationId: f.input.allocationId, generation: 2 } },
          });
          let renewals = 0;
          expect(
            yield* makeThreadVmLeaseWorker(
              f.sql,
              () =>
                Effect.sync(() => {
                  renewals++;
                }),
              f.input.hostId,
            ).runOne(),
          ).toBe(true);
          expect(renewals).toBe(1);
          expect(
            (yield* makeThreadVmReplacementStore(f.sql).list(f.input.ownerUserId)).map(
              (r) => r.allocationId,
            ),
          ).toContain(f.input.allocationId);
          const backup = makeThreadVmBackupStore(f.sql);
          expect(yield* backup.enqueueDue(f.input.hostId)).not.toBeNull();
          // A finished backup no longer competes with the pause candidate.
          yield* f.sql`UPDATE relay_thread_vm_backups SET phase='failed' WHERE allocation_id=${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '31 minutes' WHERE allocation_id=${f.input.allocationId}`;
          expect(yield* makeThreadVmPauseStore(f.sql).reserveIdle(f.input.hostId)).toBe(
            f.input.allocationId,
          );
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at=clock_timestamp() WHERE allocation_id=${f.input.allocationId}`;
          yield* authorizeThreadVmConnection(
            f.input.ownerUserId,
            ThreadId.make(f.input.threadId),
          ).pipe(Effect.flip);
        }),
    );

    it.effect(
      "reserves an idle pause but retains running compute until source recovery is certified",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const activity = makeThreadVmActivityStore(f.sql);
          const revision = yield* activity.beginInspection(f.input.allocationId);
          yield* activity.finishInspection({
            allocationId: f.input.allocationId,
            revision,
            activity: "idle",
          });
          yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since = clock_timestamp() - interval '31 minutes'
          WHERE allocation_id = ${f.input.allocationId}`;
          const allocation = yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId);
          const provision = yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId);
          let state: "running" | "paused" = "running";
          let sealed = false;
          let pauses = 0;
          const info = (): SandboxInfo => ({
            sandboxId: allocation!.computeRef!,
            templateId: f.input.templateId,
            metadata: {
              "launchpad.managed": "thread-vm-v1",
              "launchpad.allocation_id": f.input.allocationId,
              "launchpad.operation_id": provision!.operationId,
              "launchpad.thread_id": f.input.threadId,
              "launchpad.generation": "1",
            },
            startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            endAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            state,
            cpuCount: 2,
            memoryMB: 4096,
            envdVersion: "test",
          });
          const worker = makeThreadVmPauseWorker(
            f.sql,
            {
              inspect: () => Effect.sync(info),
              pause: () =>
                Effect.sync(() => {
                  pauses++;
                  state = "paused";
                }),
            },
            {
              seal: (_sandbox, identity, pauseId) =>
                Effect.gen(function* () {
                  expect(identity.scope.allocationId).toBe(f.input.allocationId);
                  expect(pauseId).toBeTruthy();
                  sealed = true;
                  expect(
                    yield* Effect.flip(
                      makeThreadPlacementStore(f.sql).admit({
                        ...f.owner,
                        workId: "racing-turn",
                      }),
                    ),
                  ).toMatchObject({ _tag: "ThreadPlacementConflict" });
                  expect(
                    yield* Effect.flip(
                      makeThreadPlacementStore(f.sql).beginMove({
                        operationId: NodeCrypto.randomUUID(),
                        threadId: f.input.threadId,
                        actorUserId: f.input.ownerUserId,
                        sourceEnvironmentId: f.environmentId,
                        expectedGeneration: 1,
                        destinationEnvironmentId: "local",
                        destinationProjectId: "local-project",
                      }),
                    ),
                  ).toMatchObject({ _tag: "ThreadPlacementConflict" });
                  expect(yield* makeThreadJournalStore(f.sql).next(f.owner)).toBeNull();
                  return { bootId: NodeCrypto.randomUUID(), idle: true };
                }).pipe(Effect.orDie),
              reopen: () => Effect.die("Idle VM must stay sealed while pausing"),
            },
            f.input.hostId,
          );
          expect(yield* worker.runOne()).toBe(false);
          expect(sealed).toBe(false);
          expect(pauses).toBe(0);
          expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
            "running",
          );
          expect((yield* makeThreadVmCapacityStore(f.sql).get(provision!.operationId))?.state).toBe(
            "started",
          );
        }),
    );

    it.effect("does not pause a VM with a pending command", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        yield* f.setup.begin({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
        });
        yield* f.setup.finish({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
          receiptSha256: "a".repeat(64),
        });
        const activity = makeThreadVmActivityStore(f.sql);
        const revision = yield* activity.beginInspection(f.input.allocationId);
        yield* activity.finishInspection({
          allocationId: f.input.allocationId,
          revision,
          activity: "idle",
        });
        yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since = clock_timestamp() - interval '31 minutes'
          WHERE allocation_id = ${f.input.allocationId}`;
        const commandId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_thread_commands
          (command_id, thread_id, position, accepted_generation, actor_json, payload_json)
          VALUES (${commandId}, ${f.input.threadId}, 1, 1, '{}'::jsonb, '{}'::jsonb)`;
        const worker = makeThreadVmPauseWorker(
          f.sql,
          {
            inspect: () => Effect.die("Pending work must block inspection"),
            pause: () => Effect.die("Pending work must block pause"),
          },
          {
            seal: () => Effect.die("Pending work must block guest seal"),
            reopen: () => Effect.die("Pending work must block guest reopen"),
          },
          f.input.hostId,
        );
        expect(yield* worker.runOne()).toBe(false);
        const rows = yield* f.sql`SELECT 1 FROM relay_thread_vm_pauses
          WHERE allocation_id = ${f.input.allocationId}`;
        expect(rows).toHaveLength(0);
      }),
    );

    const backupRetentionFixture = Effect.gen(function* () {
      const f = yield* initialSetupFixture;
      yield* f.prepare;
      yield* f.setup.begin({ allocationId: f.input.allocationId, environmentId: f.environmentId });
      yield* f.setup.finish({
        allocationId: f.input.allocationId,
        environmentId: f.environmentId,
        receiptSha256: "a".repeat(64),
      });
      const old = NodeCrypto.randomUUID(),
        current = NodeCrypto.randomUUID();
      const insert = (operationId: string, minutesAgo: number) => f.sql`
        INSERT INTO relay_thread_vm_backups
          (operation_id,allocation_id,generation,compute_ref,snapshot_name,snapshot_id,
            source_template_id,source_build_id,phase,verified_at,probe_receipt)
        VALUES (${operationId},${f.input.allocationId},1,${`compute-${f.input.allocationId}`},
          ${`backup-${operationId}`},${`snapshot-${operationId}`},${`snapshot-${operationId}`},
          ${NodeCrypto.randomUUID()},'verified',clock_timestamp() - make_interval(mins => ${minutesAgo}),
          ${f.sql.json({ operationID: operationId, generation: `backup-${operationId}`, preparedBuildID: "d9dc0c90-8d53-447e-997f-40359797d086", manifestSHA256: "c".repeat(64), coldProbe: { version: 1, preparedBuildID: "d9dc0c90-8d53-447e-997f-40359797d086", rootfsSHA256: "a".repeat(64), initSHA256: "b".repeat(64), physicalStopConfirmed: true, mountOnly: true } })})`;
      yield* insert(old, 20);
      return {
        ...f,
        old,
        current,
        insert,
        retention: makeThreadVmBackupRetentionStore(f.sql),
        backups: makeThreadVmBackupStore(f.sql),
      };
    });

    const savedDiskFixture = Effect.gen(function* () {
      const f = yield* backupRetentionFixture;
      const operationId = NodeCrypto.randomUUID();
      const intent = {
        threadId: f.input.threadId,
        backupOperationId: f.old,
        operationId,
        generation: 1,
      };
      const allocations = makeThreadVmAllocationStore(f.sql);
      yield* f.retention.pin(intent);
      yield* allocations.requestDeletion(f.input.allocationId);
      yield* allocations.confirmDeleted({
        allocationId: f.input.allocationId,
        computeRef: `compute-${f.input.allocationId}`,
      });
      const savedDisks = makeThreadVmSavedDiskStore(f.sql);
      const save = yield* savedDisks.retain(intent);
      return {
        ...f,
        intent,
        save,
        savedDisks,
        allocations,
        restore: {
          threadId: f.input.threadId,
          savedDiskOperationId: operationId,
          operationId: NodeCrypto.randomUUID(),
          allocationId: NodeCrypto.randomUUID(),
          actorUserId: f.input.ownerUserId,
          expectedGeneration: 1,
        },
      };
    });

    it.effect("refuses restore when a retained disk has no cold proof", () =>
      Effect.gen(function* () {
        const f = yield* savedDiskFixture;
        yield* f.sql`UPDATE relay_thread_vm_backups SET probe_receipt=NULL WHERE operation_id=${f.old}`;
        expect(yield* Effect.flip(f.savedDisks.beginRestore(f.restore))).toMatchObject({
          _tag: "ThreadVmSavedDiskConflict",
        });
        expect(yield* f.allocations.get(f.restore.allocationId)).toBeNull();
        expect((yield* f.savedDisks.get(f.save.operationId))?.phase).toBe("available");
      }),
    );

    it.effect("retains only a pinned verified disk after confirmed allocation deletion", () =>
      Effect.gen(function* () {
        const f = yield* backupRetentionFixture;
        const savedDisks = makeThreadVmSavedDiskStore(f.sql);
        const intent = {
          threadId: f.input.threadId,
          backupOperationId: f.old,
          operationId: NodeCrypto.randomUUID(),
          generation: 1,
        };
        yield* f.retention.pin(intent);
        expect(yield* Effect.flip(savedDisks.retain(intent))).toMatchObject({
          _tag: "ThreadVmSavedDiskConflict",
        });
        const allocations = makeThreadVmAllocationStore(f.sql);
        yield* allocations.requestDeletion(f.input.allocationId);
        expect(yield* Effect.flip(savedDisks.retain(intent))).toMatchObject({
          _tag: "ThreadVmSavedDiskConflict",
        });
        yield* allocations.confirmDeleted({
          allocationId: f.input.allocationId,
          computeRef: `compute-${f.input.allocationId}`,
        });
        const save = yield* savedDisks.retain(intent);
        expect(save.phase).toBe("available");
        expect(yield* savedDisks.retain(intent)).toEqual(save);
        expect(
          yield* Effect.flip(
            allocations.reserve({
              allocationId: NodeCrypto.randomUUID(),
              threadId: f.input.threadId,
              organizationId: f.input.organizationId,
              ownerUserId: f.input.ownerUserId,
              templateId: f.input.templateId,
            }),
          ),
        ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
        expect(
          yield* Effect.flip(
            makeThreadJournalStore(f.sql).confirmThrough({ ...f.owner, sourceSequence: 1000 }),
          ),
        ).toMatchObject({ _tag: "ThreadPlacementConflict" });
        expect(
          yield* Effect.flip(savedDisks.retain({ ...intent, threadId: "foreign-thread" })),
        ).toMatchObject({ _tag: "ThreadVmSavedDiskConflict" });
        expect(
          yield* Effect.flip(
            makeThreadPlacementStore(f.sql).admit({ ...f.owner, workId: "must-not-run-old-vm" }),
          ),
        ).toMatchObject({ _tag: "ThreadPlacementConflict" });
        expect(yield* makeThreadJournalStore(f.sql).next(f.owner)).toBeNull();
        expect(
          yield* Effect.flip(
            makeThreadPlacementStore(f.sql).beginMove({
              threadId: f.input.threadId,
              operationId: NodeCrypto.randomUUID(),
              actorUserId: f.input.ownerUserId,
              sourceEnvironmentId: f.environmentId,
              expectedGeneration: 1,
              destinationEnvironmentId: "local",
              destinationProjectId: "local",
            }),
          ),
        ).toMatchObject({ _tag: "ThreadPlacementConflict" });
        const pins = yield* f.sql<{ operationId: string }>`SELECT operation_id AS "operationId"
          FROM relay_thread_vm_backup_pins WHERE backup_operation_id=${f.old}`;
        expect(pins).toEqual([{ operationId: `saved-${intent.operationId}` }]);
      }),
    );

    it.effect(
      "keeps recoverable final saves for configured host IDs longer than 64 characters",
      () =>
        Effect.gen(function* () {
          const f = yield* backupRetentionFixture;
          const hostId = `operator-compute-host-${NodeCrypto.randomUUID()}`.padEnd(180, "x");
          yield* makeThreadVmCapacityStore(f.sql).configure(hostId, 1);
          yield* f.sql`UPDATE relay_thread_vm_capacity SET host_id=${hostId}
        WHERE allocation_id=${f.input.allocationId}`;
          const intent = {
            threadId: f.input.threadId,
            backupOperationId: f.old,
            operationId: NodeCrypto.randomUUID(),
            generation: 1,
          };
          yield* f.retention.pin(intent);
          const allocations = makeThreadVmAllocationStore(f.sql);
          yield* allocations.requestDeletion(f.input.allocationId);
          yield* allocations.confirmDeleted({
            allocationId: f.input.allocationId,
            computeRef: `compute-${f.input.allocationId}`,
          });
          const saved = yield* makeThreadVmSavedDiskStore(f.sql).retain(intent);
          expect(saved.hostId).toBe(hostId);
          expect(saved.phase).toBe("available");
        }),
    );

    it.effect(
      "reserves restore pins and quota atomically, and keeps them through expired retention",
      () =>
        Effect.gen(function* () {
          const f = yield* savedDiskFixture;
          yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=0
          WHERE organization_id=${f.input.organizationId}`;
          expect(yield* Effect.flip(f.savedDisks.beginRestore(f.restore))).toMatchObject({
            _tag: "ThreadVmQuotaExceeded",
          });
          expect((yield* f.savedDisks.get(f.save.operationId))?.phase).toBe("available");
          expect(yield* f.allocations.get(f.restore.allocationId)).toBeNull();
          expect(
            (yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId,
          ).toBeNull();
          const quotaFailurePins = yield* f.sql`SELECT 1 FROM relay_thread_vm_backup_pins
          WHERE backup_operation_id=${f.old} AND operation_id=${f.restore.operationId}`;
          expect(quotaFailurePins).toHaveLength(0);
          yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user=1
          WHERE organization_id=${f.input.organizationId}`;
          expect(
            yield* Effect.flip(
              f.savedDisks.beginRestore({ ...f.restore, actorUserId: "another-user" }),
            ),
          ).toMatchObject({ _tag: "ThreadVmSavedDiskConflict" });
          const restored = yield* f.savedDisks.beginRestore(f.restore);
          expect(restored.phase).toBe("restoring");
          expect(yield* f.savedDisks.beginRestore(f.restore)).toEqual(restored);
          expect(
            yield* Effect.flip(
              f.savedDisks.beginRestore({ ...f.restore, allocationId: NodeCrypto.randomUUID() }),
            ),
          ).toMatchObject({ _tag: "ThreadVmSavedDiskConflict" });
          expect(yield* f.allocations.get(f.restore.allocationId)).toMatchObject({
            state: "creating",
            ownerUserId: f.input.ownerUserId,
          });
          expect(yield* makeThreadVmCapacityStore(f.sql).get(f.restore.operationId)).toMatchObject({
            state: "waiting",
            allocationId: f.restore.allocationId,
          });
          yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days'
          WHERE operation_id=${f.save.operationId}`;
          expect(yield* f.savedDisks.claimExpired(f.input.hostId)).toBeNull();
          expect(yield* Effect.flip(f.savedDisks.cancelRestore(f.restore))).toMatchObject({
            _tag: "ThreadVmSavedDiskConflict",
          });
          expect(yield* Effect.flip(f.savedDisks.completeRestore(f.restore))).toMatchObject({
            _tag: "ThreadVmSavedDiskConflict",
          });
          const savedAt = (yield* f.savedDisks.get(f.save.operationId))!.savedAt;
          yield* f.allocations.requestDeletion(f.restore.allocationId);
          yield* f.allocations.confirmDeleted({
            allocationId: f.restore.allocationId,
            computeRef: null,
          });
          const cancelled = yield* f.savedDisks.cancelRestore(f.restore);
          expect(cancelled.phase).toBe("available");
          expect(cancelled.savedAt).toBe(savedAt);
          expect(yield* f.savedDisks.cancelRestore(f.restore)).toEqual(cancelled);
          expect(
            yield* Effect.flip(
              f.savedDisks.cancelRestore({ ...f.restore, operationId: NodeCrypto.randomUUID() }),
            ),
          ).toMatchObject({ _tag: "ThreadVmSavedDiskConflict" });
          const expiry = yield* f.savedDisks.claimExpired(f.input.hostId);
          expect(expiry?.operationId).toBe(f.save.operationId);
          expect(yield* Effect.flip(f.savedDisks.beginRestore(f.restore))).toMatchObject({
            _tag: "ThreadVmSavedDiskConflict",
          });
        }),
    );

    it.effect(
      "serializes concurrent restore requests and excludes expiry during their transaction",
      () =>
        Effect.gen(function* () {
          const f = yield* savedDiskFixture;
          const other = {
            ...f.restore,
            operationId: NodeCrypto.randomUUID(),
            allocationId: NodeCrypto.randomUUID(),
          };
          const results = yield* parallel([
            Effect.result(f.savedDisks.beginRestore(f.restore)),
            Effect.result(f.savedDisks.beginRestore(other)),
          ]);
          expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
          expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
          const allocations = yield* f.sql`SELECT 1 FROM relay_thread_vm_allocations
          WHERE thread_id=${f.input.threadId} AND deleted_at IS NULL`;
          expect(allocations).toHaveLength(1);
          const g = yield* savedDiskFixture;
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const restoring = yield* Effect.forkScoped(
            g.sql.withTransaction(
              Effect.gen(function* () {
                yield* g.savedDisks.beginRestore(g.restore);
                yield* g.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days'
            WHERE operation_id=${g.save.operationId}`;
                yield* Deferred.succeed(acquired, undefined);
                yield* Deferred.await(release);
              }),
            ),
          );
          yield* Deferred.await(acquired);
          expect(yield* g.savedDisks.claimExpired(g.input.hostId)).toBeNull();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(restoring);
          expect((yield* g.savedDisks.get(g.save.operationId))?.phase).toBe("restoring");
          expect(yield* g.savedDisks.claimExpired(g.input.hostId)).toBeNull();
          const status = yield* getThreadVmStatus(g.input.threadId).pipe(
            Effect.provideService(RelayClientPrincipal, {
              userId: g.input.ownerUserId,
              token: "test",
            }),
          );
          expect(status.savedDisk).toMatchObject({ phase: "restoring" });
        }).pipe(Effect.scoped),
    );

    it.effect("releases a saved-disk restore only after its new generation is activated", () =>
      Effect.gen(function* () {
        const f = yield* savedDiskFixture;
        yield* f.savedDisks.beginRestore(f.restore);
        const capacity = makeThreadVmCapacityStore(f.sql);
        yield* capacity.admitNext(f.input.hostId);
        yield* capacity.beginExecution(f.restore.operationId);
        const computeRef = `restore-${f.restore.allocationId}`;
        yield* capacity.recordCreated(f.restore.operationId, computeRef);
        yield* f.allocations.recordCreated({ allocationId: f.restore.allocationId, computeRef });
        const environmentId = `restored-${f.restore.allocationId}`;
        const credentialId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_environment_credentials
          (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES (${credentialId},${environmentId},'restored-key',${credentialId},'now','now')`;
        yield* f.sql`INSERT INTO relay_thread_vm_provisions
          (allocation_id,operation_id,generation,phase) VALUES
          (${f.restore.allocationId},${f.restore.operationId},2,'created')`;
        yield* makeThreadVmBindingStore(f.sql).bind({
          allocationId: f.restore.allocationId,
          operationId: f.restore.operationId,
          environmentId,
          credentialId,
          environmentPublicKey: "restored-key",
        });
        yield* f.sql`INSERT INTO relay_thread_vm_setups
          (allocation_id,canonical_key,branch,revision,phase,environment_id,receipt_sha256)
          VALUES (${f.restore.allocationId},${f.input.canonicalKey},'main',${f.input.revision},
            'ready',${environmentId},${"a".repeat(64)})`;
        expect(yield* Effect.flip(f.savedDisks.completeRestore(f.restore))).toMatchObject({
          _tag: "ThreadVmSavedDiskConflict",
        });
        // This fixture represents the ownership/activation receipt, not a real cold boot.
        yield* f.sql`UPDATE relay_thread_placements SET environment_id=${environmentId},
          generation=2,operation_id=NULL WHERE thread_id=${f.input.threadId}`;
        yield* f.savedDisks.completeRestore(f.restore);
        yield* f.savedDisks.completeRestore(f.restore);
        expect((yield* f.savedDisks.get(f.save.operationId))?.phase).toBe("restored");
        const pins = yield* f.sql`SELECT 1 FROM relay_thread_vm_backup_pins
          WHERE backup_operation_id=${f.old}`;
        expect(pins).toHaveLength(0);
        expect(yield* Effect.flip(f.savedDisks.cancelRestore(f.restore))).toMatchObject({
          _tag: "ThreadVmSavedDiskConflict",
        });
        expect(
          yield* makeThreadPlacementStore(f.sql).admit({
            threadId: f.input.threadId,
            environmentId,
            generation: 2,
            workId: "after-restore",
          }),
        ).toMatchObject({ newlyAdmitted: true });
      }),
    );

    it.effect(
      "reconciles saved-disk expiry without deleting separately retained native state",
      () =>
        Effect.gen(function* () {
          const f = yield* savedDiskFixture;
          const native = makeThreadArtifactStore(f.sql);
          const artifact = {
            artifactId: NodeCrypto.randomUUID(),
            threadId: f.input.threadId,
            operationId: NodeCrypto.randomUUID(),
            kind: "native" as const,
            sha256: "a".repeat(64),
            sizeBytes: 10,
          };
          yield* native.begin(artifact);
          yield* native.complete({ ...artifact, retentionDays: null });
          yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days'
          WHERE operation_id=${f.save.operationId}`;
          let calls = 0;
          const worker = makeThreadVmSavedDiskWorker(
            f.sql,
            {
              deleteSnapshot: (snapshotId) =>
                Effect.gen(function* () {
                  expect(snapshotId).toBe(`snapshot-${f.old}`);
                  calls++;
                  if (calls === 1)
                    return yield* new ThreadVmComputeError({
                      operation: "delete snapshot",
                      message: "reply lost",
                    });
                  return false;
                }),
            },
            f.input.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* f.savedDisks.get(f.save.operationId))?.phase).toBe("expiring");
          expect(yield* worker.runOne()).toBe(false);
          expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
          expect(
            yield* Effect.flip(
              f.retention.pin({
                threadId: f.input.threadId,
                backupOperationId: f.old,
                operationId: "late-pin",
              }),
            ),
          ).toMatchObject({ _tag: "ThreadVmBackupConflict" });
          // A policy edit cannot reverse a deletion which already won.
          yield* f.sql`UPDATE relay_thread_vm_policies SET saved_disk_retention_days=90
          WHERE organization_id=${f.input.organizationId}`;
          yield* f.sql`UPDATE relay_thread_vm_saved_disks SET retry_at=clock_timestamp()
          WHERE operation_id=${f.save.operationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* f.savedDisks.get(f.save.operationId))?.phase).toBe("expired");
          expect((yield* f.backups.get(f.old))?.phase).toBe("retired");
          expect((yield* native.get(artifact.artifactId))?.state).toBe("complete");
          expect(yield* native.claimExpired()).toBeNull();
          expect(calls).toBe(2);
        }),
    );

    it.effect(
      "rechecks current retention policy and counts calendar days across daylight saving",
      () =>
        Effect.gen(function* () {
          const f = yield* savedDiskFixture;
          yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at='2026-03-28T12:00:00Z'::timestamptz
          WHERE operation_id=${f.save.operationId}`;
          yield* f.sql`UPDATE relay_thread_vm_policies SET saved_disk_retention_days=2,
          calendar_time_zone='Europe/Berlin' WHERE organization_id=${f.input.organizationId}`;
          expect((yield* f.savedDisks.get(f.save.operationId))?.expiresAt).toBe(
            "2026-03-30T11:00:00.000Z",
          );
          yield* f.sql`UPDATE relay_thread_vm_saved_disks SET saved_at=clock_timestamp()-interval '31 days'
          WHERE operation_id=${f.save.operationId}`;
          yield* f.sql`UPDATE relay_thread_vm_policies SET saved_disk_retention_days=90
          WHERE organization_id=${f.input.organizationId}`;
          expect(yield* f.savedDisks.claimExpired(f.input.hostId)).toBeNull();
          yield* f.sql`UPDATE relay_thread_vm_policies SET saved_disk_retention_days=30
          WHERE organization_id=${f.input.organizationId}`;
          const pin = {
            threadId: f.input.threadId,
            backupOperationId: f.old,
            operationId: NodeCrypto.randomUUID(),
          };
          yield* f.retention.pin(pin);
          expect(yield* f.savedDisks.claimExpired(f.input.hostId)).toBeNull();
          yield* f.retention.releasePin(pin);
          expect((yield* f.savedDisks.claimExpired(f.input.hostId))?.operationId).toBe(
            f.save.operationId,
          );
        }),
    );

    it.effect("keeps the current save, active candidates and durable operation pins", () =>
      Effect.gen(function* () {
        const f = yield* backupRetentionFixture;
        expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
        yield* f.insert(f.current, 0);
        const pin = {
          threadId: f.input.threadId,
          backupOperationId: f.old,
          operationId: NodeCrypto.randomUUID(),
        };
        yield* f.retention.pin(pin);
        yield* f.retention.pin(pin);
        expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
        yield* f.retention.releasePin(pin);
        const candidate = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_thread_vm_backups
          (operation_id,allocation_id,generation,compute_ref,snapshot_name,phase)
          VALUES (${candidate},${f.input.allocationId},1,${`compute-${f.input.allocationId}`},
            ${`candidate-${candidate}`},'creating')`;
        expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
        yield* f.sql`UPDATE relay_thread_vm_backups SET phase='failed' WHERE operation_id=${candidate}`;
        yield* f.sql`UPDATE relay_thread_placements SET operation_id=${NodeCrypto.randomUUID()}
          WHERE thread_id=${f.input.threadId}`;
        expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
        yield* f.sql`UPDATE relay_thread_placements SET operation_id=NULL WHERE thread_id=${f.input.threadId}`;
        const claim = yield* f.retention.claim(f.input.hostId);
        expect(claim?.operationId).toBe(f.old);
        expect((yield* f.backups.get(f.current))?.phase).toBe("verified");
        expect(yield* Effect.flip(f.retention.pin(pin))).toMatchObject({
          _tag: "ThreadVmBackupConflict",
        });
        expect(yield* f.retention.claim(f.input.hostId)).toBeNull();
      }),
    );

    it.effect("reconciles a lost snapshot deletion reply without retiring current recovery", () =>
      Effect.gen(function* () {
        const f = yield* backupRetentionFixture;
        yield* f.insert(f.current, 0);
        let calls = 0;
        const worker = makeThreadVmBackupRetentionWorker(
          f.sql,
          {
            deleteSnapshot: (snapshotId) =>
              Effect.gen(function* () {
                expect(snapshotId).toBe(`snapshot-${f.old}`);
                calls++;
                if (calls === 1)
                  return yield* new ThreadVmComputeError({
                    operation: "delete snapshot",
                    message: "reply lost after catalog deletion",
                  });
                return false; // The SDK has confirmed that this catalog entry is absent.
              }),
          },
          f.input.hostId,
        );
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* f.backups.get(f.old))?.phase).toBe("retiring");
        expect((yield* f.backups.get(f.current))?.phase).toBe("verified");
        expect(yield* worker.runOne()).toBe(false);
        yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at=clock_timestamp()
          WHERE operation_id=${f.old}`;
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* f.backups.get(f.old))?.phase).toBe("retired");
        expect((yield* f.backups.get(f.current))?.phase).toBe("verified");
        expect(yield* worker.runOne()).toBe(false);
        expect(calls).toBe(2);
        expect(
          yield* Effect.flip(
            f.retention.pin({
              threadId: "foreign-thread",
              backupOperationId: f.current,
              operationId: "foreign",
            }),
          ),
        ).toMatchObject({ _tag: "ThreadVmBackupConflict" });
        expect(
          (yield* Effect.result(f.sql`UPDATE relay_thread_vm_backups
          SET snapshot_id=${`snapshot-${f.current}`} WHERE operation_id=${f.old}`))._tag,
        ).toBe("Failure");
      }),
    );

    it.effect(
      "reconciles a lost backup reply and verifies cold recovery before publishing it",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const allocation = (yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))!;
          const provision = (yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId))!;
          const backup = makeThreadVmBackupStore(f.sql);
          const info: SandboxInfo = {
            sandboxId: allocation.computeRef!,
            templateId: f.input.templateId,
            metadata: {
              "launchpad.managed": "thread-vm-v1",
              "launchpad.allocation_id": f.input.allocationId,
              "launchpad.operation_id": provision.operationId,
              "launchpad.thread_id": f.input.threadId,
              "launchpad.generation": "1",
            },
            startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            endAt: DateTime.toDateUtc(DateTime.makeUnsafe(900_000)),
            state: "running",
            cpuCount: 2,
            memoryMB: 4096,
            envdVersion: "test",
          };
          let captures = 0;
          let probes = 0;
          let cancellations = 0;
          const worker = makeThreadVmBackupWorker(
            f.sql,
            {
              inspect: () => Effect.succeed(info),
              snapshot: (_sandbox, name) =>
                Effect.gen(function* () {
                  captures++;
                  expect(name).toMatch(/^launchpad-backup-/);
                  return yield* new ThreadVmComputeError({
                    operation: "snapshot",
                    message: "response lost after capture",
                  });
                }),
              findSnapshot: () =>
                Effect.succeed({
                  snapshotId: "snapshot-1",
                  names: ["launchpad-backup:latest"],
                }),
              restore: {
                resolveNamedSnapshot: () =>
                  Effect.succeed({
                    sourceTemplateID: "snapshot-template",
                    sourceBuildID: NodeCrypto.randomUUID(),
                  }),
                prepare: (operationID, request) =>
                  Effect.sync(() => {
                    probes++;
                    expect(request.bootstrap).toBeUndefined();
                    return {
                      operationID,
                      generation: request.generation,
                      sandboxID: allocation.computeRef!,
                      executionID: NodeCrypto.randomUUID(),
                      preparedBuildID: "d9dc0c90-8d53-447e-997f-40359797d086",
                      manifestSHA256: "c".repeat(64),
                      ...(probes < 2
                        ? {}
                        : {
                            coldProbe: {
                              version: 1,
                              preparedBuildID: "d9dc0c90-8d53-447e-997f-40359797d086",
                              rootfsSHA256: "a".repeat(64),
                              initSHA256: "b".repeat(64),
                              physicalStopConfirmed: true,
                              mountOnly: true,
                            },
                          }),
                      state: "prepared" as const,
                    };
                  }),
                cancel: (operationID, generation) =>
                  Effect.sync(() => {
                    cancellations++;
                    return {
                      operationID,
                      generation,
                      sandboxID: allocation.computeRef!,
                      executionID: NodeCrypto.randomUUID(),
                      preparedBuildID: NodeCrypto.randomUUID(),
                      state: cancellations === 1 ? ("cancelling" as const) : ("cancelled" as const),
                    };
                  }),
              },
            },
            f.input.hostId,
          );
          expect(yield* worker.runOne()).toBe(true);
          const [candidate] = yield* f.sql<{ operationId: string }>`
          SELECT operation_id AS "operationId" FROM relay_thread_vm_backups
          WHERE allocation_id = ${f.input.allocationId}`;
          expect((yield* backup.get(candidate!.operationId))?.phase).toBe("creating");
          expect(
            yield* Effect.flip(
              makeThreadVmAllocationStore(f.sql).requestDeletion(f.input.allocationId),
            ),
          ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
          expect(
            yield* Effect.flip(
              makeThreadPlacementStore(f.sql).beginMove({
                operationId: NodeCrypto.randomUUID(),
                threadId: f.input.threadId,
                actorUserId: f.input.ownerUserId,
                sourceEnvironmentId: f.environmentId,
                expectedGeneration: 1,
                destinationEnvironmentId: "local",
                destinationProjectId: "local-project",
              }),
            ),
          ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at = clock_timestamp()
          WHERE operation_id = ${candidate!.operationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* backup.get(candidate!.operationId))?.phase).toBe("captured");
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* backup.get(candidate!.operationId))?.phase).toBe("verifying");
          expect(cancellations).toBe(0);
          yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at = clock_timestamp()
            WHERE operation_id = ${candidate!.operationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* backup.get(candidate!.operationId))?.phase).toBe("cleanup");
          yield* f.sql`UPDATE relay_thread_vm_backups SET retry_at = clock_timestamp()
          WHERE operation_id = ${candidate!.operationId}`;
          expect(yield* worker.runOne()).toBe(true);
          expect((yield* backup.get(candidate!.operationId))?.phase).toBe("verified");
          expect((yield* backup.get(candidate!.operationId))?.probeReceipt).toMatchObject({
            operationID: candidate!.operationId,
            manifestSHA256: "c".repeat(64),
            coldProbe: { physicalStopConfirmed: true },
          });
          expect(captures).toBe(1);
          expect(probes).toBe(2);
          expect(cancellations).toBe(2);
          expect(yield* worker.runOne()).toBe(false);
        }),
    );

    it.effect(
      "reads current VM lifecycle without waking compute or exposing it to another user",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const read = (userId: string) =>
            getThreadVmStatus(f.input.threadId).pipe(
              Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
            );
          expect(yield* Effect.flip(read(NodeCrypto.randomUUID()))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          expect(yield* read(f.input.ownerUserId)).toMatchObject({
            allocation: { allocationId: f.input.allocationId, state: "running" },
            setupPhase: "ready",
            capacityState: "started",
            activity: "unknown",
            backupPhase: null,
          });
          yield* makeThreadVmBackupStore(f.sql).enqueueDue(f.input.hostId);
          expect(yield* read(f.input.ownerUserId)).toMatchObject({ backupPhase: "pending" });
        }),
    );

    it.effect("suggests only an owned, fresh-idle VM for quota replacement", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        yield* f.setup.begin({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
        });
        yield* f.setup.finish({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
          receiptSha256: "a".repeat(64),
        });
        const replacement = makeThreadVmReplacementStore(f.sql);
        expect(yield* replacement.suggest(f.input.ownerUserId)).toBeNull();
        const activity = makeThreadVmActivityStore(f.sql);
        const revision = yield* activity.beginInspection(f.input.allocationId);
        yield* activity.finishInspection({
          allocationId: f.input.allocationId,
          revision,
          activity: "idle",
        });
        expect(yield* replacement.suggest(f.input.ownerUserId)).toMatchObject({
          allocationId: f.input.allocationId,
          threadId: f.input.threadId,
          state: "running",
        });
        expect(yield* replacement.suggest(NodeCrypto.randomUUID())).toBeNull();
        yield* f.sql`INSERT INTO relay_thread_commands
          (command_id, thread_id, position, accepted_generation, actor_json, payload_json)
          VALUES (${NodeCrypto.randomUUID()}, ${f.input.threadId}, 1, 1, '{}'::jsonb, '{}'::jsonb)`;
        expect(yield* replacement.suggest(f.input.ownerUserId)).toBeNull();
      }),
    );

    for (const scenario of [
      "archive",
      "unarchive",
      "undo",
      "pause",
      "edit",
      "send",
      "resume",
      "archived-send",
      "unarchived-send",
      "paused-send",
      "unarchived-resume",
      "mirrored-unarchived-send",
      "mirrored-enabled-send",
    ] as const) {
      it.effect(`paused VM wake admission: ${scenario}`, () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const provision = (yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId))!;
          const allocation = (yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))!;
          yield* makeThreadVmAllocationStore(f.sql).recordPowerState({
            allocationId: f.input.allocationId,
            computeRef: allocation.computeRef!,
            state: "paused",
            capacityOperationId: provision.operationId,
          });
          yield* f.sql`INSERT INTO relay_thread_vm_pauses(allocation_id,operation_id,generation,phase) VALUES(${f.input.allocationId},${NodeCrypto.randomUUID()},1,'completed')`;
          const journal = makeThreadJournalStore(f.sql),
            resumes = makeThreadVmResumeStore(f.sql);
          const stage = Effect.fnUntraced(function* (data: Record<string, unknown>) {
            const command = yield* decodeClientCommand({
              commandId: NodeCrypto.randomUUID(),
              threadId: f.input.threadId,
              createdAt: "2026-10-07T00:00:00Z",
              ...data,
            });
            if (!("threadId" in command)) return yield* Effect.die("Expected a thread command");
            return yield* journal.stage({
              threadId: f.input.threadId,
              actor: { userId: f.input.ownerUserId, displayName: null, imageUrl: null },
              command,
            });
          });
          const send = {
            type: "thread.prompt.enqueue",
            message: { messageId: NodeCrypto.randomUUID(), text: "hello", attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
          };
          if (["archived-send", "unarchived-send", "unarchived-resume"].includes(scenario)) {
            yield* stage({ type: "thread.archive" });
            if (scenario !== "archived-send") yield* stage({ type: "thread.unarchive" });
          }
          if (scenario === "paused-send") yield* stage({ type: "thread.queue.pause" });
          if (scenario.startsWith("mirrored-")) {
            const event = historyEvent(f.input.threadId, 1);
            yield* journal.append({ ...f.owner, event });
            yield* journal.append({
              ...f.owner,
              event: {
                ...event,
                type: "thread.unarchived",
                sequence: 2,
                eventId: EventId.make(NodeCrypto.randomUUID()),
                payload: { threadId: ThreadId.make(f.input.threadId), updatedAt: event.occurredAt },
              },
            });
            if (scenario === "mirrored-enabled-send")
              yield* journal.append({
                ...f.owner,
                event: {
                  ...event,
                  type: "thread.prompt-queue-changed",
                  sequence: 3,
                  eventId: EventId.make(NodeCrypto.randomUUID()),
                  payload: {
                    threadId: ThreadId.make(f.input.threadId),
                    updatedAt: event.occurredAt,
                    control: { enabled: true, revision: 1, pauseReason: null },
                  },
                },
              });
          }
          yield* stage(
            scenario === "archive"
              ? { type: "thread.archive" }
              : scenario === "unarchive"
                ? { type: "thread.unarchive" }
                : scenario === "undo"
                  ? {
                      type: "thread.checkpoint.revert",
                      turnCount: 0,
                    }
                  : scenario === "pause"
                    ? { type: "thread.queue.pause" }
                    : scenario === "edit"
                      ? {
                          type: "thread.prompt.edit",
                          messageId: "message",
                          expectedRevision: 1,
                          message: { text: "edited", attachments: [] },
                        }
                      : scenario === "resume" || scenario === "unarchived-resume"
                        ? { type: "thread.queue.resume", expectedRevision: 0 }
                        : send,
          );
          const wakes = ["send", "resume", "unarchived-resume", "mirrored-enabled-send"].includes(
            scenario,
          );
          expect(yield* resumes.get(f.input.allocationId)).toEqual(
            wakes ? expect.objectContaining({ phase: "waiting" }) : null,
          );
          expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
            "paused",
          );
        }),
      );
    }

    it.effect("wakes a paused VM through FIFO capacity and recovers a lost resume reply", () =>
      Effect.gen(function* () {
        const f = yield* initialSetupFixture;
        yield* f.prepare;
        yield* f.setup.begin({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
        });
        yield* f.setup.finish({
          allocationId: f.input.allocationId,
          environmentId: f.environmentId,
          receiptSha256: "a".repeat(64),
        });
        const provision = (yield* makeThreadVmProvisionStore(f.sql).get(f.input.allocationId))!;
        const allocation = (yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))!;
        const pauseOperationId = NodeCrypto.randomUUID();
        yield* makeThreadVmAllocationStore(f.sql).recordPowerState({
          allocationId: f.input.allocationId,
          computeRef: allocation.computeRef!,
          state: "paused",
          capacityOperationId: provision.operationId,
        });
        yield* f.sql`INSERT INTO relay_thread_vm_pauses (allocation_id, operation_id, generation, phase)
          VALUES (${f.input.allocationId}, ${pauseOperationId}, 1, 'completed')`;
        const resumes = makeThreadVmResumeStore(f.sql);
        const settings = {
          hostId: f.input.hostId,
          maxRunningVms: 1,
          publicRelayUrl: "https://relay.test",
          autoPauseEnabled: false,
          autoBackupEnabled: false,
          autoDeleteEnabled: false,
          replacementEnabled: false,
          restoreEnabled: false,
          resetEnabled: false,
          templateBuildId: "verified",
          compute: {
            apiUrl: "https://compute.test",
            sandboxUrl: "https://proxy.test",
            apiKey: Redacted.make("test-key"),
            templateId: "next-allocation-template:verified",
            hostAddresses: ["192.0.2.1"],
            timeoutMs: 600000,
          },
        };
        const asUser = (userId: string) =>
          resumeThreadVm(f.input.threadId).pipe(
            Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
            Effect.provideService(ThreadVmRuntimeConfiguration, { settings }),
          );
        expect(yield* Effect.flip(asUser(NodeCrypto.randomUUID()))).toMatchObject({
          _tag: "RelayTenancyNotFoundError",
        });
        const queued = yield* makeThreadJournalStore(f.sql).stage({
          threadId: f.input.threadId,
          actor: { userId: f.input.ownerUserId, displayName: null, imageUrl: null },
          command: {
            type: "thread.queue.pause",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: ThreadId.make(f.input.threadId),
            createdAt: "2026-10-06T00:00:00Z",
          },
        });
        expect(queued?.receipt).toBeNull();
        expect(yield* makeThreadJournalStore(f.sql).next(f.owner)).toBeNull();
        const requested = yield* asUser(f.input.ownerUserId);
        expect(requested.phase).toBe("waiting");
        expect((yield* makeThreadVmCapacityStore(f.sql).get(requested.operationId))?.state).toBe(
          "waiting",
        );
        let state: "running" | "paused" = "paused";
        let wakeCalls = 0;
        let gateCalls = 0;
        const allocationInfo: SandboxInfo = {
          sandboxId: allocation.computeRef!,
          templateId: f.input.templateId,
          metadata: {
            "launchpad.managed": "thread-vm-v1",
            "launchpad.allocation_id": f.input.allocationId,
            "launchpad.operation_id": provision.operationId,
            "launchpad.thread_id": f.input.threadId,
            "launchpad.generation": "1",
          },
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          endAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
          state,
          cpuCount: 2,
          memoryMB: 4096,
          envdVersion: "test",
        };
        const worker = makeThreadVmResumeWorker(
          f.sql,
          {
            inspect: () => Effect.sync(() => ({ ...allocationInfo, state })),
            resume: () =>
              Effect.gen(function* () {
                wakeCalls++;
                state = "running";
                return yield* new ThreadVmComputeError({
                  operation: "resume",
                  message: "lost reply",
                });
              }),
          },
          {
            reopenAfterResume: (_sandbox, identity, operationId) =>
              Effect.gen(function* () {
                gateCalls++;
                expect(identity.scope.allocationId).toBe(f.input.allocationId);
                expect(identity.templateId).toBe(f.input.templateId);
                expect(identity.templateId).not.toBe(settings.compute.templateId);
                expect(operationId).toBe(pauseOperationId);
                expect(
                  yield* Effect.flip(
                    makeThreadPlacementStore(f.sql).admit({
                      ...f.owner,
                      workId: "racing-wake",
                    }),
                  ),
                ).toMatchObject({ _tag: "ThreadPlacementConflict" });
              }).pipe(Effect.orDie),
          },
          f.input.hostId,
        );
        expect(yield* worker.runOne()).toBe(true);
        expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("resuming");
        expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "paused",
        );
        yield* f.sql`UPDATE relay_thread_vm_resumes SET retry_at = clock_timestamp()
          WHERE allocation_id = ${f.input.allocationId}`;
        expect(yield* worker.runOne()).toBe(true);
        expect(wakeCalls).toBe(1);
        expect(gateCalls).toBe(1);
        expect((yield* resumes.get(f.input.allocationId))?.phase).toBe("completed");
        expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "running",
        );
        expect((yield* makeThreadVmCapacityStore(f.sql).get(requested.operationId))?.state).toBe(
          "started",
        );
        expect(yield* makeThreadJournalStore(f.sql).next(f.owner)).toBeNull();
        yield* makeThreadVmPauseRecoveryStore(
          f.sql,
          yield* ThreadArtifactObjectStorage,
        ).confirmActivation({
          ...f.owner,
          operationId: pauseOperationId,
        });
        expect((yield* makeThreadJournalStore(f.sql).next(f.owner))?.commandId).toBe(
          queued?.commandId,
        );
        let renewals = 0;
        const lease = makeThreadVmLeaseWorker(
          f.sql,
          (_sandbox, identity) =>
            Effect.sync(() => {
              expect(identity.scope.allocationId).toBe(f.input.allocationId);
              renewals++;
            }),
          f.input.hostId,
        );
        expect(yield* lease.runOne()).toBe(true);
        expect(renewals).toBe(1);
        expect(yield* lease.runOne()).toBe(false);
        yield* makeThreadJournalStore(f.sql).acknowledge({
          ...f.owner,
          commandId: queued!.commandId,
          receipt: { status: "accepted", sequence: 1 },
        });
        const inspector = makeThreadVmActivityWorker(
          f.sql,
          () => Effect.succeed("idle" as const),
          f.input.hostId,
        );
        expect(yield* inspector.runOne()).toBe(true);
        yield* f.sql`UPDATE relay_thread_vm_activity SET idle_since=clock_timestamp()-interval '31 minutes' WHERE allocation_id=${f.input.allocationId}`;
        let secondPauseOperation: string | undefined;
        const pauseAgain = makeThreadVmPauseWorker(
          f.sql,
          {
            inspect: () => Effect.succeed({ ...allocationInfo, state }),
            pause: () =>
              Effect.sync(() => {
                state = "paused";
              }),
          },
          {
            seal: (_sandbox, _identity, operationId) =>
              Effect.sync(() => {
                secondPauseOperation = operationId;
                return { bootId: NodeCrypto.randomUUID(), idle: true };
              }),
            reopen: () => Effect.die("Unexpected reopen"),
          },
          f.input.hostId,
        );
        expect(yield* pauseAgain.runOne()).toBe(false);
        expect(secondPauseOperation).toBeUndefined();
        const [pendingPause] = yield* f.sql<{
          operationId: string;
          phase: string;
        }>`SELECT operation_id AS "operationId",phase
          FROM relay_thread_vm_pauses WHERE allocation_id=${f.input.allocationId}`;
        expect(pendingPause?.operationId).not.toBe(pauseOperationId);
        expect(pendingPause?.phase).toBe("pending");
        expect((yield* makeThreadVmAllocationStore(f.sql).get(f.input.allocationId))?.state).toBe(
          "running",
        );
      }),
    );

    it.effect(
      "collects disconnected VM tunnels even after revocation without opting legacy links in",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          const allocations = yield* makeManagedEndpointAllocations;
          const key = {
            userId: `thread-vm:${f.input.allocationId}`,
            environmentId: f.environmentId,
          };
          const tunnelName = `vm-${f.input.allocationId}`;
          yield* allocations.reserve({ ...key, hostname: "vm.relay.test", tunnelName });
          yield* allocations.reserve({
            userId: "legacy-user",
            environmentId: "legacy-environment",
            hostname: "legacy.relay.test",
            tunnelName: "legacy-tunnel",
          });
          yield* allocations.reserve({
            userId: "thread-vm:unknown",
            environmentId: "unknown-environment",
            hostname: "unknown.relay.test",
            tunnelName: "unknown-tunnel",
          });
          const read = allocations.listByTunnelNames([
            tunnelName,
            "legacy-tunnel",
            "unknown-tunnel",
          ]);
          expect((yield* read).find((row) => row.tunnelName === tunnelName)?.recoveryEnabled).toBe(
            true,
          );
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = 'now' WHERE allocation_id = ${f.input.allocationId}`;
          const rows = yield* read;
          expect(rows.find((row) => row.tunnelName === tunnelName)?.recoveryEnabled).toBe(true);
          expect(rows.find((row) => row.tunnelName === "legacy-tunnel")?.recoveryEnabled).toBe(
            false,
          );
          expect(rows.find((row) => row.tunnelName === "unknown-tunnel")?.recoveryEnabled).toBe(
            false,
          );
        }),
    );

    it.effect(
      "confines tunnel recovery to its prepared VM and rejects access removed during provisioning",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          const principal = {
            environmentId: EnvironmentId.make(f.environmentId),
            environmentPublicKey: "setup-key",
            credentialId: f.credentialId,
            threadVm: {
              allocationId: f.input.allocationId,
              threadId: ThreadId.make(f.input.threadId),
              repositoryId: f.input.repositoryId,
              generation: 1,
            },
          };
          const expectedOwner = `thread-vm:${f.input.allocationId}`;
          let provisions = 0,
            revoke = false;
          const releases: string[] = [];
          const endpoint = {
            providerKind: "cloudflare_tunnel" as const,
            httpBaseUrl: "https://vm.relay.test/",
            wsBaseUrl: "wss://vm.relay.test/ws",
          };
          const provider = ManagedEndpointProvider.of({
            provision: (input) =>
              Effect.gen(function* () {
                provisions++;
                expect(input).toEqual({
                  userId: expectedOwner,
                  environmentId: f.environmentId,
                  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
                });
                if (revoke)
                  yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id = ${f.input.organizationId} AND user_id = ${f.input.ownerUserId}`.pipe(
                    Effect.orDie,
                  );
                return {
                  endpoint,
                  runtime: {
                    providerKind: "cloudflare_tunnel" as const,
                    tunnelId: "own-tunnel",
                    connectorToken: "vm-only-token",
                  },
                };
              }),
            release: (input) =>
              Effect.sync(() => {
                expect(input.userId).toBe(expectedOwner);
                expect(input.environmentId).toBe(f.environmentId);
                releases.push(input.expectedTunnelId ?? "");
                return input.expectedTunnelId === "own-tunnel";
              }),
            prepareDeprovision: () => Effect.succeed(null),
            deprovision: () => Effect.succeed(false),
            reconcileOrigin: () => Effect.succeed("ready" as const),
          });
          const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(ManagedEndpointProvider, provider),
              Effect.provideService(RelayEnvironmentPrincipal, principal),
            );
          yield* provide(recoverThreadVmEndpoint(f.owner)).pipe(Effect.flip);
          expect(provisions).toBe(0);
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const result = yield* provide(recoverThreadVmEndpoint(f.owner));
          expect(result.runtime.connectorToken).toBe("vm-only-token");
          for (const input of [
            { ...f.owner, threadId: "other" },
            { ...f.owner, environmentId: "other" },
            { ...f.owner, generation: 2 },
          ])
            yield* provide(recoverThreadVmEndpoint(input)).pipe(Effect.flip);
          expect(provisions).toBe(1);
          expect(
            yield* provide(releaseThreadVmEndpoint({ ...f.owner, tunnelId: "stale-tunnel" })),
          ).toEqual({ released: false });
          expect(
            yield* provide(releaseThreadVmEndpoint({ ...f.owner, tunnelId: "own-tunnel" })),
          ).toEqual({ released: true });
          expect(releases).toEqual(["stale-tunnel", "own-tunnel"]);
          revoke = true;
          yield* provide(recoverThreadVmEndpoint(f.owner)).pipe(Effect.flip);
          expect(provisions).toBe(2);
          yield* provide(recoverThreadVmEndpoint(f.owner)).pipe(Effect.flip);
          expect(provisions).toBe(2);
        }),
    );

    it.effect(
      "connects private VMs through their managed endpoint without falling back after revocation",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          const keys = NodeCrypto.generateKeyPairSync("ed25519", {
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
            publicKeyEncoding: { type: "spki", format: "pem" },
          });
          yield* f.sql`UPDATE relay_environment_credentials SET environment_public_key = ${keys.publicKey} WHERE credential_id = ${f.credentialId}`;
          yield* f.sql`UPDATE relay_thread_vm_bindings SET environment_public_key = ${keys.publicKey} WHERE allocation_id = ${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET environment_public_key = ${keys.publicKey} WHERE allocation_id = ${f.input.allocationId}`;
          const settings = yield* RelayConfiguration.RelayConfiguration;
          const allocation = {
            userId: `thread-vm:${f.input.allocationId}`,
            environmentId: f.environmentId,
            hostname: "vm.relay.test",
            tunnelId: "own-tunnel",
            tunnelName: "vm",
            dnsRecordId: "dns",
            readyAt: "now",
            updatedAt: "now",
            generation: 1,
            origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          };
          const services = Layer.mergeAll(
            Layer.succeed(RelayConfiguration.RelayConfiguration, {
              ...settings,
              managedEndpointBaseDomain: "relay.test",
              cloudMintPrivateKey: Redacted.make(keys.privateKey),
            }),
            Layer.mock(ManagedEndpointAllocations, {
              get: (key) => {
                expect(key).toEqual({ userId: allocation.userId, environmentId: f.environmentId });
                return Effect.succeed(allocation);
              },
            }),
            Layer.succeed(UserDirectory, {
              lookup: () =>
                Effect.succeed(
                  new Map([
                    [
                      f.input.ownerUserId,
                      {
                        userId: f.input.ownerUserId,
                        displayName: "VM Owner",
                        email: null,
                        imageUrl: "https://avatar.test/owner.png",
                      },
                    ],
                  ]),
                ),
            }),
          );
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          let requests = 0;
          const transport: typeof fetch = async (url, init) => {
            requests++;
            expect(String(url)).toBe("https://vm.relay.test/api/t3-connect/mint-credential");
            expect(new Headers(init?.headers).has("e2b-traffic-access-token")).toBe(false);
            const body = decodeEndpointRequest(init?.body);
            const request = decodeMintRequest(decodeRelayJwt(body.proof));
            expect(request.sub).toBe(f.input.ownerUserId);
            expect(request.deviceId).toBe("device");
            expect(request.name).toBe("VM Owner");
            expect(request.picture).toBe("https://avatar.test/owner.png");
            const encode = encodeEndpointJson;
            const header = Buffer.from(
              encode({ alg: "EdDSA", typ: RELAY_MINT_RESPONSE_TYP }),
            ).toString("base64url");
            const payload = Buffer.from(
              encode({
                iss: `t3-env:${f.environmentId}`,
                aud: "https://relay.test",
                sub: f.environmentId,
                jti: "response",
                iat: now,
                exp: now + 60,
                environmentId: f.environmentId,
                requestNonce: request.nonce,
                clientProofKeyThumbprint: request.clientProofKeyThumbprint,
                credential: "client-only-credential",
              }),
            ).toString("base64url");
            const unsigned = `${header}.${payload}`;
            return Response.json({
              credential: "client-only-credential",
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe((now + 60) * 1000)),
              proof: `${unsigned}.${NodeCrypto.sign(null, Buffer.from(unsigned), keys.privateKey).toString("base64url")}`,
            });
          };
          const request = (environmentId = f.environmentId) =>
            connectThreadVmIfBound(
              {
                environmentId,
                userId: f.input.ownerUserId,
                clientProofKeyThumbprint: "client-key",
                deviceId: "device",
              },
              transport,
            ).pipe(Effect.provide(services));
          expect(yield* request("not-a-vm")).toBeNull();
          expect(requests).toBe(0);
          expect(yield* request()).toMatchObject({
            environmentId: f.environmentId,
            credential: "client-only-credential",
            endpoint: { httpBaseUrl: "https://vm.relay.test/" },
          });
          let healthRequests = 0,
            tamper = false,
            revokeDuringHealth = false;
          let signalHealth!: () => void;
          let finishHealth!: () => void;
          const pendingHealth = new Promise<void>((resolve) => {
            signalHealth = resolve;
          });
          const releaseHealth = new Promise<void>((resolve) => {
            finishHealth = resolve;
          });
          const healthTransport: typeof fetch = async (url, init) => {
            healthRequests++;
            expect(String(url)).toBe("https://vm.relay.test/api/t3-connect/health");
            expect([...new Headers(init?.headers).keys()]).toEqual(["content-type"]);
            const proof = decodeHealthRequest(
              decodeRelayJwt(decodeEndpointRequest(init?.body).proof),
            );
            expect(proof.sub).toBe(f.input.ownerUserId);
            expect(proof.scope).toEqual(["environment:status"]);
            const descriptor = {
              environmentId: f.environmentId,
              label: "Private VM",
              platform: { os: "linux", arch: "arm64" },
              serverVersion: "test",
              capabilities: { repositoryIdentity: true },
            };
            const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(now * 1000));
            const header = Buffer.from(
              encodeEndpointJson({ alg: "EdDSA", typ: RELAY_HEALTH_RESPONSE_TYP }),
            ).toString("base64url");
            const payload = Buffer.from(
              encodeEndpointJson({
                iss: `t3-env:${f.environmentId}`,
                aud: "https://relay.test",
                sub: f.environmentId,
                jti: "health-response",
                iat: now,
                exp: now + 60,
                environmentId: f.environmentId,
                requestNonce: proof.nonce,
                status: "online",
                checkedAt,
                descriptor,
              }),
            ).toString("base64url");
            const unsigned = `${header}.${payload}`;
            if (revokeDuringHealth) {
              signalHealth();
              await releaseHealth;
            }
            return Response.json({
              environmentId: f.environmentId,
              status: "online",
              checkedAt,
              descriptor: tamper ? { ...descriptor, label: "Forged" } : descriptor,
              proof: `${unsigned}.${NodeCrypto.sign(null, Buffer.from(unsigned), keys.privateKey).toString("base64url")}`,
            });
          };
          const health = (userId: string = f.input.ownerUserId) =>
            getThreadVmStatusIfBound(
              { environmentId: f.environmentId, userId },
              healthTransport,
            ).pipe(Effect.provide(services));
          expect(yield* health()).toMatchObject({
            status: "online",
            descriptor: { label: "Private VM" },
          });
          tamper = true;
          yield* health().pipe(Effect.flip);
          tamper = false;
          yield* health("another-user").pipe(Effect.flip);
          expect(healthRequests).toBe(2);
          yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'paused' WHERE allocation_id = ${f.input.allocationId}`;
          expect(yield* health()).toMatchObject({ status: "offline" });
          yield* request().pipe(Effect.flip);
          expect(healthRequests).toBe(2);
          expect(requests).toBe(1);
          yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'running' WHERE allocation_id = ${f.input.allocationId}`;
          revokeDuringHealth = true;
          const inFlightHealth = yield* health().pipe(Effect.forkChild);
          yield* Effect.promise(() => pendingHealth);
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = 'now' WHERE allocation_id = ${f.input.allocationId}`;
          finishHealth();
          yield* Fiber.join(inFlightHealth).pipe(Effect.flip);
          yield* request().pipe(Effect.flip);
          yield* health().pipe(Effect.flip);
          expect(healthRequests).toBe(3);
          expect(requests).toBe(1);
        }),
    );

    it.effect(
      "authorizes connection minting only for a prepared running VM with a current owner and key",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          const threadId = ThreadId.make(f.input.threadId);
          const request = (user = f.input.ownerUserId) =>
            authorizeThreadVmConnection(user, threadId);
          yield* f.prepare;
          yield* request().pipe(Effect.flip);
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          yield* request().pipe(Effect.flip);
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: "a".repeat(64),
          });
          expect(yield* request()).toEqual({
            state: "running",
            environmentId: f.environmentId,
            projectId: `vm:${f.input.threadId}`,
            environmentPublicKey: "setup-key",
            credentialId: f.credentialId,
            sandboxId: `compute-${f.input.allocationId}`,
            identity: {
              operationId: f.input.allocationId,
              scope: {
                allocationId: f.input.allocationId,
                threadId,
                repositoryId: f.input.repositoryId,
                generation: 1,
              },
            },
          });
          const other = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (${f.input.organizationId},${other},'admin','now','now')`;
          yield* request(other).pipe(Effect.flip);
          yield* f.sql`UPDATE relay_organization_members SET role = 'member' WHERE organization_id = ${f.input.organizationId} AND user_id = ${f.input.ownerUserId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`INSERT INTO relay_repository_access (repository_id,organization_id,user_id,role,created_at,updated_at) VALUES (${f.input.repositoryId},${f.input.organizationId},${f.input.ownerUserId},'member','now','now')`;
          yield* request();
          yield* f.sql`DELETE FROM relay_repository_access WHERE repository_id = ${f.input.repositoryId} AND user_id = ${f.input.ownerUserId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_organization_members SET role = 'admin' WHERE organization_id = ${f.input.organizationId} AND user_id = ${f.input.ownerUserId}`;
          for (const state of ["paused", "deleting"]) {
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state = ${state} WHERE allocation_id = ${f.input.allocationId}`;
            yield* request().pipe(Effect.flip);
          }
          yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'running' WHERE allocation_id = ${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at = NULL WHERE allocation_id = ${f.input.allocationId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at = 'now' WHERE allocation_id = ${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = 'now' WHERE allocation_id = ${f.input.allocationId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = NULL WHERE allocation_id = ${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${f.credentialId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = NULL WHERE credential_id = ${f.credentialId}`;
          yield* f.sql`UPDATE relay_thread_placements SET operation_id = 'pending-move' WHERE thread_id = ${threadId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_thread_placements SET operation_id = NULL WHERE thread_id = ${threadId}`;
          yield* request();
          yield* f.sql`UPDATE relay_thread_placements SET environment_id = 'moved', generation = 2 WHERE thread_id = ${threadId}`;
          yield* request().pipe(Effect.flip);
        }),
    );

    it.effect(
      "confines client access to a running VM's current private owner and repository grant",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          const principal = {
            environmentId: EnvironmentId.make(f.environmentId),
            environmentPublicKey: "setup-key",
            credentialId: f.credentialId,
            threadVm: {
              allocationId: f.input.allocationId,
              threadId: ThreadId.make(f.input.threadId),
              repositoryId: f.input.repositoryId,
              generation: 1,
            },
          };
          const input = { ...f.owner, userId: f.input.ownerUserId };
          const request = (changes = {}, identity = principal) =>
            checkThreadVmClientAccess({ ...input, ...changes }).pipe(
              Effect.provideService(RelayEnvironmentPrincipal, identity),
            );
          expect(yield* request()).toEqual({
            ...input,
            projectId: `vm:${input.threadId}`,
            repositoryId: f.input.repositoryId,
          });
          const otherAdmin = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (${f.input.organizationId},${otherAdmin},'admin','now','now')`;
          for (const change of [
            { userId: otherAdmin },
            { userId: "anonymous" },
            { threadId: "another-thread" },
            { environmentId: "other-env" },
            { generation: 2 },
          ])
            expect(yield* request(change).pipe(Effect.flip)).toMatchObject({
              _tag: expect.stringMatching(/^RelayTenancy/),
            });
          const { threadVm: _scope, ...legacy } = principal;
          yield* checkThreadVmClientAccess(input).pipe(
            Effect.provideService(RelayEnvironmentPrincipal, legacy),
            Effect.flip,
          );
          // Demotion retains ownership but now requires an explicit repository grant.
          yield* f.sql`UPDATE relay_organization_members SET role = 'member' WHERE organization_id = ${f.input.organizationId} AND user_id = ${input.userId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`INSERT INTO relay_repository_access (repository_id,organization_id,user_id,role,created_at,updated_at) VALUES (${f.input.repositoryId},${f.input.organizationId},${input.userId},'member','now','now')`;
          yield* request();
          yield* f.sql`DELETE FROM relay_repository_access WHERE repository_id = ${f.input.repositoryId} AND user_id = ${input.userId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_organization_members SET role = 'admin' WHERE organization_id = ${f.input.organizationId} AND user_id = ${input.userId}`;
          for (const state of ["paused", "deleting"]) {
            yield* f.sql`UPDATE relay_thread_vm_allocations SET state = ${state} WHERE allocation_id = ${f.input.allocationId}`;
            yield* request().pipe(Effect.flip);
          }
          yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'running' WHERE allocation_id = ${f.input.allocationId}`;
          yield* request();
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${f.credentialId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = NULL WHERE credential_id = ${f.credentialId}`;
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = 'now' WHERE allocation_id = ${f.input.allocationId}`;
          yield* request().pipe(Effect.flip);
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = NULL WHERE allocation_id = ${f.input.allocationId}`;
          yield* f.sql`UPDATE relay_thread_placements SET environment_id = 'new-owner', generation = 2 WHERE thread_id = ${input.threadId}`;
          yield* request().pipe(Effect.flip);
        }),
    );

    it.effect(
      "starts only prepared current VMs, deduplicates claims and preserves holds after lost replies",
      () =>
        Effect.gen(function* () {
          for (const mode of [
            "ready",
            "lost",
            "revoked-before",
            "revoked-after",
            "moved",
            "paused",
            "bad-binding",
            "expired",
          ] as const) {
            const f = yield* initialSetupFixture;
            yield* f.prepare;
            yield* f.sql`INSERT INTO relay_repository_aliases (canonical_key,repository_id,organization_id,created_at) VALUES (${f.input.canonicalKey},${f.input.repositoryId},${f.input.organizationId},'now')`;
            const entered = yield* Deferred.make<void>();
            const continueStart = yield* Deferred.make<void>();
            let calls = 0;
            const worker = makeThreadVmServerWorker(
              f.sql,
              (sandbox, identity, digest) =>
                Effect.gen(function* () {
                  calls++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(continueStart);
                  expect(sandbox).toBe(`compute-${f.input.allocationId}`);
                  expect(identity.scope.threadId).toBe(f.input.threadId);
                  expect(digest).toBe("a".repeat(64));
                  if (mode === "revoked-after")
                    yield* f.sql`DELETE FROM relay_organization_members WHERE user_id = ${f.input.ownerUserId}`;
                  if (mode === "expired")
                    yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.input.allocationId}`;
                  if (mode === "lost")
                    return yield* new ThreadVmComputeError({
                      operation: "startup",
                      message: "Lost reply",
                    });
                }).pipe(Effect.catchTag("SqlError", Effect.die)),
              f.input.hostId,
            );
            expect(yield* worker.runOne()).toBe(false);
            yield* f.setup.begin({
              allocationId: f.input.allocationId,
              environmentId: f.environmentId,
            });
            expect(yield* worker.runOne()).toBe(false);
            yield* f.setup.finish({
              allocationId: f.input.allocationId,
              environmentId: f.environmentId,
              receiptSha256: "a".repeat(64),
            });
            if (mode === "revoked-before")
              yield* f.sql`DELETE FROM relay_organization_members WHERE user_id = ${f.input.ownerUserId}`;
            if (mode === "moved")
              yield* f.sql`UPDATE relay_thread_placements SET operation_id = 'move' WHERE thread_id = ${f.input.threadId}`;
            if (mode === "paused")
              yield* f.sql`UPDATE relay_thread_vm_allocations SET state = 'paused' WHERE allocation_id = ${f.input.allocationId}`;
            if (mode === "bad-binding")
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${f.credentialId}`;
            const excluded = mode === "moved" || mode === "paused";
            const noLaunch = excluded || mode === "revoked-before" || mode === "bad-binding";
            if (noLaunch) {
              expect(yield* worker.runOne()).toBe(!excluded);
            } else {
              const running = yield* worker.runOne().pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              expect(yield* worker.runOne()).toBe(false);
              yield* Deferred.succeed(continueStart, undefined);
              expect(yield* Fiber.join(running)).toBe(true);
            }
            expect(calls).toBe(noLaunch ? 0 : 1);
            expect((yield* f.setup.get(f.input.allocationId))?.phase).toBe("ready");
            expect(
              (yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId,
            ).toBe(mode === "moved" ? "move" : null);
            if (mode !== "expired") expect(yield* worker.runOne()).toBe(false);
            if (mode === "lost")
              expect((yield* f.setup.get(f.input.allocationId))?.errorCode).toBe(
                "startup_unconfirmed",
              );
          }
        }),
    );

    it.effect(
      "confirms initial activation only after verified setup and mirrored initial history",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.prepare;
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
          });
          const receipt: RelayThreadVmSetupReceipt = {
            version: 1,
            operationId: f.input.allocationId,
            environmentId: EnvironmentId.make(f.environmentId),
            projectId: ProjectId.make(`vm:${f.input.threadId}`),
            scope: {
              allocationId: f.input.allocationId,
              threadId: ThreadId.make(f.input.threadId),
              repositoryId: f.input.repositoryId,
              generation: 1,
            },
            workspaceRoot: "/workspace/project",
            revision: f.input.revision,
            sequence: 2,
            execution: "frozen",
          };
          const principal = {
            environmentId: receipt.environmentId,
            environmentPublicKey: "setup-key",
            credentialId: f.credentialId,
            threadVm: receipt.scope,
          };
          const asVm = Effect.provideService(RelayEnvironmentPrincipal, principal);
          const request = { environmentId: f.environmentId, threadId: f.input.threadId, receipt };
          expect(yield* confirmInitialVmActivation(request).pipe(asVm)).toEqual({ ready: false });
          const encoded = yield* encodeInitialReceipt(receipt);
          yield* f.setup.finish({
            allocationId: f.input.allocationId,
            environmentId: f.environmentId,
            receiptSha256: NodeCrypto.createHash("sha256").update(encoded).digest("hex"),
          });
          expect(yield* confirmInitialVmActivation(request).pipe(asVm)).toEqual({ ready: false });
          yield* f.sql`INSERT INTO relay_thread_history (thread_id,cursor,environment_id,source_sequence,event_json)
        VALUES (${f.input.threadId},1,${f.environmentId},2,'{"type":"thread.created"}'::jsonb)`;
          expect(yield* confirmInitialVmActivation(request).pipe(asVm)).toEqual({ ready: true });
          expect(
            yield* confirmInitialVmActivation({
              ...request,
              receipt: { ...receipt, operationId: "other" },
            }).pipe(asVm),
          ).toEqual({ ready: false });
          yield* f.sql`UPDATE relay_thread_placements SET operation_id = 'new-move' WHERE thread_id = ${f.input.threadId}`;
          expect(yield* confirmInitialVmActivation(request).pipe(asVm)).toEqual({ ready: false });
          yield* f.sql`UPDATE relay_thread_placements SET operation_id = NULL WHERE thread_id = ${f.input.threadId}`;
          yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id = ${f.input.organizationId} AND user_id = ${f.input.ownerUserId}`;
          expect(yield* confirmInitialVmActivation(request).pipe(asVm, Effect.flip)).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
        }),
    );

    it.effect(
      "runs guest setup once per claim, rechecks access, and never releases an uncertain or mismatched result",
      () =>
        Effect.gen(function* () {
          for (const mode of [
            "ready",
            "failure",
            "uncertain",
            "wrong-receipt",
            "revoked",
            "expired",
          ] as const) {
            const f = yield* initialSetupFixture;
            yield* f.prepare;
            yield* f.sql`INSERT INTO relay_repository_aliases (canonical_key,repository_id,organization_id,created_at)
        VALUES (${f.input.canonicalKey},${f.input.repositoryId},${f.input.organizationId},'now')`;
            let calls = 0;
            const worker = makeThreadVmSetupWorker(
              f.sql,
              (_sandbox, environmentId, input) =>
                Effect.gen(function* () {
                  calls++;
                  expect(input.title).toBe(f.input.initialState.title);
                  expect(
                    (yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId,
                  ).toBe(f.input.allocationId);
                  if (mode === "revoked")
                    yield* f.sql`DELETE FROM relay_organization_members WHERE organization_id = ${f.input.organizationId} AND user_id = ${f.input.ownerUserId}`;
                  if (mode === "expired")
                    yield* f.sql`UPDATE relay_thread_vm_provisions SET claim_until = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.input.allocationId}`;
                  const reply: RelayThreadVmSetupReply =
                    mode === "failure"
                      ? { status: "blocked", code: "provider_credentials_missing" }
                      : mode === "uncertain"
                        ? { status: "blocked", code: "setup_unconfirmed" }
                        : {
                            status: "prepared",
                            receipt: {
                              version: 1,
                              operationId: f.input.allocationId,
                              environmentId: EnvironmentId.make(environmentId),
                              projectId: ProjectId.make(`vm:${f.input.threadId}`),
                              scope: input.workspace.scope,
                              workspaceRoot: "/workspace/project",
                              revision:
                                mode === "wrong-receipt" ? "b".repeat(40) : f.input.revision,
                              sequence: 2,
                              execution: "frozen",
                            },
                          };
                  return reply;
                }).pipe(Effect.orDie),
              f.input.hostId,
            );
            const results = yield* Effect.all([worker.runOne(), worker.runOne()], {
              concurrency: "unbounded",
            });
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(calls).toBe(1);
            const setup = yield* f.setup.get(f.input.allocationId);
            expect(setup?.phase).toBe(
              mode === "ready" ? "ready" : mode === "failure" ? "failed" : "running",
            );
            expect(
              (yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId,
            ).toBe(mode === "ready" ? null : f.input.allocationId);
            if (mode === "ready") expect(setup?.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
            if (mode === "failure") expect(setup?.errorCode).toBe("provider_credentials_missing");
            if (mode !== "expired") expect(yield* worker.runOne()).toBe(false);
          }
        }),
    );

    it.effect(
      "refuses direct VM creation without reserving quota and keeps retained setup status private",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.sql`INSERT INTO relay_repository_aliases (canonical_key,repository_id,organization_id,created_at)
          VALUES (${f.input.canonicalKey},${f.input.repositoryId},${f.input.organizationId},'now')`;
          const input = {
            ...f.input,
            threadId: ThreadId.make(f.input.threadId),
            organizationId: RelayOrganizationId.make(f.input.organizationId),
            repositoryId: RelayRepositoryId.make(f.input.repositoryId),
          };
          expect(yield* Effect.flip(createThreadVm(input))).toMatchObject({
            _tag: "RelayTenancyConflictError",
            reason: "thread_vm_move_required",
          });
          expect(yield* f.setup.get(input.allocationId)).toBeNull();
          expect(
            yield* f.sql`SELECT 1 FROM relay_thread_vm_allocations WHERE allocation_id=${input.allocationId}`,
          ).toHaveLength(0);
          expect(
            yield* f.sql`SELECT 1 FROM relay_thread_vm_replacements WHERE request_id=${input.allocationId}`,
          ).toHaveLength(0);

          // Existing setup records remain inspectable and cancellable; refusing new
          // requests must not expose another person's retained VM state.
          yield* f.setup.enqueue(f.input);
          const asOwner = Effect.provideService(RelayClientPrincipal, {
            userId: f.input.ownerUserId,
            token: "test",
          });
          expect(yield* getThreadVmSetup(input.threadId).pipe(asOwner)).toMatchObject({
            phase: "pending",
            canonicalKey: f.input.canonicalKey,
          });
          const adminId = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at) VALUES (${input.organizationId},${adminId},'admin','now','now')`;
          expect(
            yield* Effect.flip(
              getThreadVmSetup(input.threadId).pipe(
                Effect.provideService(RelayClientPrincipal, { userId: adminId, token: "test" }),
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          yield* f.sql`DELETE FROM relay_organization_members WHERE user_id=${f.input.ownerUserId}`;
          expect(yield* Effect.flip(getThreadVmSetup(input.threadId).pipe(asOwner))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
        }),
    );

    it.effect(
      "reserves new VM setup atomically, deduplicates retries, and never adopts an existing thread",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          const replies = yield* parallel(
            Array.from({ length: 6 }, () => f.setup.enqueue(f.input)),
          );
          expect(replies.map((entry) => entry.phase)).toEqual(Array(6).fill("pending"));
          expect(
            yield* f.sql`SELECT allocation_id FROM relay_thread_vm_allocations WHERE thread_id = ${f.input.threadId}`,
          ).toHaveLength(1);
          for (const changes of [
            { initialState: { ...f.input.initialState, title: "Changed" } },
            { revision: "b".repeat(40) },
            { branch: "other" },
            { repositoryId: "other" },
            { hostId: "other" },
            { templateId: "other" },
            { allocationId: NodeCrypto.randomUUID() },
          ])
            expect(yield* Effect.flip(f.setup.enqueue({ ...f.input, ...changes }))).toMatchObject({
              _tag: "ThreadVmSetupConflict",
            });
          yield* f.sql`UPDATE relay_thread_vm_policies SET max_vms_per_user = 1 WHERE organization_id = ${f.input.organizationId}`;
          const next = {
            ...f.input,
            allocationId: NodeCrypto.randomUUID(),
            threadId: NodeCrypto.randomUUID(),
          };
          expect(yield* Effect.flip(f.setup.enqueue(next))).toMatchObject({
            _tag: "ThreadVmQuotaExceeded",
          });
          expect(
            yield* f.sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id = ${next.threadId}`,
          ).toHaveLength(0);
          expect((yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId).toBe(
            f.input.allocationId,
          );
        }),
    );

    it.effect(
      "keeps prompts and work blocked through enrollment and setup, releasing only a matching ready receipt",
      () =>
        Effect.gen(function* () {
          const f = yield* initialSetupFixture;
          yield* f.setup.enqueue(f.input);
          expect(
            yield* Effect.flip(
              f.setup.begin({ allocationId: f.input.allocationId, environmentId: f.environmentId }),
            ),
          ).toMatchObject({ _tag: "ThreadVmSetupConflict" });
          yield* f.prepare;
          const owner = f.owner;
          const placement = makeThreadPlacementStore(f.sql);
          const journal = makeThreadJournalStore(f.sql);
          yield* journal.stage({
            threadId: owner.threadId,
            actor: { userId: f.input.ownerUserId, displayName: "Owner", imageUrl: null },
            command: {
              type: "thread.archive",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId: ThreadId.make(owner.threadId),
            },
          });
          yield* f.setup.begin({
            allocationId: f.input.allocationId,
            environmentId: owner.environmentId,
          });
          expect(yield* journal.next(owner)).toBeNull();
          expect(yield* Effect.flip(placement.admit({ ...owner, workId: "turn" }))).toMatchObject({
            _tag: "ThreadPlacementConflict",
          });
          expect(
            yield* Effect.flip(
              f.setup.finish({
                allocationId: f.input.allocationId,
                environmentId: "other",
                receiptSha256: "b".repeat(64),
              }),
            ),
          ).toMatchObject({ _tag: "ThreadVmSetupConflict" });
          const receipt = {
            allocationId: f.input.allocationId,
            environmentId: owner.environmentId,
            receiptSha256: "b".repeat(64),
          };
          expect((yield* f.setup.finish(receipt)).phase).toBe("ready");
          expect((yield* f.setup.finish(receipt)).phase).toBe("ready");
          expect(
            yield* Effect.flip(f.setup.finish({ ...receipt, receiptSha256: "c".repeat(64) })),
          ).toMatchObject({ _tag: "ThreadVmSetupConflict" });
          expect(yield* journal.next(owner)).not.toBeNull();
          expect((yield* placement.admit({ ...owner, workId: "turn" })).newlyAdmitted).toBe(true);
        }),
    );

    it.effect(
      "persists failed setup without releasing the hold and rejects late readiness after revocation or deletion",
      () =>
        Effect.gen(function* () {
          for (const failure of ["setup", "credential", "deletion"] as const) {
            const f = yield* initialSetupFixture;
            yield* f.prepare;
            const input = { allocationId: f.input.allocationId, environmentId: f.environmentId };
            yield* f.setup.begin(input);
            if (failure === "setup") {
              yield* f.setup.fail({ ...input, errorCode: "provider_credentials_missing" });
              expect(
                (yield* makeThreadVmSetupStore(f.sql).get(input.allocationId))?.errorCode,
              ).toBe("provider_credentials_missing");
              expect(yield* Effect.flip(f.setup.begin(input))).toMatchObject({
                _tag: "ThreadVmSetupConflict",
              });
            } else if (failure === "credential") {
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${f.credentialId}`;
            } else {
              yield* makeThreadVmAllocationStore(f.sql).requestDeletion(input.allocationId);
            }
            expect(
              yield* Effect.flip(f.setup.finish({ ...input, receiptSha256: "d".repeat(64) })),
            ).toMatchObject({ _tag: "ThreadVmSetupConflict" });
            expect(
              (yield* makeThreadPlacementStore(f.sql).get(f.input.threadId))?.operationId,
            ).toBe(f.input.allocationId);
          }
        }),
    );

    it.effect(
      "mints only the assigned repository and rechecks VM and owner authority after GitHub responds",
      () =>
        Effect.gen(function* () {
          const organizationId = NodeCrypto.randomUUID();
          const repositoryId = NodeCrypto.randomUUID();
          const f = yield* makeEnrollmentFixture({ organizationId, repositoryId });
          yield* f.store.exchange(f.input, f.issue);
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          const canonicalKey = `github.com/test-owner/repo-${repositoryId}`;
          yield* f.sql`INSERT INTO relay_repository_aliases (canonical_key,repository_id,organization_id,created_at)
          VALUES (${canonicalKey},${repositoryId},${organizationId},'now')`;
          yield* f.sql`INSERT INTO relay_github_installations (organization_id,installation_id,account_login,account_type,connected_by_user_id,created_at,updated_at)
          VALUES (${organizationId},'420001','test-owner','Organization',${allocation.ownerUserId},'now','now')`;
          const input = {
            environmentId: f.input.environmentId,
            threadId: allocation.threadId,
            generation: 2,
            canonicalKey,
          };
          const principal = {
            environmentId: EnvironmentId.make(f.input.environmentId),
            environmentPublicKey: f.input.environmentPublicKey,
            credentialId: f.credentialId,
            threadVm: {
              allocationId: f.allocationId,
              threadId: ThreadId.make(allocation.threadId),
              repositoryId,
              generation: 2,
            },
          };
          let minted = 0;
          let afterMint = Effect.void;
          const github = GithubApp.of({
            installUrl: Effect.succeed(null),
            getInstallation: () => Effect.die("unexpected installation read"),
            listRepositories: () => Effect.die("unexpected repository list"),
            listInstallations: Effect.die("unexpected installation list"),
            describe: () => Effect.die("unexpected app read"),
            mintInstallationToken: () => Effect.die("installation-wide tokens forbidden"),
            mintRepositoryToken: (scope) =>
              Effect.gen(function* () {
                expect(scope).toEqual({ installationId: "420001", canonicalKey });
                minted++;
                yield* afterMint;
                return { token: "repository-test-token", expiresAt: "2099-01-01T00:00:00Z" };
              }),
          });
          const request = (changes = {}) =>
            mintThreadVmRepositoryToken({ ...input, ...changes }).pipe(
              Effect.provideService(RelayEnvironmentPrincipal, principal),
              Effect.provideService(GithubApp, github),
            );
          const denied = { _tag: "RelayTenancyNotFoundError" };
          // Enrollment alone does not authorize workspace access before placement commits.
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          yield* f.sql`UPDATE relay_thread_placements SET environment_id = ${input.environmentId}, generation = 2 WHERE thread_id = ${input.threadId}`;
          expect(yield* request()).toEqual({
            token: "repository-test-token",
            expiresAt: "2099-01-01T00:00:00Z",
            canonicalKey,
          });
          for (const change of [
            { canonicalKey: "github.com/test-owner/another" },
            { threadId: "other-thread" },
            { generation: 1 },
          ]) {
            expect(yield* Effect.flip(request(change))).toMatchObject({
              _tag: expect.stringMatching(/^RelayTenancy/),
            });
          }
          expect(minted).toBe(1);
          afterMint =
            f.sql`DELETE FROM relay_organization_members WHERE organization_id = ${organizationId} AND user_id = ${allocation.ownerUserId}`.pipe(
              Effect.asVoid,
              Effect.orDie,
            );
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          expect(minted).toBe(2);
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          expect(minted).toBe(2);
          yield* f.sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at)
          VALUES (${organizationId},${allocation.ownerUserId},'admin','now','now')`;
          afterMint = f.bindings.revoke(f.allocationId).pipe(Effect.orDie);
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          expect(minted).toBe(3);
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          expect(minted).toBe(3);
          yield* f.sql`UPDATE relay_thread_vm_bindings SET revoked_at = NULL WHERE allocation_id = ${f.allocationId}`;
          afterMint =
            f.sql`UPDATE relay_github_installations SET installation_id = '420002' WHERE organization_id = ${organizationId}`.pipe(
              Effect.asVoid,
              Effect.orDie,
            );
          expect(yield* Effect.flip(request())).toMatchObject(denied);
          expect(minted).toBe(4);
        }),
    );

    it.effect(
      "enrolls exactly once and recovers the same encrypted response after a lost reply",
      () =>
        Effect.gen(function* () {
          const f = yield* enrollmentFixture;
          expect(Redacted.value(yield* f.store.prepare(f.intent))).toBe(Redacted.value(f.seed));
          const replies = yield* parallel(
            Array.from({ length: 6 }, () => f.store.exchange(f.input, f.issue)),
          );
          expect(replies.map(Redacted.value)).toEqual(Array(6).fill(Redacted.value(f.response)));
          expect(f.issued()).toBe(1);
          const [row] =
            yield* f.sql`SELECT sealed_seed, sealed_response, seed_hash FROM relay_thread_vm_enrollments WHERE allocation_id = ${f.allocationId}`;
          expect(row?.sealed_seed).not.toContain(Redacted.value(f.seed));
          expect(row?.sealed_response).not.toContain(Redacted.value(f.response));
          expect(row?.seed_hash).not.toBe(Redacted.value(f.seed));
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET expires_at = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
          expect(Redacted.value(yield* f.store.exchange(f.input, f.issue))).toBe(
            Redacted.value(f.response),
          );
          expect(f.issued()).toBe(1);
          expect(Redacted.value(yield* makeThreadVmEnrollmentStore(f.sql).prepare(f.intent))).toBe(
            Redacted.value(f.seed),
          );
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          const receipt = {
            enrolled: true as const,
            environmentId: EnvironmentId.make(f.input.environmentId),
            allocationId: f.allocationId,
            operationId: f.operationId,
            threadId: ThreadId.make(allocation.threadId),
            generation: 2,
          };
          expect(
            yield* Effect.flip(
              f.store.confirmInstalled({ ...receipt, environmentId: EnvironmentId.make("other") }),
            ),
          ).toMatchObject({ _tag: "ThreadVmEnrollmentInvalid" });
          yield* f.store.confirmInstalled(receipt);
          yield* f.store.confirmInstalled(receipt);
          expect(yield* Effect.flip(f.store.prepare(f.intent))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          const [installed] =
            yield* f.sql`SELECT sealed_seed, installed_at FROM relay_thread_vm_enrollments WHERE allocation_id = ${f.allocationId}`;
          expect(installed?.sealed_seed).toBeNull();
          expect(installed?.installed_at).not.toBeNull();
        }),
    );

    it.effect("renews an unused expired enrollment seed once and invalidates the old seed", () =>
      Effect.gen(function* () {
        const f = yield* enrollmentFixture;
        yield* f.sql`UPDATE relay_thread_vm_enrollments SET expires_at = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
        const seeds = yield* parallel(Array.from({ length: 6 }, () => f.store.prepare(f.intent)));
        const renewed = seeds[0]!;
        expect(Redacted.value(renewed)).not.toBe(Redacted.value(f.seed));
        expect(seeds.map(Redacted.value)).toEqual(Array(6).fill(Redacted.value(renewed)));
        const [beforeRetry] =
          yield* f.sql`SELECT expires_at FROM relay_thread_vm_enrollments WHERE allocation_id = ${f.allocationId}`;
        expect(Redacted.value(yield* f.store.prepare(f.intent))).toBe(Redacted.value(renewed));
        const [afterRetry] =
          yield* f.sql`SELECT expires_at FROM relay_thread_vm_enrollments WHERE allocation_id = ${f.allocationId}`;
        expect(afterRetry?.expires_at).toEqual(beforeRetry?.expires_at);
        expect(yield* Effect.flip(f.store.exchange(f.input, f.issue))).toMatchObject({
          _tag: "ThreadVmEnrollmentInvalid",
        });
        expect(f.issued()).toBe(0);
        expect(
          Redacted.value(yield* f.store.exchange({ ...f.input, seed: renewed }, f.issue)),
        ).toBe(Redacted.value(f.response));
        expect(f.issued()).toBe(1);
      }),
    );

    it.effect(
      "rejects wrong enrollment identities, expired seeds and deleting allocations before issuing credentials",
      () =>
        Effect.gen(function* () {
          const f = yield* enrollmentFixture;
          for (const change of [
            { seed: Redacted.make("wrong") },
            { operationId: "wrong" },
            { allocationId: "wrong" },
          ]) {
            expect(
              yield* Effect.flip(f.store.exchange({ ...f.input, ...change }, f.issue)),
            ).toMatchObject({ _tag: "ThreadVmEnrollmentInvalid" });
          }
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET expires_at = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
          expect(yield* Effect.flip(f.store.exchange(f.input, f.issue))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          expect(
            yield* Effect.flip(f.store.prepare({ ...f.intent, operationId: "wrong" })),
          ).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          yield* f.allocations.requestDeletion(f.allocationId);
          expect(yield* Effect.flip(f.store.prepare(f.intent))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          expect(yield* Effect.flip(f.store.exchange(f.input, f.issue))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          expect(f.issued()).toBe(0);
        }),
    );

    it.effect(
      "does not replay enrollment to a different key or after credential rotation or revocation",
      () =>
        Effect.gen(function* () {
          const f = yield* enrollmentFixture;
          yield* f.store.exchange(f.input, f.issue);
          for (const change of [
            { environmentId: "other" },
            { environmentPublicKey: "other-key" },
          ]) {
            expect(
              yield* Effect.flip(f.store.exchange({ ...f.input, ...change }, f.issue)),
            ).toMatchObject({ _tag: "ThreadVmEnrollmentInvalid" });
          }
          const replacement = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES (${replacement},${f.input.environmentId},${f.input.environmentPublicKey},${replacement},'now','now')`;
          yield* f.bindings.bind({ ...f.input, credentialId: replacement });
          expect(yield* Effect.flip(f.store.exchange(f.input, f.issue))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          yield* f.bindings.bind({ ...f.input, credentialId: f.credentialId });
          yield* f.sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${f.credentialId}`;
          expect(yield* Effect.flip(f.store.exchange(f.input, f.issue))).toMatchObject({
            _tag: "ThreadVmEnrollmentInvalid",
          });
          expect(f.issued()).toBe(1);
        }),
    );

    it.effect(
      "rolls back the claim, credential and binding when enrollment fails before its receipt",
      () =>
        Effect.gen(function* () {
          const f = yield* enrollmentFixture;
          const failure = f.issue.pipe(Effect.andThen(Effect.fail("injected-response-failure")));
          expect(yield* Effect.flip(f.store.exchange(f.input, failure))).toBe(
            "injected-response-failure",
          );
          expect(
            yield* f.sql`SELECT credential_id FROM relay_environment_credentials WHERE credential_id = ${f.credentialId}`,
          ).toHaveLength(0);
          expect(
            yield* f.sql`SELECT environment_id FROM relay_thread_vm_bindings WHERE allocation_id = ${f.allocationId}`,
          ).toHaveLength(0);
          expect(Redacted.value(yield* f.store.prepare(f.intent))).toBe(Redacted.value(f.seed));
          expect(Redacted.value(yield* f.store.exchange(f.input, f.issue))).toBe(
            Redacted.value(f.response),
          );
        }),
    );

    it.effect(
      "verifies signed enrollment and current owner access for first issue and response recovery",
      () =>
        Effect.gen(function* () {
          const repositoryId = NodeCrypto.randomUUID();
          const f = yield* makeEnrollmentFixture({
            organizationId: NodeCrypto.randomUUID(),
            repositoryId,
          });
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          yield* f.sql`INSERT INTO relay_organizations (organization_id,name,created_at,updated_at)
          VALUES (${allocation.organizationId},'Enrollment test','now','now') ON CONFLICT DO NOTHING`;
          yield* f.sql`INSERT INTO relay_organization_members (organization_id,user_id,role,created_at,updated_at)
          VALUES (${allocation.organizationId},${allocation.ownerUserId},'member','now','now') ON CONFLICT (organization_id,user_id) DO UPDATE SET role = 'member'`;
          yield* f.sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
          VALUES (${repositoryId},${allocation.organizationId},'Enrollment repository','now','now') ON CONFLICT DO NOTHING`;
          const grant = f.sql`INSERT INTO relay_repository_access (repository_id,user_id,organization_id,role,created_at,updated_at)
          VALUES (${repositoryId},${allocation.ownerUserId},${allocation.organizationId},'developer','now','now')`;
          yield* grant;
          const key = NodeCrypto.generateKeyPairSync("ed25519", {
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          });
          const other = NodeCrypto.generateKeyPairSync("ed25519", {
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          });
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          const payload = {
            iss: `t3-env:${f.input.environmentId}`,
            sub: f.input.environmentId,
            aud: "https://relay.test",
            iat: now,
            exp: now + 120,
            jti: NodeCrypto.randomUUID(),
            allocationId: f.allocationId,
            operationId: f.operationId,
            seed: Redacted.value(f.seed),
            environmentId: f.input.environmentId,
            environmentPublicKey: key.publicKey,
          };
          const sign = (
            changes = {},
            privateKey = key.privateKey,
            typ = RELAY_THREAD_VM_ENROLL_PROOF_TYP,
          ) => signRelayJwt({ privateKey, typ, payload: { ...payload, ...changes } });
          const db = yield* RelayDb;
          const credentialLayer = EnvironmentCredentials.layer.pipe(
            Layer.provide(Layer.succeed(RelayDb, db)),
            Layer.provide(NodeEffectCrypto.layer),
          );
          const enroll = (proof: string) =>
            enrollThreadVm(proof).pipe(Effect.provide(credentialLayer));
          const denied = { _tag: "RelayAuthInvalidError", reason: "not_authorized" };
          for (const proof of [
            "bad-jwt",
            yield* sign({}, other.privateKey),
            yield* sign({}, key.privateKey, "t3-machine-enroll+jwt"),
            yield* sign({ aud: "https://other.test" }),
            yield* sign({ sub: "other" }),
            yield* sign({ exp: now - 1 }),
            yield* sign({ iat: now + 1 }),
            yield* sign({ exp: now + 301 }),
            yield* sign({ seed: "wrong" }),
          ]) {
            expect(yield* Effect.flip(enroll(proof))).toMatchObject(denied);
          }
          expect(
            yield* f.sql`SELECT credential_id FROM relay_environment_credentials WHERE environment_id = ${f.input.environmentId}`,
          ).toHaveLength(0);
          yield* f.sql`DELETE FROM relay_repository_access WHERE user_id = ${allocation.ownerUserId}`;
          expect(yield* Effect.flip(enroll(yield* sign()))).toMatchObject(denied);
          yield* grant;
          const first = yield* enroll(yield* sign());
          expect(first.scope).toEqual({
            allocationId: f.allocationId,
            threadId: allocation.threadId,
            repositoryId,
            generation: 2,
          });
          expect(first.environmentId).toBe(f.input.environmentId);
          expect(yield* enroll(yield* sign({ jti: NodeCrypto.randomUUID() }))).toEqual(first);
          const credentials = yield* EnvironmentCredentials.EnvironmentCredentials.pipe(
            Effect.provide(credentialLayer),
          );
          expect(
            Option.getOrThrow(yield* credentials.authenticate(first.environmentCredential))
              .threadVm,
          ).toEqual(first.scope);
          yield* f.sql`DELETE FROM relay_repository_access WHERE user_id = ${allocation.ownerUserId}`;
          expect(yield* Effect.flip(enroll(yield* sign()))).toMatchObject(denied);
          expect(
            yield* f.sql`SELECT credential_id FROM relay_environment_credentials WHERE environment_id = ${f.input.environmentId}`,
          ).toHaveLength(1);
        }),
    );

    it.effect(
      "recovers enrollment delivery after a lost reply and keeps revoked owners unprovisioned",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          // Earlier fixtures exercise storage without scheduling enrollment; isolate the worker queue.
          yield* sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() + interval '1 day' WHERE phase = 'created'`;
          const repositoryId = NodeCrypto.randomUUID(),
            organizationId = NodeCrypto.randomUUID();
          const f = yield* makeEnrollmentFixture({ organizationId, repositoryId });
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          const organizations = yield* Organizations.Organizations;
          yield* organizations.ensureForUser({ organizationId, userId: allocation.ownerUserId });
          yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
          VALUES (${repositoryId},${organizationId},'Worker test','now','now') ON CONFLICT DO NOTHING`;
          const enrollmentContext = yield* Effect.context<
            Crypto.Crypto | SecretBox.RelaySecretBox
          >();
          let calls = 0;
          const deliver = (
            _sandboxId: string,
            input: import("@t3tools/contracts/relay").RelayThreadVmBootstrap,
          ) =>
            Effect.gen(function* () {
              calls++;
              expect(Redacted.value(input.seed)).toBe(Redacted.value(f.seed));
              expect(input.scope).toMatchObject({
                repositoryId,
                threadId: allocation.threadId,
                generation: 2,
              });
              yield* f.store
                .exchange(f.input, f.issue)
                .pipe(Effect.provideContext(enrollmentContext), Effect.orDie);
              if (calls === 1)
                return yield* new ThreadVmComputeError({
                  operation: "enroll",
                  message: "lost reply",
                });
              return {
                enrolled: true as const,
                environmentId: EnvironmentId.make(f.input.environmentId),
                allocationId: f.allocationId,
                operationId: f.operationId,
                threadId: ThreadId.make(allocation.threadId),
                generation: 2,
              };
            });
          const worker = (hostId = f.hostId) =>
            makeThreadVmEnrollmentWorker(
              sql,
              deliver,
              {
                url: "https://relay.test",
                issuer: "https://relay.test",
              },
              hostId,
            );
          expect(yield* worker("unrelated-host").runOne()).toBe(false);
          expect(calls).toBe(0);
          yield* parallel(Array.from({ length: 5 }, () => worker().runOne()));
          expect(calls).toBe(1);
          expect((yield* f.provisions.get(f.allocationId))?.errorCode).toBe(
            "enrollment_unconfirmed",
          );
          yield* sql`UPDATE relay_thread_vm_enrollments SET expires_at = clock_timestamp() - interval '1 second' WHERE allocation_id = ${f.allocationId}`;
          yield* f.eligible;
          yield* worker().runOne();
          expect(calls).toBe(2);
          expect(f.issued()).toBe(1);
          expect((yield* f.provisions.get(f.allocationId))?.errorCode).toBeNull();
          expect(yield* worker().runOne()).toBe(false);
          const [receipt] =
            yield* sql`SELECT sealed_seed, installed_at FROM relay_thread_vm_enrollments WHERE allocation_id = ${f.allocationId}`;
          expect(receipt?.sealed_seed).toBeNull();
          expect(receipt?.installed_at).not.toBeNull();

          const denied = yield* makeEnrollmentFixture({
            organizationId: NodeCrypto.randomUUID(),
            repositoryId: NodeCrypto.randomUUID(),
          });
          const deniedAllocation = (yield* denied.allocations.get(denied.allocationId))!;
          yield* sql`DELETE FROM relay_organization_members WHERE organization_id = ${deniedAllocation.organizationId} AND user_id = ${deniedAllocation.ownerUserId}`;
          yield* worker(denied.hostId).runOne();
          expect(calls).toBe(2);
          expect((yield* denied.provisions.get(denied.allocationId))?.errorCode).toBe(
            "enrollment_access_denied",
          );
          yield* denied.sql`UPDATE relay_thread_vm_provisions SET retry_at = clock_timestamp() + interval '1 day' WHERE allocation_id = ${denied.allocationId}`;
        }),
    );

    it.effect("keeps VM credentials thread-scoped even if a broad environment link exists", () =>
      Effect.gen(function* () {
        const f = yield* provisionFixture;
        yield* f.worker().runOne();
        const allocation = (yield* f.allocations.get(f.allocationId))!;
        const environmentId = `scoped-${f.allocationId}`,
          environmentPublicKey = "vm-test-public-key";
        const db = yield* RelayDb;
        const credentials = yield* EnvironmentCredentials.EnvironmentCredentials.pipe(
          Effect.provide(
            EnvironmentCredentials.layer.pipe(
              Layer.provide(Layer.succeed(RelayDb, db)),
              Layer.provide(NodeEffectCrypto.layer),
            ),
          ),
        );
        const token = yield* credentials.create({ environmentId, environmentPublicKey });
        expect(Option.isNone(yield* credentials.authenticate(token))).toBe(true);
        const credentialId = token.split("_")[1]!;
        const bindings = makeThreadVmBindingStore(f.sql);
        const binding = {
          allocationId: f.allocationId,
          operationId: f.operationId,
          environmentId,
          environmentPublicKey,
          credentialId,
        };
        expect(
          yield* Effect.flip(bindings.bind({ ...binding, operationId: "wrong-operation" })),
        ).toMatchObject({ _tag: "ThreadVmProvisionConflict" });
        expect(
          yield* Effect.flip(bindings.bind({ ...binding, environmentPublicKey: "different-key" })),
        ).toMatchObject({ _tag: "ThreadVmProvisionConflict" });
        yield* bindings.bind(binding);
        yield* bindings.bind(binding);
        const authenticated = yield* credentials.authenticate(token);
        expect(Option.isSome(authenticated)).toBe(true);
        const principal = Option.getOrThrow(authenticated);
        expect(principal.threadVm).toEqual({
          allocationId: f.allocationId,
          threadId: allocation.threadId,
          repositoryId: "repo",
          generation: 2,
        });
        yield* f.sql`INSERT INTO relay_environment_links (user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url, endpoint_provider_kind, created_at, updated_at)
        VALUES (${allocation.ownerUserId}, ${environmentId}, ${environmentPublicKey}, 'https://vm.invalid', 'wss://vm.invalid/ws', 'manual', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`;
        // A personal link must not widen an already-bound VM credential, even after revocation.
        expect(Option.getOrThrow(yield* credentials.authenticate(token)).threadVm).toEqual(
          principal.threadVm,
        );
        yield* bindings.revoke(f.allocationId);
        expect(Option.isNone(yield* credentials.authenticate(token))).toBe(true);
        const replacement = yield* credentials.create({ environmentId, environmentPublicKey });
        expect(Option.isNone(yield* credentials.authenticate(replacement))).toBe(true);
      }),
    );

    it.effect("deduplicates parallel admissions and keeps completion receipts", () =>
      Effect.gen(function* () {
        const { owner, enrollment } = fixture();
        yield* run((store) => store.enroll(enrollment));
        const results = yield* parallel(
          Array.from({ length: 12 }, () =>
            run((store) => store.admit({ ...owner, workId: "turn" })),
          ),
        );
        expect(results.filter((result) => result.newlyAdmitted)).toHaveLength(1);
        yield* run((store) => store.completeWork({ ...owner, workId: "turn" }));
        expect(yield* run((store) => store.admit({ ...owner, workId: "turn" }))).toMatchObject({
          newlyAdmitted: false,
          completed: true,
        });
      }),
    );

    it.effect("rejects a private move requested by someone other than the thread owner", () =>
      Effect.gen(function* () {
        const { enrollment, move } = fixture();
        yield* run((store) =>
          Effect.gen(function* () {
            yield* store.enroll(enrollment);
            expect(
              yield* Effect.flip(store.beginMove({ ...move, actorUserId: "other-user" })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect((yield* store.get(enrollment.threadId))?.operationId).toBeNull();
            yield* store.beginMove(move);
          }),
        );
      }),
    );

    it.effect("requires admitted work to drain and blocks new work throughout handoff", () =>
      Effect.gen(function* () {
        const { owner, enrollment, move, manifest } = fixture();
        yield* run((store, sql) =>
          Effect.gen(function* () {
            yield* store.enroll(enrollment);
            yield* store.admit({ ...owner, workId: "turn" });
            yield* store.beginMove(move);
            expect(
              yield* Effect.flip(store.sourceFrozen({ ...move, ...owner, ...manifest })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(yield* Effect.flip(store.admit({ ...owner, workId: "next" }))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            expect(yield* store.admit({ ...owner, workId: "turn" })).toMatchObject({
              newlyAdmitted: false,
            });
            yield* store.completeWork({ ...owner, workId: "turn" });
            expect(
              yield* Effect.flip(store.sourceFrozen({ ...move, ...owner, ...manifest })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            yield* makeThreadJournalStore(sql).confirmThrough({
              ...owner,
              sourceSequence: manifest.sourceCursor,
            });
            yield* store.sourceFrozen({ ...move, ...owner, ...manifest });
            expect(yield* Effect.flip(store.commitMove(move))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            expect(
              yield* Effect.flip(
                store.destinationReady({
                  ...move,
                  environmentId: "vm",
                  ...manifest,
                  sourceCursor: 32,
                }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            yield* store.destinationReady({ ...move, environmentId: "vm", ...manifest });
            expect(yield* Effect.flip(store.commitMove(move))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            yield* publishMoveFixture(sql, move);
            yield* store.commitMove(move);
            const destination = { ...owner, environmentId: "vm", generation: 2 };
            expect(
              yield* Effect.flip(store.admit({ ...owner, workId: "old-owner" })),
            ).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            expect(
              yield* Effect.flip(store.admit({ ...destination, workId: "next" })),
            ).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            yield* store.activated({ ...move, ...destination });
            expect(yield* store.admit({ ...destination, workId: "next" })).toMatchObject({
              newlyAdmitted: true,
            });
            expect(
              yield* Effect.flip(store.admit({ ...destination, workId: "turn" })),
            ).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
          }),
        );
      }),
    );

    it.effect(
      "recovers a committed move after a lost response without advancing generation twice",
      () =>
        Effect.gen(function* () {
          const { prepare, move, enrollment } = fixture();
          yield* run(prepare);
          yield* run((store) => store.commitMove(move));
          // A new store instance has no process-local state.
          yield* run((store) =>
            Effect.gen(function* () {
              expect(yield* store.beginMove(move)).toMatchObject({ phase: "committed" });
              expect(yield* store.commitMove(move)).toMatchObject({ phase: "committed" });
              expect(yield* store.get(move.threadId)).toMatchObject({
                generation: 2,
                environmentId: "vm",
              });
              expect(yield* Effect.flip(store.enroll(enrollment))).toMatchObject({
                _tag: "ThreadPlacementConflict",
              });
              expect(yield* Effect.flip(store.requestAbort(move))).toMatchObject({
                _tag: "ThreadPlacementConflict",
              });
            }),
          );
        }),
    );

    it.effect("serializes cancel versus commit with exactly one winner", () =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 8; attempt++) {
          const { prepare, move } = fixture();
          yield* run(prepare);
          const outcomes = yield* parallel([
            run((store) => Effect.result(store.commitMove(move))),
            run((store) => Effect.result(store.requestAbort(move))),
          ]);
          expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
          const placement = yield* run((store) => store.get(move.threadId));
          const state = yield* run((store) => store.getMove(move));
          expect(placement?.generation).toBe(state.phase === "committed" ? 2 : 1);
        }
      }),
    );

    it.effect("keeps source blocked until destination cleanup is confirmed", () =>
      Effect.gen(function* () {
        const { prepare, owner, move } = fixture();
        yield* run(prepare);
        yield* run((store) =>
          Effect.gen(function* () {
            yield* store.requestAbort(move);
            expect(yield* Effect.flip(store.admit({ ...owner, workId: "next" }))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            yield* store.destinationRemoved(move);
            yield* store.destinationRemoved(move);
            expect(yield* store.admit({ ...owner, workId: "next" })).toMatchObject({
              newlyAdmitted: true,
            });
            expect(yield* Effect.flip(store.commitMove(move))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
          }),
        );
      }),
    );

    it.effect("binds operation retries to the exact thread, actor and destination", () =>
      Effect.gen(function* () {
        const { prepare, move } = fixture();
        yield* run(prepare);
        yield* run((store) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(store.beginMove({ ...move, destinationProjectId: "unrelated" })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(store.beginMove({ ...move, actorUserId: "another-user" })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(
                store.beginMove({ ...move, operationId: NodeCrypto.randomUUID() }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(store.getMove({ ...move, threadId: NodeCrypto.randomUUID() })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          }),
        );
      }),
    );

    const allocationFixture = Effect.fnUntraced(function* (ownerUserId = NodeCrypto.randomUUID()) {
      const { enrollment } = fixture();
      yield* run((store) => store.enroll({ ...enrollment, ownerUserId }));
      return {
        allocationId: NodeCrypto.randomUUID(),
        threadId: enrollment.threadId,
        organizationId: "org",
        ownerUserId,
        templateId: "template-pinned",
      };
    });

    it.effect(
      "rejects idle inspections that race with newer work and treats stale reports as unknown",
      () =>
        Effect.gen(function* () {
          const intent = yield* allocationFixture();
          const sql = yield* PgClient.PgClient;
          const allocations = makeThreadVmAllocationStore(sql);
          const activity = makeThreadVmActivityStore(sql);
          yield* allocations.reserve(intent);
          yield* allocations.recordCreated({
            allocationId: intent.allocationId,
            computeRef: NodeCrypto.randomUUID(),
          });

          const staleRevision = yield* activity.beginInspection(intent.allocationId);
          yield* activity.recordWork(intent.allocationId);
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: staleRevision,
              activity: "idle",
            }),
          ).toBe(false);
          expect(yield* activity.get(intent.allocationId)).toMatchObject({
            activity: "unknown",
            idleSince: null,
          });

          const currentRevision = yield* activity.beginInspection(intent.allocationId);
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: currentRevision,
              activity: "idle",
            }),
          ).toBe(true);
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: currentRevision,
              activity: "busy",
            }),
          ).toBe(false);
          const idle = yield* activity.get(intent.allocationId);
          expect(idle?.activity).toBe("idle");
          expect(typeof idle?.idleSince).toBe("number");
          const nextRevision = yield* activity.beginInspection(intent.allocationId);
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: nextRevision,
              activity: "idle",
            }),
          ).toBe(true);
          expect((yield* activity.get(intent.allocationId))?.idleSince).toEqual(idle?.idleSince);

          const timedOutRevision = yield* activity.beginInspection(intent.allocationId);
          yield* sql`UPDATE relay_thread_vm_activity SET observed_at = clock_timestamp() - interval '3 minutes'
          WHERE allocation_id = ${intent.allocationId}`;
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: timedOutRevision,
              activity: "idle",
            }),
          ).toBe(false);
          const recoveredRevision = yield* activity.beginInspection(intent.allocationId);
          expect(
            yield* activity.finishInspection({
              allocationId: intent.allocationId,
              revision: recoveredRevision,
              activity: "idle",
            }),
          ).toBe(true);
          expect((yield* activity.get(intent.allocationId))?.idleSince).not.toEqual(
            idle?.idleSince,
          );

          yield* sql`UPDATE relay_thread_vm_activity SET observed_at = clock_timestamp() - interval '3 minutes'
          WHERE allocation_id = ${intent.allocationId}`;
          expect(yield* activity.get(intent.allocationId)).toMatchObject({
            activity: "unknown",
            idleSince: null,
          });
        }),
    );

    it.effect("reserves the user quota atomically across concurrent threads", () =>
      Effect.gen(function* () {
        const ownerUserId = NodeCrypto.randomUUID();
        const intents = yield* parallel(
          Array.from({ length: 16 }, () => allocationFixture(ownerUserId)),
        );
        const results = yield* parallel(
          intents.map((intent) => runAllocation((store) => Effect.result(store.reserve(intent)))),
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(3);
        for (const result of results) {
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              _tag: "ThreadVmQuotaExceeded",
              maxVms: 3,
              reservedVms: 3,
            });
        }
      }),
    );

    it.effect("keeps uncertain creation and deletion charged until positive absence", () =>
      Effect.gen(function* () {
        const ownerUserId = NodeCrypto.randomUUID();
        const intents = yield* parallel(
          Array.from({ length: 4 }, () => allocationFixture(ownerUserId)),
        );
        const first = intents[0]!;
        for (const intent of intents.slice(0, 3))
          yield* runAllocation((store) => store.reserve(intent));
        yield* runAllocation((store) =>
          Effect.gen(function* () {
            yield* store.requestDeletion(first.allocationId);
            expect(yield* Effect.flip(store.reserve(intents[3]!))).toMatchObject({
              _tag: "ThreadVmQuotaExceeded",
            });
            // Create response arrives after deletion intent; it must not return the VM to running.
            expect(
              yield* store.recordCreated({
                allocationId: first.allocationId,
                computeRef: NodeCrypto.randomUUID(),
              }),
            ).toMatchObject({ state: "deleting" });
            expect(
              yield* Effect.flip(
                store.confirmDeleted({ allocationId: first.allocationId, computeRef: null }),
              ),
            ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
            const current = yield* store.get(first.allocationId);
            yield* store.confirmDeleted({
              allocationId: first.allocationId,
              computeRef: current!.computeRef,
            });
            expect(yield* store.reserve(intents[3]!)).toMatchObject({ state: "creating" });
            expect(yield* store.reserve(first)).toMatchObject({ state: "deleted" });
          }),
        );
      }),
    );

    it.effect("allows only one live allocation per thread even with different owners", () =>
      Effect.gen(function* () {
        const first = yield* allocationFixture();
        const outcomes = yield* parallel([
          runAllocation((store) => Effect.result(store.reserve(first))),
          runAllocation((store) =>
            Effect.result(
              store.reserve({
                ...first,
                ownerUserId: NodeCrypto.randomUUID(),
                allocationId: NodeCrypto.randomUUID(),
              }),
            ),
          ),
        ]);
        expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
        const failure = outcomes.find((result) => result._tag === "Failure");
        expect(failure).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ThreadVmAllocationConflict" },
        });
      }),
    );

    it.effect("retains paused capacity and rejects stale power changes after deletion", () =>
      Effect.gen(function* () {
        const intent = yield* allocationFixture();
        const computeRef = NodeCrypto.randomUUID();
        yield* runAllocation((store) =>
          Effect.gen(function* () {
            yield* store.reserve(intent);
            expect(
              yield* Effect.flip(
                store.confirmDeleted({ allocationId: intent.allocationId, computeRef: null }),
              ),
            ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
            yield* store.recordCreated({ allocationId: intent.allocationId, computeRef });
            yield* store.recordPowerState({
              allocationId: intent.allocationId,
              computeRef,
              state: "paused",
            });
            expect(yield* store.reserve(intent)).toMatchObject({
              state: "paused",
              deletedAt: null,
            });
            yield* store.requestDeletion(intent.allocationId);
            expect(
              yield* Effect.flip(
                store.recordPowerState({
                  allocationId: intent.allocationId,
                  computeRef,
                  state: "running",
                }),
              ),
            ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
            yield* store.confirmDeleted({ allocationId: intent.allocationId, computeRef });
            expect(
              yield* Effect.flip(
                store.recordCreated({ allocationId: intent.allocationId, computeRef }),
              ),
            ).toMatchObject({ _tag: "ThreadVmAllocationConflict" });
          }),
        );
      }),
    );

    it.effect("does not revoke existing reservations when an administrator lowers the quota", () =>
      Effect.gen(function* () {
        const intent = yield* allocationFixture();
        const organizationId = NodeCrypto.randomUUID();
        const { enrollment } = fixture();
        yield* run((store) =>
          store.enroll({ ...enrollment, organizationId, ownerUserId: intent.ownerUserId }),
        );
        const input = { ...intent, organizationId, threadId: enrollment.threadId };
        yield* runAllocation((store) => store.reserve(input));
        yield* Effect.flatMap(
          PgClient.PgClient,
          (sql) =>
            sql`UPDATE relay_thread_vm_policies SET max_vms_per_user = 0, revision = revision + 1 WHERE organization_id = ${organizationId}`,
        );
        expect(yield* runAllocation((store) => store.reserve(input))).toMatchObject({
          state: "creating",
        });
        yield* runAllocation((store) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(
                store.reserve({ ...input, allocationId: NodeCrypto.randomUUID() }),
              ),
            ).toMatchObject({ _tag: "ThreadVmQuotaExceeded", maxVms: 0 });
          }),
        );
      }),
    );

    const actor = { userId: "user", displayName: "Stefan", imageUrl: null };
    const archiveCommand = (threadId: string) => ({
      type: "thread.archive" as const,
      threadId: ThreadId.make(threadId),
      commandId: CommandId.make(NodeCrypto.randomUUID()),
    });
    const historyEvent = (threadId: string, sequence: number): OrchestrationEvent => ({
      type: "thread.archived",
      aggregateKind: "thread",
      aggregateId: ThreadId.make(threadId),
      sequence,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      occurredAt: "2026-10-02T06:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: ThreadId.make(threadId),
        archivedAt: "2026-10-02T06:00:00.000Z",
        updatedAt: "2026-10-02T06:00:00.000Z",
      },
    });

    it.effect(
      "orders concurrent commands and reports pending until a persisted receipt arrives",
      () =>
        Effect.gen(function* () {
          const { enrollment, owner } = fixture();
          yield* run((store) => store.enroll(enrollment));
          const commands = Array.from({ length: 12 }, () => archiveCommand(owner.threadId));
          const entries = yield* parallel(
            commands.map((command) =>
              runJournal((store) => store.stage({ threadId: owner.threadId, actor, command })),
            ),
          );
          expect(entries.map((entry) => entry!.position).sort((a, b) => a - b)).toEqual(
            Array.from({ length: 12 }, (_, i) => i + 1),
          );
          expect(entries.every((entry) => entry?.receipt === null)).toBe(true);
          const ordered = entries.toSorted((a, b) => a!.position - b!.position);
          yield* runJournal((store) =>
            Effect.gen(function* () {
              expect(yield* store.next(owner)).toMatchObject({ commandId: ordered[0]!.commandId });
              expect(
                yield* Effect.flip(
                  store.acknowledge({
                    ...owner,
                    commandId: ordered[1]!.commandId,
                    receipt: { status: "accepted", sequence: 9 },
                  }),
                ),
              ).toMatchObject({ _tag: "ThreadPlacementConflict" });
              yield* store.acknowledge({
                ...owner,
                commandId: ordered[0]!.commandId,
                receipt: { status: "rejected", detail: "already archived" },
              });
              expect(yield* store.next(owner)).toMatchObject({ commandId: ordered[1]!.commandId });
            }),
          );
        }),
    );

    it.effect("deduplicates command retries and preserves the accepted author through a move", () =>
      Effect.gen(function* () {
        const { enrollment, owner, move, manifest } = fixture();
        const command = archiveCommand(owner.threadId);
        yield* run((store) => store.enroll(enrollment));
        yield* runJournal((store) =>
          Effect.gen(function* () {
            yield* store.stage({ threadId: owner.threadId, actor, command });
            expect(yield* store.stage({ threadId: owner.threadId, actor, command })).toMatchObject({
              position: 1,
            });
            expect(
              yield* Effect.flip(
                store.stage({
                  threadId: owner.threadId,
                  actor: { ...actor, userId: "other" },
                  command,
                }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          }),
        );
        yield* run((store, sql) =>
          Effect.gen(function* () {
            yield* store.beginMove(move);
            yield* makeThreadJournalStore(sql).confirmThrough({
              ...owner,
              sourceSequence: manifest.sourceCursor,
            });
            yield* store.sourceFrozen({ ...owner, ...move, ...manifest });
            yield* publishMoveFixture(sql, move);
            yield* store.destinationReady({ ...move, environmentId: "vm", ...manifest });
            yield* store.commitMove(move);
          }),
        );
        const destination = { ...owner, environmentId: "vm", generation: 2 };
        expect(yield* runJournal((store) => store.next(destination))).toBeNull();
        yield* run((store) => store.activated({ ...move, ...destination }));
        yield* runJournal((store) =>
          Effect.gen(function* () {
            expect(yield* store.next(destination)).toMatchObject({
              position: 1,
              actor,
              acceptedGeneration: 1,
            });
            expect(yield* Effect.flip(store.next(owner))).toMatchObject({
              _tag: "ThreadPlacementConflict",
            });
            yield* store.acknowledge({
              ...destination,
              commandId: command.commandId,
              receipt: { status: "accepted", sequence: 1 },
            });
            yield* store.acknowledge({
              ...destination,
              commandId: command.commandId,
              receipt: { status: "accepted", sequence: 1 },
            });
            expect(
              yield* Effect.flip(
                store.acknowledge({
                  ...destination,
                  commandId: command.commandId,
                  receipt: { status: "rejected" },
                }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          }),
        );
      }),
    );

    it.effect("retains paginated history with original source IDs across an ownership change", () =>
      Effect.gen(function* () {
        const base = fixture();
        const environmentId = `local-${base.owner.threadId}`;
        const owner = { ...base.owner, environmentId };
        const move = { ...base.move, sourceEnvironmentId: environmentId };
        const manifest = { ...base.manifest, sourceCursor: 400 };
        yield* run((store) => store.enroll({ ...base.enrollment, environmentId }));
        const event = historyEvent(owner.threadId, 400);
        yield* runJournal((store) =>
          Effect.gen(function* () {
            const wrongThread = historyEvent(NodeCrypto.randomUUID(), 399);
            expect(
              yield* Effect.flip(
                store.append({
                  ...owner,
                  event: { ...wrongThread, aggregateId: ThreadId.make(owner.threadId) },
                }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(yield* store.append({ ...owner, event })).toBe(1);
            expect(yield* store.append({ ...owner, event })).toBe(1);
            expect(
              yield* Effect.flip(
                store.append({
                  ...owner,
                  event: { ...event, eventId: EventId.make(NodeCrypto.randomUUID()) },
                }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(
                store.append({ ...owner, event: historyEvent(owner.threadId, 399) }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(store.confirmThrough({ ...owner, sourceSequence: 399 })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          }),
        );
        yield* run((store, sql) =>
          Effect.gen(function* () {
            yield* store.beginMove(move);
            yield* makeThreadJournalStore(sql).confirmThrough({
              ...owner,
              sourceSequence: manifest.sourceCursor,
            });
            yield* store.sourceFrozen({ ...owner, ...move, ...manifest });
            yield* publishMoveFixture(sql, move);
            yield* store.destinationReady({ ...move, environmentId: "vm", ...manifest });
            yield* store.commitMove(move);
            yield* store.activated({ ...move, environmentId: "vm", generation: 2 });
          }),
        );
        yield* runJournal((store) =>
          Effect.gen(function* () {
            expect(yield* store.append({ ...owner, event })).toBe(1);
            expect(
              yield* Effect.flip(
                store.append({ ...owner, event: historyEvent(owner.threadId, 401) }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* store.append({
                ...owner,
                environmentId: "vm",
                generation: 2,
                event: historyEvent(owner.threadId, 1),
              }),
            ).toBe(2);
            expect(yield* store.history({ threadId: owner.threadId, after: 0, limit: 1 })).toEqual([
              { cursor: 1, environmentId, event },
            ]);
            expect(
              yield* store.history({ threadId: owner.threadId, after: 1, limit: 1 }),
            ).toMatchObject([{ cursor: 2, environmentId: "vm", event: { sequence: 1 } }]);
            expect(yield* store.history({ threadId: owner.threadId, after: 2, limit: 1 })).toEqual(
              [],
            );
          }),
        );
      }),
    );

    it.effect("blocks new source history once its export is frozen", () =>
      Effect.gen(function* () {
        const { prepare, owner } = fixture();
        yield* run(prepare);
        yield* runJournal((store) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(
                store.append({ ...owner, event: historyEvent(owner.threadId, 999) }),
              ),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
            expect(
              yield* Effect.flip(store.history({ threadId: owner.threadId, after: 0, limit: 201 })),
            ).toMatchObject({ _tag: "ThreadPlacementConflict" });
          }),
        );
      }),
    );
    it.effect(
      "reads saved private history without compute and denies admins, revoked grants and removed members",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const organizations = yield* Organizations.Organizations;
          const organizationId = NodeCrypto.randomUUID();
          const adminId = NodeCrypto.randomUUID();
          const ownerUserId = NodeCrypto.randomUUID();
          const repositoryId = NodeCrypto.randomUUID();
          const threadId = NodeCrypto.randomUUID();
          yield* organizations.ensureForUser({ organizationId, userId: adminId });
          yield* organizations.addMember({ organizationId, userId: ownerUserId, role: "member" });
          yield* sql`INSERT INTO relay_repositories (repository_id, organization_id, name, created_at, updated_at)
          VALUES (${repositoryId}, ${organizationId}, 'Private repository', 'now', 'now')`;
          yield* sql`INSERT INTO relay_repository_access (repository_id, user_id, organization_id, role, created_at, updated_at)
          VALUES (${repositoryId}, ${ownerUserId}, ${organizationId}, 'developer', 'now', 'now')`;
          yield* run((store) =>
            store.enroll({
              threadId,
              organizationId,
              repositoryId,
              ownerUserId,
              environmentId: "offline-source",
              projectId: "project",
            }),
          );
          yield* runJournal((store) =>
            store.append({
              threadId,
              environmentId: "offline-source",
              generation: 1,
              event: historyEvent(threadId, 42),
            }),
          );
          const placement = getPortableThreadPlacement(threadId);
          const read = getPortableThreadHistory({ threadId, after: 0, limit: 1 });
          const asOwner = Effect.provideService(RelayClientPrincipal, {
            userId: ownerUserId,
            token: "test",
          });
          const denied = { _tag: "RelayTenancyNotFoundError", reason: "thread_not_found" };
          expect(yield* placement.pipe(asOwner)).toMatchObject({
            threadId,
            ownerUserId,
            environmentId: "offline-source",
          });
          expect(yield* read.pipe(asOwner)).toMatchObject({
            entries: [{ cursor: 1, event: { sequence: 42 } }],
          });
          expect(
            yield* getPortableThreadHistory({ threadId, after: 1, limit: 1 }).pipe(asOwner),
          ).toEqual({ entries: [] });
          for (const request of [placement.pipe(Effect.asVoid), read.pipe(Effect.asVoid)]) {
            expect(
              yield* Effect.flip(
                request.pipe(
                  Effect.provideService(RelayClientPrincipal, { userId: adminId, token: "test" }),
                ),
              ),
            ).toMatchObject(denied);
          }
          yield* sql`DELETE FROM relay_repository_access WHERE repository_id = ${repositoryId} AND user_id = ${ownerUserId}`;
          expect(yield* Effect.flip(read.pipe(asOwner))).toMatchObject(denied);
          yield* sql`UPDATE relay_organization_members SET role = 'admin' WHERE user_id = ${ownerUserId}`;
          expect((yield* read.pipe(asOwner)).entries).toHaveLength(1);
          yield* sql`DELETE FROM relay_organization_members WHERE user_id = ${ownerUserId}`;
          expect(yield* Effect.flip(read.pipe(asOwner))).toMatchObject(denied);
          expect(
            yield* Effect.flip(getPortableThreadPlacement("unknown").pipe(asOwner)),
          ).toMatchObject(denied);
        }),
    );

    it.effect(
      "authenticates inbox authors, serializes retries and retains commands while the owner is moving",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const organizations = yield* Organizations.Organizations;
          const organizationId = NodeCrypto.randomUUID();
          const ownerUserId = NodeCrypto.randomUUID();
          const otherAdmin = NodeCrypto.randomUUID();
          const repositoryId = NodeCrypto.randomUUID();
          const threadId = ThreadId.make(NodeCrypto.randomUUID());
          yield* organizations.ensureForUser({ organizationId, userId: ownerUserId });
          yield* organizations.addMember({ organizationId, userId: otherAdmin, role: "admin" });
          yield* sql`INSERT INTO relay_repositories (repository_id, organization_id, name, created_at, updated_at)
          VALUES (${repositoryId}, ${organizationId}, 'Private repository', 'now', 'now')`;
          yield* run((store) =>
            store.enroll({
              threadId,
              organizationId,
              repositoryId,
              ownerUserId,
              environmentId: "source",
              projectId: "project",
            }),
          );
          const command = {
            type: "thread.queue.pause" as const,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            createdAt: "2026-10-02T00:00:00Z",
            author: { userId: "forged-user", displayName: "Forged", imageUrl: null },
          };
          const asOwner = Effect.provideService(RelayClientPrincipal, {
            userId: ownerUserId,
            token: "test",
          });
          const profile = (displayName: string) =>
            Effect.provideService(UserDirectory, {
              lookup: () =>
                Effect.succeed(
                  new Map([[ownerUserId, { displayName, imageUrl: null, email: null }]]),
                ),
            });
          const submit = stagePortableThreadCommand(threadId, command);
          const receipts = yield* parallel(
            Array.from({ length: 12 }, () => submit.pipe(asOwner, profile("Original"))),
          );
          expect(receipts).toEqual(
            Array.from({ length: 12 }, () => ({
              commandId: command.commandId,
              position: 1,
              receipt: null,
            })),
          );
          expect(yield* submit.pipe(asOwner, profile("New name"))).toEqual(receipts[0]);
          expect(yield* getPendingPortableThreadCommands(threadId, 0, 1).pipe(asOwner)).toEqual({
            entries: [receipts[0]],
            hasMore: false,
          });
          expect(yield* getPendingPortableThreadCommands(threadId, 1, 1).pipe(asOwner)).toEqual({
            entries: [],
            hasMore: false,
          });
          expect(
            yield* Effect.flip(getPendingPortableThreadCommands(threadId, 0, 0).pipe(asOwner)),
          ).toMatchObject({
            _tag: "RelayTenancyConflictError",
          });
          const queued = yield* runJournal((store) => store.command(threadId, command.commandId));
          expect(queued?.actor).toEqual({
            userId: ownerUserId,
            displayName: "Original",
            imageUrl: null,
          });
          expect(queued?.command).not.toHaveProperty("author");
          expect(
            yield* Effect.flip(
              stagePortableThreadCommand(threadId, {
                ...command,
                createdAt: "2026-10-03T00:00:00Z",
              }).pipe(asOwner, profile("New name")),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "thread_command_conflict" });
          expect(
            yield* Effect.flip(
              stagePortableThreadCommand(threadId, {
                ...command,
                threadId: ThreadId.make("other-thread"),
              }).pipe(asOwner, profile("Original")),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError" });
          const asOther = Effect.provideService(RelayClientPrincipal, {
            userId: otherAdmin,
            token: "test",
          });
          expect(yield* Effect.flip(submit.pipe(asOther, profile("Other")))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
            reason: "thread_not_found",
          });
          expect(
            yield* Effect.flip(
              getPortableThreadCommandReceipt(threadId, command.commandId).pipe(asOther),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          expect(
            yield* Effect.flip(getPendingPortableThreadCommands(threadId, 0, 200).pipe(asOther)),
          ).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          const receipt = { status: "accepted" as const, sequence: 7 };
          yield* runJournal((store) =>
            store.acknowledge({
              threadId,
              environmentId: "source",
              generation: 1,
              commandId: command.commandId,
              receipt,
            }),
          );
          expect(yield* submit.pipe(asOwner, profile("New name"))).toEqual({
            ...receipts[0],
            receipt,
          });
          expect(yield* getPendingPortableThreadCommands(threadId, 0, 200).pipe(asOwner)).toEqual({
            entries: [],
            hasMore: false,
          });
          expect(
            yield* getPortableThreadCommandReceipt(threadId, command.commandId).pipe(asOwner),
          ).toEqual({ ...receipts[0], receipt });
          expect(
            yield* getPortableThreadCommandReceipt(threadId, "not-submitted").pipe(asOwner),
          ).toBeNull();
          yield* run((store) =>
            store.beginMove({
              threadId,
              actorUserId: ownerUserId,
              operationId: NodeCrypto.randomUUID(),
              sourceEnvironmentId: "source",
              expectedGeneration: 1,
              destinationEnvironmentId: "vm",
              destinationProjectId: "vm-project",
            }),
          );
          const pending = { ...command, commandId: CommandId.make(NodeCrypto.randomUUID()) };
          expect(
            yield* stagePortableThreadCommand(threadId, pending).pipe(asOwner, profile("New name")),
          ).toEqual({ commandId: pending.commandId, position: 2, receipt: null });
          expect(
            yield* runJournal((store) =>
              store.next({ threadId, environmentId: "source", generation: 1 }),
            ),
          ).toBeNull();
          yield* sql`DELETE FROM relay_organization_members WHERE user_id = ${ownerUserId}`;
          expect(yield* Effect.flip(submit.pipe(asOwner, profile("Original")))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          expect(
            yield* Effect.flip(
              getPortableThreadCommandReceipt(threadId, command.commandId).pipe(asOwner),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
        }),
    );

    it.effect(
      "checks the VM binding on each thread operation and permits only already-admitted deletion drain",
      () =>
        Effect.gen(function* () {
          const f = yield* provisionFixture;
          yield* f.worker().runOne();
          const allocation = (yield* f.allocations.get(f.allocationId))!;
          const organizations = yield* Organizations.Organizations;
          yield* organizations.ensureForUser({
            organizationId: allocation.organizationId,
            userId: allocation.ownerUserId,
          });
          yield* f.sql`INSERT INTO relay_repositories (repository_id, organization_id, name, created_at, updated_at)
        VALUES ('repo',${allocation.organizationId},'Bound repository','now','now') ON CONFLICT DO NOTHING`;
          const environmentId = `vm-${f.allocationId}`,
            environmentPublicKey = "scoped-api-key",
            credentialId = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
        VALUES (${credentialId},${environmentId},${environmentPublicKey},${credentialId},'now','now')`;
          const bindings = makeThreadVmBindingStore(f.sql);
          const bound = yield* bindings.bind({
            allocationId: f.allocationId,
            operationId: f.operationId,
            environmentId,
            environmentPublicKey,
            credentialId,
          });
          const scope = { ...bound, threadId: ThreadId.make(bound.threadId) };
          const principal = { environmentId, environmentPublicKey, credentialId, threadVm: scope };
          const asVm = Effect.provideService(RelayEnvironmentPrincipal, principal);
          const placement = makeThreadPlacementStore(f.sql);
          const move = {
            threadId: allocation.threadId,
            operationId: NodeCrypto.randomUUID(),
            actorUserId: allocation.ownerUserId,
            sourceEnvironmentId: "local",
            expectedGeneration: 1,
            destinationEnvironmentId: environmentId,
            destinationProjectId: "vm-project",
          };
          const manifest = { sourceCursor: 0, manifestSha256: "c".repeat(64) };
          yield* placement.beginMove(move);
          yield* makeThreadJournalStore(f.sql).confirmThrough({
            threadId: allocation.threadId,
            environmentId: "local",
            generation: 1,
            sourceSequence: manifest.sourceCursor,
          });
          yield* placement.sourceFrozen({
            ...move,
            ...manifest,
            environmentId: "local",
            generation: 1,
          });
          yield* publishMoveFixture(f.sql, move);
          yield* placement.destinationReady({ ...move, ...manifest, environmentId });
          yield* placement.commitMove(move);
          yield* placement.activated({ ...move, environmentId, generation: 2 });
          const owner = { threadId: allocation.threadId, environmentId, generation: 2 };
          const work = { ...owner, workId: "vm-turn" };
          expect(yield* admitPortableThreadWork(work).pipe(asVm)).toMatchObject({
            newlyAdmitted: true,
          });
          for (const invalidScope of [
            { ...scope, generation: 1 },
            { ...scope, repositoryId: "other-repository" },
            { ...scope, allocationId: "other-allocation" },
            { ...scope, threadId: ThreadId.make("other-thread") },
          ]) {
            expect(
              yield* Effect.flip(
                nextPortableThreadCommand(owner).pipe(
                  Effect.provideService(RelayEnvironmentPrincipal, {
                    ...principal,
                    threadVm: invalidScope,
                  }),
                ),
              ),
            ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          }
          yield* f.allocations.requestDeletion(f.allocationId);
          expect(yield* Effect.flip(nextPortableThreadCommand(owner).pipe(asVm))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          expect(yield* completePortableThreadWork(work).pipe(asVm)).toEqual({ ok: true });
          yield* bindings.revoke(f.allocationId);
          expect(
            yield* Effect.flip(
              appendPortableThreadHistory({
                ...owner,
                event: historyEvent(owner.threadId, 1),
              }).pipe(asVm),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
        }),
    );

    it.effect(
      "fences environment credentials and generations while allowing admitted work to drain after revocation",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const organizations = yield* Organizations.Organizations;
          const organizationId = NodeCrypto.randomUUID();
          const ownerUserId = NodeCrypto.randomUUID();
          const repositoryId = NodeCrypto.randomUUID();
          const threadId = NodeCrypto.randomUUID();
          const environmentId = NodeCrypto.randomUUID();
          const credentialId = NodeCrypto.randomUUID();
          const environmentPublicKey = "test-key";
          const owner = { threadId, environmentId, generation: 1 };
          const asEnvironment = Effect.provideService(RelayEnvironmentPrincipal, {
            environmentId,
            environmentPublicKey,
            credentialId,
          });
          yield* organizations.ensureForUser({ organizationId, userId: ownerUserId });
          yield* sql`INSERT INTO relay_repositories (repository_id, organization_id, name, created_at, updated_at)
          VALUES (${repositoryId}, ${organizationId}, 'Private repository', 'now', 'now')`;
          yield* sql`INSERT INTO relay_environment_credentials
          (credential_id, environment_id, environment_public_key, credential_hash, created_at, updated_at)
          VALUES (${credentialId}, ${environmentId}, ${environmentPublicKey}, ${credentialId}, 'now', 'now')`;
          yield* sql`INSERT INTO relay_environment_links
          (user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url, endpoint_provider_kind, created_at, updated_at)
          VALUES (${ownerUserId}, ${environmentId}, ${environmentPublicKey}, 'https://test.invalid', 'wss://test.invalid', 'cloudflare', 'now', 'now')`;
          yield* run((store) =>
            store.enroll({
              threadId,
              organizationId,
              repositoryId,
              ownerUserId,
              environmentId,
              projectId: "project",
            }),
          );
          const command = archiveCommand(threadId);
          yield* runJournal((store) =>
            store.stage({ threadId, actor: { ...actor, userId: ownerUserId }, command }),
          );
          expect(yield* nextPortableThreadCommand(owner).pipe(asEnvironment)).toMatchObject({
            commandId: command.commandId,
          });
          const work = { ...owner, workId: "provider-turn" };
          const grants = yield* parallel(
            Array.from({ length: 8 }, () => admitPortableThreadWork(work).pipe(asEnvironment)),
          );
          expect(grants.filter((grant) => grant.newlyAdmitted)).toHaveLength(1);
          const denied = { _tag: "RelayTenancyNotFoundError" };
          for (const principal of [
            { environmentId: "other-environment", environmentPublicKey, credentialId },
            { environmentId, environmentPublicKey: "other-key", credentialId },
            { environmentId, environmentPublicKey, credentialId: "not-the-authenticated-token" },
          ]) {
            expect(
              yield* Effect.flip(
                nextPortableThreadCommand(owner).pipe(
                  Effect.provideService(RelayEnvironmentPrincipal, principal),
                ),
              ),
            ).toMatchObject(denied);
          }
          expect(
            yield* Effect.flip(
              admitPortableThreadWork({ ...work, generation: 2 }).pipe(asEnvironment),
            ),
          ).toMatchObject({
            _tag: "RelayTenancyConflictError",
            reason: "thread_placement_changed",
          });
          yield* sql`DELETE FROM relay_organization_members WHERE user_id = ${ownerUserId}`;
          expect(
            yield* Effect.flip(nextPortableThreadCommand(owner).pipe(asEnvironment)),
          ).toMatchObject(denied);
          expect(
            yield* Effect.flip(
              admitPortableThreadWork({ ...work, workId: "new-work" }).pipe(asEnvironment),
            ),
          ).toMatchObject(denied);
          expect(yield* completePortableThreadWork(work).pipe(asEnvironment)).toEqual({ ok: true });
          const receipt = { status: "accepted" as const, sequence: 7 };
          expect(
            yield* acknowledgePortableThreadCommand({
              ...owner,
              commandId: command.commandId,
              receipt,
            }).pipe(asEnvironment),
          ).toEqual({ ok: true });
          expect(
            yield* appendPortableThreadHistory({ ...owner, event: historyEvent(threadId, 7) }).pipe(
              asEnvironment,
            ),
          ).toEqual({ cursor: 1 });
          const nextCommand = archiveCommand(threadId);
          yield* runJournal((store) => store.stage({ threadId, actor, command: nextCommand }));
          const move = {
            threadId,
            operationId: NodeCrypto.randomUUID(),
            actorUserId: ownerUserId,
            sourceEnvironmentId: environmentId,
            expectedGeneration: 1,
            destinationEnvironmentId: "destination",
            destinationProjectId: "destination-project",
          };
          yield* run((store) => store.beginMove(move));
          expect(
            yield* confirmPortableThreadHistoryThrough({ ...owner, sourceSequence: 7 }).pipe(
              asEnvironment,
            ),
          ).toEqual({ sourceSequence: 7 });
          yield* run((store) =>
            store.sourceFrozen({
              ...move,
              ...owner,
              sourceCursor: 7,
              manifestSha256: "a".repeat(64),
            }),
          );
          expect(
            yield* confirmPortableThreadHistoryThrough({ ...owner, sourceSequence: 7 }).pipe(
              asEnvironment,
            ),
          ).toEqual({ sourceSequence: 7 });
          expect(
            yield* Effect.flip(
              confirmPortableThreadHistoryThrough({ ...owner, sourceSequence: 8 }).pipe(
                asEnvironment,
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError" });
          expect(
            yield* acknowledgePortableThreadCommand({
              ...owner,
              commandId: command.commandId,
              receipt,
            }).pipe(asEnvironment),
          ).toEqual({ ok: true });
          expect(
            yield* Effect.flip(
              acknowledgePortableThreadCommand({
                ...owner,
                commandId: nextCommand.commandId,
                receipt,
              }).pipe(asEnvironment),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError" });
          expect(
            yield* Effect.flip(
              appendPortableThreadHistory({ ...owner, event: historyEvent(threadId, 8) }).pipe(
                asEnvironment,
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError" });
          yield* sql`UPDATE relay_environment_links SET revoked_at = 'now' WHERE environment_id = ${environmentId}`;
          expect(
            yield* Effect.flip(completePortableThreadWork(work).pipe(asEnvironment)),
          ).toMatchObject(denied);
          yield* sql`UPDATE relay_environment_links SET revoked_at = NULL WHERE environment_id = ${environmentId}`;
          yield* sql`UPDATE relay_environment_credentials SET revoked_at = 'now' WHERE credential_id = ${credentialId}`;
          expect(
            yield* Effect.flip(completePortableThreadWork(work).pipe(asEnvironment)),
          ).toMatchObject(denied);
        }),
    );

    it.effect(
      "lets members read policy but only current admins edit it, with revision checks",
      () =>
        Effect.gen(function* () {
          const organizations = yield* Organizations.Organizations;
          const organizationId = NodeCrypto.randomUUID();
          const adminId = NodeCrypto.randomUUID();
          const memberId = NodeCrypto.randomUUID();
          yield* organizations.ensureForUser({ organizationId, userId: adminId });
          yield* organizations.addMember({ organizationId, userId: memberId, role: "member" });
          const initial = yield* getThreadVmPolicy().pipe(
            Effect.provideService(RelayClientPrincipal, { userId: memberId, token: "test" }),
          );
          expect(initial).toEqual({
            organizationId,
            revision: 1,
            policy: DEFAULT_THREAD_VM_POLICY,
          });
          const update = {
            ...initial,
            policy: { ...initial.policy, maxVmsPerUser: 2, pauseAfterIdleMinutes: 15 },
          };
          const denied = yield* Effect.flip(
            updateThreadVmPolicy(update).pipe(
              Effect.provideService(RelayClientPrincipal, { userId: memberId, token: "test" }),
            ),
          );
          expect(denied).toMatchObject({
            _tag: "RelayTenancyForbiddenError",
            reason: "not_an_admin",
          });
          const saved = yield* updateThreadVmPolicy(update).pipe(
            Effect.provideService(RelayClientPrincipal, { userId: adminId, token: "test" }),
          );
          expect(saved).toEqual({ organizationId, revision: 2, policy: update.policy });
          expect(
            yield* Effect.flip(
              updateThreadVmPolicy(update).pipe(
                Effect.provideService(RelayClientPrincipal, { userId: adminId, token: "test" }),
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "vm_policy_changed" });
          const anotherAdmin = NodeCrypto.randomUUID();
          const otherOrganizationId = NodeCrypto.randomUUID();
          yield* organizations.ensureForUser({
            organizationId: otherOrganizationId,
            userId: anotherAdmin,
          });
          expect(
            yield* getThreadVmPolicy().pipe(
              Effect.provideService(RelayClientPrincipal, { userId: anotherAdmin, token: "test" }),
            ),
          ).toEqual({
            organizationId: otherOrganizationId,
            revision: 1,
            policy: DEFAULT_THREAD_VM_POLICY,
          });
          expect(
            yield* Effect.flip(
              updateThreadVmPolicy({ ...update, revision: 1 }).pipe(
                Effect.provideService(RelayClientPrincipal, {
                  userId: anotherAdmin,
                  token: "test",
                }),
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "vm_policy_changed" });
          expect(
            yield* getThreadVmPolicy().pipe(
              Effect.provideService(RelayClientPrincipal, { userId: anotherAdmin, token: "test" }),
            ),
          ).toEqual({
            organizationId: otherOrganizationId,
            revision: 1,
            policy: DEFAULT_THREAD_VM_POLICY,
          });
        }),
    );

    it.effect(
      "enrolls a local thread only after its frozen history and deduplication baseline arrive",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient,
            organizationId = NodeCrypto.randomUUID(),
            ownerUserId = NodeCrypto.randomUUID(),
            repositoryId = NodeCrypto.randomUUID(),
            threadId = ThreadId.make(NodeCrypto.randomUUID()),
            environmentId = EnvironmentId.make(NodeCrypto.randomUUID()),
            credentialId = NodeCrypto.randomUUID(),
            environmentPublicKey = NodeCrypto.randomUUID(),
            operationId = NodeCrypto.randomUUID(),
            projectId = ProjectId.make("local-project");
          const canonicalKey = `github.com/enrollment/${repositoryId}`;
          yield* (yield* Organizations.Organizations).ensureForUser({
            organizationId,
            userId: ownerUserId,
          });
          yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES(${repositoryId},${organizationId},'Local enrollment','now','now')`;
          yield* sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${canonicalKey},${repositoryId},${organizationId},'now')`;
          yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES(${credentialId},${environmentId},${environmentPublicKey},${credentialId},'now','now')`;
          yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES(${ownerUserId},${environmentId},${environmentPublicKey},'https://test.invalid','wss://test.invalid','cloudflare','now','now')`;
          const asEnvironment = Effect.provideService(RelayEnvironmentPrincipal, {
            environmentId,
            credentialId,
            environmentPublicKey,
          });
          const request = {
            environmentId,
            threadId,
            projectId,
            canonicalKey,
            operationId,
            actorUserId: ownerUserId,
          };
          expect(
            (yield* Effect.flip(
              prepareLocalThreadEnrollment({ ...request, actorUserId: "foreign" }).pipe(
                asEnvironment,
              ),
            ))._tag,
          ).toBe("RelayTenancyNotFoundError");
          expect(yield* makeThreadPlacementStore(sql).get(threadId)).toBeNull();
          const cancelledRequest = {
            ...request,
            threadId: ThreadId.make(NodeCrypto.randomUUID()),
            operationId: NodeCrypto.randomUUID(),
          };
          const cancelledPrepared =
            yield* prepareLocalThreadEnrollment(cancelledRequest).pipe(asEnvironment);
          const aborted = yield* abortLocalThreadEnrollment(cancelledRequest).pipe(asEnvironment);
          expect(aborted.outcome).toBe("aborted");
          expect(yield* abortLocalThreadEnrollment(cancelledRequest).pipe(asEnvironment)).toEqual(
            aborted,
          );
          expect(
            (yield* Effect.flip(prepareLocalThreadEnrollment(cancelledRequest).pipe(asEnvironment)))
              ._tag,
          ).toBe("RelayTenancyConflictError");
          const cancelledOwner = {
            environmentId,
            threadId: cancelledRequest.threadId,
            generation: 1,
          };
          expect(
            (yield* Effect.flip(
              admitPortableThreadWork({ ...cancelledOwner, workId: "cancelled" }).pipe(
                asEnvironment,
              ),
            ))._tag,
          ).toBe("RelayTenancyNotFoundError");
          expect(
            (yield* Effect.flip(
              makeThreadJournalStore(sql).stage({
                threadId: cancelledRequest.threadId,
                actor: { userId: ownerUserId, displayName: "Owner", imageUrl: null },
                command: {
                  type: "thread.archive",
                  threadId: cancelledRequest.threadId,
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                },
              }),
            ))._tag,
          ).toBe("ThreadPlacementConflict");
          const reenrollment = { ...cancelledRequest, operationId: NodeCrypto.randomUUID() };
          expect(
            (yield* prepareLocalThreadEnrollment(reenrollment).pipe(asEnvironment)).phase,
          ).toBe("preparing");
          expect(yield* abortLocalThreadEnrollment(cancelledRequest).pipe(asEnvironment)).toEqual(
            aborted,
          );
          expect(
            (yield* makeThreadPlacementStore(sql).get(cancelledRequest.threadId))?.operationId,
          ).toBe(reenrollment.operationId);
          expect(cancelledPrepared.placement.environmentId).toBe(environmentId);
          const stagedRequest = {
            ...request,
            threadId: ThreadId.make(NodeCrypto.randomUUID()),
            operationId: NodeCrypto.randomUUID(),
          };
          yield* prepareLocalThreadEnrollment(stagedRequest).pipe(asEnvironment);
          yield* makeThreadJournalStore(sql).stage({
            threadId: stagedRequest.threadId,
            actor: { userId: ownerUserId, displayName: "Owner", imageUrl: null },
            command: {
              type: "thread.archive",
              threadId: stagedRequest.threadId,
              commandId: CommandId.make(NodeCrypto.randomUUID()),
            },
          });
          expect(
            (yield* abortLocalThreadEnrollment(stagedRequest).pipe(asEnvironment)).outcome,
          ).toBe("continue");
          const unprepared = {
            ...request,
            threadId: ThreadId.make(NodeCrypto.randomUUID()),
            operationId: NodeCrypto.randomUUID(),
          };
          expect((yield* abortLocalThreadEnrollment(unprepared).pipe(asEnvironment)).outcome).toBe(
            "aborted",
          );
          expect(
            (yield* Effect.flip(prepareLocalThreadEnrollment(unprepared).pipe(asEnvironment)))._tag,
          ).toBe("RelayTenancyConflictError");
          const prepared = yield* prepareLocalThreadEnrollment(request).pipe(asEnvironment);
          expect(prepared.phase).toBe("preparing");
          expect(yield* prepareLocalThreadEnrollment(request).pipe(asEnvironment)).toEqual(
            prepared,
          );
          expect(
            (yield* Effect.flip(
              prepareLocalThreadEnrollment({
                ...request,
                projectId: ProjectId.make("changed"),
              }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          const owner = { environmentId, threadId, generation: 1 };
          expect(
            (yield* Effect.flip(
              admitPortableThreadWork({ ...owner, workId: "early" }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          const confirm = {
            environmentId,
            threadId,
            operationId,
            sourceSequence: 5,
            receiptCount: 2,
          };
          expect(
            (yield* Effect.flip(confirmLocalThreadEnrollment(confirm).pipe(asEnvironment)))._tag,
          ).toBe("RelayTenancyConflictError");
          const event = yield* decodeMoveHistoryEvent({
            type: "thread.created",
            sequence: 5,
            eventId: NodeCrypto.randomUUID(),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-10-07T00:00:00Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              projectId,
              title: "Local",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-10-07T00:00:00Z",
              updatedAt: "2026-10-07T00:00:00Z",
            },
          });
          yield* appendPortableThreadHistory({ ...owner, event }).pipe(asEnvironment);
          // Other threads can advance the environment-global scan beyond this thread's final event.
          yield* confirmPortableThreadHistoryThrough({ ...owner, sourceSequence: 9 }).pipe(
            asEnvironment,
          );
          const receipts = [
            {
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              aggregateKind: "thread" as const,
              aggregateId: threadId,
              projectId,
              acceptedAt: "2026-10-07T00:00:00Z",
              resultSequence: 5,
              status: "accepted" as const,
              error: null,
            },
            {
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              aggregateKind: "thread" as const,
              aggregateId: threadId,
              projectId,
              acceptedAt: "2026-10-07T00:00:00Z",
              resultSequence: 9,
              status: "rejected" as const,
              error: "Previously rejected",
            },
          ];
          expect(
            (yield* Effect.flip(
              receiveLocalEnrollmentReceipts({
                ...request,
                receipts: [{ ...receipts[0]!, aggregateId: ThreadId.make("foreign") }],
              }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          expect(
            (yield* Effect.flip(
              receiveLocalEnrollmentReceipts({
                ...request,
                receipts: [{ ...receipts[0]!, projectId: ProjectId.make("foreign-project") }],
              }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          yield* receiveLocalEnrollmentReceipts({ ...request, receipts }).pipe(asEnvironment);
          yield* receiveLocalEnrollmentReceipts({ ...request, receipts }).pipe(asEnvironment);
          expect(
            (yield* Effect.flip(
              confirmLocalThreadEnrollment({ ...confirm, receiptCount: 1 }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          const activated = yield* confirmLocalThreadEnrollment(confirm).pipe(asEnvironment);
          expect(activated.phase).toBe("active");
          expect(activated.placement.operationId).toBeNull();
          expect(yield* confirmLocalThreadEnrollment(confirm).pipe(asEnvironment)).toEqual(
            activated,
          );
          expect(
            (yield* Effect.flip(
              confirmLocalThreadEnrollment({ ...confirm, sourceSequence: 4 }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          yield* receiveLocalEnrollmentReceipts({ ...request, receipts }).pipe(asEnvironment);
          expect(
            (yield* Effect.flip(
              receiveLocalEnrollmentReceipts({
                ...request,
                receipts: [{ ...receipts[0]!, commandId: CommandId.make(NodeCrypto.randomUUID()) }],
              }).pipe(asEnvironment),
            ))._tag,
          ).toBe("RelayTenancyConflictError");
          const journal = makeThreadJournalStore(sql),
            actor = { userId: ownerUserId, displayName: "Owner", imageUrl: null };
          for (const receipt of receipts) {
            const entry = yield* journal.stage({
              threadId,
              actor,
              command: { type: "thread.archive", threadId, commandId: receipt.commandId },
            });
            expect(entry?.receipt).toEqual(
              receipt.status === "accepted"
                ? { status: "accepted", sequence: 5 }
                : { status: "rejected", detail: "Previously rejected" },
            );
          }
          expect(yield* journal.next(owner)).toBeNull();
          expect(
            (yield* admitPortableThreadWork({ ...owner, workId: "after" }).pipe(asEnvironment))
              .newlyAdmitted,
          ).toBe(true);
          expect((yield* abortLocalThreadEnrollment(request).pipe(asEnvironment)).outcome).toBe(
            "continue",
          );
          yield* sql`UPDATE relay_environment_links SET revoked_at='now' WHERE environment_id=${environmentId}`;
          expect(
            (yield* abortLocalThreadEnrollment(reenrollment).pipe(asEnvironment)).outcome,
          ).toBe("aborted");
          expect(
            (yield* Effect.flip(prepareLocalThreadEnrollment(request).pipe(asEnvironment)))._tag,
          ).toBe("RelayTenancyNotFoundError");
        }),
    );
    const vmMoveFixture = Effect.fnUntraced(function* () {
      const sql = yield* PgClient.PgClient;
      const organizationId = NodeCrypto.randomUUID(),
        repositoryId = NodeCrypto.randomUUID(),
        ownerUserId = NodeCrypto.randomUUID();
      yield* (yield* Organizations.Organizations).ensureForUser({
        organizationId,
        userId: ownerUserId,
      });
      yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at)
        VALUES (${repositoryId},${organizationId},'VM move','now','now')`;
      const environmentId = NodeCrypto.randomUUID(),
        credentialId = NodeCrypto.randomUUID(),
        environmentPublicKey = NodeCrypto.randomUUID();
      yield* sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
        VALUES (${credentialId},${environmentId},${environmentPublicKey},${credentialId},'now','now')`;
      yield* sql`INSERT INTO relay_environment_links (user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
        VALUES (${ownerUserId},${environmentId},${environmentPublicKey},'https://test.invalid','wss://test.invalid','cloudflare','now','now')`;
      const placements = makeThreadPlacementStore(sql),
        destinations = makeThreadVmMoveDestinationStore(sql),
        allocations = makeThreadVmAllocationStore(sql);
      const threadId = NodeCrypto.randomUUID(),
        operationId = NodeCrypto.randomUUID(),
        hostId = NodeCrypto.randomUUID();
      yield* placements.enroll({
        threadId,
        organizationId,
        repositoryId,
        ownerUserId,
        environmentId,
        projectId: "source-project",
      });
      yield* makeThreadVmCapacityStore(sql).configure(hostId, 10);
      const intent = {
        threadId,
        operationId,
        actorUserId: ownerUserId,
        sourceEnvironmentId: environmentId,
        expectedGeneration: 1,
        hostId,
        templateId: "template:immutable-build",
        cancelBeforeStart: false,
      };
      const settings = {
        hostId,
        maxRunningVms: 10,
        publicRelayUrl: "https://relay.test",
        autoPauseEnabled: false,
        autoBackupEnabled: false,
        autoDeleteEnabled: false,
        replacementEnabled: false,
        restoreEnabled: false,
        resetEnabled: false,
        templateBuildId: "build",
        compute: {
          apiUrl: "https://compute.test",
          sandboxUrl: "https://proxy.test",
          apiKey: Redacted.make("test"),
          templateId: intent.templateId,
          timeoutMs: 600000,
          hostAddresses: [],
        },
      };
      const asSource = Effect.provideService(RelayEnvironmentPrincipal, {
        environmentId,
        credentialId,
        environmentPublicKey,
      });
      const begin = (changes = {}) =>
        beginPortableThreadVmMove({
          threadId,
          operationId,
          environmentId,
          generation: 1,
          actorUserId: ownerUserId,
          cancelBeforeStart: false,
          ...changes,
        }).pipe(asSource, Effect.provideService(ThreadVmRuntimeConfiguration, { settings }));
      const metadata = {
        "launchpad.managed": "thread-vm-v1",
        "launchpad.operation_id": operationId,
        "launchpad.allocation_id": operationId,
        "launchpad.thread_id": threadId,
        "launchpad.generation": "2",
      };
      const computeRef = `vm-${operationId}`;
      const provision = () =>
        makeThreadVmProvisionWorker(
          sql,
          {
            create: () => Effect.succeed({ sandboxId: computeRef, metadata }),
            cancelCreate: () => Effect.die("Unexpected creation cancellation"),
            findOperation: () => Effect.succeed([]),
          },
          intent.templateId,
          hostId,
        ).runOne();
      const bind = Effect.fnUntraced(function* () {
        const destinationEnvironmentId = NodeCrypto.randomUUID(),
          destinationCredentialId = NodeCrypto.randomUUID(),
          key = NodeCrypto.randomUUID();
        yield* sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES (${destinationCredentialId},${destinationEnvironmentId},${key},${destinationCredentialId},'now','now')`;
        yield* makeThreadVmBindingStore(sql).bind({
          allocationId: operationId,
          operationId,
          environmentId: destinationEnvironmentId,
          environmentPublicKey: key,
          credentialId: destinationCredentialId,
        });
        yield* sql`INSERT INTO relay_thread_vm_enrollments (allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,installed_at)
          VALUES (${operationId},${operationId},${NodeCrypto.randomUUID()},clock_timestamp()+interval '1 hour',${destinationEnvironmentId},${key},'sealed',${destinationCredentialId},clock_timestamp())`;
        return {
          enrolled: true as const,
          allocationId: operationId,
          operationId,
          threadId: ThreadId.make(threadId),
          generation: 2,
          environmentId: EnvironmentId.make(destinationEnvironmentId),
        };
      });
      return {
        sql,
        intent,
        placements,
        destinations,
        allocations,
        settings,
        begin,
        metadata,
        computeRef,
        provision,
        bind,
      };
    });

    it.effect("reserves a VM move atomically and assigns only its confirmed enrollment", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        const first = yield* f.begin();
        expect(first).toMatchObject({
          status: "accepted",
          move: {
            phase: "preparing",
            destinationEnvironmentId: `pending-vm:${f.intent.operationId}`,
          },
        });
        expect(yield* f.begin()).toEqual(first);
        expect((yield* f.placements.get(f.intent.threadId))?.generation).toBe(1);
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("creating");
        expect(yield* Effect.flip(f.begin({ actorUserId: "stranger" }))).toMatchObject({
          _tag: "RelayTenancyNotFoundError",
        });
        expect(yield* Effect.flip(f.begin({ generation: 2 }))).toMatchObject({
          _tag: "RelayTenancyConflictError",
        });
        const forged = {
          enrolled: true as const,
          allocationId: f.intent.operationId,
          operationId: f.intent.operationId,
          threadId: ThreadId.make(f.intent.threadId),
          generation: 2,
          environmentId: EnvironmentId.make("forged"),
        };
        expect(yield* Effect.flip(f.destinations.assigned(forged))).toMatchObject({
          _tag: "ThreadPlacementConflict",
        });
        yield* f.provision();
        const receipt = yield* f.bind();
        yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=NULL WHERE allocation_id=${receipt.allocationId}`;
        expect(yield* Effect.flip(f.destinations.assigned(receipt))).toMatchObject({
          _tag: "ThreadPlacementConflict",
        });
        yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=clock_timestamp() WHERE allocation_id=${receipt.allocationId}`;
        expect(yield* f.destinations.assigned(receipt)).toBe(true);
        expect(yield* f.destinations.assigned(receipt)).toBe(true);
        expect((yield* f.placements.getMove(f.intent)).destinationEnvironmentId).toBe(
          receipt.environmentId,
        );
        expect((yield* f.placements.get(f.intent.threadId))?.environmentId).toBe(
          f.intent.sourceEnvironmentId,
        );
        expect(
          yield* Effect.flip(f.destinations.assigned({ ...receipt, generation: 3 })),
        ).toMatchObject({ _tag: "ThreadPlacementConflict" });
      }),
    );

    it.effect("leaves a quota-blocked move local and cancels it without creating a VM", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        yield* f.sql`INSERT INTO relay_thread_vm_policies (organization_id,max_vms_per_user) VALUES (${(yield* f.placements.get(f.intent.threadId))!.organizationId},1)`;
        const other = fixture();
        yield* f.placements.enroll({
          ...other.enrollment,
          organizationId: (yield* f.placements.get(f.intent.threadId))!.organizationId,
          ownerUserId: f.intent.actorUserId,
        });
        yield* f.allocations.reserve({
          allocationId: NodeCrypto.randomUUID(),
          threadId: other.owner.threadId,
          organizationId: (yield* f.placements.get(f.intent.threadId))!.organizationId,
          ownerUserId: f.intent.actorUserId,
          templateId: f.intent.templateId,
        });
        expect(yield* f.begin()).toMatchObject({
          status: "quota_reached",
          maxVms: 1,
          reservedVms: 1,
        });
        expect((yield* f.placements.get(f.intent.threadId))?.operationId).toBeNull();
        expect(yield* f.allocations.get(f.intent.operationId)).toBeNull();
        expect(yield* f.begin({ cancelBeforeStart: true })).toMatchObject({
          status: "accepted",
          move: { phase: "aborted" },
        });
        expect((yield* f.placements.get(f.intent.threadId))?.operationId).toBeNull();
        expect(yield* f.allocations.get(f.intent.operationId)).toBeNull();
      }),
    );

    it.effect("keeps cancellation fenced until a never-created VM reservation is released", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        yield* f.begin();
        yield* f.placements.requestAbort(f.intent);
        let calls = 0;
        const cleanup = makeThreadVmMoveCleanupWorker(
          f.sql,
          {
            inspect: () =>
              Effect.sync(() => {
                calls++;
                return null;
              }),
            destroy: () =>
              Effect.sync(() => {
                calls++;
              }),
          },
          f.intent.hostId,
        );
        yield* cleanup.runOne();
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleting");
        expect((yield* f.placements.getMove(f.intent)).phase).toBe("aborting");
        yield* f.provision();
        yield* cleanup.runOne();
        expect(calls).toBe(0);
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleted");
        expect((yield* f.placements.getMove(f.intent)).phase).toBe("aborted");
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.intent.operationId))?.state).toBe(
          "released",
        );
      }),
    );

    for (const problem of ["none", "foreign", "unknown", "lost-stop", "stale-placement"] as const) {
      it.effect(`cancelled VM cleanup reconciles an unreadable pause: ${problem}`, () =>
        Effect.gen(function* () {
          const f = yield* vmMoveFixture();
          yield* f.begin();
          yield* f.provision();
          const receipt = yield* f.bind();
          yield* f.destinations.assigned(receipt);
          yield* f.placements.requestAbort(f.intent);
          let stops = 0,
            identityReads = 0;
          const cleanup = makeThreadVmMoveCleanupWorker(
            f.sql,
            {
              inspect: () =>
                Effect.fail(
                  new ThreadVmComputeError({
                    operation: "inspect",
                    message: "Paused disk readiness is unavailable",
                  }),
                ),
              inspectCreation: (operationId) =>
                Effect.gen(function* () {
                  identityReads++;
                  if (problem === "stale-placement" && identityReads === 1)
                    yield* f.sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${f.intent.threadId}`.pipe(
                      Effect.orDie,
                    );
                  return problem === "unknown"
                    ? null
                    : {
                        operationId,
                        computeRef: f.computeRef,
                        metadata: {
                          ...f.metadata,
                          ...(problem === "foreign"
                            ? { "launchpad.thread_id": "another-thread" }
                            : {}),
                        },
                      };
                }),
              destroy: (id) =>
                Effect.gen(function* () {
                  expect(id).toBe(f.computeRef);
                  stops++;
                  if (problem === "lost-stop" && stops === 1)
                    return yield* new ThreadVmComputeError({
                      operation: "destroy",
                      message: "Lost certified stop reply",
                    });
                }),
            },
            f.intent.hostId,
          );
          yield* cleanup.runOne();
          expect(stops).toBe(problem === "none" || problem === "lost-stop" ? 1 : 0);
          expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe(
            problem === "none" ? "deleted" : "deleting",
          );
          expect((yield* f.placements.get(f.intent.threadId))?.environmentId).toBe(
            f.intent.sourceEnvironmentId,
          );
          if (problem === "lost-stop" || problem === "stale-placement") {
            if (problem === "stale-placement")
              yield* f.sql`UPDATE relay_thread_placements SET generation=1 WHERE thread_id=${f.intent.threadId}`;
            yield* cleanup.runOne();
            expect(stops).toBe(problem === "lost-stop" ? 2 : 1);
            expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleted");
          }
        }),
      );
    }

    it.effect("holds VM quota after a lost deletion reply or foreign compute identity", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        yield* f.begin();
        yield* f.provision();
        const receipt = yield* f.bind();
        yield* f.destinations.assigned(receipt);
        yield* f.placements.requestAbort(f.intent);
        let deleted = 0,
          wrong = true,
          lost = true;
        const cleanup = makeThreadVmMoveCleanupWorker(
          f.sql,
          {
            inspect: () =>
              Effect.succeed({
                sandboxId: f.computeRef,
                metadata: {
                  ...f.metadata,
                  ...(wrong ? { "launchpad.allocation_id": "foreign" } : {}),
                },
                templateId: "template",
                startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
                endAt: DateTime.toDateUtc(DateTime.makeUnsafe(1)),
                state: "running",
                cpuCount: 2,
                memoryMB: 4096,
                envdVersion: "test",
              } satisfies SandboxInfo),
            destroy: () =>
              Effect.gen(function* () {
                deleted++;
                if (lost)
                  return yield* new ThreadVmComputeError({
                    operation: "delete",
                    message: "lost stop receipt",
                  });
              }),
          },
          f.intent.hostId,
        );
        yield* cleanup.runOne();
        expect(deleted).toBe(0);
        wrong = false;
        yield* cleanup.runOne();
        expect(deleted).toBe(1);
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleting");
        expect((yield* f.placements.getMove(f.intent)).phase).toBe("aborting");
        expect((yield* makeThreadVmCapacityStore(f.sql).get(f.intent.operationId))?.state).toBe(
          "started",
        );
        const [credential] =
          yield* f.sql`SELECT revoked_at FROM relay_environment_credentials WHERE environment_id=${receipt.environmentId}`;
        expect(credential?.revoked_at).toBeNull();
        lost = false;
        yield* cleanup.runOne();
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleted");
        expect((yield* f.placements.getMove(f.intent)).phase).toBe("aborted");
        const [revoked] =
          yield* f.sql`SELECT revoked_at FROM relay_environment_credentials WHERE environment_id=${receipt.environmentId}`;
        expect(revoked?.revoked_at).not.toBeNull();
        expect(yield* cleanup.runOne()).toBe(false);
      }),
    );

    it.effect(
      "allows only the installed frozen move guest to configure its repository before ownership commits",
      () =>
        Effect.gen(function* () {
          const f = yield* vmMoveFixture();
          yield* f.begin();
          yield* f.provision();
          const receipt = yield* f.bind();
          yield* f.destinations.assigned(receipt);
          const placement = (yield* f.placements.get(f.intent.threadId))!,
            canonicalKey = `github.com/test-owner/repo-${placement.repositoryId}`;
          yield* f.sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id,created_at) VALUES(${canonicalKey},${placement.repositoryId},${placement.organizationId},'now')`;
          yield* f.sql`INSERT INTO relay_github_installations(organization_id,installation_id,account_login,account_type,connected_by_user_id,created_at,updated_at)
        VALUES(${placement.organizationId},'420001','test-owner','Organization',${placement.ownerUserId},'now','now')`;
          const [key] = yield* f.sql<{
            credentialId: string;
            environmentPublicKey: string;
          }>`SELECT credential_id AS "credentialId",environment_public_key AS "environmentPublicKey"
        FROM relay_environment_credentials WHERE environment_id=${receipt.environmentId}`;
          const principal = {
            ...key!,
            environmentId: receipt.environmentId,
            threadVm: {
              allocationId: receipt.allocationId,
              threadId: receipt.threadId,
              repositoryId: placement.repositoryId,
              generation: 2,
            },
          };
          const provide = Effect.provideService(RelayEnvironmentPrincipal, principal),
            input = {
              threadId: f.intent.threadId,
              environmentId: receipt.environmentId,
              generation: 2,
            };
          let minted = 0,
            afterMint = Effect.void;
          const github = GithubApp.of({
            installUrl: Effect.succeed(null),
            getInstallation: () => Effect.die("unexpected"),
            listRepositories: () => Effect.die("unexpected"),
            listInstallations: Effect.die("unexpected"),
            describe: () => Effect.die("unexpected"),
            mintInstallationToken: () => Effect.die("broad token forbidden"),
            mintRepositoryToken: (scope) =>
              Effect.gen(function* () {
                expect(scope).toEqual({ installationId: "420001", canonicalKey });
                minted++;
                yield* afterMint;
                return { token: "scoped-test-token", expiresAt: "2099-01-01T00:00:00Z" };
              }),
          });
          const mint = () =>
            mintThreadVmRepositoryToken({ ...input, canonicalKey }).pipe(
              provide,
              Effect.provideService(GithubApp, github),
            );
          expect((yield* Effect.flip(getThreadVmRepositoryBinding(input).pipe(provide)))._tag).toBe(
            "RelayTenancyNotFoundError",
          );
          expect((yield* Effect.flip(mint()))._tag).toBe("RelayTenancyNotFoundError");
          expect(minted).toBe(0);
          yield* makeThreadJournalStore(f.sql).confirmThrough({
            threadId: f.intent.threadId,
            environmentId: f.intent.sourceEnvironmentId,
            generation: 1,
            sourceSequence: 1,
          });
          yield* f.placements.sourceFrozen({
            ...f.intent,
            environmentId: f.intent.sourceEnvironmentId,
            generation: 1,
            sourceCursor: 1,
            manifestSha256: "a".repeat(64),
          });
          expect((yield* Effect.flip(getThreadVmRepositoryBinding(input).pipe(provide)))._tag).toBe(
            "RelayTenancyNotFoundError",
          );
          yield* publishMoveFixture(f.sql, f.intent);
          expect(yield* getThreadVmRepositoryBinding(input).pipe(provide)).toEqual({
            ...input,
            canonicalKey,
            repositoryId: placement.repositoryId,
            operationId: f.intent.operationId,
          });
          expect((yield* mint()).token).toBe("scoped-test-token");
          expect(minted).toBe(1);
          expect((yield* f.placements.get(f.intent.threadId))?.environmentId).toBe(
            f.intent.sourceEnvironmentId,
          );
          expect(
            (yield* Effect.flip(
              admitPortableThreadWork({ ...input, workId: "premature" }).pipe(provide),
            ))._tag,
          ).toBe("RelayTenancyNotFoundError");
          for (const changes of [
            { generation: 1 },
            { threadId: "foreign" },
            { environmentId: f.intent.sourceEnvironmentId },
          ]) {
            expect(
              (yield* Effect.flip(
                getThreadVmRepositoryBinding({ ...input, ...changes }).pipe(provide),
              ))._tag,
            ).toMatch(/^RelayTenancy/);
          }
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=NULL WHERE allocation_id=${receipt.allocationId}`;
          expect((yield* Effect.flip(mint()))._tag).toBe("RelayTenancyNotFoundError");
          yield* f.sql`UPDATE relay_thread_vm_enrollments SET installed_at=clock_timestamp() WHERE allocation_id=${receipt.allocationId}`;
          afterMint = f.placements.requestAbort(f.intent).pipe(Effect.orDie, Effect.asVoid);
          expect((yield* Effect.flip(mint()))._tag).toBe("RelayTenancyNotFoundError");
          expect(minted).toBe(2);
          expect((yield* Effect.flip(getThreadVmRepositoryBinding(input).pipe(provide)))._tag).toBe(
            "RelayTenancyNotFoundError",
          );
        }),
    );

    it.effect("starts an enrolled move guest only after a verified frozen archive exists", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        yield* f.begin();
        yield* f.provision();
        const receipt = yield* f.bind();
        yield* f.destinations.assigned(receipt);
        const expectedDigest = yield* threadVmMoveServerDigest(receipt);
        let starts = 0,
          lost = true;
        const worker = makeThreadVmMoveServerWorker(
          f.sql,
          (_id, identity, digest, mode) =>
            Effect.gen(function* () {
              starts++;
              expect(_id).toBe(f.computeRef);
              expect(identity.scope.generation).toBe(2);
              expect(mode).toBe("move");
              expect(digest).toBe(expectedDigest);
              if (lost)
                return yield* new ThreadVmComputeError({
                  operation: "startup",
                  message: "lost reply",
                });
            }),
          f.intent.hostId,
        );
        expect(yield* worker.runOne()).toBe(false);
        expect(starts).toBe(0);
        yield* makeThreadJournalStore(f.sql).confirmThrough({
          threadId: f.intent.threadId,
          environmentId: f.intent.sourceEnvironmentId,
          generation: 1,
          sourceSequence: 1,
        });
        yield* f.placements.sourceFrozen({
          ...f.intent,
          environmentId: f.intent.sourceEnvironmentId,
          generation: 1,
          sourceCursor: 1,
          manifestSha256: "a".repeat(64),
        });
        expect(yield* worker.runOne()).toBe(false);
        yield* publishMoveFixture(f.sql, f.intent);
        expect(yield* worker.runOne()).toBe(true);
        expect(starts).toBe(1);
        expect(
          (yield* makeThreadVmProvisionStore(f.sql).get(f.intent.operationId))?.errorCode,
        ).toBe("startup_unconfirmed");
        expect((yield* f.placements.get(f.intent.threadId))?.generation).toBe(1);
        yield* f.sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.intent.operationId}`;
        lost = false;
        expect(yield* worker.runOne()).toBe(true);
        expect(starts).toBe(2);
        expect((yield* f.placements.getMove(f.intent)).phase).toBe("frozen");
        yield* f.sql`UPDATE relay_thread_vm_provisions SET retry_at=clock_timestamp() WHERE allocation_id=${f.intent.operationId}`;
        yield* f.placements.requestAbort(f.intent);
        expect(yield* worker.runOne()).toBe(false);
        expect(starts).toBe(2);
      }),
    );

    it.effect("removes a retired source VM only after destination activation", () =>
      Effect.gen(function* () {
        const f = yield* vmMoveFixture();
        yield* f.begin();
        yield* f.provision();
        const receipt = yield* f.bind();
        yield* f.destinations.assigned(receipt);
        const manifest = { sourceCursor: 1, manifestSha256: "a".repeat(64) };
        yield* makeThreadJournalStore(f.sql).confirmThrough({
          threadId: f.intent.threadId,
          environmentId: f.intent.sourceEnvironmentId,
          generation: 1,
          sourceSequence: 1,
        });
        yield* f.placements.sourceFrozen({
          ...f.intent,
          environmentId: f.intent.sourceEnvironmentId,
          generation: 1,
          ...manifest,
        });
        yield* f.placements.destinationReady({
          ...f.intent,
          environmentId: receipt.environmentId,
          ...manifest,
        });
        yield* publishMoveFixture(f.sql, f.intent);
        yield* f.placements.commitMove(f.intent);
        yield* f.placements.activated({
          ...f.intent,
          environmentId: receipt.environmentId,
          generation: 2,
        });
        const back = {
          ...f.intent,
          operationId: NodeCrypto.randomUUID(),
          sourceEnvironmentId: receipt.environmentId,
          expectedGeneration: 2,
          destinationEnvironmentId: f.intent.sourceEnvironmentId,
          destinationProjectId: "source-project",
        };
        yield* f.placements.beginMove(back);
        yield* makeThreadJournalStore(f.sql).confirmThrough({
          threadId: f.intent.threadId,
          environmentId: receipt.environmentId,
          generation: 2,
          sourceSequence: 2,
        });
        yield* f.placements.sourceFrozen({
          ...back,
          environmentId: receipt.environmentId,
          generation: 2,
          sourceCursor: 2,
          manifestSha256: "b".repeat(64),
        });
        yield* f.placements.destinationReady({
          ...back,
          environmentId: back.destinationEnvironmentId,
          sourceCursor: 2,
          manifestSha256: "b".repeat(64),
        });
        yield* publishMoveFixture(f.sql, back);
        yield* f.placements.commitMove(back);
        let deleted = 0;
        const cleanup = makeThreadVmMoveCleanupWorker(
          f.sql,
          {
            inspect: () =>
              Effect.fail(
                new ThreadVmComputeError({
                  operation: "inspect",
                  message: "Paused source readiness is unavailable",
                }),
              ),
            inspectCreation: (operationId) =>
              Effect.succeed({ operationId, computeRef: f.computeRef, metadata: f.metadata }),
            destroy: () =>
              Effect.sync(() => {
                deleted++;
              }),
          },
          f.intent.hostId,
        );
        expect(yield* cleanup.runOne()).toBe(false);
        expect(deleted).toBe(0);
        yield* f.placements.activated({
          ...back,
          environmentId: back.destinationEnvironmentId,
          generation: 3,
        });
        expect(yield* cleanup.runOne()).toBe(true);
        expect(deleted).toBe(1);
        expect((yield* f.allocations.get(f.intent.operationId))?.state).toBe("deleted");
        expect((yield* f.placements.get(f.intent.threadId))?.environmentId).toBe(
          back.destinationEnvironmentId,
        );
      }),
    );

    it.effect(
      "coordinates authenticated moves without granting either participant premature ownership",
      () =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const organizationId = NodeCrypto.randomUUID(),
            ownerUserId = NodeCrypto.randomUUID(),
            repositoryId = NodeCrypto.randomUUID();
          yield* (yield* Organizations.Organizations).ensureForUser({
            organizationId,
            userId: ownerUserId,
          });
          yield* sql`INSERT INTO relay_repositories (repository_id,organization_id,name,created_at,updated_at) VALUES (${repositoryId},${organizationId},'Moves','now','now')`;
          const environment = Effect.fnUntraced(function* () {
            const environmentId = NodeCrypto.randomUUID(),
              credentialId = NodeCrypto.randomUUID(),
              environmentPublicKey = NodeCrypto.randomUUID();
            yield* sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${credentialId},${environmentId},${environmentPublicKey},${credentialId},'now','now')`;
            yield* sql`INSERT INTO relay_environment_links (user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${ownerUserId},${environmentId},${environmentPublicKey},'https://test.invalid','wss://test.invalid','cloudflare','now','now')`;
            return { environmentId, credentialId, environmentPublicKey };
          });
          const source = yield* environment(),
            destination = yield* environment(),
            stranger = yield* environment();
          const store = makeThreadPlacementStore(sql),
            threadId = NodeCrypto.randomUUID(),
            operationId = NodeCrypto.randomUUID();
          yield* store.enroll({
            threadId,
            organizationId,
            repositoryId,
            ownerUserId,
            environmentId: source.environmentId,
            projectId: "source-project",
          });
          const src = { threadId, operationId, environmentId: source.environmentId, generation: 1 };
          const dst = {
            threadId,
            operationId,
            environmentId: destination.environmentId,
            generation: 2,
          };
          const asSource = Effect.provideService(RelayEnvironmentPrincipal, source),
            asDestination = Effect.provideService(RelayEnvironmentPrincipal, destination);
          const intent = {
            ...src,
            actorUserId: ownerUserId,
            destinationEnvironmentId: destination.environmentId,
            destinationProjectId: "destination-project",
          };
          const begun = yield* beginPortableThreadMove(intent).pipe(asSource);
          expect(begun).toMatchObject({ phase: "preparing", manifestArtifactId: null });
          expect(yield* beginPortableThreadMove(intent).pipe(asSource)).toEqual(begun);
          expect(
            yield* Effect.flip(
              beginPortableThreadMove({ ...intent, actorUserId: "another-owner" }).pipe(asSource),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          expect(
            yield* Effect.flip(
              getPortableThreadMove({ ...src, environmentId: stranger.environmentId }).pipe(
                Effect.provideService(RelayEnvironmentPrincipal, stranger),
              ),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          expect(
            yield* Effect.flip(
              getPortableThreadMove({ ...dst, generation: 1 }).pipe(asDestination),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          expect(
            yield* pendingPortableThreadMoves({
              environmentId: destination.environmentId,
              after: null,
              limit: 50,
            }).pipe(asDestination),
          ).toEqual({ entries: [begun], next: null });
          expect(yield* Effect.flip(store.admit({ ...src, workId: "too-late" }))).toMatchObject({
            _tag: "ThreadPlacementConflict",
          });
          const manifest = { sourceCursor: 31, manifestSha256: "a".repeat(64) };
          yield* makeThreadJournalStore(sql).confirmThrough({ ...src, sourceSequence: 31 });
          yield* freezePortableThreadMove({ ...src, ...manifest }).pipe(asSource);
          expect(
            yield* Effect.flip(readyPortableThreadMove({ ...src, ...manifest }).pipe(asSource)),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          yield* readyPortableThreadMove({ ...dst, ...manifest }).pipe(asDestination);
          expect(yield* Effect.flip(commitPortableThreadMove(src).pipe(asSource))).toMatchObject({
            _tag: "RelayTenancyConflictError",
          });
          yield* publishMoveFixture(sql, { threadId, operationId });
          yield* sql`UPDATE relay_environment_links SET revoked_at='now' WHERE environment_id=${destination.environmentId}`;
          expect(yield* Effect.flip(commitPortableThreadMove(src).pipe(asSource))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          expect((yield* store.get(threadId))?.generation).toBe(1);
          yield* sql`UPDATE relay_environment_links SET revoked_at=NULL WHERE environment_id=${destination.environmentId}`;
          const committed = yield* commitPortableThreadMove(src).pipe(asSource);
          expect(committed.phase).toBe("committed");
          expect(yield* commitPortableThreadMove(src).pipe(asSource)).toEqual(committed);
          expect((yield* store.get(threadId))?.generation).toBe(2);
          expect(yield* Effect.flip(abortPortableThreadMove(src).pipe(asSource))).toMatchObject({
            _tag: "RelayTenancyConflictError",
          });
          expect(yield* Effect.flip(activatePortableThreadMove(src).pipe(asSource))).toMatchObject({
            _tag: "RelayTenancyNotFoundError",
          });
          expect((yield* activatePortableThreadMove(dst).pipe(asDestination)).phase).toBe(
            "completed",
          );
          expect((yield* activatePortableThreadMove(dst).pipe(asDestination)).phase).toBe(
            "completed",
          );
          expect(
            yield* pendingPortableThreadMoves({
              environmentId: destination.environmentId,
              after: null,
              limit: 50,
            }).pipe(asDestination),
          ).toEqual({ entries: [], next: null });
          const returnId = NodeCrypto.randomUUID(),
            back = { ...dst, operationId: returnId },
            backTarget = { ...src, operationId: returnId, generation: 3 };
          yield* beginPortableThreadMove({
            ...back,
            actorUserId: ownerUserId,
            destinationEnvironmentId: source.environmentId,
            destinationProjectId: "source-project",
          }).pipe(asDestination);
          yield* abortPortableThreadMove(back).pipe(asDestination);
          expect(
            yield* Effect.flip(
              confirmPortableThreadMoveDestinationRemoved(back).pipe(asDestination),
            ),
          ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
          expect(
            (yield* confirmPortableThreadMoveDestinationRemoved(backTarget).pipe(asSource)).phase,
          ).toBe("aborted");
          expect((yield* store.get(threadId))?.environmentId).toBe(destination.environmentId);
          expect((yield* store.get(threadId))?.operationId).toBeNull();
          const cancelledId = NodeCrypto.randomUUID(),
            cancelSource = { ...back, operationId: cancelledId },
            cancelTarget = { ...backTarget, operationId: cancelledId };
          yield* beginPortableThreadMove({
            ...cancelSource,
            actorUserId: ownerUserId,
            destinationEnvironmentId: source.environmentId,
            destinationProjectId: "source-project",
          }).pipe(asDestination);
          const messageId = MessageId.make(NodeCrypto.randomUUID()),
            at = "2026-10-07T00:00:00Z";
          const event = yield* decodeMoveHistoryEvent({
            type: "thread.prompt-queue-changed",
            eventId: NodeCrypto.randomUUID(),
            sequence: 32,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              threadId,
              updatedAt: at,
              entry: {
                kind: "move",
                messageId,
                destination: {
                  kind: "environment",
                  environmentId: source.environmentId,
                  projectId: "source-project",
                },
                revision: 3,
                acceptedSequence: 30,
                createdAt: at,
                state: "moving",
                operationId: cancelledId,
              },
            },
          });
          yield* makeThreadJournalStore(sql).append({ ...cancelSource, event });
          yield* makeThreadJournalStore(sql).confirmThrough({
            ...cancelSource,
            sourceSequence: 32,
          });
          yield* freezePortableThreadMove({
            ...cancelSource,
            sourceCursor: 32,
            manifestSha256: "b".repeat(64),
          }).pipe(asDestination);
          const cancel = {
            type: "thread.move.cancel" as const,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: ThreadId.make(threadId),
            messageId,
            expectedRevision: 2,
            createdAt: at,
          };
          const asOwner = Effect.provideService(RelayClientPrincipal, {
            userId: ownerUserId,
            token: "test",
          });
          const directory = Effect.provideService(UserDirectory, {
            lookup: () => Effect.succeed(new Map()),
          });
          expect(
            (yield* stagePortableThreadCommand(threadId, cancel).pipe(asOwner, directory)).receipt,
          ).toBeNull();
          expect((yield* store.getMove(cancelSource)).phase).toBe("frozen");
          const matched = {
            ...cancel,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            expectedRevision: 3,
          };
          const staged = yield* stagePortableThreadCommand(threadId, matched).pipe(
            asOwner,
            directory,
          );
          expect(staged.receipt).toBeNull();
          expect((yield* store.getMove(cancelSource)).phase).toBe("aborting");
          expect(
            yield* stagePortableThreadCommand(threadId, matched).pipe(asOwner, directory),
          ).toEqual(staged);
          yield* confirmPortableThreadMoveDestinationRemoved(cancelTarget).pipe(asSource);
          expect((yield* store.get(threadId))?.generation).toBe(2);
        }),
    );

    it.effect("authorizes streamed artifacts before consumption and again after storage", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const organizations = yield* Organizations.Organizations;
        const organizationId = NodeCrypto.randomUUID(),
          ownerUserId = NodeCrypto.randomUUID(),
          repositoryId = NodeCrypto.randomUUID();
        const threadId = NodeCrypto.randomUUID(),
          environmentId = NodeCrypto.randomUUID(),
          credentialId = NodeCrypto.randomUUID();
        const environmentPublicKey = "artifact-test-key";
        yield* organizations.ensureForUser({ organizationId, userId: ownerUserId });
        yield* sql`INSERT INTO relay_repositories (repository_id, organization_id, name, created_at, updated_at) VALUES (${repositoryId},${organizationId},'Artifacts','now','now')`;
        yield* sql`INSERT INTO relay_environment_credentials (credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at) VALUES (${credentialId},${environmentId},${environmentPublicKey},${credentialId},'now','now')`;
        yield* sql`INSERT INTO relay_environment_links (user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES (${ownerUserId},${environmentId},${environmentPublicKey},'https://test.invalid','wss://test.invalid','cloudflare','now','now')`;
        yield* makeThreadPlacementStore(sql).enroll({
          threadId,
          environmentId,
          organizationId,
          ownerUserId,
          repositoryId,
          projectId: "project",
        });
        const principal = { environmentId, environmentPublicKey, credentialId };
        const asEnvironment = Effect.provideService(RelayEnvironmentPrincipal, principal);
        const bytes = new TextEncoder().encode("streamed checkpoint"),
          sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const input = {
          threadId,
          environmentId,
          generation: 1,
          artifactId: NodeCrypto.randomUUID(),
          operationId: NodeCrypto.randomUUID(),
          kind: "native" as const,
          sha256,
          sizeBytes: bytes.length,
          body: Stream.succeed(bytes),
        };
        const receipt = yield* uploadPortableThreadArtifact(input).pipe(asEnvironment);
        expect(receipt).toEqual({
          threadId,
          artifactId: input.artifactId,
          operationId: input.operationId,
          kind: "native",
          sha256,
          sizeBytes: bytes.length,
          state: "complete",
        });
        expect(yield* uploadPortableThreadArtifact(input).pipe(asEnvironment)).toEqual(receipt);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const routes = HttpApiBuilder.layer(
              HttpApi.make("RelayApi").add(RelayApi.groups.threadArtifacts),
            ).pipe(
              Layer.provide(threadArtifactsApi),
              Layer.provide(
                Layer.succeed(RelayEnvironmentAuth, {
                  environmentBearer: (effect) => effect.pipe(asEnvironment),
                }),
              ),
              Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
            );
            const httpEffect = yield* HttpRouter.toHttpEffect(routes).pipe(
              Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
            );
            const artifactId = NodeCrypto.randomUUID();
            const query = new URLSearchParams({
              generation: "1",
              operationId: input.operationId,
              kind: "native",
              sha256,
              sizeBytes: String(bytes.length),
            });
            const response = yield* httpEffect.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    `https://relay.test/v1/environments/${environmentId}/threads/${threadId}/artifacts/${artifactId}?${query}`,
                    {
                      method: "PUT",
                      headers: { "content-type": "application/octet-stream" },
                      body: bytes,
                    },
                  ),
                ),
              ),
            );
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).json())).toEqual({
              ...receipt,
              artifactId,
            });
            const rejected = yield* httpEffect.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    `https://relay.test/v1/environments/other/threads/${threadId}/artifacts/${NodeCrypto.randomUUID()}?${query}`,
                    { method: "PUT", body: bytes },
                  ),
                ),
              ),
            );
            expect(rejected.status).toBe(404);
          }),
        );

        let consumed = 0;
        const wrong = {
          ...input,
          artifactId: NodeCrypto.randomUUID(),
          generation: 2,
          body: Stream.succeed(bytes).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                consumed++;
              }),
            ),
          ),
        };
        expect(
          yield* Effect.flip(uploadPortableThreadArtifact(wrong).pipe(asEnvironment)),
        ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "thread_placement_changed" });
        expect(consumed).toBe(0);
        expect(yield* makeThreadArtifactStore(sql).get(wrong.artifactId)).toBeNull();
        const objects = yield* ThreadArtifactObjectStorage;
        const raced = { ...input, artifactId: NodeCrypto.randomUUID() };
        const revokedDuringPut = {
          ...objects,
          put: (upload: Parameters<typeof objects.put>[0]) =>
            objects
              .put(upload)
              .pipe(
                Effect.andThen(
                  sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${credentialId}`,
                ),
                Effect.asVoid,
              ),
        };
        expect(
          yield* Effect.flip(
            uploadPortableThreadArtifact(raced).pipe(
              asEnvironment,
              Effect.provideService(ThreadArtifactObjectStorage, revokedDuringPut),
            ),
          ),
        ).toMatchObject({ _tag: "RelayTenancyNotFoundError" });
        expect((yield* makeThreadArtifactStore(sql).get(raced.artifactId))?.state).toBe("pending");
        yield* sql`UPDATE relay_environment_credentials SET revoked_at=NULL WHERE credential_id=${credentialId}`;
        expect((yield* uploadPortableThreadArtifact(raced).pipe(asEnvironment)).state).toBe(
          "complete",
        );
        const stale = { ...input, artifactId: NodeCrypto.randomUUID() };
        const movedDuringPut = {
          ...objects,
          put: (upload: Parameters<typeof objects.put>[0]) =>
            objects
              .put(upload)
              .pipe(
                Effect.andThen(
                  sql`UPDATE relay_thread_placements SET generation=2 WHERE thread_id=${threadId}`,
                ),
                Effect.asVoid,
              ),
        };
        expect(
          yield* Effect.flip(
            uploadPortableThreadArtifact(stale).pipe(
              asEnvironment,
              Effect.provideService(ThreadArtifactObjectStorage, movedDuringPut),
            ),
          ),
        ).toMatchObject({ _tag: "RelayTenancyConflictError", reason: "thread_placement_changed" });
        expect((yield* makeThreadArtifactStore(sql).get(stale.artifactId))?.state).toBe("pending");
      }),
    );

    it.effect("keeps verified artifacts immutable and pinned across an uncertain deletion", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const { enrollment } = fixture();
        yield* run((store) => store.enroll(enrollment));
        const store = makeThreadArtifactStore(sql);
        const intent = {
          artifactId: NodeCrypto.randomUUID(),
          threadId: enrollment.threadId,
          operationId: NodeCrypto.randomUUID(),
          kind: "workspace" as const,
          sha256: "a".repeat(64),
          sizeBytes: 42,
        };
        expect((yield* store.begin(intent)).state).toBe("pending");
        expect((yield* store.begin(intent)).storageKey).toBe(
          `thread-artifacts/v1/${intent.artifactId}`,
        );
        expect(
          yield* Effect.flip(store.begin({ ...intent, sha256: "b".repeat(64) })),
        ).toMatchObject({ _tag: "ThreadArtifactConflict" });
        expect(
          yield* Effect.flip(
            store.complete({
              artifactId: intent.artifactId,
              sha256: "b".repeat(64),
              sizeBytes: 42,
              retentionDays: 30,
            }),
          ),
        ).toMatchObject({ _tag: "ThreadArtifactConflict" });
        yield* store.complete({
          artifactId: intent.artifactId,
          sha256: intent.sha256,
          sizeBytes: 42,
          retentionDays: 30,
        });
        const pin = NodeCrypto.randomUUID();
        yield* store.pin({
          artifactId: intent.artifactId,
          threadId: enrollment.threadId,
          operationId: pin,
        });
        yield* sql`UPDATE relay_thread_artifacts SET retention_until = clock_timestamp() - interval '1 day'
          WHERE artifact_id = ${intent.artifactId}`;
        expect(yield* store.claimExpired()).toBeNull();
        yield* store.releasePin({ artifactId: intent.artifactId, operationId: pin });
        const first = yield* store.claimExpired();
        expect(first).toMatchObject({ artifactId: intent.artifactId, state: "deleting" });
        expect(
          yield* Effect.flip(
            store.pin({
              artifactId: intent.artifactId,
              threadId: enrollment.threadId,
              operationId: pin,
            }),
          ),
        ).toMatchObject({ _tag: "ThreadArtifactConflict" });
        expect(yield* store.claimExpired()).toBeNull();
        yield* sql`UPDATE relay_thread_artifacts SET delete_claim_until = clock_timestamp() - interval '1 second'
          WHERE artifact_id = ${intent.artifactId}`;
        const second = yield* store.claimExpired();
        expect(second?.artifactId).toBe(intent.artifactId);
        expect(second?.claimId).not.toBe(first?.claimId);
        expect(
          yield* Effect.flip(
            store.confirmDeleted({
              artifactId: intent.artifactId,
              claimId: first!.claimId,
            }),
          ),
        ).toMatchObject({ _tag: "ThreadArtifactConflict" });
        yield* store.confirmDeleted({ artifactId: intent.artifactId, claimId: second!.claimId });
        expect((yield* store.get(intent.artifactId))?.state).toBe("deleted");
      }),
    );

    it.effect("expires a crashed read pin without expiring an operation pin", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const { enrollment } = fixture();
        yield* run((placements) => placements.enroll(enrollment));
        const store = makeThreadArtifactStore(sql);
        const intent = {
          artifactId: NodeCrypto.randomUUID(),
          threadId: enrollment.threadId,
          operationId: NodeCrypto.randomUUID(),
          kind: "native" as const,
          sha256: "c".repeat(64),
          sizeBytes: 1,
        };
        yield* store.begin(intent);
        yield* store.complete({
          artifactId: intent.artifactId,
          sha256: intent.sha256,
          sizeBytes: 1,
          retentionDays: 1,
        });
        const readId = NodeCrypto.randomUUID();
        const moveId = NodeCrypto.randomUUID();
        yield* store.pin({
          artifactId: intent.artifactId,
          threadId: intent.threadId,
          operationId: readId,
          leaseMinutes: 60,
        });
        yield* store.pin({
          artifactId: intent.artifactId,
          threadId: intent.threadId,
          operationId: moveId,
        });
        yield* sql`UPDATE relay_thread_artifacts SET retention_until = clock_timestamp() - interval '1 day'
          WHERE artifact_id = ${intent.artifactId}`;
        yield* sql`UPDATE relay_thread_artifact_pins SET expires_at = clock_timestamp() - interval '1 second'
          WHERE artifact_id = ${intent.artifactId} AND operation_id = ${readId}`;
        yield* store.expireReadPins();
        const pins = yield* sql<{ operationId: string }>`SELECT operation_id AS "operationId"
          FROM relay_thread_artifact_pins WHERE artifact_id = ${intent.artifactId}`;
        expect(pins).toEqual([{ operationId: moveId }]);
        expect(yield* store.claimExpired()).toBeNull();
        yield* store.releasePin({ artifactId: intent.artifactId, operationId: moveId });
        expect(yield* store.claimExpired()).toMatchObject({ artifactId: intent.artifactId });
      }),
    );

    it.effect("renews a retried read pin and never shortens a durable operation pin", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const { enrollment } = fixture();
        yield* run((placements) => placements.enroll(enrollment));
        const store = makeThreadArtifactStore(sql);
        const intent = {
          artifactId: NodeCrypto.randomUUID(),
          threadId: enrollment.threadId,
          operationId: NodeCrypto.randomUUID(),
          kind: "native" as const,
          sha256: "d".repeat(64),
          sizeBytes: 1,
        };
        yield* store.begin(intent);
        yield* store.complete({ ...intent, retentionDays: 1 });
        const pin = {
          artifactId: intent.artifactId,
          threadId: intent.threadId,
          operationId: NodeCrypto.randomUUID(),
        };
        yield* store.pin({ ...pin, leaseMinutes: 60 });
        yield* sql`UPDATE relay_thread_artifact_pins SET expires_at = clock_timestamp() - interval '1 second'
          WHERE artifact_id = ${pin.artifactId} AND operation_id = ${pin.operationId}`;
        yield* sql`UPDATE relay_thread_artifacts SET retention_until = clock_timestamp() - interval '1 day'
          WHERE artifact_id = ${intent.artifactId}`;
        yield* store.pin({ ...pin, leaseMinutes: 60 });
        expect(yield* store.claimExpired()).toBeNull();
        yield* store.expireReadPins();
        const [renewed] = yield* sql<{ active: boolean }>`SELECT
          expires_at > clock_timestamp() + interval '59 minutes' AS active
          FROM relay_thread_artifact_pins
          WHERE artifact_id = ${pin.artifactId} AND operation_id = ${pin.operationId}`;
        expect(renewed?.active).toBe(true);
        yield* store.pin({ ...pin, leaseMinutes: 1 });
        const [unchanged] = yield* sql<{ active: boolean }>`SELECT
          expires_at > clock_timestamp() + interval '59 minutes' AS active
          FROM relay_thread_artifact_pins
          WHERE artifact_id = ${pin.artifactId} AND operation_id = ${pin.operationId}`;
        expect(unchanged?.active).toBe(true);
        yield* store.pin(pin);
        yield* store.pin({ ...pin, leaseMinutes: 1 });
        const [durable] = yield* sql<{ durable: boolean }>`SELECT expires_at IS NULL AS durable
          FROM relay_thread_artifact_pins
          WHERE artifact_id = ${pin.artifactId} AND operation_id = ${pin.operationId}`;
        expect(durable?.durable).toBe(true);
        expect(yield* store.claimExpired()).toBeNull();
        yield* store.releasePin(pin);
        expect(yield* store.claimExpired()).toMatchObject({ artifactId: intent.artifactId });
      }),
    );

    it.effect("finishes an upload when the object was stored but the put reply was lost", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "launchpad-artifact-lost-put-" });
        return yield* Effect.gen(function* () {
          const { enrollment } = fixture();
          yield* run((placements) => placements.enroll(enrollment));
          const objects = makeLocalThreadArtifactObjects(fs, root);
          const catalog = makeThreadArtifactStore(sql);
          const bytes = new TextEncoder().encode("complete before timeout");
          const intent = {
            artifactId: NodeCrypto.randomUUID(),
            threadId: enrollment.threadId,
            operationId: NodeCrypto.randomUUID(),
            kind: "history" as const,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
            retentionDays: 1,
          };
          const artifact = yield* catalog.begin(intent);
          const body = () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            });
          yield* objects.put({ key: artifact.storageKey, sizeBytes: bytes.length, body: body() });
          const interrupted = makeThreadArtifactTransfer(sql, {
            ...objects,
            put: () => Effect.fail(new ThreadArtifactObjectError({ operation: "lost reply" })),
          });
          expect(yield* interrupted.upload({ ...intent, body: body() })).toMatchObject({
            artifactId: intent.artifactId,
            state: "complete",
          });
          const missing = { ...intent, artifactId: NodeCrypto.randomUUID() };
          expect(
            yield* Effect.flip(interrupted.upload({ ...missing, body: body() })),
          ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "missing" });
          expect((yield* catalog.get(missing.artifactId))?.state).toBe("pending");
        }).pipe(Effect.ensuring(fs.remove(root, { recursive: true }).pipe(Effect.ignore)));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    it.effect("rejects an uploaded move whose domain manifest is invalid", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "launchpad-move-artifacts-" });
        return yield* Effect.gen(function* () {
          const { enrollment, move, owner } = fixture();
          const placements = makeThreadPlacementStore(sql);
          yield* placements.enroll(enrollment);
          yield* placements.beginMove(move);
          const objects = makeLocalThreadArtifactObjects(fs, root);
          const transfer = makeThreadArtifactTransfer(sql, objects);
          const publication = makeThreadMoveArtifactStore(sql, objects);
          const sourceBytes = new TextEncoder().encode("frozen source manifest\n");
          const sourceSha = NodeCrypto.createHash("sha256").update(sourceBytes).digest("hex");
          yield* makeThreadJournalStore(sql).confirmThrough({ ...owner, sourceSequence: 31 });
          yield* placements.sourceFrozen({
            ...move,
            ...owner,
            sourceCursor: 31,
            manifestSha256: sourceSha,
          });
          const sourceArtifactId = NodeCrypto.randomUUID();
          const chunk = {
            artifactId: sourceArtifactId,
            sha256: sourceSha,
            sizeBytes: sourceBytes.length,
          };
          const manifest = {
            format: "launchpad-thread-chunks-v1" as const,
            threadId: enrollment.threadId,
            operationId: move.operationId,
            sourceEnvironmentId: move.sourceEnvironmentId,
            generation: move.expectedGeneration,
            transferManifestSha256: sourceSha,
            files: [
              {
                path: "manifest.json",
                sha256: sourceSha,
                sizeBytes: sourceBytes.length,
                chunks: [chunk],
              },
            ],
          };
          const manifestBytes = new TextEncoder().encode(encodeChunkManifest(manifest));
          const manifestArtifactId = NodeCrypto.randomUUID();
          const upload = (artifactId: string, kind: "manifest" | "history", bytes: Uint8Array) =>
            transfer.upload({
              artifactId,
              threadId: enrollment.threadId,
              operationId: move.operationId,
              kind,
              sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              sizeBytes: bytes.length,
              retentionDays: 1,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            });
          yield* upload(manifestArtifactId, "manifest", manifestBytes);
          expect(
            yield* Effect.flip(
              Stream.runCollect(
                publication.readPublished({
                  threadId: enrollment.threadId,
                  operationId: move.operationId,
                  artifactId: manifestArtifactId,
                }),
              ),
            ),
          ).toMatchObject({ _tag: "ThreadMoveArtifactConflict" });
          expect(
            yield* Effect.flip(
              publication.publish({
                threadId: enrollment.threadId,
                operationId: move.operationId,
                manifestArtifactId,
              }),
            ),
          ).toMatchObject({ _tag: "ThreadMoveArtifactConflict" });
          expect(yield* publication.get(move.operationId)).toBeNull();
          const [temporaryPins] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
            FROM relay_thread_artifact_pins WHERE artifact_id = ${manifestArtifactId}`;
          expect(temporaryPins?.count).toBe(0);
          yield* upload(sourceArtifactId, "manifest", sourceBytes);
          expect(
            yield* Effect.flip(
              publication.publish({
                threadId: enrollment.threadId,
                operationId: move.operationId,
                manifestArtifactId,
              }),
            ),
          ).toBeDefined();
          yield* placements.destinationReady({
            ...move,
            environmentId: "vm",
            sourceCursor: 31,
            manifestSha256: sourceSha,
          });
          expect(yield* Effect.flip(placements.commitMove(move))).toMatchObject({
            _tag: "ThreadPlacementConflict",
          });
          yield* placements.requestAbort(move);
          yield* placements.destinationRemoved(move);
          yield* publication.releasePins(move.operationId);
          yield* sql`UPDATE relay_thread_artifacts SET retention_until=clock_timestamp()-interval '1 day' WHERE thread_id=${enrollment.threadId}`;
          expect(
            yield* Effect.flip(
              Stream.runCollect(
                publication.readPublished({
                  threadId: enrollment.threadId,
                  operationId: move.operationId,
                  artifactId: sourceArtifactId,
                }),
              ),
            ),
          ).toMatchObject({ _tag: "ThreadMoveArtifactConflict" });
          expect(yield* transfer.collectOne()).toBe(true);
          expect(yield* transfer.collectOne()).toBe(true);
          expect(yield* transfer.collectOne()).toBe(false);
        }).pipe(Effect.ensuring(fs.remove(root, { recursive: true }).pipe(Effect.ignore)));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    it.effect("publishes only verified object bytes and physically removes expired artifacts", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "launchpad-transfer-test-" });
        const { enrollment } = fixture();
        yield* run((store) => store.enroll(enrollment));
        const transfer = makeThreadArtifactTransfer(sql, makeLocalThreadArtifactObjects(fs, root));
        const bytes = new TextEncoder().encode("saved conversation state");
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const intent = {
          artifactId: NodeCrypto.randomUUID(),
          threadId: enrollment.threadId,
          operationId: NodeCrypto.randomUUID(),
          kind: "native" as const,
          sha256,
          sizeBytes: bytes.length,
          retentionDays: 30,
        };
        const body = (data: Uint8Array) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(data);
              controller.close();
            },
          });
        const uploaded = yield* transfer.upload({ ...intent, body: body(bytes) });
        expect(uploaded.state).toBe("complete");
        yield* fs.writeFileString(`${root}/${intent.artifactId}`, "corrupted object");
        expect(
          yield* Effect.flip(
            transfer.readPinned({
              artifactId: intent.artifactId,
              threadId: intent.threadId,
              operationId: NodeCrypto.randomUUID(),
            }),
          ),
        ).toMatchObject({ _tag: "ThreadArtifactObjectError", operation: "checksum" });
        const [failedReadPins] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
          FROM relay_thread_artifact_pins WHERE artifact_id = ${intent.artifactId}`;
        expect(failedReadPins?.count).toBe(0);
        yield* fs.writeFile(`${root}/${intent.artifactId}`, bytes);
        const readOperationId = NodeCrypto.randomUUID();
        const stream = yield* transfer.readPinned({
          artifactId: intent.artifactId,
          threadId: intent.threadId,
          operationId: readOperationId,
        });
        expect(
          Array.from(yield* Stream.runCollect(stream)).flatMap((chunk) => Array.from(chunk)),
        ).toEqual(Array.from(bytes));
        yield* sql`UPDATE relay_thread_artifacts SET retention_until = clock_timestamp() - interval '1 day'
          WHERE artifact_id = ${intent.artifactId}`;
        expect(yield* transfer.collectOne()).toBe(false);
        yield* transfer.releasePin({ artifactId: intent.artifactId, operationId: readOperationId });
        expect(yield* transfer.collectOne()).toBe(true);
        expect((yield* makeThreadArtifactStore(sql).get(intent.artifactId))?.state).toBe("deleted");
        const bad = { ...intent, artifactId: NodeCrypto.randomUUID(), sha256: "0".repeat(64) };
        expect(yield* Effect.flip(transfer.upload({ ...bad, body: body(bytes) }))).toMatchObject({
          _tag: "ThreadArtifactObjectError",
          operation: "checksum",
        });
        expect((yield* makeThreadArtifactStore(sql).get(bad.artifactId))?.state).toBe("pending");
        yield* sql`UPDATE relay_thread_artifacts SET created_at = clock_timestamp() - interval '2 days'
          WHERE artifact_id = ${bad.artifactId}`;
        expect(yield* transfer.collectOne()).toBe(true);
        expect((yield* makeThreadArtifactStore(sql).get(bad.artifactId))?.state).toBe("deleted");
        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    it.effect("retries an artifact delete whose storage reply was lost", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "launchpad-delete-test-" });
        const { enrollment } = fixture();
        yield* run((store) => store.enroll(enrollment));
        const local = makeLocalThreadArtifactObjects(fs, root);
        let loseReply = true;
        const transfer = makeThreadArtifactTransfer(sql, {
          ...local,
          remove: (key: string) =>
            local.remove(key).pipe(
              Effect.flatMap(() => {
                if (loseReply) {
                  loseReply = false;
                  return Effect.fail(new ThreadArtifactObjectError({ operation: "lost reply" }));
                }
                return Effect.void;
              }),
            ),
        });
        const bytes = new TextEncoder().encode("retained");
        const artifactId = NodeCrypto.randomUUID();
        yield* transfer.upload({
          artifactId,
          threadId: enrollment.threadId,
          operationId: NodeCrypto.randomUUID(),
          kind: "history",
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
          retentionDays: 30,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        });
        yield* sql`UPDATE relay_thread_artifacts SET retention_until = clock_timestamp() - interval '1 day'
          WHERE artifact_id = ${artifactId}`;
        expect(yield* transfer.collectOne()).toBe(true);
        expect((yield* makeThreadArtifactStore(sql).get(artifactId))?.state).toBe("deleting");
        yield* sql`UPDATE relay_thread_artifacts SET retry_at = clock_timestamp()
          WHERE artifact_id = ${artifactId}`;
        expect(yield* transfer.collectOne()).toBe(true);
        expect((yield* makeThreadArtifactStore(sql).get(artifactId))?.state).toBe("deleted");
        yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  });
});
