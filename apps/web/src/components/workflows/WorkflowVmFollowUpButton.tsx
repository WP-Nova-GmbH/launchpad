import type { RelayWorkflowVmFollowUp } from "@t3tools/contracts/relay";
import type { WorkflowScope } from "@t3tools/client-runtime/relay/workflow-session";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  ArrowLeftIcon,
  ClockIcon,
  CloudDownloadIcon,
  CloudIcon,
  CloudOffIcon,
  RotateCwIcon,
  UnlinkIcon,
} from "lucide-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectWorkflowVmFollowUp } from "../../state/workflowVmFollowUp";
import { Button } from "../ui/button";
import { WorkflowOutcome } from "./WorkflowOutcome";
import { useWorkflowClient, workflowError } from "./workflowState";
import { workflowRunsReturnForJob } from "./workflowRunsNavigation";

const pendingStatus = {
  waiting_capacity: { title: "Waiting for a VM slot", icon: ClockIcon },
  waiting_codex: { title: "Reconnect Codex to continue", icon: UnlinkIcon },
  resuming: { title: "Resuming workspace", icon: ClockIcon },
  restoring: { title: "Restoring workspace", icon: CloudDownloadIcon },
};

type FollowUpState =
  | { state: "idle" }
  | { state: "opening" }
  | { state: "pending"; phase: keyof typeof pendingStatus; detail: string }
  | { state: "failed"; detail: string; publishingDetail?: string | null }
  | { state: "unavailable"; detail: string; publishingDetail: string | null };

