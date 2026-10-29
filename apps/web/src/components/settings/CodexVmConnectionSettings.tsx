import { EllipsisIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useCodexVmConnection } from "../../cloud/codexVmConnection";
import { OpenAI } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The ChatGPT brand button stays in this feature rather than changing shared controls. */
function ContinueWithChatGPT({
  disabled,
  onClick,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-black bg-black px-3 text-sm font-medium text-white outline-none hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/85"
    >
      <OpenAI aria-hidden="true" className="size-4 fill-current dark:fill-current" />
      Continue with ChatGPT
    </button>
  );
}

function ManageUsage() {
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
          aria-label="Manage usage in ChatGPT with the connected account"
        />
      }
    >
      Manage usage
    </Button>
  );
}

export function CodexVmConnectionSettings({
  organizationId,
  isAdmin,
}: {
  readonly organizationId: string;
  readonly isAdmin: boolean;
}) {
  const state = useCodexVmConnection(organizationId);
  const [confirmation, setConfirmation] = useState<"replace" | "disconnect" | null>(null);
  const connection = state.connection;
  const pending = state.attempt?.phase === "pending" || state.attempt?.phase === "exchanging";
  const connected = connection?.status === "connected";
  const reconnectRequired = connection?.status === "reconnect_required";
  const canSignIn = isAdmin && state.supported === true && !state.loading && !state.busy;
  const continueSignIn = () => {
    void (state.retryable
      ? state.retry()
      : connection?.connectionId
        ? state.reconnect()
        : state.connect());
  };
  const title =
    connection?.label ??
    (state.loading
      ? "Reading connection…"
      : state.error && !connection
        ? "Connection unavailable"
        : "No account connected");

  return (
    <>
      <SettingsSection
        id={searchableSetting("organization-codex-vms").id}
        title="Codex for VMs"
        icon={<OpenAI className="size-4" aria-hidden="true" />}
        headerAction={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh Codex VM connection"
            disabled={state.loading || state.busy}
            onClick={() => void state.refresh()}
          >
            <RefreshCwIcon />
          </Button>
        }
      >
        <SettingsRow
          title={title}
          description={
            connected
              ? "Using ChatGPT plan. VMs that select this account share its allowance."
              : "Connect a dedicated ChatGPT account once, then choose it when preparing VMs."
          }
          status={
            connection ? (
              <Badge variant={connected ? "success" : reconnectRequired ? "warning" : "secondary"}>
                {connection.refreshing
                  ? "Renewing session"
                  : connected
                    ? "Connected"
                    : reconnectRequired
                      ? "Reconnect required"
                      : "Disconnected"}
              </Badge>
            ) : undefined
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              {connected ? <ManageUsage /> : null}
              {isAdmin && pending && state.authorizationUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <a href={state.authorizationUrl} target="_blank" rel="noopener noreferrer" />
                  }
                >
                  Open ChatGPT sign-in
                </Button>
              ) : null}
              {isAdmin && pending ? (
                <Button size="sm" variant="outline" onClick={() => void state.cancel()}>
                  Cancel sign-in
                </Button>
              ) : null}
              {isAdmin && !pending && connection && (!connected || state.retryable) ? (
                <ContinueWithChatGPT disabled={!canSignIn} onClick={continueSignIn} />
              ) : null}
              {isAdmin && connection?.connectionId && !pending ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Codex VM account actions"
                        disabled={state.busy || state.loading}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem disabled={!canSignIn} onClick={() => void state.reconnect()}>
                      Reconnect with ChatGPT
                    </MenuItem>
                    <MenuItem disabled={!canSignIn} onClick={() => setConfirmation("replace")}>
                      Replace account…
                    </MenuItem>
                    {connection.status !== "disconnected" ? (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          variant="destructive"
                          onClick={() => setConfirmation("disconnect")}
                        >
                          Disconnect…
                        </MenuItem>
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          }
        >
          <div className="space-y-2 px-3 pb-3 text-sm sm:px-4">
            {pending ? (
              <p role="status" className="text-muted-foreground">
                Finish sign-in in your browser. This attempt expires after ten minutes.
              </p>
            ) : null}
            {state.loading && connection ? (
              <p role="status" className="text-muted-foreground">
                Refreshing connection…
              </p>
            ) : null}
            {state.error ? (
              <p role="alert" className="text-destructive">
                {state.error}
              </p>
            ) : null}
            {state.warning ? (
              <p role="status" className="text-warning-foreground">
                {state.warning}
              </p>
            ) : null}
            {!isAdmin ? (
              <p className="text-muted-foreground">
                Only organization admins can connect or change this account.
              </p>
            ) : null}
            {isAdmin && state.supported === false ? (
              <p className="text-muted-foreground">
                Connect from Launchpad desktop or a local web client with the browser and server on
                the same computer. SSH and remote connections cannot receive this sign-in callback.
              </p>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <Dialog
        open={isAdmin && confirmation !== null && connection !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "replace" ? "Replace the VM account?" : "Disconnect Codex for VMs?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "replace"
                ? "Existing VM selections stay tied to this account. After replacing it, select the new account during VM preparation."
                : "New Codex work using this connection will need a reconnect. Work already in progress may continue."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            {confirmation === "replace" ? (
              <ContinueWithChatGPT
                disabled={!canSignIn}
                onClick={() => {
                  setConfirmation(null);
                  void state.replace();
                }}
              />
            ) : (
              <Button
                variant="destructive"
                disabled={!isAdmin || state.busy || state.loading || !connection}
                onClick={() => {
                  setConfirmation(null);
                  void state.disconnect();
                }}
              >
                Disconnect
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={state.needsPlanConfirmation}
        onOpenChange={(open) => {
          if (!open) state.dismissPlanConfirmation();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>You&apos;re using your ChatGPT plan</DialogTitle>
            <DialogDescription>
              Codex requests from VMs that select this connection use this ChatGPT account&apos;s
              plan or credits. Manage that usage in ChatGPT Settings. Your organization&apos;s VM
              limits still apply.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <ManageUsage />
            <Button onClick={state.dismissPlanConfirmation}>Got it</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
