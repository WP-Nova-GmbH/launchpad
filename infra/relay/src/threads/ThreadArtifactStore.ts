import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ThreadArtifactConflict extends Schema.TaggedError<ThreadArtifactConflict>()(
  "ThreadArtifactConflict",
  { message: Schema.String },
) {}
const conflict = (message: string) => new ThreadArtifactConflict({ message });

export type ThreadArtifactKind = "workspace" | "native" | "attachment" | "history" | "manifest";
export interface ThreadArtifact {
  readonly artifactId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly kind: ThreadArtifactKind;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly state: "pending" | "complete" | "deleting" | "deleted";
}

/** The key is server-derived. A caller cannot point an artifact at another object's bytes. */
export function makeThreadArtifactStore(sql: PgClient) {
  const get = Effect.fn("relay.thread_artifact.get")(function* (artifactId: string) {
    const [row] = yield* sql<ThreadArtifact>`SELECT artifact_id AS "artifactId",
      thread_id AS "threadId", operation_id AS "operationId", kind,
      storage_key AS "storageKey", sha256, size_bytes::int AS "sizeBytes", state
      FROM relay_thread_artifacts WHERE artifact_id = ${artifactId}`;
    return row ?? null;
  });

  const begin = Effect.fn("relay.thread_artifact.begin")(function* (input: {
    readonly artifactId: string;
    readonly threadId: string;
    readonly operationId: string;
    readonly kind: ThreadArtifactKind;
    readonly sha256: string;
    readonly sizeBytes: number;
  }) {
    if (
      !/^[0-9a-f-]{36}$/u.test(input.artifactId) ||
      !/^[0-9a-f]{64}$/u.test(input.sha256) ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > 64 * 1024 * 1024 ||
      !["workspace", "native", "attachment", "history", "manifest"].includes(input.kind)
    )
      return yield* conflict("Invalid artifact intent");
    const storageKey = `thread-artifacts/v1/${input.artifactId}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR SHARE`;
        if (
          (yield* sql`SELECT 1 FROM relay_thread_deletions WHERE thread_id=${input.threadId}`)
            .length
        )
          return yield* conflict("Thread was permanently deleted");
        yield* sql`INSERT INTO relay_thread_artifacts
        (artifact_id,thread_id,operation_id,kind,storage_key,sha256,size_bytes,state)
        VALUES (${input.artifactId},${input.threadId},${input.operationId},${input.kind},
          ${storageKey},${input.sha256},${input.sizeBytes},'pending')
        ON CONFLICT (artifact_id) DO NOTHING`;
        const artifact = yield* get(input.artifactId);
        if (
          !artifact ||
          artifact.threadId !== input.threadId ||
          artifact.operationId !== input.operationId ||
          artifact.kind !== input.kind ||
          artifact.sha256 !== input.sha256 ||
          artifact.sizeBytes !== input.sizeBytes ||
          artifact.storageKey !== storageKey ||
          artifact.state === "deleted"
        )
          return yield* conflict("Artifact ID reused with different intent");
        return artifact;
      }),
    );
  });

  /** Call only after re-reading the temporary object and hashing its full stream. */
  const complete = Effect.fn("relay.thread_artifact.complete")(function* (input: {
    readonly artifactId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly retentionDays: number | null;
  }) {
    if (
      input.retentionDays !== null &&
      (!Number.isSafeInteger(input.retentionDays) ||
        input.retentionDays < 1 ||
        input.retentionDays > 3650)
    )
      return yield* conflict("Invalid artifact retention");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [artifact] = yield* sql<ThreadArtifact>`SELECT artifact_id AS "artifactId",
        thread_id AS "threadId", operation_id AS "operationId", kind,
        storage_key AS "storageKey", sha256, size_bytes::int AS "sizeBytes", state
        FROM relay_thread_artifacts WHERE artifact_id = ${input.artifactId} FOR UPDATE`;
        if (
          !artifact ||
          artifact.sha256 !== input.sha256 ||
          artifact.sizeBytes !== input.sizeBytes ||
          !["pending", "complete"].includes(artifact.state)
        )
          return yield* conflict("Artifact bytes or state do not match the intent");
        if (artifact.state === "pending") {
          yield* sql`UPDATE relay_thread_artifacts SET state = 'complete',
          completed_at = clock_timestamp(),
          retention_until = CASE WHEN ${input.retentionDays}::int IS NULL THEN NULL
            ELSE clock_timestamp() + make_interval(days => ${input.retentionDays}::int) END
          WHERE artifact_id = ${input.artifactId}`;
        }
        return { ...artifact, state: "complete" as const };
      }),
    );
  });

  const pin = Effect.fn("relay.thread_artifact.pin")(function* (input: {
    readonly artifactId: string;
    readonly threadId: string;
    readonly operationId: string;
    readonly leaseMinutes?: number;
  }) {
    if (
      input.leaseMinutes !== undefined &&
      (!Number.isSafeInteger(input.leaseMinutes) ||
        input.leaseMinutes < 1 ||
        input.leaseMinutes > 60)
    )
      return yield* conflict("Invalid artifact read lease");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [artifact] = yield* sql<ThreadArtifact>`SELECT artifact_id AS "artifactId",
        thread_id AS "threadId", operation_id AS "operationId", kind,
        storage_key AS "storageKey", sha256, size_bytes::int AS "sizeBytes", state
        FROM relay_thread_artifacts WHERE artifact_id = ${input.artifactId} FOR UPDATE`;
        if (!artifact || artifact.threadId !== input.threadId || artifact.state !== "complete")
          return yield* conflict("Artifact is not available for this thread");
        yield* sql`INSERT INTO relay_thread_artifact_pins (artifact_id,operation_id,expires_at)
        VALUES (${input.artifactId},${input.operationId},
          CASE WHEN ${input.leaseMinutes ?? null}::int IS NULL THEN NULL
            ELSE clock_timestamp() + make_interval(mins => ${input.leaseMinutes ?? null}::int) END)
        ON CONFLICT (artifact_id,operation_id) DO UPDATE SET expires_at =
          CASE WHEN relay_thread_artifact_pins.expires_at IS NULL OR EXCLUDED.expires_at IS NULL
            THEN NULL
            ELSE GREATEST(relay_thread_artifact_pins.expires_at,EXCLUDED.expires_at) END`;
        return artifact;
      }),
    );
  });

  /** A bounded upload may still finish after audience revocation. Keep its object
   * pinned until the network effect settles; a crashed worker's lease expires. */
  const pinUpload = Effect.fn("relay.thread_artifact.pin_upload")(function* (input: {
    readonly artifactId: string;
    readonly threadId: string;
    readonly operationId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${input.threadId} FOR SHARE`;
        const deleted =
          yield* sql`SELECT 1 FROM relay_thread_deletions WHERE thread_id=${input.threadId}`;
        if (deleted.length) return yield* conflict("Thread was permanently deleted");
        const rows =
          yield* sql`SELECT 1 FROM relay_thread_artifacts WHERE artifact_id=${input.artifactId} AND thread_id=${input.threadId} AND state IN ('pending','complete') FOR UPDATE`;
        if (!rows.length) return yield* conflict("Artifact is not writable for this thread");
        yield* sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id,expires_at) VALUES(${input.artifactId},${input.operationId},clock_timestamp()+interval '1 hour')`;
      }),
    );
  });
  const releasePin = Effect.fn("relay.thread_artifact.release_pin")(function* (input: {
    readonly artifactId: string;
    readonly operationId: string;
  }) {
    yield* sql`DELETE FROM relay_thread_artifact_pins
      WHERE artifact_id = ${input.artifactId} AND operation_id = ${input.operationId}`;
  });

  /** An interrupted reader cannot leave a permanent pin. Durable operation pins have no expiry. */
  const expireReadPins = Effect.fn("relay.thread_artifact.expire_read_pins")(function* () {
    yield* sql`DELETE FROM relay_thread_artifact_pins
      WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp()`;
  });

  /** A deleting row keeps its object key so a lost storage reply is retried. */
  const claimExpired = Effect.fn("relay.thread_artifact.claim_expired")(function* (
    threadId?: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [candidate] = yield* sql<ThreadArtifact>`SELECT artifact_id AS "artifactId",
        thread_id AS "threadId", operation_id AS "operationId", kind,
        storage_key AS "storageKey", sha256, size_bytes::int AS "sizeBytes", state
        FROM relay_thread_artifacts a
        WHERE (${threadId ?? null}::text IS NULL OR a.thread_id = ${threadId ?? null})
          AND (a.state = 'deleting' OR
          (a.state = 'pending' AND a.created_at < clock_timestamp() - interval '1 day') OR
          (a.state = 'complete' AND a.retention_until <= clock_timestamp()))
          AND a.retry_at <= clock_timestamp()
          AND (a.delete_claim_until IS NULL OR a.delete_claim_until <= clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM relay_thread_artifact_pins p
            WHERE p.artifact_id = a.artifact_id
              AND (p.expires_at IS NULL OR p.expires_at > clock_timestamp()))
        ORDER BY a.created_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED`;
        if (!candidate) return null;
        const claimId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        yield* sql`UPDATE relay_thread_artifacts SET state = 'deleting',
        delete_claim_id = ${claimId},
        delete_claim_until = clock_timestamp() + interval '2 minutes'
        WHERE artifact_id = ${candidate.artifactId}`;
        return { ...candidate, state: "deleting" as const, claimId };
      }),
    );
  });

  const confirmDeleted = Effect.fn("relay.thread_artifact.confirm_deleted")(function* (input: {
    readonly artifactId: string;
    readonly claimId: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [artifact] = yield* sql<{ state: string; claimId: string | null }>`SELECT state,
        delete_claim_id AS "claimId" FROM relay_thread_artifacts
        WHERE artifact_id = ${input.artifactId} FOR UPDATE`;
        if (!artifact || artifact.state === "deleted") return;
        if (artifact.state !== "deleting" || artifact.claimId !== input.claimId)
          return yield* conflict("Artifact deletion claim changed");
        const pins = yield* sql`SELECT 1 FROM relay_thread_artifact_pins
        WHERE artifact_id = ${input.artifactId}
          AND (expires_at IS NULL OR expires_at > clock_timestamp())`;
        if (pins.length) return yield* conflict("Artifact became pinned during deletion");
        yield* sql`UPDATE relay_thread_artifacts SET state = 'deleted',
        deleted_at = clock_timestamp(), delete_claim_id = NULL, delete_claim_until = NULL
        WHERE artifact_id = ${input.artifactId}`;
      }),
    );
  });

  const deferDelete = Effect.fn("relay.thread_artifact.defer_delete")(function* (input: {
    readonly artifactId: string;
    readonly claimId: string;
  }) {
    yield* sql`UPDATE relay_thread_artifacts SET delete_claim_id = NULL,
      delete_claim_until = NULL, retry_at = clock_timestamp() + interval '1 minute'
      WHERE artifact_id = ${input.artifactId} AND state = 'deleting'
        AND delete_claim_id = ${input.claimId}`;
  });

  return {
    get,
    begin,
    complete,
    pin,
    pinUpload,
    releasePin,
    expireReadPins,
    claimExpired,
    confirmDeleted,
    deferDelete,
  };
}
