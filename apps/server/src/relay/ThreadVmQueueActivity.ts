import { ThreadId } from "@t3tools/contracts";
import { threadPromptQueueHasWork } from "@t3tools/shared/threadPromptQueue";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { getPromptQueue } from "../persistence/ProjectionPromptQueues.ts";
import { ThreadExecutionFenceError } from "../persistence/ThreadExecutionFence.ts";

export class ThreadVmQueuedWork extends Schema.TaggedError<ThreadVmQueuedWork>()(
  "ThreadVmQueuedWork",
  { threadId: Schema.String },
) {}

/** Run inside the ownership transaction so queue writes cannot race the final freeze. */
export const assertThreadVmQueueIdle = Effect.fn("ThreadVmQueueActivity.assert_idle")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const [thread] = yield* sql<{ archivedAt: string | null }>`SELECT archived_at AS "archivedAt"
    FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
  if (!thread)
    return yield* new ThreadExecutionFenceError({
      threadId,
      detail: "VM thread projection is unavailable.",
    });
  const queue = yield* getPromptQueue(sql, ThreadId.make(threadId));
  if (queue && threadPromptQueueHasWork(queue, thread.archivedAt !== null))
    return yield* new ThreadVmQueuedWork({ threadId });
});
