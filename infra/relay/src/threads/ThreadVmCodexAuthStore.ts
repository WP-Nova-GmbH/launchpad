import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  CodexVmConnectionError,
  type RelayThreadVmCodexAuthSelection,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { makeCodexVmConnections } from "../tenancy/CodexVmConnections.ts";

export interface ThreadVmCodexAuthIdentity {
  readonly allocationId: string;
  readonly environmentId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly organizationId: string;
}
const unavailable = () => new CodexVmConnectionError({ reason: "source_unavailable" });

/** Callers own placement/binding authorization. Rows retain removed account IDs instead of falling back. */
export function makeThreadVmCodexAuthStore(sql: PgClient) {
  const accounts = makeCodexVmConnections(sql);
  const exact = Effect.fn("relay.vm_codex_auth.exact")(function* (
    input: ThreadVmCodexAuthIdentity,
  ) {
    const [row] = yield* sql<{
      mode: "personal" | "organization";
      connectionId: string | null;
    }>`SELECT mode,connection_id AS "connectionId"
      FROM relay_thread_vm_codex_auth WHERE allocation_id=${input.allocationId} AND environment_id=${input.environmentId}
      AND generation=${input.generation} AND thread_id=${input.threadId} AND organization_id=${input.organizationId} FOR SHARE`;
    return row
      ? row.mode === "personal"
        ? { mode: "personal" as const }
        : { mode: "organization" as const, connectionId: row.connectionId! }
      : null;
  });
  const read = Effect.fn("relay.vm_codex_auth.read")(function* (input: ThreadVmCodexAuthIdentity) {
    const selected = yield* exact(input);
    if (selected) return selected;
    const prior =
      yield* sql`SELECT 1 FROM relay_thread_vm_codex_auth WHERE thread_id=${input.threadId} AND organization_id=${input.organizationId} LIMIT 1`;
    if (prior.length) return yield* unavailable();
    return { mode: "personal" as const };
  });
  const connection = Effect.fn("relay.vm_codex_auth.connection")(function* (
    input: ThreadVmCodexAuthIdentity,
  ) {
    const selection = yield* read(input);
    const current =
      selection.mode === "organization" ? yield* accounts.get(input.organizationId) : null;
    return {
      selection,
      connection:
        current?.connectionId ===
        (selection.mode === "organization" ? selection.connectionId : null)
          ? current
          : null,
    };
  });
  const select = Effect.fn("relay.vm_codex_auth.select")(function* (
    input: ThreadVmCodexAuthIdentity,
    selection: RelayThreadVmCodexAuthSelection,
  ) {
    if (selection.mode === "organization") {
      const rows =
        yield* sql`SELECT connection_id FROM relay_codex_vm_connections WHERE organization_id=${input.organizationId}
        AND connection_id=${selection.connectionId} AND status='connected' FOR SHARE`;
      if (!rows.length) return yield* new CodexVmConnectionError({ reason: "not_connected" });
    }
    yield* sql`INSERT INTO relay_thread_vm_codex_auth(allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id)
      VALUES(${input.allocationId},${input.environmentId},${input.generation},${input.threadId},${input.organizationId},${selection.mode},${selection.mode === "organization" ? selection.connectionId : null})
      ON CONFLICT(allocation_id,environment_id,generation) DO UPDATE SET mode=excluded.mode,connection_id=excluded.connection_id,acknowledged_connection_id=NULL
      WHERE relay_thread_vm_codex_auth.thread_id=excluded.thread_id AND relay_thread_vm_codex_auth.organization_id=excluded.organization_id`;
    return yield* connection(input);
  });
  /** Only the new guest's authenticated source lookup attests support for this exact selection. */
  const acknowledge = Effect.fn("relay.vm_codex_auth.acknowledge")(function* (
    input: ThreadVmCodexAuthIdentity,
  ) {
    yield* sql`UPDATE relay_thread_vm_codex_auth SET acknowledged_connection_id=connection_id
      WHERE allocation_id=${input.allocationId} AND environment_id=${input.environmentId}
      AND generation=${input.generation} AND thread_id=${input.threadId} AND organization_id=${input.organizationId}
      AND mode='organization' AND acknowledged_connection_id IS DISTINCT FROM connection_id
      AND EXISTS(SELECT 1 FROM relay_codex_vm_connections c WHERE c.organization_id=${input.organizationId}
        AND c.connection_id=relay_thread_vm_codex_auth.connection_id AND c.status='connected')`;
  });
  /** A downlevel guest's personal readiness receipt cannot activate a managed selection. */
  const requireAcknowledged = Effect.fn("relay.vm_codex_auth.require_acknowledged")(function* (
    input: ThreadVmCodexAuthIdentity,
  ) {
    const selected = yield* read(input);
    if (selected.mode === "personal") return;
    const current =
      yield* sql`SELECT 1 FROM relay_codex_vm_connections WHERE organization_id=${input.organizationId}
        AND connection_id=${selected.connectionId} AND status='connected' FOR SHARE`;
    if (!current.length) return yield* new CodexVmConnectionError({ reason: "not_connected" });
    const acknowledged =
      yield* sql`SELECT 1 FROM relay_thread_vm_codex_auth WHERE allocation_id=${input.allocationId}
      AND environment_id=${input.environmentId} AND generation=${input.generation} AND thread_id=${input.threadId}
      AND organization_id=${input.organizationId} AND acknowledged_connection_id=${selected.connectionId}`;
    if (!acknowledged.length)
      return yield* new CodexVmConnectionError({ reason: "vm_update_required" });
  });
  const transfer = Effect.fn("relay.vm_codex_auth.transfer")(function* (
    input: ThreadVmCodexAuthIdentity & {
      readonly sourceEnvironmentId: string | null;
      readonly sourceGeneration: number;
    },
  ) {
    const existing = yield* exact(input);
    if (existing) return yield* connection(input);
    const [source] =
      input.sourceEnvironmentId === null
        ? []
        : yield* sql<{
            mode: "personal" | "organization";
            connectionId: string | null;
          }>`SELECT mode,connection_id AS "connectionId"
      FROM relay_thread_vm_codex_auth WHERE thread_id=${input.threadId} AND organization_id=${input.organizationId}
      AND environment_id=${input.sourceEnvironmentId} AND generation=${input.sourceGeneration} FOR SHARE`;
    if (!source) {
      const prior =
        yield* sql`SELECT 1 FROM relay_thread_vm_codex_auth WHERE thread_id=${input.threadId} AND organization_id=${input.organizationId} LIMIT 1`;
      if (prior.length) return null;
    }
    // A missing historical binding cannot adopt a different account or expose copied guest secrets.
    yield* sql`INSERT INTO relay_thread_vm_codex_auth(allocation_id,environment_id,generation,thread_id,organization_id,mode,connection_id)
      VALUES(${input.allocationId},${input.environmentId},${input.generation},${input.threadId},${input.organizationId},${source?.mode ?? "personal"},${source?.connectionId ?? null})
      ON CONFLICT DO NOTHING`;
    return yield* connection(input);
  });
  /** Every enrolled move/reset/restore guest crosses this one fresh-identity boundary. */
  const inheritBinding = Effect.fn("relay.vm_codex_auth.inherit_binding")(function* (
    input: ThreadVmCodexAuthIdentity,
  ) {
    const [source] = yield* sql<{
      environmentId: string;
      generation: number;
      restoreEnvironmentId: string | null;
      restoreGeneration: number | null;
    }>`
      SELECT t.environment_id AS "environmentId",t.generation,
      coalesce(f.environment_id,b.environment_id) AS "restoreEnvironmentId",r.generation AS "restoreGeneration"
      FROM relay_thread_placements t LEFT JOIN relay_thread_vm_restores r ON r.operation_id=t.operation_id AND r.thread_id=t.thread_id
      LEFT JOIN relay_thread_vm_final_saves f ON f.operation_id=r.saved_disk_operation_id
      LEFT JOIN relay_thread_vm_backup_recoveries b ON b.operation_id=r.operation_id
      WHERE t.thread_id=${input.threadId} AND t.organization_id=${input.organizationId}`;
    if (!source) return yield* unavailable();
    const restoring = source.environmentId.startsWith("pending-restore:");
    if (restoring && (!source.restoreEnvironmentId || source.restoreGeneration === null))
      return null;
    return yield* transfer({
      ...input,
      sourceEnvironmentId: restoring ? source.restoreEnvironmentId : source.environmentId,
      sourceGeneration: restoring
        ? (source.restoreGeneration ?? input.generation - 1)
        : source.generation,
    });
  });
  return { read, connection, select, acknowledge, requireAcknowledged, transfer, inheritBinding };
}
