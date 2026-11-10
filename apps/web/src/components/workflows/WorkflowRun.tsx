import { CloudIcon, MonitorIcon, GitBranchIcon, PlayIcon } from "lucide-react";
import { WorkflowAlert } from "./WorkflowAlert";
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
  vmExecutionAvailable?: boolean;
};

export function WorkflowRun(props: WorkflowRunProps) {
  const { workflow, vmExecutionAvailable } = props;
  const kind = workflow.definition.target.kind;
  const vmUnavailable = kind === "vm" && !vmExecutionAvailable;
  const publishingUnavailable =
    kind === "vm" && workflow.definition.steps.some((step) => step.kind === "action");
  return (
    <WorkflowRunForm
      key={workflowSessionKey(
        props.scope,
        `${workflow.workflowId}:${kind}:${workflow.archived}:${vmUnavailable}:${publishingUnavailable}`,
      )}
      {...props}
      vmUnavailable={vmUnavailable}
      publishingUnavailable={publishingUnavailable}
    />
  );
}

function WorkflowRunForm({
  scope,
  workflow,
  projects,
  call,
  vmUnavailable,
  publishingUnavailable,
}: WorkflowRunProps & { vmUnavailable: boolean; publishingUnavailable: boolean }) {
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
  const draft =
    (drafts.accountId === scope.accountId ? drafts.runs[key] : undefined) ?? emptyWorkflowRun;
  const savedTarget = workflow.definition.target;
  const machine = savedTarget.kind === "machine" ? savedTarget : null;
  const target = projects.find(
    (project) =>
      project.environmentId === machine?.environmentId && project.projectId === machine?.projectId,
  );
  const pending = draft.operation?.state === "pending";
  const uncertain = draft.operation?.state === "uncertain";
  const uncertainVm = uncertain && draft.operation?.targetKind === "vm";
  const runBlocked = vmUnavailable || workflow.archived || publishingUnavailable;
  const replayOnly = runBlocked || savedTarget.kind !== "vm";
  const checkingPrevious = pending && replayOnly && draft.operation?.targetKind === "vm";
  const submit = async (recover: boolean) => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    const current = state.runs[key];
    if (
      state.accountId !== scope.accountId ||
      !active.current ||
      submission.current ||
      !current ||
      current.operation?.state === "pending"
    )
      return;
    if (recover) {
      if (current.operation?.targetKind !== "vm") return;
    } else if (!current.instruction.trim() || runBlocked) return;
    const request = { draft: current };
    submission.current = request;
    const ownsSubmission = () =>
      active.current &&
      submission.current === request &&
      appAtomRegistry.get(workflowDraftAtom).accountId === scope.accountId;
    try {
      if (!recover && current.operation?.state === "uncertain") {
        setConfirming(true);
        if (
          !(await confirmWorkflow(
            "The previous submission may already have started or could still start. Starting another can create an additional run. Continue?",
          ))
        )
          return;
      }
      if (!ownsSubmission() || appAtomRegistry.get(workflowDraftAtom).runs[key] !== request.draft)
        return;
      setConfirming(false);
      const job = await runWorkflowDraft(
        scope,
        workflow.workflowId,
        recover
          ? { kind: "recover", replayOnly }
          : {
              kind: "start",
              targetKind: savedTarget.kind,
              replaceUncertain: current.operation?.state === "uncertain",
            },
        (payload) =>
          call((client, token) =>
            client.runWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
          ),
      );
      const retained = appAtomRegistry.get(workflowDraftAtom).runs[key]?.instruction;
      if (job && ownsSubmission() && (!recover || !retained?.trim()))
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
  const error = draft.error ? (
    <WorkflowAlert
      title={uncertain ? "Run submission not confirmed" : "Could not start this run"}
      variant={uncertain ? "warning" : "error"}
      actions={
        !runBlocked ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
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
        ) : undefined
      }
    >
      {draft.error} Your instructions are kept.
    </WorkflowAlert>
  ) : null;
  const recoverVm = uncertainVm ? (
    <WorkflowAlert
      title="Previous submission not confirmed"
      variant="warning"
      actions={
        <Button
          type="button"
          variant="outline"
          disabled={confirming}
          onClick={() => void submit(true)}
        >
          {replayOnly ? "Check previous submission" : "Retry previous submission"}
        </Button>
      }
    >
      The previous VM submission could not be confirmed. Check or retry it before starting another
      run.
    </WorkflowAlert>
  ) : null;
  const recoverMachine =
    uncertain && !uncertainVm ? (
      <WorkflowAlert
        title="Run may have started"
        variant="warning"
        actions={
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
        }
      >
        Run may have started. Check recent runs to confirm before submitting again.
      </WorkflowAlert>
    ) : null;
  const startedJob = draft.startedJobId ? (
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
  ) : null;
  if (runBlocked)
    return (
      <div className="mx-auto w-full max-w-xl space-y-2">
        <h1 className="text-xl font-semibold">Run {workflow.definition.name}</h1>
        <WorkflowAlert
          title={
            workflow.archived
              ? "Workflow archived"
              : publishingUnavailable
                ? "Publishing requires a Machine"
                : "VM execution unavailable"
          }
          variant="warning"
          actions={
            <>
              <Button
                variant="outline"
                onClick={() =>
                  navigate({
                    to: "/workflows/$repositoryId/$workflowId/edit",
                    params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
                  })
                }
              >
                {workflow.archived ? "Open workflow settings" : "Edit workflow"}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  navigate({
                    to: "/workflows/$repositoryId",
                    params: { repositoryId: scope.repositoryId },
                    search: { tab: "workflows" },
                  })
                }
              >
                Back to workflows
              </Button>
            </>
          }
        >
          {workflow.archived
            ? "Restore this workflow before running it."
            : publishingUnavailable
              ? "Publishing requires a Machine target. Remove Push branch and Open PR steps to use VM."
              : "Running VM workflows is not available yet."}
        </WorkflowAlert>
        {draft.instruction.trim() ? (
          <label className="block space-y-2">
            <span className="text-sm font-medium">Retained instructions</span>
            <Textarea readOnly value={draft.instruction} />
          </label>
        ) : null}
        {error}
        {recoverVm}
        {recoverMachine}
        {checkingPrevious ? <p role="status">Checking previous submission…</p> : null}
        {startedJob}
      </div>
    );
  return (
    <form
      className="mx-auto w-full max-w-xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Run {workflow.definition.name}</h1>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="flex min-w-0 items-center gap-1.5 wrap-anywhere">
            {savedTarget.kind === "vm" ? (
              <CloudIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span>
              {savedTarget.kind === "vm"
                ? "VM"
                : target
                  ? `${target.machineLabel} / ${target.title}`
                  : "Saved execution target is unavailable"}
            </span>
          </dd>
          {savedTarget.kind === "vm" ? (
            <>
              <dt className="text-muted-foreground">Base branch</dt>
              <dd className="flex min-w-0 items-center gap-1.5 wrap-anywhere">
                <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                <span>{savedTarget.baseBranch ?? "Repository default"}</span>
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Steps</dt>
          <dd>{workflow.definition.steps.length}</dd>
        </dl>
        <p className="mt-1 text-xs text-muted-foreground">
          Uses the saved workflow. Queued jobs use its current definition when dispatched.
        </p>
      </div>
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
      {error}
      {recoverVm}
      {recoverMachine}
      {startedJob}
      <div>
        <Button type="submit" disabled={confirming || pending || !draft.instruction.trim()}>
          <PlayIcon aria-hidden />
          {confirming
            ? "Awaiting confirmation…"
            : checkingPrevious
              ? "Checking previous submission…"
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
