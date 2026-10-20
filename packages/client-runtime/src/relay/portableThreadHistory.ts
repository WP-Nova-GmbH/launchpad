import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";
import type { RelayThreadHistoryPage } from "@t3tools/contracts/relay";
import { applyThreadDetailEvent, threadFromCreatedEvent } from "../state/threadReducer.ts";

export interface PortableThreadHistory {
  readonly cursor: number;
  readonly thread: OrchestrationThread | null;
  readonly origins: ReadonlySet<string>;
  readonly deleted: boolean;
}
export const emptyPortableThreadHistory = (): PortableThreadHistory => ({
  cursor: 0,
  thread: null,
  origins: new Set(),
  deleted: false,
});

/** Relay cursors order the view; native source numbers only identify already mirrored events. */
export function applyPortableThreadHistoryPage(
  previous: PortableThreadHistory,
  threadId: ThreadId,
  page: RelayThreadHistoryPage,
): PortableThreadHistory {
  let cursor = previous.cursor,
    thread = previous.thread,
    deleted = previous.deleted;
  const origins = new Set(previous.origins);
  let pageCursor = 0;
  for (const entry of page.entries) {
    if (entry.cursor <= pageCursor)
      throw new Error("Retained history page is not in cursor order.");
    pageCursor = entry.cursor;
    const source = entry.event;
    if (
      source.aggregateKind !== "thread" ||
      source.aggregateId !== threadId ||
      !("threadId" in source.payload) ||
      source.payload.threadId !== threadId
    )
      throw new Error("Retained history belongs to another thread.");
    if (entry.cursor <= cursor) continue;
    cursor = entry.cursor;
    const origin = JSON.stringify([entry.environmentId, source.sequence]);
    if (origins.has(origin)) continue;
    origins.add(origin);
    // This is a read-only projection. Nothing assigns this cursor to an environment receipt.
    const event = { ...source, sequence: entry.cursor };
    if (event.type === "thread.created") {
      if (thread !== null || deleted)
        throw new Error("Retained history contains another thread creation.");
      thread = threadFromCreatedEvent(event);
      continue;
    }
    if (thread === null || deleted)
      throw new Error("Retained history has no initial thread state.");
    if (event.type === "thread.placement-imported") {
      thread = {
        ...thread,
        projectId: event.payload.projectId,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        updatedAt: event.payload.updatedAt,
      };
      continue;
    }
    const result = applyThreadDetailEvent(thread, event);
    if (result.kind === "deleted") {
      thread = null;
      deleted = true;
    } else if (result.kind === "updated") thread = result.thread;
  }
  return { cursor, thread, origins, deleted };
}
