import type { CommandId } from "@t3tools/contracts";
import { makeThreadMoveProgressStore } from "../threads/ThreadMoveProgressStore.ts";
import { makeThreadCurrentQueueStore } from "../threads/ThreadCurrentQueueStore.ts";
import { threadVmQuotaUsage } from "../threads/ThreadVmQuota.ts";
import { makeThreadVmPolicyStore } from "../threads/ThreadVmPolicy.ts";
import { attachmentRelativePath } from "@t3tools/shared/attachmentLayout";
import {
  ThreadAttachmentCheckpointArchiveManifest,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
} from "@t3tools/contracts/relay";
import { makeThreadCheckpointObjects } from "../threads/ThreadCheckpointObjects.ts";
import { makeThreadNativeCheckpointStore } from "../threads/ThreadNativeCheckpointStore.ts";
import { makeThreadAttachmentCheckpointStore } from "../threads/ThreadAttachmentCheckpointStore.ts";
import {
  ThreadArtifactObjectStorage,
  ThreadArtifactObjectError,
} from "../threads/ThreadArtifactObjects.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";
import {
  RelayApi,
  RelayClientPrincipal,
  RelayPortableThreadSummary,
  type RelayPortableThreadVmSummary,
  type RelayPortableThreadPlacement,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { makeThreadJournalStore } from "../threads/ThreadJournalStore.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";

const decodeThreadSummary = Schema.decodeUnknownEffect(RelayPortableThreadSummary);

/** Relay-only discovery: saved or preparing threads need no live environment. */
export const listPortableThreads = Effect.fn("relay.api.thread_history.list")(
  function* (input: { after?: string | undefined; limit: number }) {
    const sql = (yield* RelayDb).$client;
    const { userId } = yield* RelayClientPrincipal;
    const candidates = yield* sql<{ threadId: string }>`SELECT t.thread_id AS "threadId"
      FROM relay_thread_placements t
      JOIN relay_organization_members m ON m.organization_id=t.organization_id AND m.user_id=${userId}
      JOIN relay_repositories r ON r.organization_id=t.organization_id AND r.repository_id=t.repository_id
      WHERE t.owner_user_id=${userId} AND t.thread_id > ${input.after ?? ""}
        AND (m.role='admin' OR EXISTS(SELECT 1 FROM relay_repository_access g
          WHERE g.organization_id=t.organization_id AND g.repository_id=t.repository_id AND g.user_id=${userId}))
        AND NOT EXISTS(SELECT 1 FROM relay_thread_deletions d WHERE d.thread_id=t.thread_id)
        AND NOT EXISTS(SELECT 1 FROM relay_thread_local_enrollments e WHERE e.thread_id=t.thread_id AND e.phase='aborted')
      ORDER BY t.thread_id LIMIT ${input.limit + 1}`;
    const scanned = candidates.slice(0, input.limit);
    const vmRows = scanned.length
      ? yield* sql<{
          threadId: string;
          generation: number;
          environmentId: string;
          previousLocations: NonNullable<RelayPortableThreadPlacement["previousLocations"]>;
          vm: RelayPortableThreadVmSummary;
        }>`SELECT t.thread_id AS "threadId",t.generation,t.environment_id AS "environmentId",
      coalesce((SELECT jsonb_agg(jsonb_build_object('environmentId',m.source_environment_id,'generation',m.expected_generation) ORDER BY m.expected_generation) FROM relay_thread_moves m WHERE m.thread_id=t.thread_id AND m.phase='completed' AND m.expected_generation<t.generation),'[]'::jsonb) AS "previousLocations",jsonb_build_object(
      'state', CASE WHEN move.operation_id IS NOT NULL THEN 'moving'
        WHEN final.operation_id IS NOT NULL THEN 'saving'
        WHEN reset.operation_id IS NOT NULL OR restore.operation_id IS NOT NULL THEN 'preparing'
        WHEN saved.phase IN ('expired','expiring') OR (saved.phase='available' AND saved.expires_at<=clock_timestamp()) THEN 'expired'
        WHEN saved.phase IN ('available','restoring') THEN 'saved'
        WHEN a.state='paused' THEN 'paused'
        WHEN a.state='running' AND ready.phase='ready' THEN 'running'
        WHEN a.state IN ('creating','running') THEN 'preparing'
        WHEN a.allocation_id IS NOT NULL THEN 'unavailable' ELSE 'on_machine' END,
      'projectName', repository.name,
      'activity',CASE WHEN activity.observed_at>=clock_timestamp()-interval '2 minutes' THEN activity.activity ELSE 'unknown' END,
      'observedAt',to_char(activity.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lastWorkAt',to_char(activity.last_work_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lastVerifiedBackupAt',to_char(backup.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'savedDiskOperationId',saved.operation_id,
      'savedDiskExpiresAt',to_char(saved.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS vm
      FROM relay_thread_placements t
      JOIN relay_repositories repository ON repository.repository_id=t.repository_id AND repository.organization_id=t.organization_id
      LEFT JOIN relay_thread_vm_policies policy ON policy.organization_id=t.organization_id
      LEFT JOIN relay_thread_vm_allocations a ON a.thread_id=t.thread_id AND a.deleted_at IS NULL
        AND (NOT EXISTS(SELECT 1 FROM relay_thread_vm_bindings b WHERE b.allocation_id=a.allocation_id)
          OR EXISTS(SELECT 1 FROM relay_thread_vm_bindings b WHERE b.allocation_id=a.allocation_id AND b.environment_id=t.environment_id AND b.generation=t.generation AND b.revoked_at IS NULL))
      LEFT JOIN relay_thread_vm_ready ready ON ready.allocation_id=a.allocation_id
      LEFT JOIN relay_thread_vm_activity activity ON activity.allocation_id=a.allocation_id
      LEFT JOIN relay_thread_moves move ON move.operation_id=t.operation_id AND move.phase NOT IN ('completed','aborted')
      LEFT JOIN relay_thread_vm_final_saves final ON final.operation_id=t.operation_id AND final.phase NOT IN ('completed','aborted')
      LEFT JOIN relay_thread_vm_resets reset ON reset.operation_id=t.operation_id AND reset.thread_id=t.thread_id
        AND (reset.expected_generation=t.generation OR reset.expected_generation+1=t.generation) AND reset.phase NOT IN ('completed','cancelled')
      LEFT JOIN relay_thread_vm_restores restore ON restore.operation_id=t.operation_id AND restore.thread_id=t.thread_id
        AND (restore.generation=t.generation OR restore.generation+1=t.generation) AND restore.phase NOT IN ('completed','aborted')
      LEFT JOIN LATERAL(SELECT operation_id,backup_operation_id,saved_at,phase,((saved_at AT TIME ZONE coalesce(policy.calendar_time_zone,'UTC') + coalesce(policy.saved_disk_retention_days,30)*interval '1 day') AT TIME ZONE coalesce(policy.calendar_time_zone,'UTC')) AS expires_at FROM relay_thread_vm_saved_disks WHERE thread_id=t.thread_id AND phase!='restored' AND (generation=t.generation OR (phase='restoring' AND restore_operation_id=t.operation_id)) ORDER BY saved_at DESC LIMIT 1) saved ON true
      LEFT JOIN LATERAL(SELECT verified_at FROM relay_thread_vm_backups WHERE (allocation_id=a.allocation_id OR operation_id=saved.backup_operation_id) AND phase='verified' ORDER BY verified_at DESC LIMIT 1) backup ON true
      WHERE t.thread_id=ANY(${scanned.map((row) => row.threadId)}::varchar[])`
      : [];
    const vmByThread = new Map(vmRows.map((row) => [row.threadId, row]));
    const [membership] = yield* sql<{
      organizationId: string;
    }>`SELECT organization_id AS "organizationId" FROM relay_organization_members WHERE user_id=${userId}`;
    const allowance = membership
      ? {
          used: yield* threadVmQuotaUsage(sql, userId),
          limit: (yield* makeThreadVmPolicyStore(sql).get(membership.organizationId)).policy
            .maxVmsPerUser,
        }
      : undefined;
    const entries = yield* Effect.forEach(scanned, ({ threadId }) =>
      // Recheck and hold the same access locks as individual history reads.
      withPrivateThreadAccess(threadId, "read", (placement) =>
        Effect.gen(function* () {
          const [metadata] = yield* sql<{
            title: string;
            modelSelection: unknown;
            createdAt: string | null;
            updatedAt: string | null;
          }>`SELECT COALESCE(title.value, seed.state->>'title', 'New thread') AS title,
          COALESCE(model.value, seed.state->'modelSelection') AS "modelSelection",
          COALESCE(created.value, seed.state->>'createdAt') AS "createdAt",
          COALESCE(updated.value, seed.state->>'createdAt') AS "updatedAt"
          FROM (SELECT ${threadId}::varchar AS thread_id) t
          LEFT JOIN LATERAL(SELECT initial_state::jsonb AS state FROM relay_thread_vm_setups s
            JOIN relay_thread_vm_allocations a USING(allocation_id)
            WHERE a.thread_id=t.thread_id AND initial_state IS NOT NULL ORDER BY a.allocation_id LIMIT 1) seed ON true
          LEFT JOIN LATERAL(SELECT event_json->'payload'->>'title' AS value FROM relay_thread_history
            WHERE thread_id=t.thread_id AND event_json->>'type' IN('thread.created','thread.meta-updated')
              AND event_json->'payload'->>'title' IS NOT NULL ORDER BY cursor DESC LIMIT 1) title ON true
          LEFT JOIN LATERAL(SELECT event_json->'payload'->'modelSelection' AS value FROM relay_thread_history
            WHERE thread_id=t.thread_id AND event_json->>'type' IN('thread.created','thread.meta-updated')
              AND event_json->'payload'->'modelSelection' IS NOT NULL ORDER BY cursor DESC LIMIT 1) model ON true
          LEFT JOIN LATERAL(SELECT event_json->'payload'->>'createdAt' AS value FROM relay_thread_history
            WHERE thread_id=t.thread_id AND event_json->>'type'='thread.created' ORDER BY cursor LIMIT 1) created ON true
          LEFT JOIN LATERAL(SELECT event_json->>'occurredAt' AS value FROM relay_thread_history
            WHERE thread_id=t.thread_id ORDER BY cursor DESC LIMIT 1) updated ON true`;
          const observed = vmByThread.get(threadId);
          const current =
            observed?.generation === placement.generation &&
            observed.environmentId === placement.environmentId
              ? observed
              : null;
          return yield* decodeThreadSummary({
            placement: current
              ? { ...placement, previousLocations: current.previousLocations }
              : placement,
            ...metadata,
            ...(current ? { vm: current.vm } : {}),
          }).pipe(
            Effect.catchTag("SchemaError", () => relayInternalErrorResponse("persistence_failed")),
          );
        }),
      ).pipe(Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null))),
    );
    return {
      entries: entries.filter((entry) => entry !== null),
      ...(allowance ? { allowance } : {}),
      next: candidates.length > input.limit ? scanned.at(-1)!.threadId : null,
    };
  },
  Effect.catchTags({
    SqlError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadPlacementConflict: () => relayInternalErrorResponse("persistence_failed"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const getPortableThreadPlacement = Effect.fn("relay.api.thread_history.placement")(
  function* (threadId: string) {
    return yield* withPrivateThreadAccess(threadId, "read", (placement) =>
      Effect.gen(function* () {
        const sql = (yield* RelayDb).$client;
        const [move] = placement.operationId
          ? yield* sql<{ failureDetail: string | null }>`SELECT failure_detail AS "failureDetail"
              FROM relay_thread_moves WHERE operation_id=${placement.operationId}
                AND thread_id=${threadId} AND phase IN ('preparing','frozen','ready')`
          : [];
        const previousLocations = yield* sql<{
          environmentId: string;
          generation: number;
        }>`SELECT source_environment_id AS "environmentId",expected_generation AS generation FROM relay_thread_moves WHERE thread_id=${threadId} AND phase='completed' AND expected_generation<${placement.generation} ORDER BY expected_generation`;
        return {
          ...placement,
          previousLocations,
          moveFailureDetail: move?.failureDetail ?? null,
          moveProgress: placement.operationId
            ? yield* makeThreadMoveProgressStore(sql).read(placement.operationId)
            : [],
        };
      }),
    );
  },
);
export const getPortableThreadCurrentQueue = Effect.fn("relay.api.thread_history.queue")(function* (
  threadId: string,
  commandId?: CommandId,
) {
  const sql = (yield* RelayDb).$client;
  return yield* withPrivateThreadAccess(threadId, "read", (placement) =>
    Effect.gen(function* () {
      const current = yield* makeThreadCurrentQueueStore(sql).read(threadId);
      const applied = commandId
        ? yield* sql`SELECT 1 FROM relay_thread_history
          WHERE thread_id=${threadId} AND cursor<=${current.cursor}
            AND event_json->>'type'='thread.prompt-queue-changed'
            AND event_json->>'commandId'=${commandId} LIMIT 1`
        : [];
      return {
        threadId,
        generation: placement.generation,
        ...current,
        appliedCommandId: commandId && applied.length ? commandId : null,
      };
    }),
  ).pipe(Effect.catchTag("SchemaError", () => relayInternalErrorResponse("persistence_failed")));
});
export const getPortableThreadHistory = Effect.fn("relay.api.thread_history.read")(
  function* (input: { threadId: string; after: number; limit: number }) {
    const sql = (yield* RelayDb).$client;
    return yield* withPrivateThreadAccess(input.threadId, "read", () =>
      makeThreadJournalStore(sql).history(input),
    ).pipe(
      Effect.map((entries) => ({ entries })),
      Effect.catchTag("ThreadPlacementConflict", () =>
        relayInternalErrorResponse("persistence_failed"),
      ),
    );
  },
);
const decodeAttachmentHeader = Schema.decodeEffect(
  Schema.fromJsonString(ThreadAttachmentCheckpointArchiveManifest),
);
export const readPortableThreadAttachment = Effect.fn("relay.api.thread_history.attachment")(
  function* (input: { threadId: string; attachmentId: string }) {
    const sql = (yield* RelayDb).$client,
      objects = yield* ThreadArtifactObjectStorage;
    return yield* withPrivateThreadAccess(input.threadId, "read", () =>
      Effect.gen(function* () {
        const native = yield* makeThreadNativeCheckpointStore(sql, objects).latestComplete(
          input.threadId,
        );
        const point = native
          ? yield* makeThreadAttachmentCheckpointStore(sql, objects).get(native.operationId)
          : null;
        if (!native || !point) return yield* tenancyNotFound("thread_not_found");
        return yield* makeThreadCheckpointObjects(
          sql,
          objects,
          (message) => new ThreadArtifactObjectError({ operation: message }),
        ).openFile(
          {
            threadId: input.threadId,
            operationId: point.operationId,
            manifestArtifactId: point.manifestArtifactId,
            kind: "attachment",
            maxBytes: THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES + 64 * 1024 * 1024,
          },
          (view) =>
            Effect.gen(function* () {
              const header = yield* decodeAttachmentHeader(
                yield* view.readMetadata("manifest.json", 32 * 1024 * 1024),
              );
              if (
                header.threadId !== input.threadId ||
                header.operationId !== point.operationId ||
                header.sourceEnvironmentId !== point.sourceEnvironmentId ||
                header.generation !== point.generation ||
                header.nativeArchiveSha256 !== point.nativeArchiveSha256 ||
                view.artifact.sha256 !== point.manifestSha256 ||
                view.byName.get("manifest.json")?.sha256 !== view.manifest.transferManifestSha256
              )
                return yield* tenancyConflict("thread_checkpoint_conflict");
              const descriptor = header.attachments.files.find(
                (file) => file.attachment.id === input.attachmentId,
              );
              const relative = descriptor ? attachmentRelativePath(descriptor.attachment) : null;
              const file = relative ? view.byName.get(`attachments/${relative}`) : null;
              if (!descriptor || !file) return yield* tenancyNotFound("thread_not_found");
              if (
                file.sha256 !== descriptor.sha256 ||
                file.sizeBytes !== descriptor.attachment.sizeBytes
              )
                return yield* tenancyConflict("thread_checkpoint_conflict");
              return file;
            }),
        );
      }),
    );
  },
  Effect.catchTags({
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadArtifactConflict: () => relayInternalErrorResponse("persistence_failed"),
    TimeoutError: () => relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
export const threadHistoryApi = HttpApiBuilder.group(RelayApi, "threadHistory", (handlers) =>
  handlers
    .handle("getAttachment", ({ params }) => readPortableThreadAttachment(params))
    .handle("listThreads", ({ query }) => listPortableThreads(query))
    .handle("getPlacement", ({ params }) => getPortableThreadPlacement(params.threadId))
    .handle("getCurrentQueue", ({ params, query }) =>
      getPortableThreadCurrentQueue(params.threadId, query.commandId),
    )
    .handle("getHistory", ({ params, query }) => getPortableThreadHistory({ ...params, ...query })),
);
