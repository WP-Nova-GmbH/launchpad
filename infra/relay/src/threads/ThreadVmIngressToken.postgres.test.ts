import { describe, expect, layer } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import * as SecretBox from "../auth/SecretBox.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import {
  readThreadVmTrafficAccessToken,
  sealThreadVmTrafficAccessToken,
  ThreadVmIngressTokenUnavailable,
  type ThreadVmTrafficAccessTokenIdentity,
} from "./ThreadVmIngressToken.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(
  nativeCheckpointCatalogTestLayer,
  SecretBox.layer.pipe(
    Layer.provide(
      Layer.succeed(RelayConfiguration, {
        relayIssuer: "https://relay.test",
        apns: null,
        clerkSecretKey: Redacted.make("clerk"),
        clerkPublishableKey: "public",
        clerkJwtAudience: "relay",
        apnsDeliveryJobSigningSecret: Redacted.make("push"),
        cloudMintPrivateKey: Redacted.make("private-ingress-test-key"),
        cloudMintPublicKey: "public",
        managedEndpointBaseDomain: undefined,
        managedEndpointNamespace: undefined,
      }),
    ),
  ),
);

const fixture = Effect.fnUntraced(function* () {
  const sql = yield* PgClient.PgClient;
  const allocationId = NodeCrypto.randomUUID();
  const identity = {
    allocationId,
    computeRef: `sandbox-${allocationId}`,
    operationId: NodeCrypto.randomUUID(),
    threadId: NodeCrypto.randomUUID(),
    generation: 3,
  };
  yield* sql`INSERT INTO relay_thread_placements
    (thread_id,organization_id,repository_id,owner_user_id,environment_id,project_id)
    VALUES (${identity.threadId},'org','repo','user','environment','project')`;
  yield* sql`INSERT INTO relay_thread_vm_allocations
    (allocation_id,thread_id,organization_id,owner_user_id,template_id,state)
    VALUES (${allocationId},${identity.threadId},'org','user','template','creating')`;
  const store = makeThreadVmAllocationStore(sql);
  return { sql, identity, store };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)("VM ingress token storage", () => {
  layer(testLayer)((it) => {
    it.effect(
      "records ID and ciphertext together, preserves same-ID retries and clears on deletion",
      () =>
        Effect.gen(function* () {
          const { sql, identity, store } = yield* fixture();
          const token = "private-routing-token-never-stored-plain";
          const sealed = yield* sealThreadVmTrafficAccessToken(identity, Redacted.make(token));
          const recorded = yield* store.recordCreated({
            allocationId: identity.allocationId,
            computeRef: identity.computeRef,
            sealedTrafficAccessToken: sealed,
          });
          expect(recorded).toMatchObject({ computeRef: identity.computeRef, state: "running" });
          expect(recorded).not.toHaveProperty("sealedTrafficAccessToken");
          const [row] = yield* sql<{ sealed: string }>`SELECT sealed_traffic_access_token AS sealed
          FROM relay_thread_vm_allocations WHERE allocation_id=${identity.allocationId}`;
          expect(row?.sealed).toBe(sealed);
          expect(row?.sealed).not.toContain(token);
          expect(Redacted.value(yield* readThreadVmTrafficAccessToken(sql, identity))).toBe(token);
          yield* store
            .recordCreated({
              ...identity,
              computeRef: "another-sandbox",
              sealedTrafficAccessToken: "replacement-must-not-be-written",
            })
            .pipe(Effect.flip);
          expect(Redacted.value(yield* readThreadVmTrafficAccessToken(sql, identity))).toBe(token);
          yield* store.recordCreated(identity);
          expect(Redacted.value(yield* readThreadVmTrafficAccessToken(sql, identity))).toBe(token);
          yield* store.requestDeletion(identity.allocationId);
          expect(
            yield* readThreadVmTrafficAccessToken(sql, identity).pipe(Effect.flip),
          ).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
          yield* store.confirmDeleted(identity);
          const [deleted] = yield* sql<{
            sealed: string | null;
          }>`SELECT sealed_traffic_access_token AS sealed
          FROM relay_thread_vm_allocations WHERE allocation_id=${identity.allocationId}`;
          expect(deleted?.sealed).toBeNull();
        }),
    );

    it.effect(
      "quarantines a legacy running VM without exposing or deleting its stored routing credential",
      () =>
        Effect.gen(function* () {
          const { sql, identity, store } = yield* fixture();
          const sealed = yield* sealThreadVmTrafficAccessToken(
            identity,
            Redacted.make("preserved-legacy-secret"),
          );
          yield* store.recordCreated({ ...identity, sealedTrafficAccessToken: sealed });
          yield* sql`UPDATE relay_thread_vm_allocations SET runtime_protocol='legacy' WHERE allocation_id=${identity.allocationId}`;
          expect(
            yield* readThreadVmTrafficAccessToken(sql, identity).pipe(Effect.flip),
          ).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
          const [row] = yield* sql<{
            sealed: string;
          }>`SELECT sealed_traffic_access_token AS sealed FROM relay_thread_vm_allocations WHERE allocation_id=${identity.allocationId}`;
          expect(row?.sealed).toBe(sealed);
        }),
    );

    it.effect(
      "rejects missing, swapped, stale-generation and tampered credentials with stable errors",
      () =>
        Effect.gen(function* () {
          const { sql, identity, store } = yield* fixture();
          yield* store.recordCreated(identity);
          const unavailable = (expected: ThreadVmTrafficAccessTokenIdentity = identity) =>
            readThreadVmTrafficAccessToken(sql, expected).pipe(Effect.flip);
          expect(yield* unavailable()).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
          const sealed = yield* sealThreadVmTrafficAccessToken(identity, Redacted.make("secret"));
          yield* store.recordCreated({ ...identity, sealedTrafficAccessToken: sealed });
          for (const changed of [
            { ...identity, allocationId: "other" },
            { ...identity, computeRef: "other" },
            { ...identity, operationId: "other" },
            { ...identity, threadId: "other" },
            { ...identity, generation: 4 },
          ]) {
            expect(yield* unavailable(changed)).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
          }
          const swapped = yield* sealThreadVmTrafficAccessToken(
            { ...identity, operationId: "another-operation" },
            Redacted.make("private-swapped-token"),
          );
          const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
          for (const invalid of [swapped, tampered]) {
            yield* sql`UPDATE relay_thread_vm_allocations SET sealed_traffic_access_token=${invalid}
            WHERE allocation_id=${identity.allocationId}`;
            const error = yield* unavailable();
            expect(error).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
            expect(encodeJson(error)).not.toContain("private-swapped-token");
          }
          yield* sql`UPDATE relay_thread_vm_allocations SET state='paused',sealed_traffic_access_token=${sealed}
          WHERE allocation_id=${identity.allocationId}`;
          expect(yield* unavailable()).toBeInstanceOf(ThreadVmIngressTokenUnavailable);
        }),
    );
  });
});
