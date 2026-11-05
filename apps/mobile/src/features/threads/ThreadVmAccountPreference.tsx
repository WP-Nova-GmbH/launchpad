import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmCodexAuthSelection } from "@t3tools/contracts/relay";
import { threadVmAuthSourceChoice } from "@t3tools/client-runtime/relay/threadVmControls";
import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ContextSheetSize } from "../../components/ContextSheetSize";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialRadioIndicator } from "../../components/MaterialRadioIndicator";
import { threadVmControls } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function Action({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg bg-card px-3 py-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-sm text-foreground">{label}</Text>
    </Pressable>
  );
}

/** Opened only for a registered local chat; account metadata never wakes its VM. */
export function ThreadVmAccountPreference({
  environmentId,
  threadId,
  accountId,
  disabled,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  accountId: string;
  disabled: boolean;
  onClose: () => void;
}) {
  const state = useAtomValue(threadVmControls.codexPreferenceViewAtom(environmentId, threadId));
  const save = useAtomCommand(threadVmControls.setCodexPreference, { reportFailure: false });
  const check = useAtomCommand(threadVmControls.refreshCodexPreference, { reportFailure: false });
  const retry = useAtomCommand(threadVmControls.retryCodexPreference, { reportFailure: false });
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const pending = state.phase === "saving" || state.phase === "unknown";
  const selection = pending && state.hasRequested ? state.requested : state.data?.selection;
  const choice = threadVmAuthSourceChoice(selection, state.connection);
  const organizationValue =
    state.phase === "saving" && selection?.mode === "organization"
      ? `organization:${selection.connectionId}`
      : choice.organizationValue;
  const blocked =
    disabled || state.phase === "saving" || state.isPending || state.data?.editable !== true;
  const unavailableOrganization =
    selection?.mode === "organization" &&
    (state.connection?.connectionId !== selection.connectionId ||
      state.connection.status !== "connected");
  const select = (value: RelayThreadVmCodexAuthSelection | null) => {
    if (blocked || !state.data) return;
    void save({
      environmentId,
      threadId,
      accountId,
      selection: value,
      expectedGeneration: state.data.generation,
      expectedRevision: state.data.revision,
    });
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      onRequestClose={onClose}
    >
      <View className={Platform.OS === "android" ? "flex-1 justify-end bg-backdrop" : "flex-1"}>
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close VM account"
            onPress={onClose}
            style={{ position: "absolute", inset: 0 }}
          />
        ) : null}
        <View
          className="overflow-hidden rounded-t-3xl bg-sheet-solid"
          style={Platform.OS === "android" ? { maxHeight: "90%" } : { flex: 1 }}
        >
          <ContextSheetSize height={height} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={(_width, value) => setHeight(value)}
            contentContainerStyle={{
              padding: 16,
              paddingBottom: Math.max(20, insets.bottom),
              gap: 16,
            }}
          >
            <Text accessibilityRole="header" className="text-lg font-t3-semibold text-foreground">
              Account for the next VM
            </Text>
            <Text className="text-sm text-muted-foreground">
              Remember a Codex account for this chat. Your current machine’s account stays
              unchanged.
            </Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Codex account for the next VM">
              <MaterialListRow
                title="Personal sign-in"
                accessibilityRole="radio"
                accessibilityState={{
                  checked: choice.selectedValue === "personal",
                  disabled: blocked,
                }}
                disabled={blocked}
                trailing={<MaterialRadioIndicator selected={choice.selectedValue === "personal"} />}
                onPress={() => {
                  if (choice.selectedValue !== "personal") select({ mode: "personal" });
                }}
              />
              <MaterialListRow
                title="Organization Codex"
                subtitle={state.connection?.label}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: choice.selectedValue === organizationValue,
                  disabled: blocked || state.connection?.status !== "connected",
                }}
                disabled={blocked || state.connection?.status !== "connected"}
                trailing={
                  <MaterialRadioIndicator selected={choice.selectedValue === organizationValue} />
                }
                onPress={() => {
                  if (choice.selectedValue !== organizationValue && state.connection?.connectionId)
                    select({ mode: "organization", connectionId: state.connection.connectionId });
                }}
              />
            </View>
            <Text className="text-sm text-muted-foreground">
              Personal sign-in may still be needed inside a new VM.
            </Text>
            {unavailableOrganization ? (
              <Text className="text-sm text-muted-foreground">
                The saved organization account is unavailable. Reconnect it in Organization
                settings, or choose a different account here.
              </Text>
            ) : state.connection?.status !== "connected" ? (
              <Text className="text-sm text-muted-foreground">
                Connect Codex for VMs in Organization settings to use the organization account.
              </Text>
            ) : null}
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
              {state.phase === "saving"
                ? "Saving choice…"
                : state.phase === "unknown"
                  ? "Could not confirm the saved choice. Check it or choose another account."
                  : state.isPending
                    ? "Checking saved choice…"
                    : !state.data
                      ? "Could not check the saved choice."
                      : selection?.mode === "personal"
                        ? "Saved choice: Personal sign-in."
                        : selection?.mode === "organization"
                          ? "Saved choice: Organization Codex."
                          : "No account choice saved. Choose an account when the next VM is prepared."}
            </Text>
            {disabled || (state.data && !state.data.editable) ? (
              <Text className="text-sm text-muted-foreground">
                Resolve the current move before changing the saved account.
              </Text>
            ) : null}
            {state.error ? (
              <Text accessibilityRole="alert" className="text-sm text-destructive">
                {state.error}
              </Text>
            ) : null}
            {state.phase === "unknown" ? (
              <>
                <Action
                  label="Check saved choice"
                  disabled={state.isPending}
                  onPress={() => void check({ environmentId, threadId })}
                />
                <Action
                  label="Retry same choice"
                  disabled={
                    disabled ||
                    state.isPending ||
                    (state.requested?.mode === "organization" &&
                      (state.connection?.connectionId !== state.requested.connectionId ||
                        state.connection.status !== "connected"))
                  }
                  onPress={() => void retry({ environmentId, threadId, accountId })}
                />
              </>
            ) : state.error || state.data?.editable === false ? (
              <Action
                label="Check saved choice"
                disabled={state.isPending || state.phase === "saving"}
                onPress={() => void check({ environmentId, threadId })}
              />
            ) : null}
            <Action
              label="Clear saved choice"
              disabled={blocked || (state.data?.selection === null && !state.hasRequested)}
              onPress={() => select(null)}
            />
            <Action label="Close" onPress={onClose} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
