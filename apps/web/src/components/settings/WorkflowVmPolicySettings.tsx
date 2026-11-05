import { useAuth } from "@clerk/react";
import {
  ManagedRelayTenancy,
  WorkflowVmPolicy,
  WORKFLOW_VM_LIMIT_DESCRIPTION,
  WORKFLOW_VM_LIMIT_INPUT_ERROR,
} from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useSyncExternalStore } from "react";
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
          if (!token || !userId) throw new Error("Sign in to Launchpad Connect first.");
          return runtime.runPromise(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                WorkflowVmPolicy.readWorkflowVmPolicy(client, token, { userId, organizationId }),
              ),
              Effect.mapError((cause) =>
                isScopeError(cause)
                  ? cause
                  : decodedRelayClientError("Could not read the workflow VM limit")(cause),
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
  const busy = state.loading || state.saving;
  const error = state.saveError ?? state.readError;
  const invalid = state.saveError === WORKFLOW_VM_LIMIT_INPUT_ERROR;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <h3 className="px-3 pb-2 text-sm font-medium sm:px-4">Workflow VMs</h3>
      <SettingsRow
        title="Running workflow VMs"
        description={WORKFLOW_VM_LIMIT_DESCRIPTION}
        control={
          state.record ? (
            state.canEdit ? (
              <div className="flex items-center gap-2">
                <div className="w-24">
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    max={2147483647}
                    step={1}
                    aria-label="Running workflow VMs"
                    disabled={busy}
                    value={state.draft}
                    onChange={(event) => controller.edit(event.target.value)}
                  />
                </div>
                <Button disabled={busy} onClick={() => void controller.save()}>
                  {state.saving ? "Saving…" : "Save limit"}
                </Button>
              </div>
            ) : (
              <span className="text-sm tabular-nums">{state.record.maxRunningVms}</span>
            )
          ) : null
        }
      />
      <div className="space-y-2 px-3 py-2 sm:px-4">
        {state.loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading workflow VM limit…
          </p>
        ) : null}
        {state.record && !state.canEdit ? (
          <p className="text-sm text-muted-foreground">
            An organization admin can change this limit.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {state.capabilities?.configuration === false || (!state.capabilities && !state.loading)
            ? state.readError
              ? "Could not verify workflow VM availability."
              : "Workflow VM configuration is unavailable on this relay."
            : state.capabilities?.execution
              ? "Workflow VM execution is available."
              : "VM workflow execution is not available yet."}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
            {invalid ? "" : " Reload the limit before saving again."}
          </p>
        ) : null}
        {state.saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            Limit saved.
          </p>
        ) : null}
        {(error && !invalid) || !state.record ? (
          <Button variant="outline" disabled={busy} onClick={() => void controller.load()}>
            Reload limit
          </Button>
        ) : null}
      </div>
    </div>
  );
}
