import {
  CloudIcon,
  MonitorIcon,
  GitBranchIcon,
  PlayIcon,
  BotIcon,
  HandIcon,
  UploadIcon,
  RefreshCwIcon,
  ArrowRightIcon,
} from "lucide-react";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowRequestNotSentError } from "./workflowOperations";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import {
  workflowSessionKey,
  emptyWorkflowRun,
  sameWorkflowDefinition,
  workflowDraftAtom,
  type WorkflowScope,
  type WorkflowRunDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  useWorkflowDrafts,
  useWorkflowClient,
  useActiveWorkflowView,
  editWorkflowRun,
  runWorkflowDraft,
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

type AdditionalRunConfirmation = {
  draft: WorkflowRunDraft;
  context: string;
};

// A reopened Run view can observe a change before an earlier form's request is sent.
const latestAdditionalRunContexts = new WeakMap<
  NonNullable<WorkflowRunDraft["operation"]>,
  string
>();

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
  canConfigure = false,
}: WorkflowRunProps & { vmUnavailable: boolean }) {
  const navigate = useNavigate();
  const active = useActiveWorkflowView();
  const submission = useRef<{ draft: WorkflowRunDraft } | null>(null);
  const confirmationRequest = useRef<AdditionalRunConfirmation | null>(null);
  const [confirmation, setConfirmation] = useState<AdditionalRunConfirmation | null>(null);
  const runHeading = useRef<HTMLHeadingElement>(null);
  const additionalRunControl = useRef<HTMLButtonElement>(null);
  const keepEditingControl = useRef<HTMLButtonElement>(null);
  const startedRunControl = useRef<HTMLButtonElement>(null);
  const recoveryControl = useRef<HTMLButtonElement>(null);
  const removedRecoveryFocus = useRef<Element | null>(null);
  const registerRecoveryRegion = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    return () => {
      const focused = node.ownerDocument.activeElement;
      if (focused && node.contains(focused)) removedRecoveryFocus.current = focused;
    };
  }, []);
  useLayoutEffect(() => {
    const previous = removedRecoveryFocus.current;
    if (!previous) return;
    removedRecoveryFocus.current = null;
    const { activeElement, body } = previous.ownerDocument;
    if (activeElement === previous || activeElement === body)
      (recoveryControl.current ?? startedRunControl.current ?? runHeading.current)?.focus();
  });
  useLayoutEffect(
    () => () => {
      // Invalidate callbacks when the next form commits, before passive cleanup.
      submission.current = null;
      confirmationRequest.current = null;
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
  const runBlocked = vmUnavailable || workflow.archived;
  const replayOnly = runBlocked || savedTarget.kind !== "vm";
  const pendingRecovery =
    pending && draft.recovery?.kind !== "additional-rejected" ? draft.recovery : undefined;
  const checkOnly = pendingRecovery?.kind === "retry" ? pendingRecovery.replayOnly : replayOnly;
  const checkingPrevious = pending && checkOnly && draft.operation?.targetKind === "vm";
  const confirmationContext = JSON.stringify([
    workflow.revision,
    runBlocked,
    savedTarget.kind,
    ...(savedTarget.kind === "vm"
      ? [savedTarget.baseBranch ?? null]
      : [savedTarget.environmentId, savedTarget.projectId, !!target]),
  ]);
  const confirming =
    !!confirmation &&
    !runBlocked &&
    confirmation.draft === draft &&
    confirmation.context === confirmationContext;
  if (confirmation && !confirming) setConfirmation(null);
  useLayoutEffect(() => {
    if (pendingRecovery?.kind === "additional" && draft.operation)
      latestAdditionalRunContexts.set(draft.operation, confirmationContext);
    const request = confirmationRequest.current;
    if (
      request &&
      (runBlocked || request.draft !== draft || request.context !== confirmationContext)
    )
      confirmationRequest.current = null;
  });

  const closeConfirmation = () => {
    confirmationRequest.current = null;
    setConfirmation(null);
  };
  const openConfirmation = () => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    const current = state.runs[key];
    if (
      !active.current ||
      state.accountId !== scope.accountId ||
      submission.current ||
      confirmationRequest.current ||
      runBlocked ||
      current?.operation?.state !== "uncertain" ||
      !current.instruction.trim()
    )
      return;
    const request = { draft: current, context: confirmationContext };
    confirmationRequest.current = request;
    setConfirmation(request);
  };
  const submit = async (recover: boolean, confirmed?: AdditionalRunConfirmation) => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    const current = state.runs[key];
    if (
      state.accountId !== scope.accountId ||
      !active.current ||
      submission.current ||
      confirmationRequest.current ||
      !current ||
      current.operation?.state === "pending"
    )
      return;
    if (recover) {
      if (current.operation?.targetKind !== "vm") return;
    } else if (
      !current.instruction.trim() ||
      runBlocked ||
      (current.operation?.state === "uncertain" ? current !== confirmed?.draft : !!confirmed)
    )
      return;
    const request = { draft: current };
    submission.current = request;
    const ownsSubmission = () =>
      active.current &&
      submission.current === request &&
      appAtomRegistry.get(workflowDraftAtom).accountId === scope.accountId;
    try {
      const job = await runWorkflowDraft(
        scope,
        workflow.workflowId,
        recover
          ? { kind: "recover", replayOnly }
          : {
              kind: "start",
              targetKind: savedTarget.kind,
              replaceUncertain: !!confirmed,
            },
        (payload) => {
          const operation = confirmed
            ? appAtomRegistry.get(workflowDraftAtom).runs[key]?.operation
            : null;
          return call((client, token) => {
            // Authentication may resolve after the displayed workflow has changed.
            if (
              confirmed &&
              (!operation ||
                appAtomRegistry.get(workflowDraftAtom).runs[key]?.operation !== operation ||
                (latestAdditionalRunContexts.get(operation) ?? confirmed.context) !==
                  confirmed.context)
            )
              throw new WorkflowRequestNotSentError(
                "The saved workflow changed before the run was sent. Review the execution target and try again.",
              );
            return client.runWorkflow({
              clerkToken: token,
              repositoryId: scope.repositoryId,
              payload,
            });
          });
        },
      );
      if (!ownsSubmission()) return;
      const latest = appAtomRegistry.get(workflowDraftAtom).runs[key];
      if (job && (!recover || !latest?.instruction.trim()))
        void navigate({
          to: "/workflows/$repositoryId/jobs/$jobId",
          params: { repositoryId: scope.repositoryId, jobId: job.jobId },
        });
    } finally {
      if (submission.current === request) submission.current = null;
    }
  };
  const previousSubmission = uncertain
    ? draft.operation
    : pending
      ? (pendingRecovery?.previous ??
        (checkingPrevious || draft.operation?.instruction !== draft.instruction
          ? draft.operation
          : null))
      : null;
  const originalVm = previousSubmission?.targetKind === "vm";
  const additionalRejected =
    uncertain && draft.recovery?.kind === "additional-rejected" && !!draft.error;
  const waitingForSubmission = pending
    ? pendingRecovery?.kind === "additional"
      ? "Waiting for confirmation of the additional run."
      : checkingPrevious
        ? "Checking the previous submission for a receipt."
        : "Waiting for confirmation of the previous submission."
    : "";
  const recoveryLabel = originalVm
    ? checkOnly
      ? "Check previous submission"
      : "Retry previous submission"
    : "Check runs";
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
  const additionalRunError = additionalRejected ? (
    <WorkflowAlert title="Could not start the additional run">
      {draft.error} Your instructions are kept.
    </WorkflowAlert>
  ) : null;
  const recovery = previousSubmission ? (
    <WorkflowAlert
      title={pending ? "Waiting for submission confirmation" : "Previous submission not confirmed"}
      variant={pending ? "info" : "warning"}
      announce={!pending && !additionalRejected}
    >
      <div ref={registerRecoveryRegion} className="space-y-2.5">
        <p role="status" className={pending ? undefined : "sr-only"}>
          {waitingForSubmission}
        </p>
        {!pending ? (
          <p>
            {originalVm
              ? replayOnly
                ? "Check whether the original VM submission was accepted."
                : "This run may already exist. Retrying uses the original instructions below."
              : "This run may already exist. Check Active and History for the original submission."}
          </p>
        ) : null}
        <Button
          ref={recoveryControl}
          type="button"
          size="sm-multiline"
          aria-disabled={pending || confirming || undefined}
          onClick={() => {
            if (pending || submission.current || confirmationRequest.current) return;
            if (originalVm) void submit(true);
            else checkRuns();
          }}
        >
          {originalVm ? <RefreshCwIcon aria-hidden /> : null}
          {recoveryLabel}
          {!originalVm ? <ArrowRightIcon aria-hidden /> : null}
        </Button>
        <details
          key={previousSubmission.requestId}
          ref={registerRecoveryRegion}
          className="border-t border-current/15 pt-2"
          open={previousSubmission.instruction.length < 400}
        >
          <summary className="cursor-pointer font-medium">
            Previously submitted instructions
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap wrap-anywhere">
            {previousSubmission.instruction}
          </p>
        </details>
        {draft.error && !additionalRejected ? (
          <details>
            <summary className="cursor-pointer">Error details</summary>
            <p className="mt-1.5 wrap-anywhere">{draft.error}</p>
          </details>
        ) : null}
      </div>
    </WorkflowAlert>
  ) : null;
  const startedJob = draft.startedJobId ? (
    <Button
      ref={startedRunControl}
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
        <h1 ref={runHeading} tabIndex={-1} className="text-xl font-semibold">
          Run {workflow.definition.name}
        </h1>
        <WorkflowAlert
          title={workflow.archived ? "Workflow archived" : "VM execution unavailable"}
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
            : "Running VM workflows is not available yet."}
        </WorkflowAlert>
        {recovery}
        {additionalRunError}
        {draft.instruction.trim() ? (
          <label className="block space-y-2">
            <span className="text-sm font-medium">Retained instructions</span>
            <Textarea readOnly value={draft.instruction} />
          </label>
        ) : null}
        {error}
        {startedJob}
      </div>
    );
  const instructions = (label: string, required: boolean) => (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <Textarea
        required={required}
        rows={required ? 4 : 2}
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
        <h1 ref={runHeading} tabIndex={-1} className="text-xl font-semibold">
          Run {workflow.definition.name}
        </h1>
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
      {!previousSubmission && unsavedDefinition ? (
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
      {!previousSubmission ? (
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
      {additionalRunError}
      {previousSubmission ? (
        <details ref={registerRecoveryRegion} className="rounded-lg border px-3.5 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">New run draft</summary>
          <div className="mt-3 space-y-3">
            {instructions("Instructions for a separate run", false)}
            <Button
              ref={additionalRunControl}
              type="button"
              variant="outline"
              size="sm-multiline"
              aria-disabled={pending || confirming || !draft.instruction.trim() || undefined}
              onClick={openConfirmation}
            >
              <PlayIcon aria-hidden />
              Start an additional run
            </Button>
          </div>
        </details>
      ) : (
        <>
          {instructions("Run instructions", true)}
          <p className="text-xs text-muted-foreground">For this run only.</p>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={backToWorkflows}>
          Back to workflows
        </Button>
        {!previousSubmission ? (
          <Button type="submit" size="sm" disabled={pending || !draft.instruction.trim()}>
            <PlayIcon aria-hidden />
            {pending ? "Submitting…" : "Run workflow"}
          </Button>
        ) : null}
      </div>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <AlertDialogPopup
          initialFocus={keepEditingControl}
          finalFocus={() => additionalRunControl.current ?? runHeading.current}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Start a separate run?</AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              The previous run may already exist or could still start. This starts another run of{" "}
              <strong className="font-medium text-popover-foreground">
                {workflow.definition.name}
              </strong>{" "}
              using your new instructions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              ref={keepEditingControl}
              type="button"
              variant="outline"
              onClick={closeConfirmation}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!confirming || confirmationRequest.current !== confirmation) return;
                closeConfirmation();
                void submit(false, confirmation);
              }}
            >
              Start an additional run
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </form>
  );
}
