import { workflowIssueUrl, type RepositoryWorkflowJob } from "@t3tools/contracts/workflows";
import { ChevronRightIcon, ClockIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { parseTimestampDate } from "../../timestampFormat";
import { Button } from "../ui/button";

const captureTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function WorkflowIssueDetails({ job }: { job: RepositoryWorkflowJob }) {
  const snapshot = job.issueSnapshot;
  const issue = snapshot ?? job.event;
  const awaitingSnapshot =
    !snapshot &&
    job.progress === null &&
    ((job.status === "queued" && job.workflow === null) ||
      (job.status === "preparing" && job.startAttempted === false));
  const issueHeading = useRef<HTMLHeadingElement>(null);
  const restoreDisclosureFocus = useRef(false);
  const registerDisclosure = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      restoreDisclosureFocus.current = node.ownerDocument.activeElement === node;
    };
  }, []);

  useLayoutEffect(() => {
    const heading = issueHeading.current;
    if (
      awaitingSnapshot &&
      restoreDisclosureFocus.current &&
      heading &&
      heading.ownerDocument.activeElement === heading.ownerDocument.body
    ) {
      heading.focus();
    }
    restoreDisclosureFocus.current = false;
  }, [awaitingSnapshot]);

  if (job.origin?.kind !== "automation" || !issue)
    return <p className="mt-2 text-sm">{job.instruction}</p>;

  const url = workflowIssueUrl(issue.url);
  const capturedAt = snapshot ? parseTimestampDate(snapshot.retrievedAt) : null;

  return (
    <section
      aria-label="Linear issue"
      className="mt-3 space-y-2.5 rounded-lg border bg-muted/20 px-4 py-3 text-sm wrap-anywhere"
    >
      <span role="status" className="sr-only">
        {snapshot
          ? "Linear issue snapshot saved"
          : awaitingSnapshot
            ? "Waiting to capture Linear issue details"
            : "No saved Linear issue snapshot"}
      </span>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_15rem]">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            Linear issue
            <span className="font-medium text-foreground">{issue.identifier}</span>
          </p>
          <h2 ref={issueHeading} tabIndex={-1} className="mt-0.5 font-semibold">
            {issue.title}
          </h2>
        </div>
        {url ? (
          <Button
            variant="outline"
            size="compact"
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon aria-hidden />
            Open in Linear
          </Button>
        ) : null}
      </div>
      {awaitingSnapshot ? (
        <div className="flex items-start gap-2 border-t pt-2.5">
          <ClockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">Waiting to capture</p>
            <p className="text-xs text-muted-foreground">
              If this run starts, Launchpad will capture the issue details first.
            </p>
          </div>
        </div>
      ) : (
        <>
          <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {snapshot ? "Saved for this run" : "No Linear snapshot was saved for this run."}
            {snapshot && capturedAt ? (
              <time dateTime={snapshot.retrievedAt}>{captureTimeFormatter.format(capturedAt)}</time>
            ) : null}
          </p>
          <details className="group border-t pt-2">
            <summary
              ref={registerDisclosure}
              className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
            >
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground group-open:rotate-90"
              />
              {snapshot ? "Saved issue details" : "Run instructions"}
            </summary>
            <div className="mt-2 space-y-2 pl-5">
              {snapshot ? (
                <>
                  <p className="whitespace-pre-wrap">{snapshot.description || "No description."}</p>
                  <dl className="flex flex-wrap gap-x-5 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      <dt className="text-xs text-muted-foreground">Team</dt>
                      <dd>{snapshot.team.name}</dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      <dt className="text-xs text-muted-foreground">Status</dt>
                      <dd>{snapshot.status.name}</dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      <dt className="text-xs text-muted-foreground">Labels</dt>
                      <dd>{snapshot.labels.map((label) => label.name).join(", ") || "None"}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="whitespace-pre-wrap">{job.instruction}</p>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
