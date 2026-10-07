import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { readConnectedClient, renameConnectedClient } from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionFormField } from "./ConnectionFormField";
import { rememberClientLabel, useClientName } from "./useClientName";

function ClientNameDialog({
  environmentId,
  environmentLabel,
  onClose,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  onClose: () => void;
}) {
  const live = useEnvironmentQuery(authEnvironment.currentSession({ environmentId, input: null }));
  const [suggestion] = useClientName();
  const [name, setName] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const edited = useRef(false);
  const latestLive = useRef(live.data);
  const storedLabel = useRef<string | null>(null);
  const submitting = useRef(false);
  const read = useAtomCommand(readConnectedClient, { reportFailure: false });
  const rename = useAtomCommand(renameConnectedClient, { reportFailure: false });
  useEffect(() => {
    if (!edited.current && !storedLabel.current) setName(suggestion);
  }, [suggestion]);
  useEffect(() => {
    let active = true;
    const liveAtRequest = latestLive.current;
    void read(environmentId).then((result) => {
      if (
        active &&
        latestLive.current === liveAtRequest &&
        result._tag === "Success" &&
        result.value.currentSession?.client.label
      ) {
        storedLabel.current = result.value.currentSession.client.label;
        if (!edited.current) setName(storedLabel.current);
      }
    });
    return () => {
      active = false;
    };
  }, [environmentId, read]);
  useEffect(() => {
    latestLive.current = live.data;
    const label = live.data?.client.label;
    if (label) {
      storedLabel.current = label;
      if (!edited.current) setName(label);
    }
  }, [live.data]);
  const save = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    const result = await rename({ environmentId, label: name });
    submitting.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      await rememberClientLabel(name);
      onClose();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save the client name.");
    }
  };
  return (
    <Modal
      visible
      onRequestClose={() => {
        if (!submitting.current) onClose();
      }}
      animationType="slide"
      presentationStyle="pageSheet"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-background"
      >
        <View accessibilityViewIsModal className="gap-5 px-5 pb-6 pt-12">
          <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
            Name this client
          </Text>
          <Text className="text-sm text-foreground-muted">
            A client name on {environmentLabel}.
          </Text>
          <ConnectionFormField
            label="Client name"
            value={name}
            onChangeText={(value) => {
              edited.current = true;
              setName(value);
            }}
            maxLength={80}
            autoFocus
            editable={!saving}
            returnKeyType="done"
            onSubmitEditing={() => {
              void save();
            }}
          />
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {error}
            </Text>
          ) : null}
          <MaterialButton
            label={saving ? "Saving…" : "Save name"}
            disabled={saving || !name.trim()}
            onPress={() => {
              void save();
            }}
            tone="primary"
            fullWidth
          />
          <MaterialButton label="Cancel" disabled={saving} onPress={onClose} fullWidth />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
export function ClientNameButton({
  environmentId,
  environmentLabel,
  required = false,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MaterialButton
        label={required ? "Name this client" : "Rename client"}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <ClientNameDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
export function ClientLabelGate() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const environment = environments.find(
    (entry) => entry.connection.needsClientLabel && !dismissed.has(entry.environmentId),
  );
  if (!environment) return null;
  return (
    <ClientNameDialog
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      onClose={() => setDismissed((previous) => new Set([...previous, environment.environmentId]))}
    />
  );
}
