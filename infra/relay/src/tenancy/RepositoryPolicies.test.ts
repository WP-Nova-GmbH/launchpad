import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { REPOSITORY_POLICY_ACK_TYPE } from "@t3tools/contracts";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { acknowledge, status } from "./RepositoryPolicies.ts";

const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
// A row-store double keeps this protocol test independent of a running Postgres.
// Actual table/trigger execution remains a deployment migration integration check.
it.effect(
  "keeps offline and legacy environments pending until signed monotonic acknowledgements arrive",
  () =>
    Effect.gen(function* () {
      let revision = 3;
      const applied = new Map([
        ["online", 0],
        ["offline", 0],
        ["legacy", 0],
      ]);
      const sql = Object.assign(
        (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
          Effect.sync(() => {
            const statement = strings.join("?");
            if (statement.startsWith("SELECT revision")) return [{ revision }];
            if (statement.startsWith("SELECT DISTINCT environment_id"))
              return [...applied]
                .filter(([, value]) => value < Number(values[1]))
                .map(([environmentId]) => ({ environmentId }));
            if (statement.startsWith("UPDATE relay_repository_policy_acknowledgements")) {
              const next = Number(values[0]),
                environmentId = String(values[1]);
              if (!applied.has(environmentId) || next > revision || values[2] !== "org") return [];
              applied.set(environmentId, Math.max(applied.get(environmentId)!, next));
              return [{ environment_id: environmentId }];
            }
            throw new Error(`Unexpected policy query: ${statement}`);
          }),
        { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
      ) as unknown as RelayDb["Service"]["$client"];
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const ack = Effect.fn(function* (
        environmentId: string,
        next: number,
        signedEnvironmentId = environmentId,
      ) {
        const proof = yield* signRelayJwt({
          privateKey: keys.privateKey,
          typ: REPOSITORY_POLICY_ACK_TYPE,
          payload: {
            iss: `t3-env:${environmentId}`,
            aud: "https://relay.example",
            sub: environmentId,
            jti: `${environmentId}-${next}`,
            iat: now,
            exp: now + 120,
            environmentId: signedEnvironmentId,
            organizationId: "org",
            revision: next,
          },
        });
        return yield* acknowledge({
          environmentId,
          organizationId: "org",
          publicKey: keys.publicKey,
          ack: { revision: next, proof },
        });
      });
      yield* Effect.gen(function* () {
        expect(yield* status("org")).toEqual({
          revision: 3,
          status: "pending",
          pendingEnvironmentIds: ["online", "offline", "legacy"],
        });
        expect(yield* ack("online", 3)).toBe(true);
        expect((yield* status("org")).pendingEnvironmentIds).toEqual(["offline", "legacy"]);
        expect(yield* ack("offline", 3, "other")).toBe(false);
        expect(yield* ack("offline", 99)).toBe(false);
        expect(yield* ack("offline", 3)).toBe(true);
        expect(yield* ack("legacy", 3)).toBe(true);
        expect((yield* status("org")).status).toBe("completed");
        expect(yield* ack("online", 1)).toBe(true);
        expect(applied.get("online")).toBe(3);
        // A newly activated environment participates in this same generation and
        // cannot inherit an earlier process's acknowledgement.
        revision = 4;
        applied.set("activated", 0);
        expect((yield* status("org")).pendingEnvironmentIds).toEqual([
          "online",
          "offline",
          "legacy",
          "activated",
        ]);
      }).pipe(
        Effect.provide(Layer.succeed(RelayDb, { $client: sql } as unknown as RelayDb["Service"])),
        Effect.provide(
          Layer.succeed(RelayConfiguration, {
            relayIssuer: "https://relay.example",
          } as RelayConfiguration["Service"]),
        ),
      );
    }),
);