export function WorkflowVmFollowUpButton({
  scope,
  jobId,
  title,
  onWorkspaceUnavailable,
  savedResultsAction,
  runDetailsFallback = false,
}: {
  scope: WorkflowScope;
  jobId: string;
  title: string;
  onWorkspaceUnavailable?: () => void;
  savedResultsAction?: ReactNode;
  runDetailsFallback?: boolean;
}) {
  const navigate = useNavigate();
  const runsReturn = useLocation({ select: ({ state }) => state.workflowRunsReturn });
  const returnContext = workflowRunsReturnForJob(scope, jobId, runsReturn);
  const call = useWorkflowClient(scope);
  const connect = useAtomCommand(connectWorkflowVmFollowUp, { reportFailure: false });
  const request = useRef<symbol | null>(null);
  const task = useRef<HTMLDivElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<FollowUpState>({ state: "idle" });

  useEffect(
    () => () => {
      request.current = null;
    },
    [],
  );

  const accept = useCallback(
    async (result: RelayWorkflowVmFollowUp, current: symbol) => {
      const ownsRequest = () =>
        request.current === current &&
        appAtomRegistry.get(managedRelaySessionAtom)?.accountId === scope.accountId;
      if (!ownsRequest()) return;
      if (result.state !== "running") {
        if (result.state === "expired" || result.state === "unavailable") {
          request.current = null;
          const push = result.publishing;
          const publishDetail =
            push?.detail ??
            (push?.status === "pushed"
              ? "The follow-up commit reached " + push.branch + "."
              : null);
          const detail = result.detail.replace(
            / Select Continue in VM to (?:resume|restore) it\.$/u,
            "",
          );
          if (result.state === "expired" || result.canRetry === false) {
            setState({ state: "unavailable", detail, publishingDetail: publishDetail });
            onWorkspaceUnavailable?.();
          } else {
            setState({ state: "failed", detail, publishingDetail: publishDetail });
          }
        } else {
          setState({ state: "pending", phase: result.state, detail: result.detail });
        }
        return;
      }

      const origin = {
        accountId: scope.accountId,
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        jobId,
        threadId: result.threadId,
        workflowVmFollowUpGeneration: result.generation,
      };
      setState({ state: "opening" });
      const connection = await connect({ ...result, title, origin });
      if (!ownsRequest()) return;
      if (connection._tag === "Failure") throw squashAtomCommandFailure(connection);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: result.environmentId, threadId: result.threadId },
        state: {
          workflowOrigin: origin,
          ...(returnContext ? { workflowRunsReturn: returnContext } : {}),
        },
      });
    },
    [connect, jobId, navigate, onWorkspaceUnavailable, returnContext, scope, title],
  );

  const fail = useCallback(
    (error: unknown, current: symbol) => {
      if (
        request.current !== current ||
        appAtomRegistry.get(managedRelaySessionAtom)?.accountId !== scope.accountId
      )
        return;
      request.current = null;
      setState({ state: "failed", detail: workflowError(error) });
    },
    [scope.accountId],
  );

  useEffect(() => {
    const current = request.current;
    if (state.state !== "pending" || !current) return;
    const timeout = window.setTimeout(() => {
      void call((client, clerkToken) =>
        client.getWorkflowVmFollowUp({ clerkToken, repositoryId: scope.repositoryId, jobId }),
      )
        .then((result) => accept(result, current))
        .catch((error) => fail(error, current));
    }, 2_000);
    return () => window.clearTimeout(timeout);
  }, [accept, call, fail, jobId, scope.repositoryId, state]);

  const start = () => {
    if (request.current || state.state === "unavailable") return;
    const button = actionButton.current;
    if (button && button.ownerDocument.activeElement === button) {
      task.current?.focus({ preventScroll: true });
    }
    const current = Symbol();
    request.current = current;
    setState({ state: "opening" });
    void call((client, clerkToken) =>
      client.continueWorkflowVm({ clerkToken, repositoryId: scope.repositoryId, jobId }),
    )
      .then((result) => accept(result, current))
      .catch((error) => fail(error, current));
  };

  let heading = "Continue the conversation";
  let detail = "Open the run’s conversation with its files in a VM.";
  let icon = CloudIcon;
  let tone: "neutral" | "warning" | "error" = "neutral";

  if (state.state === "opening") {
    heading = "Opening VM…";
    detail = "The conversation opens when the workspace is ready.";
    icon = ClockIcon;
  } else if (state.state === "pending") {
    const status = pendingStatus[state.phase];
    heading = status.title;
    icon = status.icon;
    detail = state.detail;
    if (state.phase === "waiting_capacity" && state.detail === "Waiting for a workflow VM slot.") {
      detail = "The workspace opens automatically when a slot is available.";
    } else if (
      state.phase === "restoring" &&
      state.detail === "Restoring the saved workflow workspace."
    ) {
      detail = "The conversation opens when the workspace is ready.";
    } else if (
      state.phase === "resuming" &&
      state.detail === "Waiting for the existing VM to resume."
    ) {
      detail = "The conversation opens when the VM is ready.";
    }
    if (state.phase === "waiting_codex") tone = "warning";
  } else if (state.state === "failed" || state.state === "unavailable") {
    const failed = state.state === "failed";
    heading = failed ? "Couldn’t open VM" : "Workspace unavailable";
    // Run details knows whether a saved result can be opened.
    detail =
      savedResultsAction === undefined
        ? state.detail
        : state.detail.replace(/ (?:The original saved|Saved) results are still available\.$/u, "");
    icon = CloudOffIcon;
    tone = failed ? "error" : "warning";
  }

  const publishingDetail = "publishingDetail" in state ? state.publishingDetail : null;
  return (
    <div ref={task} tabIndex={-1} role="group" aria-label="Workflow VM follow-up">
      <WorkflowOutcome
        title={heading}
        tone={tone}
        icon={state.state === "failed" ? undefined : icon}
        actions={
          state.state === "idle" || state.state === "failed" ? (
            <Button ref={actionButton} size="sm" onClick={start}>
              {state.state === "failed" ? <RotateCwIcon aria-hidden /> : <CloudIcon aria-hidden />}
              {state.state === "failed" ? "Retry opening VM" : "Continue in VM"}
            </Button>
          ) : state.state === "unavailable" ? (
            (savedResultsAction ??
            (runDetailsFallback ? (
              <Button
                size="sm"
                render={
                  <Link
                    to="/workflows/$repositoryId/jobs/$jobId"
                    params={{ repositoryId: scope.repositoryId, jobId }}
                    state={returnContext ? { workflowRunsReturn: returnContext } : {}}
                  />
                }
              >
                <ArrowLeftIcon aria-hidden />
                Open run details
              </Button>
            ) : null))
          ) : null
        }
      >
        <p className="wrap-anywhere">{detail}</p>
        {publishingDetail ? <p className="wrap-anywhere">{publishingDetail}</p> : null}
      </WorkflowOutcome>
    </div>
  );
}
