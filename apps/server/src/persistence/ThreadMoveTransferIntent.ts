import { ThreadTransferEncodingPolicy, ThreadTransferFormats } from "@t3tools/contracts/relay";
import { normalizeThreadTransferFormats } from "@t3tools/shared/threadTransferEncoding";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const intentSchema = Schema.Struct({
  operationId: Schema.String,
  threadId: Schema.String,
  environmentId: Schema.String,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sourceThreadTransferFormats: Schema.fromJsonString(ThreadTransferFormats),
  transferEncodingPolicy: Schema.NullOr(ThreadTransferEncodingPolicy),
  manifestSha256: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});
const decodeIntent = Schema.decodeUnknownEffect(intentSchema);
const encodeFormats = Schema.encodeSync(Schema.fromJsonString(ThreadTransferFormats));
type Identity = Pick<
  typeof intentSchema.Type,
  "operationId" | "threadId" | "environmentId" | "generation"
>;

export class ThreadMoveTransferIntentError extends Schema.TaggedError<ThreadMoveTransferIntentError>()(
  "ThreadMoveTransferIntentError",
  { message: Schema.String },
) {}
const changed = () =>
  new ThreadMoveTransferIntentError({
    message:
      "This move's saved transfer encoding or source changed. Cancel the move and start a new one.",
  });

/** Source offers survive lost begin replies; selected bytes and policy never change on retry. */
export function makeThreadMoveTransferIntent(sql: SqlClient.SqlClient) {
  const get = Effect.fnUntraced(function* (owner: Identity) {
    const [row] = yield* sql`SELECT operation_id AS "operationId",thread_id AS "threadId",
      environment_id AS "environmentId",generation,source_formats_json AS "sourceThreadTransferFormats",
      encoding_policy AS "transferEncodingPolicy",manifest_sha256 AS "manifestSha256"
      FROM thread_move_transfer_intents WHERE operation_id=${owner.operationId}`;
    if (!row) return null;
    const intent = yield* decodeIntent(row).pipe(Effect.mapError(changed));
    if (
      intent.threadId !== owner.threadId ||
      intent.environmentId !== owner.environmentId ||
      intent.generation !== owner.generation
    )
      return yield* changed();
    return intent;
  });
  const create = Effect.fnUntraced(function* (owner: Identity, formats: ThreadTransferFormats) {
    const canonical = normalizeThreadTransferFormats(formats);
    yield* sql`INSERT INTO thread_move_transfer_intents
      (operation_id,thread_id,environment_id,generation,source_formats_json,encoding_policy)
      VALUES(${owner.operationId},${owner.threadId},${owner.environmentId},${owner.generation},
        ${encodeFormats(canonical)},${canonical.includes("launchpad-thread-chunks-v2") ? null : "v1-64MiB"})
      ON CONFLICT(operation_id) DO NOTHING`;
    return (yield* get(owner))!;
  });
  const bind = Effect.fnUntraced(function* (
    owner: Identity,
    policy: ThreadTransferEncodingPolicy,
    sha256: string,
  ) {
    yield* sql`UPDATE thread_move_transfer_intents SET encoding_policy=${policy},manifest_sha256=${sha256}
      WHERE operation_id=${owner.operationId} AND thread_id=${owner.threadId}
        AND environment_id=${owner.environmentId} AND generation=${owner.generation}
        AND (encoding_policy IS NULL OR encoding_policy=${policy})
        AND (manifest_sha256 IS NULL OR manifest_sha256=${sha256})`;
    const intent = yield* get(owner);
    if (!intent || intent.transferEncodingPolicy !== policy || intent.manifestSha256 !== sha256)
      return yield* changed();
    return intent;
  });
  return { get, create, bind };
}
