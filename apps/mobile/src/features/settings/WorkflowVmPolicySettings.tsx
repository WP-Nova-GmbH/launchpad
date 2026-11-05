import { useAuth } from "@clerk/expo";
import {
  ManagedRelayTenancy,
  WorkflowVmPolicy,
  WORKFLOW_VM_LIMIT_DESCRIPTION,
  WORKFLOW_VM_LIMIT_INPUT_ERROR,
} from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { runtime } from "../../lib/runtime";
import { decodedRelayClientError } from "../cloud/linkEnvironment";
import { resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { SettingsSection } from "./components/SettingsSection";

type Controller = ReturnType<typeof WorkflowVmPolicy.makeWorkflowVmPolicyController>;
const isScopeError = Schema.is(WorkflowVmPolicy.WorkflowVmPolicyScopeError);

export function WorkflowVmPolicySettings({ organizationId }: { readonly organizationId: string }) {
  const { getToken, userId } = useAuth({ treatPendingAsSignedOut: false });
  const controller = useMemo(
    () =>
      WorkflowVmPolicy.makeWorkflowVmPolicyController({
        read: async () => {
          const token = await getToken(resolveRelayClerkTokenOptions());
          if (!token || !userId) throw new Error("Sign in to Launchpad Connect first.");
          return runtime.runPromise(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                WorkflowVmPolicy.readWorkflowVmPolicy(client, token, {
                  userId,
                  organizationId,
                }),
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
    <View className="border-t border-border pt-4">
      <SettingsSection title="Workflow VMs">
        <View className="gap-3 p-4">
          <Text className="text-lg text-foreground">Running workflow VMs</Text>
          <Text className="text-sm text-foreground-muted">{WORKFLOW_VM_LIMIT_DESCRIPTION}</Text>
          {state.record ? (
            state.canEdit ? (
              <View className="flex-row items-center gap-3">
                <AppTextInput
                  accessibilityLabel="Running workflow VMs"
                  keyboardType="number-pad"
                  className="min-h-11 w-24 rounded-xl bg-subtle-strong px-3 text-base text-foreground"
                  editable={!busy}
                  value={state.draft}
                  onChangeText={controller.edit}
                />
                <MaterialButton
                  label={state.saving ? "Saving…" : "Save limit"}
                  tone="primary"
                  disabled={busy}
                  onPress={() => void controller.save()}
                />
              </View>
            ) : (
              <Text className="text-base text-foreground">{state.record.maxRunningVms}</Text>
            )
          ) : null}
          {state.loading ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              Loading workflow VM limit…
            </Text>
          ) : null}
          {state.record && !state.canEdit ? (
            <Text className="text-sm text-foreground-muted">
              An organization admin can change this limit.
            </Text>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            {state.capabilities?.configuration === false || (!state.capabilities && !state.loading)
              ? state.readError
                ? "Could not verify workflow VM availability."
                : "Workflow VM configuration is unavailable on this relay."
              : state.capabilities?.execution
                ? "Workflow VM execution is available."
                : "VM workflow execution is not available yet."}
          </Text>
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {error}
              {invalid ? "" : " Reload the limit before saving again."}
            </Text>
          ) : null}
          {state.saved ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              Limit saved.
            </Text>
          ) : null}
          {(error && !invalid) || !state.record ? (
            <MaterialButton
              label="Reload limit"
              disabled={busy}
              onPress={() => void controller.load()}
            />
          ) : null}
        </View>
      </SettingsSection>
    </View>
  );
}
