import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmCodexAuthSelection } from "@t3tools/contracts/relay";
import { threadVmAuthSourceChoice } from "@t3tools/client-runtime/relay/threadVmControls";
import type { RefObject } from "react";
import { threadVmControls } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";

/** Mounted only after opening the local chat's account editor. It never starts a VM. */
export function ThreadVmAccountPreference({
  environmentId,
  threadId,
  accountId,
  disabled,
  onClose,
  finalFocus,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  accountId: string;
  disabled: boolean;
  onClose: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const state = useAtomValue(threadVmControls.codexPreferenceViewAtom(environmentId, threadId));
  const save = useAtomCommand(threadVmControls.setCodexPreference, { reportFailure: false });
  const check = useAtomCommand(threadVmControls.refreshCodexPreference, { reportFailure: false });
  const retry = useAtomCommand(threadVmControls.retryCodexPreference, { reportFailure: false });
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Account for the next VM</DialogTitle>
          <DialogDescription>
            Remember a Codex account for this chat. Your current machine’s account stays unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup
            aria-label="Codex account for the next VM"
            value={choice.selectedValue}
            disabled={blocked}
            onValueChange={(value) => {
              if (value === "personal") select({ mode: "personal" });
              else if (value === organizationValue && state.connection?.connectionId)
                select({ mode: "organization", connectionId: state.connection.connectionId });
            }}
          >
            <label className="flex items-center gap-2">
              <Radio value="personal" />
              Personal sign-in
            </label>
            <label className="flex items-center gap-2">
              <Radio
                value={organizationValue}
                disabled={state.connection?.status !== "connected"}
              />
              Organization Codex
              {state.connection?.label ? ` · ${state.connection.label}` : ""}
            </label>
          </RadioGroup>
          <p className="text-sm text-muted-foreground">
            Personal sign-in may still be needed inside a new VM.
          </p>
          {unavailableOrganization ? (
            <p className="text-sm text-muted-foreground">
              The saved organization account is unavailable. Reconnect it in Organization settings,
              or choose a different account here.
            </p>
          ) : state.connection?.status !== "connected" ? (
            <p className="text-sm text-muted-foreground">
              Connect Codex for VMs in Organization settings to use the organization account.
            </p>
          ) : null}
          <p role="status" aria-live="polite" className="text-sm">
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
          </p>
          {disabled || (state.data && !state.data.editable) ? (
            <p className="text-sm text-muted-foreground">
              Resolve the current move before changing the saved account.
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {state.phase === "unknown" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={state.isPending}
                onClick={() => void check({ environmentId, threadId })}
              >
                Check saved choice
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  disabled ||
                  state.isPending ||
                  (state.requested?.mode === "organization" &&
                    (state.connection?.connectionId !== state.requested.connectionId ||
                      state.connection.status !== "connected"))
                }
                onClick={() => void retry({ environmentId, threadId, accountId })}
              >
                Retry same choice
              </Button>
            </div>
          ) : state.error || state.data?.editable === false ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={state.isPending || state.phase === "saving"}
              onClick={() => void check({ environmentId, threadId })}
            >
              Check saved choice
            </Button>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={blocked || (state.data?.selection === null && !state.hasRequested)}
            onClick={() => select(null)}
          >
            Clear saved choice
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
