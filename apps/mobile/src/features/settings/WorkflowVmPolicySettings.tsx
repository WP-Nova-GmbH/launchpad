import { ErrorBanner } from "../../components/ErrorBanner";
import { useAuth } from "@clerk/expo";
import {
  ManagedRelayTenancy,
  WorkflowVmPolicy,
  workflowVmLimitDraftStatus,
  WORKFLOW_VM_LIMIT_DESCRIPTION,
  WORKFLOW_VM_LIMIT_INPUT_ERROR,
  WORKFLOW_VM_LIMIT_ZERO_HINT,
  WORKFLOW_VM_LIMIT_ZERO_STATUS,
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
          if (!token || !userId)
            throw new WorkflowVmPolicy.WorkflowVmPolicyScopeError({
              message: "Sign in to Launchpad Connect first.",
            });
          return runtime.runPromise(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                WorkflowVmPolicy.readWorkflowVmPolicy(client, token, {
                  userId,
                  organizationId,
                }),
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
  const limitTitle = "Concurrent workflow VM limit";
  const draftStatus =
    state.record && workflowVmLimitDraftStatus(state.draft, state.record.maxRunningVms);
  const saveError = state.saveError === WORKFLOW_VM_LIMIT_INPUT_ERROR ? null : state.saveError;
  return (
    <View className="border-t border-border pt-4">
      <SettingsSection title="Workflow VMs">
        <View className="gap-3 p-4">
          {state.loading ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              Loading workflow VM limit…
            </Text>
          ) : state.readError ? (
            <>
              <ErrorBanner title="Couldn’t load the VM limit" message={state.readError}>
                <MaterialButton label="Retry" onPress={() => void controller.load()} />
              </ErrorBanner>
              {state.recoveryDraft !== null ? (
                <Text className="text-sm text-foreground-muted">
                  Unsaved limit: {state.recoveryDraft}
                </Text>
              ) : null}
            </>
          ) : state.record ? (
            <>
              <View className="gap-1">
                <Text accessibilityRole="header" className="text-lg text-foreground">
                  {limitTitle}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {WORKFLOW_VM_LIMIT_DESCRIPTION}
                </Text>
              </View>
              {state.canEdit ? (
                <View className="gap-2">
                  <View className="flex-row flex-wrap items-center gap-3">
                    <AppTextInput
                      accessibilityLabel={limitTitle}
                      keyboardType="number-pad"
                      className="min-h-11 w-32 rounded-xl bg-subtle-strong px-3 text-base text-foreground"
                      editable={!state.saving}
                      value={state.draft}
                      onChangeText={controller.edit}
                    />
                    <MaterialButton
                      label={state.saving ? "Saving…" : "Save limit"}
                      tone="primary"
                      disabled={state.saving || draftStatus !== "changed"}
                      onPress={() => void controller.save()}
                    />
                  </View>
                  <Text className="text-sm text-foreground-muted">
                    {WORKFLOW_VM_LIMIT_ZERO_HINT}
                  </Text>
                  {draftStatus === "invalid" ? (
                    <Text
                      accessibilityLiveRegion="polite"
                      className="text-sm text-danger-foreground"
                    >
                      {WORKFLOW_VM_LIMIT_INPUT_ERROR}
                    </Text>
                  ) : null}
                </View>
              ) : (
                <View className="gap-1">
                  <Text className="text-base tabular-nums text-foreground">
                    {state.record.maxRunningVms}
                  </Text>
                  {state.record.maxRunningVms === 0 ? (
                    <Text className="text-sm text-foreground-muted">
                      {WORKFLOW_VM_LIMIT_ZERO_STATUS}
                    </Text>
                  ) : null}
                  <Text className="text-sm text-foreground-muted">
                    An organization admin can change this limit.
                  </Text>
                </View>
              )}
              {state.capabilities?.execution === false ? (
                <Text className="text-sm text-foreground-muted">
                  VM workflow execution is not available yet.
                </Text>
              ) : null}
              {saveError ? (
                <ErrorBanner
                  title="Could not save the VM limit"
                  message={saveError + " Reload the limit before saving again."}
                >
                  <MaterialButton label="Reload limit" onPress={() => void controller.load()} />
                </ErrorBanner>
              ) : null}
              {state.saved ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                  Limit saved.
                </Text>
              ) : null}
            </>
          ) : (
            <View className="gap-1">
              <Text accessibilityRole="header" className="font-t3-medium text-foreground">
                Workflow VM settings unavailable
              </Text>
              <Text className="text-sm text-foreground-muted">
                This relay doesn’t support workflow VM configuration.
              </Text>
            </View>
          )}
        </View>
      </SettingsSection>
    </View>
  );
}
