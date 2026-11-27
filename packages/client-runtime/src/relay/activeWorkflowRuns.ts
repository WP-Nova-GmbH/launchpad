import type {
  ActiveWorkflowRun,
  ActiveWorkflowRunPage,
  ActiveWorkflowRunPageQuery,
} from "@t3tools/contracts/workflows";
import * as Equal from "effect/Equal";

const pageSize = 20;

interface ActiveRunsState {
  readonly jobs: ReadonlyArray<ActiveWorkflowRun>;
  readonly organizationId: string | null;
  readonly total: number | null;
  readonly nextCursor: string | null;
  readonly pending: boolean;
  readonly error: string | null;
}

const initial: ActiveRunsState = {
  jobs: [],
  organizationId: null,
  total: null,
  nextCursor: null,
  pending: true,
  error: null,
};

/** A visible sidebar owns the poll. Its caller scopes the store to one signed-in session. */
export function createActiveWorkflowRuns(
  readPage: (
    query: ActiveWorkflowRunPageQuery,
    signal: AbortSignal,
  ) => Promise<ActiveWorkflowRunPage>,
) {
  let state = initial;
  let active: AbortSignal | null = null;
  let request: Promise<void> | null = null;
  let wanted = pageSize;
  const listeners = new Set<() => void>();
  const publish = (next: ActiveRunsState) => {
    if (Equal.equals(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const read = async (signal: AbortSignal, retry = true): Promise<void> => {
    const jobs: ActiveWorkflowRun[] = [];
    let cursor: string | null = null;
    let organizationId: string | null = null;
    let total: number | null = null;
    try {
      for (;;) {
        const page = await readPage(
          {
            ...(cursor ? { cursor } : {}),
            limit: Math.max(1, Math.min(100, wanted - jobs.length)),
          },
          signal,
        );
        if (signal.aborted) return;
        if (cursor && organizationId !== page.organizationId) {
          throw new Error("Organization changed while loading workflow runs.");
        }
        // Each HTTP page is a fresh database snapshot. Finishing runs or changed
        // grants between pages can invalidate the rows we have already collected.
        const loaded = jobs.length + page.jobs.length;
        const moreRowsExpected = loaded < page.total;
        if (
          (total !== null && total !== page.total) ||
          loaded > page.total ||
          Boolean(page.nextCursor) !== moreRowsExpected
        ) {
          if (retry) return read(signal, false);
          throw new Error("Workflow runs changed while loading.");
        }
        total = page.total;
        if (
          !cursor &&
          state.organizationId &&
          state.organizationId !== page.organizationId &&
          wanted
        ) {
          wanted = Math.max(pageSize, page.jobs.length);
        }
        organizationId = page.organizationId;
        jobs.push(...page.jobs);
        if (!page.nextCursor || jobs.length >= wanted) {
          publish({
            jobs: wanted ? jobs : [],
            organizationId,
            total: page.total,
            nextCursor: wanted ? page.nextCursor : null,
            error: null,
            pending: false,
          });
          return;
        }
        if (!page.jobs.length || page.nextCursor === cursor)
          throw new Error("Invalid workflow runs page.");
        cursor = page.nextCursor;
      }
    } catch {
      // The membership or a repository grant may have been revoked during a refresh.
      if (!signal.aborted)
        publish({ ...initial, pending: false, error: "Could not load workflow runs." });
    }
  };
  const refresh = () => {
    const signal = active;
    if (!signal) return;
    request ??= read(signal).finally(() => {
      if (active === signal) request = null;
    });
    return request;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    loadMore() {
      if (!active || !state.nextCursor || state.pending) return;
      wanted += pageSize;
      publish({ ...state, pending: true });
      return refresh();
    },
    watch(expanded: boolean) {
      const lifetime = new AbortController();
      active = lifetime.signal;
      wanted = expanded ? Math.max(pageSize, state.jobs.length) : 0;
      if (!expanded) publish({ ...state, jobs: [], nextCursor: null });
      else if (!state.jobs.length && state.total) publish({ ...state, pending: true });
      void refresh();
      const timer = setInterval(refresh, 5_000);
      return () => {
        clearInterval(timer);
        lifetime.abort();
        active = null;
        request = null;
      };
    },
  };
}
