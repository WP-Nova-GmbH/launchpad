import type { RelayWorkflowVmFollowUp } from "@t3tools/contracts/relay";
import type { WorkflowScope } from "@t3tools/client-runtime/relay/workflow-session";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { CloudIcon } from "lucide-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectWorkflowVmFollowUp } from "../../state/workflowVmFollowUp";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useWorkflowClient, workflowError } from "./workflowState";

type FollowUpState =
  | { state: "idle" }
  | { state: "opening" }
  | { state: "pending"; detail: string }
  | { state: "failed"; detail: string; canRetry: boolean };

export function WorkflowVmFollowUpButton({
  scope,
  jobId,
  title,
}: {
  scope: WorkflowScope;
  jobId: string;
  title: string;
}) {
  const navigate = useNavigate();
  const call = useWorkflowClient(scope);
  const connect = useAtomCommand(connectWorkflowVmFollowUp, { reportFailure: false });
  const request = useRef<symbol | null>(null);
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
          setState({
            state: "failed",
            detail: publishDetail ? result.detail + " " + publishDetail : result.detail,
            canRetry: result.canRetry !== false,
          });
        } else {
          setState({ state: "pending", detail: result.detail });
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
        state: { workflowOrigin: origin },
      });
    },
    [connect, jobId, navigate, scope, title],
  );

  const fail = useCallback((error: unknown, current: symbol) => {
    if (request.current !== current) return;
    request.current = null;
    setState({ state: "failed", detail: workflowError(error), canRetry: true });
  }, []);

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
    if (request.current || (state.state === "failed" && !state.canRetry)) return;
    const current = Symbol();
    request.current = current;
    setState({ state: "opening" });
    void call((client, clerkToken) =>
      client.continueWorkflowVm({ clerkToken, repositoryId: scope.repositoryId, jobId }),
    )
      .then((result) => accept(result, current))
      .catch((error) => fail(error, current));
  };

  const busy = state.state === "opening" || state.state === "pending";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || (state.state === "failed" && !state.canRetry)}
        onClick={start}
      >
        {busy ? <Spinner /> : <CloudIcon aria-hidden />}
        {state.state === "opening" ? "Opening VM…" : "Continue in VM"}
      </Button>
      {state.state === "pending" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.detail}
        </p>
      ) : state.state === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {state.detail}
        </p>
      ) : null}
    </div>
  );
}
