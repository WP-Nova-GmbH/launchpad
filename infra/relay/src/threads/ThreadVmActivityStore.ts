import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ThreadVmActivityConflict extends Schema.TaggedError<ThreadVmActivityConflict>()(
  "ThreadVmActivityConflict",
  { message: Schema.String },
) {}

import { lockThreadVmPolicy, writeThreadVmIdleDeadline } from "./ThreadVmPolicy.ts";

type Activity = "busy" | "idle" | "unknown";

/** Inspection revisions prevent a delayed idle reply from erasing newer work. */
export function makeThreadVmActivityStore(sql: PgClient) {
  const requireRunning = Effect.fnUntraced(function* (allocationId: string) {
    const [allocation] = yield* sql<{
      state: string;
      organizationId: string;
    }>`SELECT state,organization_id AS "organizationId" FROM relay_thread_vm_allocations
      WHERE allocation_id = ${allocationId} AND deleted_at IS NULL FOR SHARE`;
    if (allocation?.state !== "running")
      return yield* new ThreadVmActivityConflict({ message: "VM is not running" });
    return allocation.organizationId;
  });
  const ensure = Effect.fnUntraced(function* (allocationId: string) {
    yield* sql`INSERT INTO relay_thread_vm_activity (allocation_id) VALUES (${allocationId})
      ON CONFLICT DO NOTHING`;
  });
  const recordWork = Effect.fn("relay.thread_vm.activity.record_work")(function* (
    allocationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireRunning(allocationId);
        yield* ensure(allocationId);
        yield* sql`UPDATE relay_thread_vm_activity SET revision = revision + 1,
          activity = 'unknown', observed_at = NULL, idle_since = NULL, inactive_work_ids='[]'::jsonb,
          pause_due_at=NULL,delete_due_at=NULL,deadline_idle_since=NULL,deadline_policy_revision=NULL,deadline_time_zone=NULL,lifecycle_checked_at=NULL,
          last_work_at = clock_timestamp() WHERE allocation_id = ${allocationId}`;
      }),
    );
  });
  const beginInspection = Effect.fn("relay.thread_vm.activity.begin_inspection")(function* (
    allocationId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireRunning(allocationId);
        yield* ensure(allocationId);
        const [row] = yield* sql<{ revision: number }>`UPDATE relay_thread_vm_activity
          SET revision = revision + 1,
          idle_since = CASE WHEN activity = 'idle' AND observed_at >= clock_timestamp() - interval '2 minutes'
            THEN idle_since ELSE NULL END,
          activity = 'unknown', observed_at = clock_timestamp(), inactive_work_ids='[]'::jsonb
          WHERE allocation_id = ${allocationId}
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
              WHERE x.allocation_id=${allocationId} AND x.phase IN ('pending','sealed'))
          RETURNING revision`;
        if (!row) return yield* new ThreadVmActivityConflict({ message: "Activity row missing" });
        return row.revision;
      }),
    );
  });
  const finishInspection = Effect.fn("relay.thread_vm.activity.finish_inspection")(
    function* (input: {
      readonly allocationId: string;
      readonly revision: number;
      readonly activity: Activity;
      readonly inactiveWorkIds?: ReadonlyArray<string>;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const organizationId = yield* requireRunning(input.allocationId);
          const policy = yield* lockThreadVmPolicy(sql, organizationId);
          const rows = yield* sql`UPDATE relay_thread_vm_activity
          SET activity = ${input.activity}, observed_at = clock_timestamp(),
          inactive_work_ids = ${sql.json(input.activity === "idle" ? [...(input.inactiveWorkIds ?? [])] : [])},
          idle_since = CASE WHEN ${input.activity} = 'idle' THEN COALESCE(idle_since, clock_timestamp()) ELSE NULL END
          WHERE allocation_id = ${input.allocationId} AND revision = ${input.revision}
            AND activity = 'unknown'
            AND observed_at >= clock_timestamp() - interval '2 minutes'
            AND NOT EXISTS (SELECT 1 FROM relay_thread_vm_pauses x
              WHERE x.allocation_id=${input.allocationId} AND x.phase IN ('pending','sealed'))
          RETURNING allocation_id`;
          if (rows.length) yield* writeThreadVmIdleDeadline(sql, input.allocationId, policy);
          return rows.length === 1;
        }),
      );
    },
  );
  const get = Effect.fn("relay.thread_vm.activity.get")(function* (allocationId: string) {
    const [row] = yield* sql<{
      revision: number;
      activity: "busy" | "idle" | "unknown";
      idleSince: number | null;
      lastWorkAt: number | null;
    }>`SELECT revision,
      CASE WHEN observed_at >= clock_timestamp() - interval '2 minutes' THEN activity ELSE 'unknown' END AS activity,
      CASE WHEN observed_at >= clock_timestamp() - interval '2 minutes' AND activity = 'idle'
        THEN idle_since ELSE NULL END AS "idleSince",
      last_work_at AS "lastWorkAt" FROM relay_thread_vm_activity
      WHERE allocation_id = ${allocationId}`;
    return row ?? null;
  });
  return { recordWork, beginInspection, finishInspection, get };
}
