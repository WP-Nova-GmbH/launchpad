import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  createActiveWorkflowRuns,
  managedRelaySessionAtom,
  readActiveWorkflowRunsPage,
  type ManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import { workflowRunStatus } from "@t3tools/client-runtime/relay/workflow-session";
import type { ActiveWorkflowRun } from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  ClockIcon,
  EyeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { runtime } from "../../lib/runtime";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarGroup, useSidebar, useSidebarVisibility } from "../ui/sidebar";

export function SidebarWorkflowRuns() {
  const session = useAtomValue(managedRelaySessionAtom);
  const visible = useSidebarVisibility();
  return session && visible ? (
    <WorkflowRunsShelf key={session.accountId} session={session} />
  ) : null;
}

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function WorkflowRunsShelf({ session }: { session: ManagedRelaySession }) {
  const [expanded, setExpanded] = useLocalStorage(
    "launchpad:sidebar:workflow-runs-expanded",
    true,
    Schema.Boolean,
  );
  const runs = useMemo(
    () =>
      createActiveWorkflowRuns((query, signal) =>
        runtime.runPromise(readActiveWorkflowRunsPage(session, query), { signal }),
      ),
    [session],
  );
  const page = useSyncExternalStore(runs.subscribe, runs.getSnapshot, runs.getSnapshot);
  const foreground = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => false,
  );
  const listId = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const paginationFocus = useRef<{
    button: HTMLButtonElement;
    previousIds: ReadonlySet<string>;
    detachedWhileFocused: boolean;
  } | null>(null);
  const trackMoreButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // React detaches the ref before removing the focused button on the final page.
    return () => {
      const intent = paginationFocus.current;
      if (intent?.button === button)
        intent.detachedWhileFocused = button.ownerDocument.activeElement === button;
    };
  }, []);

  useLayoutEffect(() => {
    const intent = paginationFocus.current;
    if (!intent || page.pending) return;
    paginationFocus.current = null;
    const { button, previousIds, detachedWhileFocused } = intent;
    const doc = button.ownerDocument;
    if (doc.activeElement !== button && !(detachedWhileFocused && doc.activeElement === doc.body))
      return;
    const boundary = page.jobs.findLastIndex((job) => previousIds.has(job.jobId));
    const next = page.jobs[boundary + 1];
    const link = next && doc.getElementById(`${listId}-${next.jobId}`);
    (link ?? retryButton.current ?? (page.nextCursor ? button : heading.current))?.focus();
  }, [listId, page]);

  useEffect(() => {
    if (!foreground) return;
    const stop = runs.watch(expanded);
    const onFocus = () => {
      void runs.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
    };
  }, [runs, expanded, foreground]);

  return (
    <SidebarGroup role="region" aria-label="Workflow Runs">
      <button
        ref={heading}
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((open) => !open)}
        className="mx-0.5 flex h-8 cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground pointer-coarse:min-h-11"
      >
        <span>Workflow Runs{page.total === null ? "" : ` (${page.total})`}</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0", expanded && "rotate-180")} />
      </button>
      <div id={listId} hidden={!expanded}>
        {expanded && (
          <>
            {page.jobs.length > 0 && (
              <ul className="flex flex-col gap-px">
                {page.jobs.map((job) => (
                  <WorkflowRunRow key={job.jobId} job={job} id={`${listId}-${job.jobId}`} />
                ))}
              </ul>
            )}
            {page.error ? (
              <div className="flex items-center justify-between gap-1 px-2 text-xs text-sidebar-muted-foreground">
                <span>Couldn’t load active runs.</span>
                <Button
                  ref={retryButton}
                  variant="ghost"
                  size="xs"
                  onClick={() => void runs.refresh()}
                >
                  Retry
                </Button>
              </div>
            ) : page.jobs.length === 0 ? (
              <p className="px-2.5 py-1.5 text-xs text-sidebar-muted-foreground">
                {page.total === 0 ? "No active runs" : "Loading runs…"}
              </p>
            ) : null}
            {page.nextCursor && (
              <Button
                ref={trackMoreButton}
                variant="ghost"
                size="xs"
                aria-disabled={page.pending}
                onClick={(event) => {
                  if (page.pending) return;
                  if (event.detail === 0) {
                    paginationFocus.current = {
                      button: event.currentTarget,
                      previousIds: new Set(page.jobs.map((job) => job.jobId)),
                      detachedWhileFocused: false,
                    };
                  }
                  void runs.loadMore();
                }}
              >
                Show more runs
              </Button>
            )}
          </>
        )}
      </div>
    </SidebarGroup>
  );
}

const runIcons = {
  blocked: TriangleAlertIcon,
  checkpoint: EyeIcon,
  running: CirclePlayIcon,
  paused: CirclePauseIcon,
  waiting: ClockIcon,
};

function WorkflowRunRow({ job, id }: { job: ActiveWorkflowRun; id: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { label, kind } = workflowRunStatus(job);
  const Icon = runIcons[kind];
  const title = job.issueIdentifier ? `${job.issueIdentifier} · ${job.title}` : job.title;
  return (
    <li>
      <Link
        id={id}
        to="/workflows/$repositoryId/jobs/$jobId"
        params={{ repositoryId: job.repositoryId, jobId: job.jobId }}
        title={title}
        activeProps={{ className: "bg-sidebar-row-selected" }}
        className="flex min-w-0 items-start gap-2 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          if (isMobile && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
            setOpenMobile(false);
        }}
      >
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground",
            (kind === "checkpoint" || kind === "blocked") && "text-warning-foreground",
            kind === "running" && "text-info-foreground",
          )}
        />
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          <span className="block truncate text-xs text-sidebar-muted-foreground">
            {job.repositoryName} · {label}
          </span>
        </span>
      </Link>
    </li>
  );
}
