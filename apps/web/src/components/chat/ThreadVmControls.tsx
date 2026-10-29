import { portableThreadPlacementsAtom } from "@t3tools/client-runtime/relay/portableThreadPresentation";
import {
  threadMoveQueueOwnership,
  threadMoveQueuePresentation,
} from "@t3tools/client-runtime/relay/threadMoveQueuePresentation";
import { useThreadVmActionJournal } from "../../state/use-thread-vm-actions";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { useOpenLink } from "../../browser/useOpenLink";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, ThreadPromptQueue } from "@t3tools/contracts";
import type {
  RelayThreadVmStatus,
  RelayPortableThreadPlacement,
  RelayThreadVmReplacementCandidate,
  RelayThreadVmProviderAuth,
  RelayThreadVmProviderAuthBinding,
  RelayThreadVmBackupRecoveryCandidate,
} from "@t3tools/contracts/relay";
import {
  threadVmPresentation,
  threadVmProviderAuthPresentation,
  threadVmAuthSourcePresentation,
  threadVmAuthSourceChoice,
  threadVmBackupRecoveryUnavailable,
  type ThreadVmControlAction,
} from "@t3tools/client-runtime/relay/threadVmControls";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { threadVmControls, threadVmActionJournal } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { RefreshCwIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
export function useThreadMovePlacement(environmentId: EnvironmentId, threadId: ThreadId) {
  const session = useAtomValue(managedRelaySessionAtom);
  const proofs = useAtomValue(portableThreadPlacementsAtom);
  const location = useAtomValue(threadVmControls.locationViewAtom(environmentId, threadId));
  return proofs?.session === session && proofs.relayUrl === threadMoveRelayUrl()
    ? (proofs.placements.get(threadId) ?? location?.placement)
    : location?.placement;
}

type ThreadVmUi = {
  label: string;
  caption: string;
  tone: "danger" | "success" | "attention" | "neutral";
  notice: ReactNode;
  refresh: ReactNode;
  moveAction: { label: string; disabled: boolean; onPress: () => void } | null;
  moveFeedback: ReactNode;
  ownsMoveNotice: (queue: ThreadPromptQueue | null | undefined) => boolean;
  actions: (close: () => void, standalone?: boolean) => ReactNode;
  trigger: RefObject<HTMLButtonElement | null>;
};
const ThreadVmUiContext = createContext<ThreadVmUi | null>(null);
export const useThreadVmUi = () => useContext(ThreadVmUiContext);
export function ThreadVmNotice({ queue }: { queue?: ThreadPromptQueue | undefined }) {
  const ui = useThreadVmUi();
  return queue && ui?.ownsMoveNotice(queue) ? null : (ui?.notice ?? null);
}
export function ThreadVmMenuActions({ onAction }: { onAction: () => void }) {
  return useThreadVmUi()?.actions(onAction) ?? null;
}

export function ThreadVmRefreshButton() {
  return useThreadVmUi()?.refresh ?? null;
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">{children}</div>;
}
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="w-full text-xs text-muted-foreground" role="status">
      {children}
    </p>
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
    <Button
      size="xs"
      variant={danger ? "destructive" : "secondary"}
      disabled={disabled}
      onClick={onPress}
    >
      {label}
    </Button>
  );
}
function MenuAction({
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
    <button
      type="button"
      disabled={disabled}
      onClick={onPress}
      className={`w-full rounded-md px-2 py-2 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50 ${danger ? "text-destructive" : "text-foreground"}`}
    >
      {label}
    </button>
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
    <label className="grid w-full gap-1">
      {label}
      <Input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** Standalone recovery remains available when the VM cannot open a live chat. */
export function ThreadVmControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return (
    <ThreadVmControlsProvider {...props}>
      <ThreadVmRecoveryControls />
    </ThreadVmControlsProvider>
  );
}
export function ThreadVmRecoveryControls({
  hideRefresh = false,
  queue,
}: {
  hideRefresh?: boolean;
  queue?: ThreadPromptQueue | null;
}) {
  const ui = useThreadVmUi();
  if (!ui || (queue !== undefined && ui.ownsMoveNotice(queue))) return null;
  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {ui.notice ?? (
            <p className="text-sm font-medium" role="status">
              {ui.label}
            </p>
          )}
        </div>
        {!hideRefresh && <ThreadVmRefreshButton />}
      </div>
      {ui.actions(() => {}, true)}
    </div>
  );
}
export function ThreadVmControlsProvider({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: ReactNode;
}) {
  const placement = useThreadMovePlacement(environmentId, threadId);
  const view = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  const session = useAtomValue(managedRelaySessionAtom);
  const data = view?.data;
  const status = data?.status;
  const activeStatus =
    !data?.deletion &&
    status &&
    (status.allocation ||
      status.savedDisk ||
      status.reset ||
      status.restore ||
      status.finalSave ||
      status.replacement ||
      status.pendingProviderAuth)
      ? status
      : null;
  // Keep the chat subtree mounted when a local thread first acquires a VM.
  return (
    <ThreadVmControlPanel
      key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${environmentId}:${threadId}`}
      environmentId={environmentId}
      threadId={threadId}
      status={activeStatus}
      placement={placement}
      candidates={data?.candidates ?? []}
      readError={view?.error ?? null}
      deletionNote={
        data?.deletion
          ? data.deletion.phase === "completed"
            ? "Thread permanently deleted."
            : "Thread deleted. Removing its VM and saved data…"
          : null
      }
      accountId={view?.accountId ?? session?.accountId ?? ""}
      providerAuth={view?.providerAuth ?? null}
      providerAuthError={view?.providerAuthError ?? null}
      providerAuthPending={view?.providerAuthPending ?? false}
      queuePaused={view?.queuePaused ?? false}
    >
      {children}
    </ThreadVmControlPanel>
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
  const sourceState = useAtomValue(
    threadVmControls.providerAuthSourceViewAtom(environmentId, threadId),
  );
  const sourceData = sourceState.data;
  const accountSource = sourceData?.source ?? value?.authSource;
  const accountPresentation = accountSource
    ? threadVmAuthSourcePresentation(accountSource, sourceData?.connection ?? null)
    : null;
  const choice = threadVmAuthSourceChoice(accountSource, sourceData?.connection);
  const openLink = useOpenLink(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = value?.auth.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const presentation = value
    ? threadVmProviderAuthPresentation(
        {
          ...value,
          organizationConnection: sourceData?.connection ?? null,
          ...(accountSource ? { authSource: accountSource } : {}),
        },
        now,
      )
    : null;
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
      await openLink(presentation.url, { recordHistory: false });
    } catch {
      setError("Could not open the Codex sign-in page. Try opening the link again.");
    }
  };
  return (
    <section
      aria-label="VM Codex sign-in"
      className="grid w-full gap-2 rounded-lg border border-border bg-muted/30 p-3"
    >
      {!sourceData?.unsupported ? (
        <RadioGroup
          aria-label="Codex account for this VM"
          value={choice.selectedValue}
          disabled={busy || sourceState.isPending}
          onValueChange={(mode) => {
            if (mode === "personal")
              void run({ type: "select_source", source: { mode: "personal" } });
            else if (mode === choice.organizationValue && sourceData?.connection?.connectionId)
              void run({
                type: "select_source",
                source: { mode: "organization", connectionId: sourceData.connection.connectionId },
              });
          }}
        >
          <label className="flex items-center gap-2">
            <Radio value="personal" />
            Personal sign-in
          </label>
          <label className="flex items-center gap-2">
            <Radio
              value={choice.organizationValue}
              disabled={sourceData?.connection?.status !== "connected"}
            />
            Organization Codex
            {sourceData?.connection?.label ? ` · ${sourceData.connection.label}` : ""}
          </label>
        </RadioGroup>
      ) : null}
      {sourceData?.connection?.status !== "connected" && !sourceData?.unsupported ? (
        <Note>
          Connect or reconnect Codex for VMs in Organization settings to use the organization
          account.
        </Note>
      ) : null}
      {accountPresentation?.usingPlan ? (
        <div className="flex flex-wrap items-center gap-2">
          <Note>
            Using organization ChatGPT plan. Manage this connection in Organization settings → Codex
            for VMs.
          </Note>
          <ActionButton
            label="Manage usage"
            disabled={busy}
            onPress={() => {
              void openLink("https://chatgpt.com/settings/usage", { recordHistory: false }).catch(
                () => setError("Could not open ChatGPT usage settings."),
              );
            }}
          />
        </div>
      ) : null}
      <p className="font-medium">{presentation?.title ?? "Checking Codex sign-in in the new VM"}</p>
      <Note>
        {presentation?.message ?? "The VM is preparing. Its Codex sign-in status will appear here."}
      </Note>
      {presentation?.userCode ? (
        <p>
          Enter code{" "}
          <code className="select-all rounded bg-muted px-2 py-1 font-mono text-sm">
            {presentation.userCode}
          </code>{" "}
          on the sign-in page.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {presentation?.userCode ? (
          <ActionButton
            label="Copy code"
            disabled={busy}
            onPress={() => {
              void navigator.clipboard
                .writeText(presentation.userCode!)
                .catch(() => setError("Could not copy the code. Select and copy it above."));
            }}
          />
        ) : null}
        {presentation?.canStart ? (
          <ActionButton
            label={presentation.startLabel}
            disabled={busy || loading}
            onPress={() => void run({ type: "start" })}
          />
        ) : null}
        {presentation?.url ? (
          <ActionButton
            label="Open Codex sign-in page"
            disabled={busy}
            onPress={() => void open()}
          />
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
      </div>
      {error || readError ? (
        <p role="alert" className="text-destructive">
          {error ?? readError}
        </p>
      ) : null}
      {sourceData?.error || sourceState.error ? (
        <p role="alert" className="text-destructive">
          {sourceData?.error ?? sourceState.error}
        </p>
      ) : null}
    </section>
  );
}

function VmCodexAccountSummary({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const state = useAtomValue(threadVmControls.providerAuthSourceViewAtom(environmentId, threadId));
  const openLink = useOpenLink(null);
  const source = state.data?.source;
  const [error, setError] = useState<string | null>(null);
  if (!source)
    return state.data?.error || state.error ? (
      <Note>{state.data?.error ?? state.error}</Note>
    ) : null;
  const presentation = threadVmAuthSourcePresentation(source);
  return (
    <div className="grid gap-1 px-2 py-1">
      <Note>
        {presentation.label}. {presentation.detail}
      </Note>
      {source.mode === "organization" ? (
        <a
          href="https://chatgpt.com/settings/usage"
          onClick={(event) => {
            event.preventDefault();
            void openLink("https://chatgpt.com/settings/usage", { recordHistory: false }).catch(
              () => setError("Could not open ChatGPT usage settings."),
            );
          }}
        >
          Manage usage
        </a>
      ) : null}
      {error ? <Note>{error}</Note> : null}
    </div>
  );
}

function ThreadVmControlPanel({
  environmentId,
  threadId,
  status,
  placement,
  deletionNote,
  candidates,
  readError,
  accountId,
  providerAuth,
  providerAuthError,
  providerAuthPending,
  children,
  queuePaused,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  status: RelayThreadVmStatus | null;
  placement: RelayPortableThreadPlacement | null | undefined;
  deletionNote: string | null;
  candidates: ReadonlyArray<RelayThreadVmReplacementCandidate>;
  readError: string | null;
  accountId: string;
  providerAuth: RelayThreadVmProviderAuth | null;
  providerAuthError: string | null;
  providerAuthPending: boolean;
  children: ReactNode;
  queuePaused: boolean;
}) {
  const registry = useContext(RegistryContext);
  const dispatch = useAtomCommand(threadVmControls.action, { reportFailure: false });
  const preview = useAtomCommand(threadVmControls.openPreview, { reportFailure: false });
  const checkBackup = useAtomCommand(threadVmControls.checkBackupRecovery, {
    reportFailure: false,
  });
  const [backup, setBackup] = useState<RelayThreadVmBackupRecoveryCandidate | null>(null);
  const [previewPort, setPreviewPort] = useState("3000");
  const openLink = useOpenLink({ environmentId, threadId });

  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const dialogRevision = useRef(0);
  const hasStatus = status !== null;
  const dialogOpen = hasStatus && confirm !== null;
  useLayoutEffect(() => {
    if (!hasStatus && confirm !== null) {
      dialogRevision.current++;
      setConfirm(null);
    }
  }, [hasStatus, confirm]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const openConfirmation = (kind: string) => {
    dialogRevision.current++;
    setError(null);
    setConfirm(kind);
  };
  const closeConfirmation = () => {
    dialogRevision.current++;
    setConfirm(null);
  };
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
    const openedAt = dialogRevision.current;
    setBusy(true);
    setError(null);
    try {
      const result = await preview({ environmentId, threadId, port: Number(previewPort) });
      if (dialogRevision.current !== openedAt) return;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The VM preview could not be opened.",
        );
        return;
      }
      await openLink(result.value.url, { recordHistory: false });
    } catch {
      if (dialogRevision.current === openedAt) setError("The VM preview could not be opened.");
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: ThreadVmControlAction) => {
    if (busy) return;
    setError(null);
    if (await lifecycle.run({ environmentId, threadId, action })) setConfirm(null);
  };
  const capabilities = useAtomValue(threadVmControls.capabilitiesAtom);
  const presentation = threadVmPresentation({
    status,
    error: readError,
    pendingRequest: !!pending,
    queuePaused,
    providerAuth,
    capabilities: capabilities.error || capabilities.isPending ? null : capabilities.data,
  });
  const { held } = presentation;
  const restore = () => {
    if (!status) return;
    if (!status.savedDisk?.operationId) return;
    void run({
      type: "restore",
      payload: {
        operationId: randomUUID(),
        allocationId: randomUUID(),
        savedDiskOperationId: status.savedDisk.operationId,
        expectedGeneration: status.generation,
      },
    });
  };
  const checkBackupRecovery = async () => {
    if (busy || !status || !status.allocation) return;
    openConfirmation("backup");
    const openedAt = dialogRevision.current;
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
      if (dialogRevision.current !== openedAt) return;
      setBackup(result.value);
    } catch (cause) {
      if (dialogRevision.current === openedAt)
        setError(cause instanceof Error ? cause.message : "Could not check the saved backup.");
    } finally {
      setBusy(false);
    }
  };
  const selectedBackup =
    status &&
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
    if (!status) return;
    if (!status.repository) {
      setError("This thread has no retained repository upload to reset from.");
      return;
    }
    void run({
      type: "reset",
      payload: {
        operationId: randomUUID(),
        allocationId: randomUUID(),
        expectedGeneration: status.generation,
        canonicalKey: status.repository.canonicalKey,
        branch: status.repository.branch,
        revision: status.repository.revision,
      },
    });
  };
  const remove = () => {
    if (!status) return;
    void run({
      type: "delete",
      payload: {
        operationId: randomUUID(),
        expectedGeneration: status.generation,
        confirmWorkspaceLoss: true,
      },
    });
  };

  const disabled = busy || lifecycle.busy || !lifecycle.ready;
  const primary = () => {
    if (!status) {
      threadVmControls.refresh(registry, environmentId, threadId);
      return;
    }
    switch (presentation.primary?.type) {
      case "resume":
        void run({ type: "resume" });
        break;
      case "restore":
        restore();
        break;
      case "reset":
        openConfirmation("reset");
        break;
      case "cancel_restore":
        if (status.restore)
          void run({ type: "cancel_restore", operationId: status.restore.operationId });
        break;
      case "cancel_reset":
        if (status.reset) void run({ type: "cancel_reset", operationId: status.reset.operationId });
        break;
      case "cancel_setup":
        void run({ type: "cancel_setup" });
        break;
      case "check":
        threadVmControls.refresh(registry, environmentId, threadId);
        break;
      case "sign_in":
      case "replace":
        openConfirmation(presentation.primary.type === "sign_in" ? "sign_in" : "replacement");
        break;
    }
  };
  const requestFeedback = (
    <>
      {error || lifecycle.error ? (
        <Panel>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {lifecycle.error ? (
            <p role="alert" className="text-destructive">
              {lifecycle.error}
            </p>
          ) : null}
        </Panel>
      ) : null}
      {pending ? (
        <Panel>
          <Note>
            {pending.action.type === "delete"
              ? "Deletion is saved until cleanup is confirmed."
              : "This VM request is saved until admission is confirmed."}
          </Note>
          <ActionButton
            label="Retry saved VM request"
            disabled={disabled}
            onPress={() => {
              void lifecycle.run(pending).then((accepted) => {
                if (accepted) setConfirm(null);
              });
            }}
          />
          {pending.action.type === "restore_backup" ? (
            <ActionButton
              label="Cancel saved recovery request"
              disabled={disabled}
              onPress={() => {
                if (pending.action.type === "restore_backup")
                  void run({ type: "cancel_backup_recovery", payload: pending.action.payload });
              }}
            />
          ) : null}
        </Panel>
      ) : null}
    </>
  );
  const perform = (close: () => void, action: () => void) => () => {
    close();
    action();
  };
  const refresh = (
    <Button
      variant="ghost-muted"
      size="icon-xs"
      aria-label="Refresh status"
      title="Refresh status"
      disabled={busy || lifecycle.busy}
      onClick={() => threadVmControls.refresh(registry, environmentId, threadId)}
    >
      <RefreshCwIcon aria-hidden />
    </Button>
  );
  const actions = (close: () => void, standalone = false) => (
    <div className="grid gap-1 border-t border-border pt-2 empty:hidden" aria-label="VM actions">
      {status?.allocation && !status.pendingProviderAuth ? (
        <VmCodexAccountSummary environmentId={environmentId} threadId={threadId} />
      ) : null}
      {status?.pendingProviderAuth && presentation.primary?.type !== "sign_in" ? (
        <MenuAction
          label="Codex account…"
          disabled={disabled}
          onPress={perform(close, () => openConfirmation("sign_in"))}
        />
      ) : null}
      {presentation.primary && !deletionNote && !standalone ? (
        <MenuAction
          label={presentation.primary.label}
          disabled={
            disabled ||
            (presentation.primary.type !== "replace" && presentation.disabledReason !== null)
          }
          onPress={perform(close, primary)}
        />
      ) : null}
      {presentation.canPreview ? (
        <MenuAction
          label="Open preview…"
          disabled={disabled}
          onPress={perform(close, () => openConfirmation("preview"))}
        />
      ) : null}
      {presentation.canRecoverBackup ? (
        <MenuAction
          label="Recover from backup…"
          disabled={disabled}
          onPress={perform(close, () => void checkBackupRecovery())}
        />
      ) : null}
      {presentation.canCancelRestore &&
      status?.restore &&
      presentation.primary?.type !== "cancel_restore" ? (
        <MenuAction
          label="Cancel restore"
          disabled={disabled}
          onPress={perform(
            close,
            () => void run({ type: "cancel_restore", operationId: status?.restore!.operationId }),
          )}
        />
      ) : null}
      {presentation.canCancelReset &&
      status?.reset &&
      presentation.primary?.type !== "cancel_reset" ? (
        <MenuAction
          label="Cancel reset"
          disabled={disabled}
          onPress={perform(
            close,
            () => void run({ type: "cancel_reset", operationId: status?.reset!.operationId }),
          )}
        />
      ) : null}
      {presentation.canCancelSetup && presentation.primary?.type !== "cancel_setup" ? (
        <MenuAction
          label="Cancel VM setup"
          disabled={disabled}
          onPress={perform(close, () => void run({ type: "cancel_setup" }))}
        />
      ) : null}
      {status?.replacement ? (
        <MenuAction
          label="Cancel VM request"
          disabled={disabled}
          onPress={perform(
            close,
            () =>
              void run({ type: "cancel_replacement", requestId: status?.replacement!.requestId }),
          )}
        />
      ) : null}
      {standalone && presentation.canDelete ? (
        <MenuAction
          label="Permanently delete thread"
          danger
          disabled={disabled}
          onPress={() => openConfirmation("delete")}
        />
      ) : null}
    </div>
  );
  const notice =
    (status || readError || pending || deletionNote) &&
    (!presentation.ready || error || lifecycle.error || pending) ? (
      <div
        className="mb-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
        aria-label="VM needs attention"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1" role="status">
            {deletionNote ?? presentation.label}
          </p>
          {presentation.primary && !deletionNote ? (
            <ActionButton
              label={presentation.primary.label}
              disabled={
                disabled ||
                (presentation.primary.type !== "replace" && presentation.disabledReason !== null)
              }
              onPress={primary}
            />
          ) : null}
        </div>
        {presentation.disabledReason || presentation.detail ? (
          <Note>{presentation.disabledReason ?? presentation.detail}</Note>
        ) : null}
        {!dialogOpen ? requestFeedback : null}
      </div>
    ) : null;
  const ui = useMemo(
    () =>
      status || readError || pending || deletionNote
        ? {
            label: deletionNote ?? presentation.label,
            caption: presentation.ready
              ? "Ready"
              : presentation.label.replace(/^VM /, "").replace(/ VM$/, ""),
            tone: presentation.tone,
            notice,
            refresh,
            moveAction:
              presentation.primary && !deletionNote
                ? {
                    label: presentation.primary.label,
                    disabled:
                      disabled ||
                      (presentation.primary.type !== "replace" &&
                        presentation.disabledReason !== null),
                    onPress: primary,
                  }
                : null,
            moveFeedback: requestFeedback,
            ownsMoveNotice: (queue: ThreadPromptQueue | null | undefined) => {
              const ownership = threadMoveQueueOwnership({
                entries: queue?.entries,
                placement,
                status,
              });
              if (!ownership.ownsNotice) return false;
              const entry = queue?.entries.find(
                (item) =>
                  item.kind === "move" &&
                  item.state !== "pending" &&
                  item.operationId === placement?.operationId,
              );
              const move = threadMoveQueuePresentation({
                entry: entry?.kind === "move" ? entry : undefined,
                placement,
                status,
                providerAuth,
                error: readError,
              });
              return (
                !!move && (move.cancelling || !presentation.primary || move.tone !== "neutral")
              );
            },
            actions,
            trigger,
          }
        : null,
    [
      status,
      placement,
      providerAuth,
      readError,
      pending,
      deletionNote,
      presentation.primary,
      presentation.disabledReason,
      primary,
      disabled,
      requestFeedback,
      presentation.label,
      presentation.ready,
      presentation.tone,
      notice,
      refresh,
      actions,
      trigger,
    ],
  );
  return (
    <ThreadVmUiContext value={ui}>
      {children}
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <AlertDialogPopup variant="scrollable" finalFocus={trigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "preview"
                ? "Open private preview"
                : confirm === "sign_in"
                  ? "Codex account"
                  : confirm === "replacement"
                    ? "Choose a VM to replace"
                    : confirm === "delete"
                      ? "Permanently delete thread?"
                      : confirm === "reset"
                        ? "Reset VM?"
                        : confirm === "backup"
                          ? "Recover from backup?"
                          : "Replace this VM?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "preview"
                ? "Enter the port your application is listening on inside this VM."
                : confirm === "sign_in"
                  ? "Choose personal sign-in or the organization's Codex account to finish preparing this VM."
                  : confirm === "replacement"
                    ? "Your VM allowance is full. Choose a VM to save and stop. The least recently active choice is listed first."
                    : confirm === "delete"
                      ? "This removes the conversation, attachments, VM and all saved workspaces. This cannot be undone."
                      : confirm === "reset"
                        ? "Keep the conversation and rebuild from the original uploaded Git commit. Workspace changes inside the VM are discarded. The queue stays paused."
                        : confirm === "backup"
                          ? "The conversation is kept. Workspace changes after the selected backup may be lost. The queue stays paused."
                          : "Save and stop the selected VM before using its slot. Replacement waits until its backup is verified and stopping is confirmed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <Panel>
              {confirm === "preview" ? (
                <>
                  <Field
                    label="App port"
                    value={previewPort}
                    disabled={disabled}
                    onChange={setPreviewPort}
                  />
                  <ActionButton
                    label="Open private preview"
                    disabled={disabled || !presentation.canPreview}
                    onPress={() => void openPreview()}
                  />
                </>
              ) : confirm === "sign_in" && status?.pendingProviderAuth ? (
                <VmCodexSignIn
                  key={`${accountId}:${status?.pendingProviderAuth.allocationId}:${status?.pendingProviderAuth.operationId}`}
                  environmentId={environmentId}
                  threadId={threadId}
                  accountId={accountId}
                  binding={status?.pendingProviderAuth}
                  value={providerAuth}
                  readError={providerAuthError}
                  loading={providerAuthPending}
                />
              ) : confirm === "sign_in" ? (
                <Note>{presentation.label}. This VM no longer needs Codex sign-in.</Note>
              ) : confirm === "replacement" && status?.replacement?.phase !== "awaiting_choice" ? (
                <Note>This VM request changed. Close this dialog to check its current status.</Note>
              ) : confirm === "replacement" ? (
                <>
                  {candidates.map((candidate, index) => (
                    <div
                      key={candidate.allocationId}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {candidate.title ?? "Untitled thread"}
                        </p>
                        <p className="text-muted-foreground">
                          {candidate.state}
                          {index === 0 ? " · Least recently active" : ""}
                        </p>
                        <p className="text-muted-foreground">
                          {candidate.lastWorkAt
                            ? `Last work: ${new Date(candidate.lastWorkAt).toLocaleString()}`
                            : "Last work unknown"}
                        </p>
                      </div>
                      <ActionButton
                        label="Replace…"
                        disabled={disabled || presentation.disabledReason !== null}
                        onPress={() => openConfirmation(candidate.allocationId)}
                      />
                    </div>
                  ))}
                  {!candidates.length ? (
                    <Note>
                      All VMs are busy or no saved workspace can be verified. Cancel this request or
                      wait until a VM is available.
                    </Note>
                  ) : null}
                  {status?.replacement ? (
                    <ActionButton
                      label="Cancel VM request"
                      disabled={disabled}
                      onPress={() =>
                        void run({
                          type: "cancel_replacement",
                          requestId: status?.replacement!.requestId,
                        })
                      }
                    />
                  ) : null}
                </>
              ) : confirm === "backup" && !held && status ? (
                busy ? (
                  <Note>Checking the saved backup…</Note>
                ) : selectedBackup ? (
                  <>
                    <Note>
                      Verified workspace from {new Date(selectedBackup.capturedAt).toLocaleString()}
                      .
                    </Note>
                    <ActionButton
                      label="Restore this backup"
                      disabled={disabled || capabilities.data?.restore !== true}
                      onPress={() =>
                        void run({
                          type: "restore_backup",
                          payload: {
                            operationId: randomUUID(),
                            allocationId: randomUUID(),
                            expectedGeneration: status?.generation,
                            backup: selectedBackup,
                          },
                        })
                      }
                    />
                  </>
                ) : (
                  <>
                    <Note>{threadVmBackupRecoveryUnavailable(backup?.blockedReason)}</Note>
                    <ActionButton
                      label="Retry backup check"
                      disabled={disabled}
                      onPress={() => void checkBackupRecovery()}
                    />
                  </>
                )
              ) : confirm === "reset" && !held && status ? (
                <>
                  {status?.repository ? (
                    <Note>
                      {status?.repository.branch} · {status?.repository.revision.slice(0, 12)}
                    </Note>
                  ) : null}
                  <ActionButton
                    label="Reset VM"
                    disabled={disabled || capabilities.data?.reset !== true}
                    onPress={reset}
                  />
                </>
              ) : confirm === "delete" && !held && status ? (
                <ActionButton
                  label="Permanently delete thread"
                  danger
                  disabled={disabled || capabilities.data?.permanentDelete !== true}
                  onPress={remove}
                />
              ) : confirm &&
                status?.replacement?.phase === "awaiting_choice" &&
                candidates.some((candidate) => candidate.allocationId === confirm) ? (
                <>
                  <Note>
                    {candidates.find((candidate) => candidate.allocationId === confirm)?.title ??
                      "Selected VM"}
                  </Note>
                  <ActionButton
                    label="Save and replace VM"
                    disabled={disabled || capabilities.data?.replacement !== true}
                    onPress={() =>
                      void run({
                        type: "select_replacement",
                        requestId: status?.replacement!.requestId,
                        victimAllocationId: confirm,
                      })
                    }
                  />
                </>
              ) : null}
            </Panel>
            {requestFeedback}
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={closeConfirmation}>
              Close
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ThreadVmUiContext>
  );
}
