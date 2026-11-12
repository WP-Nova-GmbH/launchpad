import * as NodeCrypto from "node:crypto";
import { ThreadId } from "@t3tools/contracts";
import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import type { ThreadTransferFormat } from "@t3tools/contracts/threadTransferFormat";
import { THREAD_TRANSFER_SUPPORTED_FORMATS } from "@t3tools/shared/threadTransferEncoding";
import { describe, expect, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import {
  pendingPortableThreadMoves,
  selectPortableThreadMoveEncoding,
} from "../http/ThreadMovesApi.ts";
import { makeLocalThreadArtifactObjects } from "./ThreadArtifactLocalObjects.ts";
import { ThreadArtifactObjectStorage } from "./ThreadArtifactObjects.ts";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmReplacementCoordinator } from "./ThreadVmReplacementCoordinator.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const services = Layer.effect(
  ThreadArtifactObjectStorage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return makeLocalThreadArtifactObjects(
      fs,
      yield* fs.makeTempDirectoryScoped({ prefix: "encoding-objects-" }),
    );
  }),
).pipe(
  Layer.provideMerge(
    Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
      Layer.provideMerge(nativeCheckpointCatalogTestLayer),
    ),
  ),
);
const fixture = Effect.fnUntraced(function* (
  formats?: readonly ThreadTransferFormat[],
  begin = true,
) {
  const sql = yield* PgClient.PgClient;
  const threadId = NodeCrypto.randomUUID(),
    owner = NodeCrypto.randomUUID(),
    organizationId = NodeCrypto.randomUUID(),
    repositoryId = NodeCrypto.randomUUID();
  yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES(${organizationId},'Encoding','now','now')`;
  yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES(${organizationId},${owner},'admin','now','now')`;
  yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES(${repositoryId},${organizationId},'Encoding','now','now')`;
  const source = {
    environmentId: NodeCrypto.randomUUID(),
    credentialId: NodeCrypto.randomUUID(),
    environmentPublicKey: NodeCrypto.randomUUID(),
  };
  const destination = {
    environmentId: NodeCrypto.randomUUID(),
    credentialId: NodeCrypto.randomUUID(),
    environmentPublicKey: NodeCrypto.randomUUID(),
  };
  for (const environment of [source, destination]) {
    yield* sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
      VALUES(${environment.credentialId},${environment.environmentId},${environment.environmentPublicKey},${environment.credentialId},'now','now')`;
    yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
      VALUES(${owner},${environment.environmentId},${environment.environmentPublicKey},'https://encoding.invalid','wss://encoding.invalid','cloudflare','now','now')`;
  }
  const store = makeThreadPlacementStore(sql);
  yield* store.enroll({
    threadId,
    environmentId: source.environmentId,
    projectId: "source",
    organizationId,
    repositoryId,
    ownerUserId: owner,
  });
  const intent = {
    threadId,
    operationId: NodeCrypto.randomUUID(),
    actorUserId: owner,
    sourceEnvironmentId: source.environmentId,
    expectedGeneration: 1,
    destinationEnvironmentId: destination.environmentId,
    destinationProjectId: "destination",
  };
  if (begin)
    yield* store.beginMove({
      ...intent,
      ...(formats === undefined ? {} : { sourceThreadTransferFormats: formats }),
    });
  const input = {
    threadId,
    operationId: intent.operationId,
    environmentId: source.environmentId,
    generation: 1,
  };
  const noNetwork = EnvironmentConnector.of({
    resolveAccess: () => Effect.die("Format selection must not depend on a public endpoint"),
    status: () => Effect.die("Format selection must not depend on a public endpoint"),
    connect: () => Effect.die("Format selection must not connect an environment"),
    dispatchJob: () => Effect.die("Format selection must not dispatch work"),
  });
  const call = () =>
    selectPortableThreadMoveEncoding(input).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, source),
      Effect.provideService(EnvironmentConnector, noNetwork),
    );
  const poll = (
    principal: typeof destination = destination,
    threadTransferFormats:
      | readonly ThreadTransferFormat[]
      | undefined = THREAD_TRANSFER_SUPPORTED_FORMATS,
    requestedEnvironmentId = principal.environmentId,
  ) =>
    pendingPortableThreadMoves({
      environmentId: requestedEnvironmentId,
      after: null,
      limit: 50,
      ...(threadTransferFormats === undefined ? {} : { threadTransferFormats }),
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provideService(EnvironmentConnector, noNetwork),
    );
  return {
    sql,
    store,
    intent,
    source,
    destination,
    input,
    owner,
    organizationId,
    repositoryId,
    call,
    poll,
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "immutable transfer encoding (Postgres)",
  () => {
    layer(services)((it) => {
      it.effect(
        "defaults legacy moves exactly and freezes modern offers and the selected policy",
        () =>
          Effect.gen(function* () {
            const legacy = yield* fixture();
            expect((yield* legacy.store.getMove(legacy.intent)).transferEncodingPolicy).toBe(
              "v1-64MiB",
            );
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            expect((yield* f.store.getMove(f.intent)).transferEncodingPolicy).toBeNull();
            yield* f.store.beginMove({
              ...f.intent,
              sourceThreadTransferFormats: THREAD_TRANSFER_SUPPORTED_FORMATS.toReversed(),
            });
            expect(
              (yield* Effect.flip(
                f.store.beginMove({
                  ...f.intent,
                  sourceThreadTransferFormats: ["launchpad-thread-chunks-v1"],
                }),
              ))._tag,
            ).toBe("ThreadPlacementConflict");
            expect(
              (yield* f.store.selectEncoding({
                ...f.intent,
                destinationThreadTransferFormats: THREAD_TRANSFER_SUPPORTED_FORMATS,
              })).transferEncodingPolicy,
            ).toBe("workspace-raw-v2-8MiB");
            expect(
              (yield* f.store.selectEncoding({
                ...f.intent,
                destinationThreadTransferFormats: ["launchpad-thread-chunks-v1"],
              })).transferEncodingPolicy,
            ).toBe("workspace-raw-v2-8MiB");
            expect(
              (yield* makeThreadPlacementStore(f.sql).getMove(f.intent)).transferEncodingPolicy,
            ).toBe("workspace-raw-v2-8MiB");
          }),
      );
      it.effect(
        "uses v1 for legacy receivers and rejects incompatible offers without selecting",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            expect(
              (yield* f.store.selectEncoding({
                ...f.intent,
                destinationThreadTransferFormats: ["launchpad-thread-chunks-v1"],
              })).transferEncodingPolicy,
            ).toBe("v1-64MiB");
            const incompatible = yield* fixture(["launchpad-thread-chunks-v2"]);
            yield* Effect.flip(
              incompatible.store.selectEncoding({
                ...incompatible.intent,
                destinationThreadTransferFormats: ["launchpad-thread-chunks-v1"],
              }),
            );
            expect(
              (yield* incompatible.store.getMove(incompatible.intent)).transferEncodingPolicy,
            ).toBeNull();
          }),
      );
      it.effect("uses the authenticated destination poll without a public endpoint", () =>
        Effect.gen(function* () {
          const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
          // The destination's stale public hostname cannot be used by the managed connector.
          yield* f.sql`UPDATE relay_environment_links SET endpoint_http_base_url='https://old.example.invalid',
            endpoint_ws_base_url='wss://old.example.invalid/ws' WHERE environment_id=${f.destination.environmentId}`;
          expect((yield* f.call()).transferEncodingPolicy).toBeNull();
          expect((yield* f.poll(f.source)).entries[0]?.transferEncodingPolicy).toBeNull();
          const selected = yield* f.poll();
          expect(selected.entries[0]).toMatchObject({
            threadId: f.intent.threadId,
            operationId: f.intent.operationId,
            destinationEnvironmentId: f.destination.environmentId,
            transferEncodingPolicy: "workspace-raw-v2-8MiB",
          });
          expect((yield* f.call()).transferEncodingPolicy).toBe("workspace-raw-v2-8MiB");
          expect(
            (yield* f.poll(f.destination, ["launchpad-thread-chunks-v1"])).entries[0]
              ?.transferEncodingPolicy,
          ).toBe("workspace-raw-v2-8MiB");
        }),
      );
      it.effect("uses the legacy v1 receiver contract when a destination poll omits formats", () =>
        Effect.gen(function* () {
          const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
          const selected = yield* pendingPortableThreadMoves({
            environmentId: f.destination.environmentId,
            after: null,
            limit: 50,
          }).pipe(Effect.provideService(RelayEnvironmentPrincipal, f.destination));
          expect(selected.entries[0]?.transferEncodingPolicy).toBe("v1-64MiB");
        }),
      );
      it.effect("keeps authenticated guest enrollment authoritative over guest poll claims", () =>
        Effect.gen(function* () {
          const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
          const allocationId = NodeCrypto.randomUUID();
          yield* f.sql`INSERT INTO relay_thread_vm_allocations
            (allocation_id,thread_id,organization_id,owner_user_id,template_id,compute_ref,state)
            VALUES(${allocationId},${f.intent.threadId},${f.organizationId},${f.owner},'template',${`vm-${allocationId}`},'running')`;
          yield* f.sql`INSERT INTO relay_thread_vm_bindings
            (environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
            VALUES(${f.destination.environmentId},${allocationId},${f.intent.threadId},${f.repositoryId},2,
              ${f.destination.environmentPublicKey},${f.destination.credentialId})`;
          yield* f.sql`INSERT INTO relay_thread_vm_move_destinations(operation_id,allocation_id)
            VALUES(${f.intent.operationId},${allocationId})`;
          yield* f.sql`INSERT INTO relay_thread_vm_enrollments
            (allocation_id,operation_id,seed_hash,expires_at,environment_id,environment_public_key,sealed_response,credential_id,thread_transfer_formats_json)
            VALUES(${allocationId},${f.intent.operationId},${NodeCrypto.randomUUID()},'2100-01-01',
              ${f.destination.environmentId},${f.destination.environmentPublicKey},'private fixture',${f.destination.credentialId},
              '["launchpad-thread-chunks-v1"]'::jsonb)`;
          const guest = {
            ...f.destination,
            threadVm: {
              allocationId,
              threadId: ThreadId.make(f.intent.threadId),
              repositoryId: f.repositoryId,
              generation: 2,
            },
          };
          expect((yield* f.poll(guest)).entries[0]?.transferEncodingPolicy).toBeNull();
          expect((yield* f.call()).transferEncodingPolicy).toBe("v1-64MiB");
          expect((yield* f.poll(guest)).entries[0]?.transferEncodingPolicy).toBe("v1-64MiB");
        }),
      );
      for (const change of ["credential", "grant", "destination", "owner"] as const)
        it.effect(`a receiver poll cannot choose a policy after its ${change} changes`, () =>
          Effect.gen(function* () {
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            if (change === "credential")
              yield* f.sql`UPDATE relay_environment_credentials SET revoked_at='now' WHERE credential_id=${f.destination.credentialId}`;
            if (change === "grant")
              yield* f.sql`UPDATE relay_environment_links SET revoked_at='now' WHERE user_id=${f.owner} AND environment_id=${f.destination.environmentId}`;
            if (change === "destination")
              yield* f.sql`UPDATE relay_thread_moves SET destination_environment_id='different-destination' WHERE operation_id=${f.intent.operationId}`;
            if (change === "owner")
              yield* f.sql`DELETE FROM relay_organization_members WHERE user_id=${f.owner}`;
            expect((yield* f.poll()).entries).toEqual([]);
            expect((yield* f.store.getMove(f.intent)).transferEncodingPolicy).toBeNull();
          }),
        );
      it.effect(
        "rejects a principal naming another receiver and ignores unrelated credentials",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            const failure = yield* Effect.flip(
              f.poll(f.source, THREAD_TRANSFER_SUPPORTED_FORMATS, f.destination.environmentId),
            );
            expect(failure._tag).toBe("RelayTenancyNotFoundError");
            const unrelated = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            expect(
              (yield* f.poll(unrelated.destination)).entries.some(
                (entry) => entry.threadId === f.intent.threadId,
              ),
            ).toBe(false);
            expect((yield* f.store.getMove(f.intent)).transferEncodingPolicy).toBeNull();
          }),
      );
      for (const phase of ["ready", "committed", "aborting"] as const)
        it.effect(`does not renegotiate an existing ${phase} move during discovery`, () =>
          Effect.gen(function* () {
            const f = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
            yield* f.sql`UPDATE relay_thread_moves SET phase=${phase},source_cursor=0,manifest_sha256=${"a".repeat(64)}
              WHERE operation_id=${f.intent.operationId}`;
            if (phase === "committed")
              yield* f.sql`UPDATE relay_thread_placements SET environment_id=${f.destination.environmentId},generation=2
                WHERE thread_id=${f.intent.threadId}`;
            const result = yield* f.poll();
            expect(result.entries[0]?.phase).toBe(phase);
            expect((yield* f.store.getMove(f.intent)).transferEncodingPolicy).toBeNull();
          }),
        );
      it.effect("reports incompatible receiver formats without starving other incoming moves", () =>
        Effect.gen(function* () {
          const incompatible = yield* fixture(["launchpad-thread-chunks-v2"]);
          const compatible = yield* fixture(THREAD_TRANSFER_SUPPORTED_FORMATS);
          // Both moves share one real authenticated receiving environment.
          yield* compatible.sql`UPDATE relay_thread_moves SET destination_environment_id=${incompatible.destination.environmentId}
            WHERE operation_id=${compatible.intent.operationId}`;
          yield* compatible.sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at)
            VALUES(${compatible.owner},${incompatible.destination.environmentId},${incompatible.destination.environmentPublicKey},
              'https://old.invalid','wss://old.invalid','manual','now','now')`;
          const received = yield* incompatible.poll(incompatible.destination, [
            "launchpad-thread-chunks-v1",
          ]);
          expect(received.entries).toHaveLength(2);
          expect(
            received.entries.find((entry) => entry.threadId === incompatible.intent.threadId),
          ).toMatchObject({
            transferEncodingPolicy: null,
            failureDetail:
              "The source and destination do not share a supported transfer format. Update the destination or cancel this move.",
          });
          expect(
            received.entries.find((entry) => entry.threadId === compatible.intent.threadId)
              ?.transferEncodingPolicy,
          ).toBe("v1-64MiB");
        }),
      );
      it.effect("compares quota-waiting move offers as immutable capability sets", () =>
        Effect.gen(function* () {
          for (const legacy of [false, true]) {
            const f = yield* fixture(undefined, false);
            const coordinator = makeThreadVmReplacementCoordinator(
              f.sql,
              yield* ThreadArtifactObjectStorage,
            );
            const request = {
              requestId: f.intent.operationId,
              threadId: f.intent.threadId,
              organizationId: f.organizationId,
              repositoryId: f.repositoryId,
              ownerUserId: f.owner,
              hostId: NodeCrypto.randomUUID(),
              templateId: "template",
              intent: {
                kind: "move" as const,
                ...f.intent,
                sourceCredentialId: f.source.credentialId,
                sourcePublicKey: f.source.environmentPublicKey,
                sourceAllocationId: null,
                ...(legacy
                  ? {}
                  : { sourceThreadTransferFormats: THREAD_TRANSFER_SUPPORTED_FORMATS }),
              },
            };
            yield* coordinator.record(request);
            yield* coordinator.record({
              ...request,
              intent: {
                ...request.intent,
                sourceThreadTransferFormats: legacy
                  ? ["launchpad-thread-chunks-v1"]
                  : THREAD_TRANSFER_SUPPORTED_FORMATS.toReversed(),
              },
            });
            expect(
              (yield* Effect.flip(
                coordinator.record({
                  ...request,
                  intent: {
                    ...request.intent,
                    sourceThreadTransferFormats: legacy
                      ? THREAD_TRANSFER_SUPPORTED_FORMATS
                      : ["launchpad-thread-chunks-v1"],
                  },
                }),
              ))._tag,
            ).toBe("ThreadVmReplacementConflict");
          }
        }),
      );
    });
  },
);
