import type { RelayThreadVmEnrollmentReceipt } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelaySecretBox } from "../auth/SecretBox.ts";

export class ThreadVmEnrollmentInvalid extends Schema.TaggedError<ThreadVmEnrollmentInvalid>()(
  "ThreadVmEnrollmentInvalid",
  {},
) {
  override get message() {
    return "VM enrollment is unavailable or no longer authorized.";
  }
}
interface Enrollment {
  readonly allocationId: string;
  readonly operationId: string;
  readonly seedHash: string;
  readonly sealedSeed: string | null;
  readonly environmentId: string | null;
  readonly environmentPublicKey: string | null;
  readonly sealedResponse: string | null;
  readonly credentialId: string | null;
  readonly expired: boolean;
  readonly installed: boolean;
}

/** Internal store. The caller verifies the signed proof and current owner access before exchange. */
export function makeThreadVmEnrollmentStore(sql: PgClient) {
  const hash = Effect.fnUntraced(function* (value: Redacted.Redacted<string>) {
    const crypto = yield* Crypto.Crypto;
    return yield* crypto
      .digest("SHA-256", new TextEncoder().encode(Redacted.value(value)))
      .pipe(Effect.map(Encoding.encodeBase64Url));
  });
  const get = Effect.fnUntraced(function* (allocationId: string) {
    const [row] =
      yield* sql<Enrollment>`SELECT allocation_id AS "allocationId", operation_id AS "operationId", seed_hash AS "seedHash",
      sealed_seed AS "sealedSeed", environment_id AS "environmentId", environment_public_key AS "environmentPublicKey",
      sealed_response AS "sealedResponse", credential_id AS "credentialId", expires_at <= clock_timestamp() AS expired, installed_at IS NOT NULL AS installed
      FROM relay_thread_vm_enrollments WHERE allocation_id = ${allocationId}`;
    return row ?? null;
  });
  const lockAllocation = Effect.fnUntraced(function* (input: {
    allocationId: string;
    operationId: string;
  }) {
    const rows = yield* sql`SELECT a.allocation_id FROM relay_thread_vm_allocations a
      JOIN relay_thread_vm_provisions p USING (allocation_id)
      WHERE a.allocation_id = ${input.allocationId} AND p.operation_id = ${input.operationId}
      AND p.phase = 'created' AND a.state = 'running' AND a.deleted_at IS NULL AND a.compute_ref IS NOT NULL FOR UPDATE OF a`;
    if (!rows.length) return yield* new ThreadVmEnrollmentInvalid();
    // Read after the allocation lock is acquired: an exchange already waiting on
    // that lock must see a recovery fence committed by the stop worker.
    const recovering = yield* sql`SELECT 1 FROM relay_thread_vm_restores
      WHERE allocation_id=${input.allocationId} AND operation_id=${input.operationId}
        AND boot_recovery_started_at IS NOT NULL`;
    if (recovering.length) return yield* new ThreadVmEnrollmentInvalid();
  });
  const prepare = Effect.fn("relay.thread_vm_enrollment.prepare")(function* (input: {
    allocationId: string;
    operationId: string;
  }) {
    const box = yield* RelaySecretBox;
    const crypto = yield* Crypto.Crypto;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockAllocation(input);
        const prior = yield* get(input.allocationId);
        if (prior) {
          if (prior.operationId !== input.operationId || !prior.sealedSeed || prior.installed)
            return yield* new ThreadVmEnrollmentInvalid();
          if (!prior.expired || prior.environmentId !== null)
            return Redacted.make(yield* box.open(prior.sealedSeed));
        }
        const seed = Redacted.make(Encoding.encodeBase64Url(yield* crypto.randomBytes(32)));
        const seedHash = yield* hash(seed);
        const sealedSeed = yield* box.seal(Redacted.value(seed));
        if (prior) {
          // An unused expired seed can be replaced under the allocation lock. Never
          // rotate a consumed seed: a lost exchange reply must recover its identity.
          yield* sql`UPDATE relay_thread_vm_enrollments SET seed_hash = ${seedHash}, sealed_seed = ${sealedSeed},
            expires_at = clock_timestamp() + interval '15 minutes' WHERE allocation_id = ${input.allocationId}`;
        } else {
          yield* sql`INSERT INTO relay_thread_vm_enrollments (allocation_id, operation_id, seed_hash, sealed_seed, expires_at)
            VALUES (${input.allocationId}, ${input.operationId}, ${seedHash}, ${sealedSeed}, clock_timestamp() + interval '15 minutes')`;
        }
        return seed;
      }),
    );
  });
  const exchange = <E, R>(
    input: {
      allocationId: string;
      operationId: string;
      seed: Redacted.Redacted<string>;
      environmentId: string;
      environmentPublicKey: string;
    },
    issue: Effect.Effect<{ credentialId: string; response: Redacted.Redacted<string> }, E, R>,
  ) =>
    Effect.gen(function* () {
      const box = yield* RelaySecretBox;
      const seedHash = yield* hash(input.seed);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockAllocation(input);
          const row = yield* get(input.allocationId);
          if (!row || row.operationId !== input.operationId || row.seedHash !== seedHash)
            return yield* new ThreadVmEnrollmentInvalid();
          const requireLiveBinding = (credentialId: string) =>
            Effect.gen(function* () {
              const live =
                yield* sql`SELECT b.environment_id FROM relay_thread_vm_bindings b JOIN relay_environment_credentials c ON c.credential_id = b.credential_id
          WHERE b.allocation_id = ${input.allocationId} AND b.environment_id = ${input.environmentId} AND b.environment_public_key = ${input.environmentPublicKey}
          AND b.credential_id = ${credentialId} AND b.revoked_at IS NULL AND c.revoked_at IS NULL FOR SHARE OF b, c`;
              if (!live.length) return yield* new ThreadVmEnrollmentInvalid();
            });
          if (row.environmentId !== null) {
            if (
              row.environmentId !== input.environmentId ||
              row.environmentPublicKey !== input.environmentPublicKey ||
              !row.sealedResponse ||
              !row.credentialId
            )
              return yield* new ThreadVmEnrollmentInvalid();
            // A consumed seed can recover its own response after expiry, but never
            // revive a revoked identity or switch to another environment/key.
            yield* requireLiveBinding(row.credentialId);
            return Redacted.make(yield* box.open(row.sealedResponse));
          }
          if (row.expired) return yield* new ThreadVmEnrollmentInvalid();
          const issued = yield* issue;
          yield* requireLiveBinding(issued.credentialId);
          const sealedResponse = yield* box.seal(Redacted.value(issued.response));
          yield* sql`UPDATE relay_thread_vm_enrollments SET environment_id = ${input.environmentId}, environment_public_key = ${input.environmentPublicKey},
        sealed_response = ${sealedResponse}, credential_id = ${issued.credentialId} WHERE allocation_id = ${input.allocationId}`;
          return issued.response;
        }),
      );
    });
  const confirmInstalled = Effect.fn("relay.thread_vm_enrollment.confirm_installed")(function* (
    receipt: RelayThreadVmEnrollmentReceipt,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockAllocation(receipt);
        const rows = yield* sql`SELECT b.environment_id FROM relay_thread_vm_enrollments e
        JOIN relay_thread_vm_bindings b ON b.allocation_id = e.allocation_id AND b.credential_id = e.credential_id
        JOIN relay_environment_credentials c ON c.credential_id = b.credential_id
        WHERE e.allocation_id = ${receipt.allocationId} AND e.operation_id = ${receipt.operationId}
        AND e.environment_id = ${receipt.environmentId} AND b.environment_id = e.environment_id
        AND b.environment_public_key = e.environment_public_key AND b.thread_id = ${receipt.threadId}
        AND b.generation = ${receipt.generation} AND b.revoked_at IS NULL AND c.revoked_at IS NULL FOR SHARE OF b, c`;
        if (!rows.length) return yield* new ThreadVmEnrollmentInvalid();
        // Keep the encrypted seed until the guest confirms durable local installation.
        // Otherwise a relay restart after exchange but before delivery loses retryability.
        yield* sql`UPDATE relay_thread_vm_enrollments SET installed_at = COALESCE(installed_at, clock_timestamp()), sealed_seed = NULL
        WHERE allocation_id = ${receipt.allocationId}`;
      }),
    );
  });
  return { prepare, exchange, confirmInstalled };
}
