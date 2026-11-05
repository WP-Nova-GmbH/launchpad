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
  return (
    <WorkflowRunForm
      key={workflowSessionKey(
        props.scope,
        `${workflow.workflowId}:${kind}:${workflow.archived}:${vmUnavailable}`,
      )}
      {...props}
      vmUnavailable={vmUnavailable}
    />
  );
}

function WorkflowRunForm({
  scope,
  workflow,
  projects,
  call,
  vmUnavailable,
}: WorkflowRunProps & { vmUnavailable: boolean }) {
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
  const runBlocked = vmUnavailable || workflow.archived;
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
    <p role="alert" className="text-sm text-destructive">
      {draft.error}
    </p>
  ) : null;
  const recoverVm = uncertainVm ? (
    <div className="space-y-2">
      <p className="text-sm text-warning">The previous VM submission could not be confirmed.</p>
      <Button
        type="button"
        variant="outline"
        disabled={confirming}
        onClick={() => void submit(true)}
      >
        {replayOnly ? "Check previous submission" : "Retry previous submission"}
      </Button>
    </div>
  ) : null;
  const recoverMachine =
    uncertain && !uncertainVm ? (
      <div className="space-y-2">
        <p className="text-sm text-warning">Run may have started. Check recent runs to confirm.</p>
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
        <p className="text-sm text-muted-foreground">
          {workflow.archived
            ? "Restore this workflow before running it."
            : "Running VM workflows is not available yet."}
        </p>
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
        <p className="mt-2 text-sm text-muted-foreground">
          {workflow.definition.steps.length} steps ·{" "}
          {savedTarget.kind === "vm"
            ? `VM · ${savedTarget.baseBranch ?? "Repository default"}`
            : target
              ? target.machineLabel + " · " + target.title
              : "Saved execution target is unavailable"}
        </p>
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
