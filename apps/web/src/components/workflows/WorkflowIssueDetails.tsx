import { workflowIssueUrl, type RepositoryWorkflowJob } from "@t3tools/contracts/workflows";

export function WorkflowIssueDetails({ job }: { job: RepositoryWorkflowJob }) {
  const issue = job.issueSnapshot ?? job.event;
  if (job.origin?.kind !== "automation" || !issue)
    return <p className="mt-2 text-sm">{job.instruction}</p>;
  const url = workflowIssueUrl(issue.url);
  const snapshot = job.issueSnapshot;
  const awaitingSnapshot =
    !snapshot && job.status === "queued" && job.workflow === null && job.progress === null;
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            {issue.identifier}
          </a>
        ) : (
          issue.identifier
        )}
        : {issue.title}
      </p>
      {!awaitingSnapshot ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">Issue details</summary>
          {snapshot ? (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Saved for this run · {snapshot.retrievedAt}
              </p>
              <p>
                Team: {snapshot.team.name} · Status: {snapshot.status.name}
              </p>
              <p>Labels: {snapshot.labels.map((label) => label.name).join(", ") || "None"}</p>
              <p className="whitespace-pre-wrap">{snapshot.description || "No description."}</p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                No issue snapshot was saved for this job. Its stored instructions are shown below.
              </p>
              <p className="whitespace-pre-wrap">{job.instruction}</p>
            </div>
          )}
        </details>
      ) : (
        <p className="text-xs text-muted-foreground">
          Issue details will be read before this job starts.
        </p>
      )}
    </div>
  );
}
