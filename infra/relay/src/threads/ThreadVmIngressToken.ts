import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelaySecretBox } from "../auth/SecretBox.ts";

const identityFields = {
  allocationId: Schema.NonEmptyString,
  computeRef: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
};
const identitySchema = Schema.Struct(identityFields);
export type ThreadVmTrafficAccessTokenIdentity = typeof identitySchema.Type;
const envelopeSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), ...identityFields, token: Schema.NonEmptyString }),
);
const encodeEnvelope = Schema.encodeEffect(envelopeSchema);
const decodeEnvelope = Schema.decodeUnknownEffect(envelopeSchema);

export class ThreadVmIngressTokenUnavailable extends Schema.TaggedError<ThreadVmIngressTokenUnavailable>()(
  "ThreadVmIngressTokenUnavailable",
  {},
) {
  override get message() {
    return "The private VM routing credential is unavailable.";
  }
}

export const sealThreadVmTrafficAccessToken = Effect.fnUntraced(
  function* (identity: ThreadVmTrafficAccessTokenIdentity, token: Redacted.Redacted<string>) {
    const box = yield* RelaySecretBox;
    return yield* box.seal(
      yield* encodeEnvelope({ version: 1, ...identity, token: Redacted.value(token) }),
    );
  },
  Effect.mapError(() => new ThreadVmIngressTokenUnavailable()),
);

/** Native GET cannot recover this credential. Missing or invalid storage never wakes compute. */
export const readThreadVmTrafficAccessToken = Effect.fnUntraced(
  function* (sql: PgClient, identity: ThreadVmTrafficAccessTokenIdentity) {
    const [row] = yield* sql<{ sealed: string | null }>`
      SELECT sealed_traffic_access_token AS sealed FROM relay_thread_vm_allocations
      WHERE allocation_id = ${identity.allocationId} AND thread_id = ${identity.threadId} AND runtime_protocol='native-v1'
        AND compute_ref = ${identity.computeRef} AND state = 'running' AND deleted_at IS NULL`;
    if (!row?.sealed) return yield* new ThreadVmIngressTokenUnavailable();
    const box = yield* RelaySecretBox;
    // Binding belongs inside the authenticated ciphertext: SecretBox has no AAD.
    const envelope = yield* decodeEnvelope(yield* box.open(row.sealed));
    if (
      envelope.allocationId !== identity.allocationId ||
      envelope.computeRef !== identity.computeRef ||
      envelope.operationId !== identity.operationId ||
      envelope.threadId !== identity.threadId ||
      envelope.generation !== identity.generation
    )
      return yield* new ThreadVmIngressTokenUnavailable();
    return Redacted.make(envelope.token);
  },
  Effect.mapError(() => new ThreadVmIngressTokenUnavailable()),
);
