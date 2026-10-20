import { ThreadVmPolicy, type ThreadVmPolicyRecord } from "@t3tools/contracts/relay";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadPlacementConflict } from "./ThreadPlacementStore.ts";

const decodePolicy = Schema.decodeEffect(ThreadVmPolicy);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Count actual elapsed weekday time, including nights; only Saturday/Sunday are excluded. */
export function addWeekdayTime(start: DateTime.Utc, days: number, calendarTimeZone: string) {
  let cursor = DateTime.makeZonedUnsafe(start, { timeZone: calendarTimeZone });
  let remaining = days * DAY_MS;
  if (!Number.isSafeInteger(remaining) || days <= 0)
    throw new RangeError("Expected positive weekday duration");
  while (remaining > 0) {
    const nextMidnight = DateTime.add(DateTime.startOf(cursor, "day"), { days: 1 });
    const weekday = DateTime.toParts(cursor).weekDay;
    if (weekday !== 0 && weekday !== 6) {
      const available = nextMidnight.epochMilliseconds - cursor.epochMilliseconds;
      if (remaining <= available)
        return DateTime.formatIso(DateTime.addDuration(cursor, remaining));
      remaining -= available;
    }
    cursor = nextMidnight;
  }
  return DateTime.formatIso(cursor);
}

/** Derive from the current policy at decision time, so edits cannot leave a stale deadline. */
export function idleDeadlines(input: {
  readonly idleSince: DateTime.Utc | null;
  readonly activity: "busy" | "idle" | "unknown";
  readonly policy: ThreadVmPolicy;
}) {
  if (input.activity !== "idle" || input.idleSince === null) return null;
  return {
    pauseAt: DateTime.formatIso(
      DateTime.addDuration(input.idleSince, input.policy.pauseAfterIdleMinutes * 60_000),
    ),
    deleteAt: addWeekdayTime(
      input.idleSince,
      input.policy.deleteAfterIdleWeekdays,
      input.policy.calendarTimeZone,
    ),
  };
}

export function savedDiskExpiresAt(savedAt: DateTime.Utc, policy: ThreadVmPolicy) {
  const zoned = DateTime.makeZonedUnsafe(savedAt, { timeZone: policy.calendarTimeZone });
  return DateTime.formatIso(DateTime.add(zoned, { days: policy.savedDiskRetentionDays }));
}

export function makeThreadVmPolicyStore(sql: PgClient) {
  const get = Effect.fn("relay.thread_vm.policy_get")(function* (organizationId: string) {
    yield* sql`INSERT INTO relay_thread_vm_policies (organization_id) VALUES (${organizationId}) ON CONFLICT DO NOTHING`;
    const [row] = yield* sql<
      ThreadVmPolicy & { revision: number }
    >`SELECT revision, max_vms_per_user AS "maxVmsPerUser",
      pause_after_idle_minutes AS "pauseAfterIdleMinutes", delete_after_idle_weekdays AS "deleteAfterIdleWeekdays",
      backup_interval_minutes AS "backupIntervalMinutes", saved_disk_retention_days AS "savedDiskRetentionDays",
      calendar_time_zone AS "calendarTimeZone" FROM relay_thread_vm_policies WHERE organization_id = ${organizationId}`;
    if (!row) return yield* new ThreadPlacementConflict({ message: "VM policy is missing" });
    const { revision, ...rawPolicy } = row;
    const policy = yield* decodePolicy(rawPolicy);
    return { organizationId, revision, policy } satisfies ThreadVmPolicyRecord;
  });
  const update = Effect.fn("relay.thread_vm.policy_update")(function* (input: {
    readonly organizationId: string;
    readonly expectedRevision: number;
    readonly policy: ThreadVmPolicy;
  }) {
    const policy = yield* decodePolicy(input.policy);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE relay_thread_vm_policies SET revision = revision + 1,
        max_vms_per_user = ${policy.maxVmsPerUser}, pause_after_idle_minutes = ${policy.pauseAfterIdleMinutes},
        delete_after_idle_weekdays = ${policy.deleteAfterIdleWeekdays}, backup_interval_minutes = ${policy.backupIntervalMinutes},
        saved_disk_retention_days = ${policy.savedDiskRetentionDays}, calendar_time_zone = ${policy.calendarTimeZone}
        WHERE organization_id = ${input.organizationId} AND revision = ${input.expectedRevision} RETURNING revision`;
        if (!rows.length)
          return yield* new ThreadPlacementConflict({
            message: "VM policy changed; reload before saving",
          });
        const record = yield* get(input.organizationId);
        yield* sql`UPDATE relay_thread_vm_replacements SET checked_at=NULL
          WHERE organization_id=${input.organizationId} AND phase IN ('awaiting_choice','waiting')`;
        const allocations = yield* sql<{
          allocationId: string;
        }>`SELECT a.allocation_id AS "allocationId"
          FROM relay_thread_vm_allocations a JOIN relay_thread_vm_activity v USING(allocation_id)
          WHERE a.organization_id=${input.organizationId} AND a.deleted_at IS NULL
          ORDER BY a.allocation_id`;
        for (const allocation of allocations)
          yield* writeThreadVmIdleDeadline(sql, allocation.allocationId, record);
        return record;
      }),
    );
  });
  return { get, update };
}

/** Hold this before locking activity; policy edits recompute deadlines under the same order. */
export const lockThreadVmPolicy = Effect.fn("relay.thread_vm.policy_lock")(function* (
  sql: PgClient,
  organizationId: string,
) {
  yield* sql`SELECT organization_id FROM relay_thread_vm_policies WHERE organization_id=${organizationId} FOR SHARE`;
  return yield* makeThreadVmPolicyStore(sql).get(organizationId);
});

/** The cache is for scheduling only. Actions revalidate ownership, activity and current policy. */
export const writeThreadVmIdleDeadline = Effect.fn("relay.thread_vm.idle_deadline.write")(
  function* (sql: PgClient, allocationId: string, record: ThreadVmPolicyRecord) {
    const [row] = yield* sql<{ idleSince: string | null }>`SELECT
    to_char(idle_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "idleSince"
    FROM relay_thread_vm_activity WHERE allocation_id=${allocationId} FOR UPDATE`;
    if (!row) return;
    const deadlines = idleDeadlines({
      activity: "idle",
      idleSince: row.idleSince ? DateTime.makeUnsafe(row.idleSince) : null,
      policy: record.policy,
    });
    yield* sql`UPDATE relay_thread_vm_activity SET
    lifecycle_checked_at=CASE WHEN deadline_idle_since IS DISTINCT FROM idle_since OR deadline_policy_revision IS DISTINCT FROM ${record.revision} THEN NULL ELSE lifecycle_checked_at END,
    pause_due_at=${deadlines?.pauseAt ?? null}::timestamptz,delete_due_at=${deadlines?.deleteAt ?? null}::timestamptz,
    deadline_idle_since=CASE WHEN idle_since IS NULL THEN NULL ELSE idle_since END,
    deadline_policy_revision=CASE WHEN idle_since IS NULL THEN NULL ELSE ${record.revision} END,
    deadline_time_zone=CASE WHEN idle_since IS NULL THEN NULL ELSE ${record.policy.calendarTimeZone} END
    WHERE allocation_id=${allocationId}`;
    return deadlines;
  },
);
