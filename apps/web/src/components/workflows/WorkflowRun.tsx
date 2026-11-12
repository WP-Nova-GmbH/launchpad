import {
  CloudIcon,
  MonitorIcon,
  GitBranchIcon,
  PlayIcon,
  BotIcon,
  HandIcon,
  UploadIcon,
  RefreshCwIcon,
} from "lucide-react";
import { WorkflowAlert } from "./WorkflowAlert";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import {
  workflowSessionKey,
  emptyWorkflowRun,
  sameWorkflowDefinition,
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
  canConfigure?: boolean;
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
  canConfigure = false,
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
  const editor = drafts.accountId === scope.accountId ? drafts.editors[key] : undefined;
  const unsavedDefinition =
    !!editor && !sameWorkflowDefinition(editor.definition, workflow.definition);
  const editWorkflow = () =>
    navigate({
      to: "/workflows/$repositoryId/$workflowId/edit",
      params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
    });
  const backToWorkflows = () =>
    navigate({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: "workflows" },
    });
  const checkRuns = () =>
    navigate({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: "runs" },
    });
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
  const previousSubmission =
    uncertain || checkingPrevious || (pending && draft.operation?.instruction !== draft.instruction)
      ? draft.operation
      : null;
  const error =
    draft.error && !uncertain ? (
      <WorkflowAlert
        title="Could not start this run"
        actions={
          <Button type="button" variant="outline" size="sm" onClick={checkRuns}>
            Check runs
          </Button>
        }
      >
        {draft.error} Your instructions are kept.
      </WorkflowAlert>
    ) : null;
  const recovery = previousSubmission ? (
    <WorkflowAlert
      title={pending ? "Waiting for submission confirmation" : "Previous submission not confirmed"}
      variant={pending ? "info" : "warning"}
      actions={
        !pending ? (
          <Button
            type="button"
            size="sm"
            disabled={confirming}
            onClick={() => (uncertainVm ? void submit(true) : checkRuns())}
          >
            {uncertainVm ? <RefreshCwIcon aria-hidden /> : null}
            {uncertainVm
              ? replayOnly
                ? "Check previous submission"
                : "Retry previous submission"
              : "Check runs"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {draft.error ? (
          <details>
            <summary className="cursor-pointer">Error details</summary>
            <p className="mt-2">{draft.error}</p>
          </details>
        ) : null}
        <p>
          {pending
            ? "Your instructions are kept while confirmation is pending."
            : uncertainVm
              ? "This run may already exist. Retry the same submission before starting another."
              : "This run may already exist. Check Active and History before starting another."}
        </p>
        <details open={previousSubmission.instruction.length < 400}>
          <summary className="cursor-pointer font-medium">
            Previously submitted instructions
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 text-foreground">
            {previousSubmission.instruction}
          </p>
        </details>
      </div>
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
      <div className="mx-auto w-full max-w-xl space-y-5">
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
              {canConfigure ? (
                <Button variant="outline" onClick={editWorkflow}>
                  {workflow.archived ? "Open workflow settings" : "Edit workflow"}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={backToWorkflows}>
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
        {recovery}
        {draft.instruction.trim() ? (
          <label className="block space-y-2">
            <span className="text-sm font-medium">Retained instructions</span>
            <Textarea readOnly value={draft.instruction} />
          </label>
        ) : null}
        {error}
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
      <header className="space-y-4">
        <h1 className="text-xl font-semibold">Run {workflow.definition.name}</h1>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-xs font-medium">Saved workflow</p>
            <p className="text-xs text-muted-foreground">Revision {workflow.revision}</p>
          </div>
          {canConfigure ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || confirming}
              onClick={editWorkflow}
            >
              Edit workflow
            </Button>
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="flex min-w-0 items-start gap-1.5 wrap-anywhere">
            {savedTarget.kind === "vm" ? (
              <CloudIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <MonitorIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
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
              <dd className="flex min-w-0 items-start gap-1.5 wrap-anywhere">
                <GitBranchIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{savedTarget.baseBranch ?? "Repository default"}</span>
              </dd>
            </>
          ) : null}
        </dl>
      </header>
      {!uncertain && unsavedDefinition ? (
        <WorkflowAlert
          title="Your draft changes are not included"
          variant="warning"
          actions={
            canConfigure ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || confirming}
                onClick={editWorkflow}
              >
                Review draft
              </Button>
            ) : undefined
          }
        >
          This run uses the saved workflow.
        </WorkflowAlert>
      ) : null}
      {!uncertain ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">
            Workflow steps ({workflow.definition.steps.length})
          </summary>
          <p className="text-xs text-muted-foreground">
            Uses the saved definition available at dispatch.
          </p>
          <ol className="mt-3 space-y-3">
            {workflow.definition.steps.map((step, index) => {
              const Icon =
                step.kind === "agent" ? BotIcon : step.kind === "action" ? UploadIcon : HandIcon;
              return (
                <li key={step.id} className="flex items-start gap-3 text-sm">
                  <span className="w-5 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium">{step.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {step.kind === "agent"
                        ? "Automatic work"
                        : step.kind === "action"
                          ? step.action === "push"
                            ? "Push branch"
                            : "Open pull request"
                          : step.kind === "review"
                            ? step.role === "member"
                              ? "Repository member approval"
                              : "Maintainer approval"
                            : step.role === "member"
                              ? "Input from a repository member"
                              : "Input from a maintainer"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      {error}
      {recovery}
      {startedJob}
      <label className="block space-y-2">
        <span className="text-sm font-medium">
          {uncertain ? "New run instructions" : "Run instructions"}
        </span>
        <Textarea
          required
          rows={4}
          maxLength={32000}
          disabled={pending}
          value={draft.instruction}
          onChange={(event) =>
            editWorkflowRun(scope, workflow.workflowId, (current) => ({
              ...current,
              instruction: event.target.value,
            }))
          }
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {uncertain ? "Creates a separate run." : "For this run only."}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={backToWorkflows}>
          Back to workflows
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={uncertain ? "outline" : "default"}
          disabled={confirming || pending || !draft.instruction.trim()}
        >
          <PlayIcon aria-hidden />
          {confirming
            ? "Awaiting confirmation…"
            : checkingPrevious
              ? "Checking previous submission…"
              : pending
                ? "Submitting…"
                : uncertain
                  ? "Start an additional run"
                  : "Run workflow"}
        </Button>
      </div>
    </form>
  );
}
