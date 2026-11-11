import { WorkflowAlert } from "../workflows/WorkflowAlert";
import { useAuth } from "@clerk/react";
import {
  ManagedRelayTenancy,
  WorkflowVmPolicy,
  WORKFLOW_VM_LIMIT_DESCRIPTION,
  WORKFLOW_VM_LIMIT_INPUT_ERROR,
  WORKFLOW_VM_LIMIT_ZERO_HINT,
  WORKFLOW_VM_LIMIT_ZERO_STATUS,
  workflowVmLimitDraftStatus,
} from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RefreshCwIcon, ServerIcon } from "lucide-react";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { decodedRelayClientError } from "../../cloud/linkEnvironment";
import { runtime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

type Controller = ReturnType<typeof WorkflowVmPolicy.makeWorkflowVmPolicyController>;
const isScopeError = Schema.is(WorkflowVmPolicy.WorkflowVmPolicyScopeError);

export function WorkflowVmPolicySettings({ organizationId }: { readonly organizationId: string }) {
  const { getToken, userId } = useAuth();
  const controller = useMemo(
    () =>
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: async () => {
          const token = await getToken(resolveRelayClerkTokenOptions());
          if (!token || !userId)
            throw new WorkflowVmPolicy.WorkflowVmPolicyScopeError({
              message: "Sign in to Launchpad Connect first.",
            });
          return runtime.runPromise(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                WorkflowVmPolicy.readWorkflowVmPolicy(client, token, { userId, organizationId }),
              ),
            ),
          );
        },
        save: async (record) => {
          const token = await getToken(resolveRelayClerkTokenOptions());
          if (!token || !userId) throw new Error("Sign in to Launchpad Connect first.");
          return runtime.runPromise(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                WorkflowVmPolicy.saveWorkflowVmPolicy(
                  client,
                  token,
                  { userId, organizationId },
                  record,
                ),
              ),
              Effect.mapError((cause) =>
                isScopeError(cause)
                  ? cause
                  : decodedRelayClientError("Could not save the workflow VM limit")(cause),
              ),
            ),
          );
        },
      }),
    [getToken, userId, organizationId],
  );
  return <WorkflowVmPolicyForm controller={controller} />;
}

export function WorkflowVmPolicyForm({ controller }: { readonly controller: Controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.load();
    return controller.dispose;
  }, [controller]);
  const descriptionId = useId();
  const draftMessageId = useId();
  const { record } = state;
  const draftStatus =
    record && state.canEdit ? workflowVmLimitDraftStatus(state.draft, record.maxRunningVms) : null;
  const invalid = draftStatus === "invalid";
  const limitLabel = "Concurrent workflow VM limit";

  return (
    <div className="mt-3 border-t border-border py-3">
      <h3 className="flex items-center gap-2 px-3 text-sm font-medium sm:px-4">
        <ServerIcon aria-hidden className="size-4 text-muted-foreground" />
        Workflow VMs
      </h3>
      {state.loading ? (
        <p role="status" className="px-3 pt-3 text-sm text-muted-foreground sm:px-4">
          Loading workflow VM limit…
        </p>
      ) : state.readError ? (
        <div className="px-3 pt-3 sm:px-4">
          <WorkflowAlert
            title="Couldn’t load the VM limit"
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void controller.load()}
              >
                <RefreshCwIcon aria-hidden /> Retry
              </Button>
            }
          >
            <p>{state.readError}</p>
            {state.recoveryDraft !== null ? (
              <p className="mt-1">Unsaved limit: {state.recoveryDraft}</p>
            ) : null}
          </WorkflowAlert>
        </div>
      ) : record ? (
        <>
          <SettingsRow
            title={limitLabel}
            description={
              <span id={descriptionId}>
                <span className="block">{WORKFLOW_VM_LIMIT_DESCRIPTION}</span>
                <span className="mt-1 block">
                  {state.canEdit
                    ? WORKFLOW_VM_LIMIT_ZERO_HINT
                    : "An organization admin can change this limit."}
                </span>
                {!state.canEdit && record.maxRunningVms === 0 ? (
                  <span className="mt-1 block">{WORKFLOW_VM_LIMIT_ZERO_STATUS}</span>
                ) : null}
              </span>
            }
            control={
              state.canEdit ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-24">
                      <Input
                        size="sm"
                        type="number"
                        min={0}
                        max={2147483647}
                        step={1}
                        aria-label={limitLabel}
                        aria-describedby={
                          draftStatus === "unchanged" && !state.saved
                            ? descriptionId
                            : `${descriptionId} ${draftMessageId}`
                        }
                        aria-invalid={invalid || undefined}
                        disabled={state.saving}
                        value={state.draft}
                        onChange={(event) => controller.edit(event.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={state.saving || draftStatus !== "changed"}
                      onClick={() => void controller.save()}
                    >
                      {state.saving ? "Saving…" : "Save limit"}
                    </Button>
                  </div>
                  <div aria-live="polite" id={draftMessageId} className="max-w-48 text-xs">
                    {invalid ? (
                      <p className="text-destructive">{WORKFLOW_VM_LIMIT_INPUT_ERROR}</p>
                    ) : state.saved ? (
                      <p role="status" className="text-muted-foreground">
                        Limit saved.
                      </p>
                    ) : draftStatus === "changed" ? (
                      <p className="text-muted-foreground">
                        Saved limit is {record.maxRunningVms}.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <span className="text-sm tabular-nums">
                  {record.maxRunningVms} {record.maxRunningVms === 1 ? "VM" : "VMs"}
                </span>
              )
            }
          />
          {state.capabilities?.execution === false ? (
            <p className="px-3 text-xs text-muted-foreground sm:px-4">
              VM workflow execution is not available yet.
            </p>
          ) : null}
          {state.saveError ? (
            <div className="px-3 pt-2 sm:px-4">
              <WorkflowAlert
                title="Could not save the VM limit"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void controller.load()}
                  >
                    Reload limit
                  </Button>
                }
              >
                {state.saveError}
              </WorkflowAlert>
            </div>
          ) : null}
        </>
      ) : (
        <div className="px-3 pt-3 sm:px-4">
          <WorkflowAlert title="Workflow VM settings unavailable" variant="info">
            This relay doesn’t support workflow VM configuration.
          </WorkflowAlert>
        </div>
      )}
    </div>
  );
}
