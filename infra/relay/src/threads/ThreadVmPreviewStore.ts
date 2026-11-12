import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ThreadVmPreviewDenied extends Schema.TaggedError<ThreadVmPreviewDenied>()(
  "ThreadVmPreviewDenied",
  {},
) {}
export interface ThreadVmPreviewGrant {
  readonly previewId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly port: number;
}
const columns = `preview_id AS "previewId", user_id AS "userId", thread_id AS "threadId",
  allocation_id AS "allocationId", generation, port`;
/** One-use links exchange for host-only sessions. Neither ticket nor session secrets are stored. */
export function makeThreadVmPreviewStore(sql: PgClient) {
  const issue = Effect.fn("relay.thread_vm.preview.issue")(function* (
    grant: ThreadVmPreviewGrant & { ticketSha256: string },
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Bound forgotten grants without maintaining an in-memory session registry.
        yield* sql`SELECT thread_id FROM relay_thread_placements WHERE thread_id=${grant.threadId} FOR UPDATE`;
        yield* sql`DELETE FROM relay_thread_vm_previews WHERE thread_id=${grant.threadId} AND expires_at <= clock_timestamp()`;
        const [count] = yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM relay_thread_vm_previews
        WHERE thread_id=${grant.threadId} AND user_id=${grant.userId}`;
        if ((count?.count ?? 0) >= 24) return yield* new ThreadVmPreviewDenied();
        yield* sql`INSERT INTO relay_thread_vm_previews
        (preview_id,user_id,thread_id,allocation_id,generation,port,ticket_sha256)
        VALUES(${grant.previewId},${grant.userId},${grant.threadId},${grant.allocationId},${grant.generation},${grant.port},${grant.ticketSha256})`;
      }),
    );
  });
  const ticket = Effect.fn("relay.thread_vm.preview.ticket")(function* (
    previewId: string,
    sha: string,
  ) {
    const [grant] =
      yield* sql<ThreadVmPreviewGrant>`SELECT ${sql.literal(columns)} FROM relay_thread_vm_previews
      WHERE preview_id=${previewId} AND ticket_sha256=${sha} AND session_sha256 IS NULL
        AND ticket_expires_at > clock_timestamp() AND expires_at > clock_timestamp()`;
    if (!grant) return yield* new ThreadVmPreviewDenied();
    return grant;
  });
  const claim = Effect.fn("relay.thread_vm.preview.claim")(function* (
    previewId: string,
    ticketSha: string,
    sessionSha: string,
  ) {
    const [grant] =
      yield* sql<ThreadVmPreviewGrant>`UPDATE relay_thread_vm_previews SET session_sha256=${sessionSha}
      WHERE preview_id=${previewId} AND ticket_sha256=${ticketSha} AND session_sha256 IS NULL
        AND ticket_expires_at > clock_timestamp() AND expires_at > clock_timestamp()
      RETURNING ${sql.literal(columns)}`;
    if (!grant) return yield* new ThreadVmPreviewDenied();
    return grant;
  });
  const session = Effect.fn("relay.thread_vm.preview.session")(function* (
    previewId: string,
    sha: string,
  ) {
    const [grant] =
      yield* sql<ThreadVmPreviewGrant>`SELECT ${sql.literal(columns)} FROM relay_thread_vm_previews
      WHERE preview_id=${previewId} AND session_sha256=${sha} AND expires_at > clock_timestamp()`;
    if (!grant) return yield* new ThreadVmPreviewDenied();
    return grant;
  });
  return { issue, ticket, claim, session };
}
