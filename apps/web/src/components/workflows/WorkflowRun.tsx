import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import {
  workflowSessionKey,
  emptyWorkflowRun,
  workflowDraftAtom,
  type WorkflowScope,
  type WorkflowRunDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  useWorkflowDrafts,
  useWorkflowClient,
  useActiveWorkflowView,
  editWorkflowRun,
  runWorkflowDraft,
  confirmWorkflow,
} from "./workflowState";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { appAtomRegistry } from "../../rpc/atomRegistry";

type WorkflowRunProps = {
  scope: WorkflowScope;
  workflow: RepositoryWorkflow;
  projects: ReadonlyArray<RelayOrganizationProject>;
  call: ReturnType<typeof useWorkflowClient>;
};

export function WorkflowRun(props: WorkflowRunProps) {
  return (
    <WorkflowRunForm
      key={workflowSessionKey(
        props.scope,
        `${props.workflow.workflowId}:${props.workflow.archived}`,
      )}
      {...props}
    />
  );
}

function WorkflowRunForm({ scope, workflow, projects, call }: WorkflowRunProps) {
  const navigate = useNavigate();
  const active = useActiveWorkflowView();
  const submission = useRef<{ draft: WorkflowRunDraft } | null>(null);
  const [confirming, setConfirming] = useState(false);
  useLayoutEffect(
    () => () => {
      // Receipts may arrive after the next form commits but before passive cleanup.
      submission.current = null;
    },
    [],
  );
  const drafts = useWorkflowDrafts();
  const key = workflowSessionKey(scope, workflow.workflowId);
  const draft = drafts.runs[key] ?? emptyWorkflowRun;
  const target = projects.find(
    (project) =>
      project.environmentId === workflow.definition.environmentId &&
      project.projectId === workflow.definition.projectId,
  );
  const pending = draft.operation?.state === "pending";
  const uncertain = draft.operation?.state === "uncertain";
  const submit = async () => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    const current = state.runs[key];
    if (
      state.accountId !== scope.accountId ||
      !active.current ||
      submission.current ||
      !current?.instruction.trim() ||
      current.operation?.state === "pending" ||
      workflow.archived
    )
      return;
    const request = { draft: current };
    submission.current = request;
    const ownsSubmission = () =>
      active.current &&
      submission.current === request &&
      appAtomRegistry.get(workflowDraftAtom).accountId === scope.accountId;
    try {
      if (current.operation?.state === "uncertain") {
        setConfirming(true);
        if (
          !(await confirmWorkflow(
            "The previous run may already have started. Starting another can create an additional job. Continue?",
          ))
        )
          return;
      }
      if (!ownsSubmission() || appAtomRegistry.get(workflowDraftAtom).runs[key] !== request.draft)
        return;
      setConfirming(false);
      const job = await runWorkflowDraft(scope, workflow.workflowId, (instruction) =>
        call((client, token) =>
          client.runWorkflow({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            payload: { workflowId: workflow.workflowId, instruction },
          }),
        ),
      );
      if (job && ownsSubmission())
        void navigate({
          to: "/workflows/$repositoryId/jobs/$jobId",
          params: { repositoryId: scope.repositoryId, jobId: job.jobId },
        });
    } finally {
      if (submission.current === request) {
        submission.current = null;
        if (active.current) setConfirming(false);
      }
    }
  };
  return (
    <form
      className="mx-auto w-full max-w-xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Run {workflow.definition.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {workflow.definition.steps.length} steps ·{" "}
          {target
            ? target.machineLabel + " · " + target.title
            : "Saved execution target is unavailable"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Uses the saved workflow. Queued jobs use its current definition when dispatched.
        </p>
      </div>
      {workflow.archived ? (
        <p className="text-sm text-warning">Restore this workflow before running it.</p>
      ) : null}
      <label className="block space-y-2">
        <span className="text-sm font-medium">What should this run accomplish?</span>
        <Textarea
          required
          rows={6}
          maxLength={32000}
          disabled={pending}
          value={draft.instruction}
          onChange={(event) =>
            editWorkflowRun(scope, workflow.workflowId, (draft) => ({
              ...draft,
              instruction: event.target.value,
            }))
          }
        />
      </label>
      {draft.error ? (
        <p role="alert" className="text-sm text-destructive">
          {draft.error}
        </p>
      ) : null}
      {uncertain ? (
        <div className="space-y-2">
          <p className="text-sm text-warning">
            Run may have started. Check recent runs before starting another.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              navigate({
                to: "/workflows/$repositoryId",
                params: { repositoryId: scope.repositoryId },
                search: { tab: "runs" },
              })
            }
          >
            Check recent runs
          </Button>
        </div>
      ) : null}
      {draft.startedJobId ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            navigate({
              to: "/workflows/$repositoryId/jobs/$jobId",
              params: { repositoryId: scope.repositoryId, jobId: draft.startedJobId! },
            })
          }
        >
          View started run
        </Button>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={confirming || pending || workflow.archived || !draft.instruction.trim()}
        >
          {confirming
            ? "Awaiting confirmation…"
            : pending
              ? "Starting…"
              : uncertain
                ? "Start another run"
                : "Run workflow"}
        </Button>
      </div>
    </form>
  );
}
