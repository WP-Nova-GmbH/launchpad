import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayThreadVmStatus,
  RelayThreadVmReplacementCandidate,
  RelayThreadVmProviderAuth,
  RelayThreadVmProviderAuthBinding,
  RelayThreadVmBackupRecoveryCandidate,
} from "@t3tools/contracts/relay";
import {
  threadVmStatusLabel,
  threadVmProviderAuthPresentation,
  threadVmBackupRecoveryUnavailable,
  type ThreadVmControlAction,
} from "@t3tools/client-runtime/relay/threadVmControls";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useContext, useState, type ReactNode } from "react";
import * as Crypto from "expo-crypto";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { threadVmControls, threadVmActionJournal } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
function Panel({ children }: { children: ReactNode }) {
  return <View className="gap-2 px-3 py-2">{children}</View>;
}
function Note({ children }: { children: ReactNode }) {
  return (
    <Text className="text-xs text-muted-foreground" accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}
function ActionButton({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg bg-card px-3 py-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className={danger ? "text-xs text-destructive" : "text-xs text-foreground"}>
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground">{label}</Text>
      <AppTextInput
        accessibilityLabel={label}
        value={value}
        editable={!disabled}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

export function ThreadVmControls({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const registry = useContext(RegistryContext);
  const view = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  if (!view) return null;
  const data = view.data;
  if (!data?.status && !data?.deletion)
    return view.error ? (
      <Panel>
        <Note>{view.error}</Note>
        <ActionButton
          label="Retry"
          disabled={view.isPending}
          onPress={() => threadVmControls.refresh(registry, environmentId, threadId)}
        />
      </Panel>
    ) : null;
  if (data.deletion)
    return (
      <Panel>
        <Note>
          {data.deletion.phase === "completed"
            ? "Thread permanently deleted."
            : "Thread deleted. Removing its VM and saved data…"}
        </Note>
      </Panel>
    );
  const status = data.status!;
  if (
    !status.allocation &&
    !status.savedDisk &&
    !status.reset &&
    !status.restore &&
    !status.replacement &&
    !status.pendingProviderAuth
  )
    return null;
  return (
    <ThreadVmControlPanel
      key={`${view.accountId}:${environmentId}:${threadId}`}
      environmentId={environmentId}
      threadId={threadId}
      status={status}
      candidates={data.candidates}
      readError={view.error}
      accountId={view.accountId}
      providerAuth={view.providerAuth}
      providerAuthError={view.providerAuthError}
      providerAuthPending={view.providerAuthPending}
    />
  );
}

function VmCodexSignIn({
  environmentId,
  threadId,
  accountId,
  binding,
  value,
  readError,
  loading,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  accountId: string;
  binding: RelayThreadVmProviderAuthBinding;
  value: RelayThreadVmProviderAuth | null;
  readError: string | null;
  loading: boolean;
}) {
  const dispatch = useAtomCommand(threadVmControls.providerAuthAction, { reportFailure: false });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const presentation = value ? threadVmProviderAuthPresentation(value) : null;
  const run = async (action: Parameters<typeof dispatch>[0]["action"]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId, threadId, accountId, binding, action });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not confirm VM sign-in. Check its status before retrying.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    if (!presentation?.url || busy) return;
    setError(null);
    try {
      await Linking.openURL(presentation.url);
    } catch {
      setError("Could not open the Codex sign-in page. Try opening the link again.");
    }
  };
  return (
    <View
      accessibilityLabel="VM Codex sign-in"
      className="gap-2 rounded-lg border border-border bg-card p-3"
    >
      <Text className="text-xs font-semibold text-foreground">
        {presentation?.title ?? "Checking Codex sign-in in the new VM"}
      </Text>
      <Note>
        {presentation?.message ?? "The VM is preparing. Its Codex sign-in status will appear here."}
      </Note>
      {presentation?.userCode ? (
        <Text selectable className="text-sm text-foreground">
          Enter code {presentation.userCode} on the sign-in page.
        </Text>
      ) : null}
      {presentation?.canStart ? (
        <ActionButton
          label={presentation.startLabel}
          disabled={busy || loading}
          onPress={() => void run({ type: "start" })}
        />
      ) : null}
      {presentation?.url ? (
        <ActionButton label="Open Codex sign-in page" disabled={busy} onPress={() => void open()} />
      ) : null}
      {presentation?.canCancel && value?.auth.flowId ? (
        <ActionButton
          label="Cancel sign-in"
          disabled={busy}
          onPress={() => void run({ type: "cancel", flowId: value.auth.flowId! })}
        />
      ) : null}
      <ActionButton
        label={busy || loading ? "Checking sign-in…" : "Check sign-in status"}
        disabled={busy || loading}
        onPress={() => void run({ type: "refresh" })}
      />
      {error || readError ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">
          {error ?? readError}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadVmControlPanel({
  environmentId,
  threadId,
  status,
  candidates,
  readError,
  accountId,
  providerAuth,
  providerAuthError,
  providerAuthPending,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  status: RelayThreadVmStatus;
  candidates: ReadonlyArray<RelayThreadVmReplacementCandidate>;
  readError: string | null;
  accountId: string;
  providerAuth: RelayThreadVmProviderAuth | null;
  providerAuthError: string | null;
  providerAuthPending: boolean;
}) {
  const dispatch = useAtomCommand(threadVmControls.action, { reportFailure: false });
  const preview = useAtomCommand(threadVmControls.openPreview, { reportFailure: false });
  const checkBackup = useAtomCommand(threadVmControls.checkBackupRecovery, {
    reportFailure: false,
  });
  const [backup, setBackup] = useState<RelayThreadVmBackupRecoveryCandidate | null>(null);
  const [previewPort, setPreviewPort] = useState("3000");

  const [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reset" | "delete" | string | null>(null);
  const session = useAtomValue(managedRelaySessionAtom);
  const submit = useCallback(
    async (input: Parameters<typeof dispatch>[0]) => {
      const result = await dispatch(input);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [dispatch],
  );
  const lifecycle = useThreadVmActionJournal(
    threadVmActionJournal,
    session,
    threadMoveRelayUrl(),
    submit,
  );
  const pending = lifecycle.entries.find((entry) => entry.threadId === threadId);
  const openPreview = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await preview({ environmentId, threadId, port: Number(previewPort) });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The VM preview could not be opened.",
        );
        return;
      }
      await Linking.openURL(result.value.url);
    } catch {
      setError("The VM preview could not be opened.");
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: ThreadVmControlAction) => {
    if (busy) return;
    setError(null);
    if (await lifecycle.run({ environmentId, threadId, action })) setConfirm(null);
  };
  const held = !!(
    pending ||
    status.finalSave ||
    status.restore ||
    status.reset ||
    status.replacement ||
    (status.resumePhase && status.resumePhase !== "completed")
  );
  const restore = () => {
    if (!status.savedDisk?.operationId) return;
    void run({
      type: "restore",
      payload: {
        operationId: Crypto.randomUUID(),
        allocationId: Crypto.randomUUID(),
        savedDiskOperationId: status.savedDisk.operationId,
        expectedGeneration: status.generation,
      },
    });
  };
  const checkBackupRecovery = async () => {
    if (busy || !status.allocation) return;
    setBusy(true);
    setError(null);
    setBackup(null);
    try {
      const result = await checkBackup({
        environmentId,
        threadId,
        accountId,
        expectedGeneration: status.generation,
        sourceAllocationId: status.allocation.allocationId,
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setBackup(result.value);
      setConfirm("backup");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check the saved backup.");
    } finally {
      setBusy(false);
    }
  };
  const selectedBackup =
    backup?.available &&
    backup.generation === status.generation &&
    backup.sourceAllocationId === status.allocation?.allocationId &&
    backup.backupOperationId &&
    backup.capturedAt &&
    backup.nativeCheckpointOperationId
      ? {
          sourceAllocationId: backup.sourceAllocationId,
          backupOperationId: backup.backupOperationId,
          capturedAt: backup.capturedAt,
          nativeCheckpointOperationId: backup.nativeCheckpointOperationId,
        }
      : null;
  const reset = () => {
    if (!status.repository) {
      setError("This thread has no retained repository upload to reset from.");
      return;
    }
    void run({
      type: "reset",
      payload: {
        operationId: Crypto.randomUUID(),
        allocationId: Crypto.randomUUID(),
        expectedGeneration: status.generation,
        canonicalKey: status.repository.canonicalKey,
        branch: status.repository.branch,
        revision: status.repository.revision,
      },
    });
  };
  const remove = () => {
    void run({
      type: "delete",
      payload: {
        operationId: Crypto.randomUUID(),
        expectedGeneration: status.generation,
        confirmWorkspaceLoss: true,
      },
    });
  };

  const cancelRestore =
    status.restore &&
    status.restore.canCancel !== false &&
    ["pending", "preparing", "prepared", "boot_preparing", "boot_prepared"].includes(
      status.restore.phase,
    );
  const cancelReset = status.reset && ["pending", "creating"].includes(status.reset.phase);
  return (
    <Panel>
      <ActionButton
        label={
          providerAuth
            ? threadVmProviderAuthPresentation(providerAuth).title
            : threadVmStatusLabel(status)
        }
        disabled={busy || lifecycle.busy || !lifecycle.ready}
        onPress={() => setExpanded(!expanded)}
      />
      {status.pendingProviderAuth ? (
        <VmCodexSignIn
          key={`${accountId}:${status.pendingProviderAuth.allocationId}:${status.pendingProviderAuth.operationId}`}
          environmentId={environmentId}
          threadId={threadId}
          accountId={accountId}
          binding={status.pendingProviderAuth}
          value={providerAuth}
          readError={providerAuthError}
          loading={providerAuthPending}
        />
      ) : null}
      {pending && (
        <Panel>
          <Note>
            {pending.action.type === "delete"
              ? "Deletion is saved until cleanup is confirmed."
              : "This VM request is saved until admission is confirmed."}
          </Note>
          <ActionButton
            label="Retry saved VM request"
            disabled={busy || lifecycle.busy || !lifecycle.ready}
            onPress={() => void lifecycle.run(pending)}
          />
          {pending.action.type === "restore_backup" ? (
            <ActionButton
              label="Cancel saved recovery request"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => {
                if (pending.action.type === "restore_backup")
                  void run({ type: "cancel_backup_recovery", payload: pending.action.payload });
              }}
            />
          ) : null}
        </Panel>
      )}
      {lifecycle.error && <Note>{lifecycle.error}</Note>}
      {status.restore?.errorCode && !status.pendingProviderAuth ? (
        <Note>
          Recovery could not confirm the last step. It keeps retrying the same request and preserves
          your saved data.
        </Note>
      ) : null}
      {expanded ? (
        <Panel>
          {status.allocation?.state === "running" &&
          !status.pausePhase &&
          !status.restore &&
          !status.reset ? (
            <Panel>
              <Field
                label="App port"
                value={previewPort}
                disabled={busy || lifecycle.busy || !lifecycle.ready}
                onChange={setPreviewPort}
              />
              <ActionButton
                label="Open private preview"
                disabled={busy || lifecycle.busy || !lifecycle.ready}
                onPress={() => void openPreview()}
              />
            </Panel>
          ) : null}
          {status.lastVerifiedBackupAt ? (
            <Note>Last verified backup: {status.lastVerifiedBackupAt}</Note>
          ) : null}
          {!held &&
          (status.allocation?.state === "running" || status.allocation?.state === "paused") &&
          status.lastVerifiedBackupAt ? (
            <ActionButton
              label="Recover from backup…"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => void checkBackupRecovery()}
            />
          ) : null}
          {status.savedDisk ? (
            <Note>Saved workspace expires: {status.savedDisk.expiresAt}</Note>
          ) : null}
          {!held && status.allocation?.state === "paused" ? (
            <ActionButton
              label="Resume VM"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => void run({ type: "resume" })}
            />
          ) : null}
          {!held && status.savedDisk?.phase === "available" && status.savedDisk.operationId ? (
            <ActionButton
              label="Restore VM"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={restore}
            />
          ) : null}
          {!held && status.savedDisk?.phase === "expired" && status.repository ? (
            <ActionButton
              label="Reset VM"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => setConfirm("reset")}
            />
          ) : null}
          {cancelRestore && status.restore ? (
            <ActionButton
              label="Cancel restore"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() =>
                void run({ type: "cancel_restore", operationId: status.restore!.operationId })
              }
            />
          ) : null}
          {cancelReset && status.reset ? (
            <ActionButton
              label="Cancel reset"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() =>
                void run({ type: "cancel_reset", operationId: status.reset!.operationId })
              }
            />
          ) : null}
          {!held && ["pending", "running", "failed"].includes(status.setupPhase ?? "") ? (
            <ActionButton
              label="Cancel VM setup"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => void run({ type: "cancel_setup" })}
            />
          ) : null}
          {status.replacement?.phase === "awaiting_choice" ? (
            <Panel>
              <Note>
                Your VM limit is reached. Choose an idle VM to save and stop. The first available
                choice is the least recently active.
              </Note>
              {candidates.map((candidate) => (
                <ActionButton
                  key={candidate.allocationId}
                  label={`Replace ${candidate.title ?? "thread " + candidate.threadId.slice(0, 8)} (${candidate.state})`}
                  disabled={busy || lifecycle.busy || !lifecycle.ready}
                  onPress={() => setConfirm(candidate.allocationId)}
                />
              ))}
              {!candidates.length ? <Note>No idle VM can be replaced right now.</Note> : null}
            </Panel>
          ) : null}
          {status.replacement ? (
            <ActionButton
              label="Cancel VM request"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() =>
                void run({ type: "cancel_replacement", requestId: status.replacement!.requestId })
              }
            />
          ) : null}
          {!held ? (
            <ActionButton
              label="Permanently delete thread"
              danger
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => setConfirm("delete")}
            />
          ) : null}
          {confirm === "backup" && !held ? (
            <Panel>
              {selectedBackup ? (
                <>
                  <Note>
                    Restore the workspace backup from{" "}
                    {new Date(selectedBackup.capturedAt).toLocaleString()}? Workspace changes after
                    that backup may be lost. The saved conversation is kept, and queued messages
                    stay paused until you resume them.
                  </Note>
                  <ActionButton
                    label="Restore this backup"
                    disabled={busy || lifecycle.busy || !lifecycle.ready}
                    onPress={() =>
                      void run({
                        type: "restore_backup",
                        payload: {
                          operationId: Crypto.randomUUID(),
                          allocationId: Crypto.randomUUID(),
                          expectedGeneration: status.generation,
                          backup: selectedBackup,
                        },
                      })
                    }
                  />
                </>
              ) : (
                <Note>{threadVmBackupRecoveryUnavailable(backup?.blockedReason)}</Note>
              )}
            </Panel>
          ) : confirm === "reset" && !held ? (
            <Panel>
              <Note>
                Reset keeps this conversation and leaves the queue paused. The new VM returns to the
                Git commit uploaded when this thread moved from your machine. Changes made inside
                the VM are discarded.
              </Note>
              {status.repository && (
                <Note>
                  {status.repository.branch} · {status.repository.revision.slice(0, 12)}
                </Note>
              )}
              <ActionButton
                label="Reset VM"
                disabled={busy || lifecycle.busy || !lifecycle.ready}
                onPress={reset}
              />
            </Panel>
          ) : confirm === "delete" && !held ? (
            <Panel>
              <Note>
                Permanently delete this thread, its VM, conversation, attachments and saved
                workspace? This cannot be undone.
              </Note>
              <ActionButton
                label="Confirm permanent deletion"
                danger
                disabled={busy || lifecycle.busy || !lifecycle.ready}
                onPress={remove}
              />
            </Panel>
          ) : confirm && status.replacement?.phase === "awaiting_choice" ? (
            <Panel>
              <Note>Save and stop this VM, then use its slot for the waiting request?</Note>
              <ActionButton
                label="Confirm replacement"
                disabled={busy || lifecycle.busy || !lifecycle.ready}
                onPress={() =>
                  void run({
                    type: "select_replacement",
                    requestId: status.replacement!.requestId,
                    victimAllocationId: confirm,
                  })
                }
              />
            </Panel>
          ) : null}
          {confirm ? (
            <ActionButton
              label="Back"
              disabled={busy || lifecycle.busy || !lifecycle.ready}
              onPress={() => setConfirm(null)}
            />
          ) : null}
        </Panel>
      ) : null}
      {readError || error ? <Note>{error ?? readError}</Note> : null}
    </Panel>
  );
}
