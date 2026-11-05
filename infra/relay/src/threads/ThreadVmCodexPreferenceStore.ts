import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  CodexVmConnectionError,
  type RelayThreadVmCodexAuthSelection,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ThreadVmCodexPreferenceConflict extends Schema.TaggedError<ThreadVmCodexPreferenceConflict>()(
  "ThreadVmCodexPreferenceConflict",
  { message: Schema.String },
) {}

/** Callers hold the private thread's placement lock; this metadata never grants guest access. */
export function makeThreadVmCodexPreferenceStore(sql: PgClient) {
  const read = Effect.fn("relay.vm_codex_preference.read")(function* (input: {
    threadId: string;
    organizationId: string;
  }) {
    const [row] = yield* sql<{
      revision: bigint;
      mode: "personal" | "organization" | null;
      connectionId: string | null;
    }>`SELECT revision,mode,connection_id AS "connectionId" FROM relay_thread_vm_codex_preferences
      WHERE thread_id=${input.threadId} AND organization_id=${input.organizationId}`;
    return {
      revision: Number(row?.revision ?? 0),
      selection: !row?.mode
        ? null
        : row.mode === "personal"
          ? { mode: "personal" as const }
          : { mode: "organization" as const, connectionId: row.connectionId! },
    };
  });
  const validate = Effect.fn("relay.vm_codex_preference.validate")(function* (
    organizationId: string,
    selection: RelayThreadVmCodexAuthSelection | null,
  ) {
    if (selection?.mode !== "organization") return;
    const rows = yield* sql`SELECT connection_id FROM relay_codex_vm_connections
      WHERE organization_id=${organizationId} AND connection_id=${selection.connectionId}
      AND status='connected' FOR SHARE`;
    if (!rows.length) return yield* new CodexVmConnectionError({ reason: "not_connected" });
  });
  const save = Effect.fn("relay.vm_codex_preference.save")(function* (
    input: { threadId: string; organizationId: string; expectedRevision?: number },
    selection: RelayThreadVmCodexAuthSelection | null,
  ) {
    const previous = yield* read(input);
    if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision)
      return yield* new ThreadVmCodexPreferenceConflict({
        message: "The saved VM account changed.",
      });
    yield* validate(input.organizationId, selection);
    const [row] = yield* sql<{ revision: bigint }>`INSERT INTO relay_thread_vm_codex_preferences
      (thread_id,organization_id,revision,mode,connection_id)
      VALUES(${input.threadId},${input.organizationId},1,${selection?.mode ?? null},${selection?.mode === "organization" ? selection.connectionId : null})
      ON CONFLICT(thread_id) DO UPDATE SET revision=relay_thread_vm_codex_preferences.revision+1,
        mode=excluded.mode,connection_id=excluded.connection_id
      WHERE relay_thread_vm_codex_preferences.organization_id=excluded.organization_id
        AND relay_thread_vm_codex_preferences.revision=${previous.revision}
      RETURNING revision`;
    if (!row)
      return yield* new ThreadVmCodexPreferenceConflict({
        message: "The saved VM account changed.",
      });
    return { revision: Number(row.revision), selection };
  });
  return { read, save };
}
