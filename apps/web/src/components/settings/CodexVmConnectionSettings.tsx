import { EllipsisIcon, InfoIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useCodexVmConnection } from "../../cloud/codexVmConnection";
import { cn } from "../../lib/utils";
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

/** Inline feedback shares the settings group's surface and separators. */
function ConnectionNotice({
  title,
  children,
  action,
  tone = "muted",
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: "muted" | "warning" | "error";
}) {
  const Icon = tone === "muted" ? InfoIcon : TriangleAlertIcon;
  return (
    <div
      role={tone === "muted" ? "status" : "alert"}
      className={cn(
        "@container/codex-notice px-3 py-3 last:rounded-b-xl sm:px-4",
        tone === "warning" && "bg-warning-surface text-warning-foreground",
      )}
    >
      <div className="flex flex-col items-start gap-3 @min-[24rem]/codex-notice:flex-row">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              tone === "muted" && "text-muted-foreground",
              tone === "warning" && "text-warning",
              tone === "error" && "text-destructive",
            )}
          />
          <div className="min-w-0 space-y-0.5 wrap-anywhere text-xs">
            <p className="font-medium">{title}</p>
            <div
              className={cn(
                "space-y-0.5",
                tone === "warning" ? "text-warning-foreground/80" : "text-muted-foreground",
              )}
            >
              {children}
            </div>
          </div>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
    </div>
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
  const readError = state.connectionReadError;
  const knownAccount = Boolean(connection?.connectionId);
  const accountMenu = isAdmin && knownAccount && !pending;
  const canRefresh = !state.loading && !state.busy;
  const checkSignIn = pending && !state.busy && !readError;
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
    (readError
      ? "Connection unavailable"
      : !connection
        ? "Reading connection…"
        : "No account connected");
  const lastKnownStatus = connected
    ? "Connected"
    : reconnectRequired
      ? "Reconnect required"
      : "Disconnected";
  const statusLabel =
    state.busy && !pending
      ? "Working…"
      : state.loading
        ? connection
          ? "Checking status…"
          : null
        : pending
          ? null
          : readError || !connection
            ? null
            : connection.refreshing
              ? "Renewing session"
              : lastKnownStatus;
  const verifiedIdle =
    !readError && !state.loading && !state.busy && !pending && !connection?.refreshing;

  return (
    <>
      <SettingsSection
        id={searchableSetting("organization-codex-vms").id}
        title="Codex for VMs"
        icon={<OpenAI className="size-4" aria-hidden="true" />}
      >
        <SettingsRow
          title={<span className="wrap-anywhere">{title}</span>}
          description={
            connected
              ? "Using ChatGPT plan. VMs that select this account share its allowance."
              : knownAccount
                ? "VMs using this account share its ChatGPT allowance."
                : "Connect a dedicated ChatGPT account once, then choose it when preparing VMs."
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              {statusLabel ? (
                <span role="status">
                  <Badge
                    variant={
                      verifiedIdle && connected
                        ? "success"
                        : verifiedIdle && reconnectRequired
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {statusLabel}
                  </Badge>
                </span>
              ) : null}
              {knownAccount ? <ManageUsage /> : null}
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
              {accountMenu ? (
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
                    {!readError ? (
                      <>
                        <MenuItem disabled={!canRefresh} onClick={() => void state.refresh()}>
                          <RefreshCwIcon />
                          Refresh status
                        </MenuItem>
                        <MenuSeparator />
                      </>
                    ) : null}
                    <MenuItem disabled={!canSignIn} onClick={() => void state.reconnect()}>
                      Reconnect with ChatGPT
                    </MenuItem>
                    <MenuItem disabled={!canSignIn} onClick={() => setConfirmation("replace")}>
                      Replace account…
                    </MenuItem>
                    {connection?.status !== "disconnected" ? (
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
              {!readError && !pending && !accountMenu ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Refresh Codex VM connection"
                  disabled={!canRefresh}
                  onClick={() => void state.refresh()}
                >
                  <RefreshCwIcon />
                </Button>
              ) : null}
            </div>
          }
        />
        {readError ? (
          <ConnectionNotice
            title="Can’t check account status"
            tone="warning"
            action={
              <Button
                size="xs"
                variant="outline"
                disabled={!canRefresh}
                onClick={() => void state.refresh()}
              >
                Retry
              </Button>
            }
          >
            <p>{readError}</p>
            {connection ? <p>Last known status: {lastKnownStatus}.</p> : null}
            {state.error === readError ? <p>The account action could not be confirmed.</p> : null}
          </ConnectionNotice>
        ) : null}
        {pending ? (
          <ConnectionNotice
            title={
              state.attempt?.phase === "exchanging"
                ? "Finishing sign-in…"
                : "Finish sign-in in your browser"
            }
            action={
              checkSignIn ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canRefresh}
                  onClick={() => void state.refresh()}
                >
                  Check sign-in status
                </Button>
              ) : undefined
            }
          >
            {state.attempt?.phase === "exchanging"
              ? state.busy
                ? "Waiting for the sign-in result."
                : "The sign-in result has not been confirmed yet."
              : "This attempt expires after ten minutes."}
          </ConnectionNotice>
        ) : null}
        {state.error && state.error !== readError ? (
          <ConnectionNotice title="Account action needs attention" tone="error">
            {state.error}
          </ConnectionNotice>
        ) : null}
        {state.warning ? (
          <ConnectionNotice title="Review the previous session" tone="warning">
            {state.warning}
          </ConnectionNotice>
        ) : null}
        {!isAdmin ? (
          <ConnectionNotice title="Account management">
            Only organization admins can connect or change this account.
          </ConnectionNotice>
        ) : null}
        {isAdmin && state.supported === false ? (
          <ConnectionNotice title="Local sign-in required">
            Connect from Launchpad desktop or a local web client with the browser and server on the
            same computer. SSH and remote connections cannot receive this sign-in callback.
          </ConnectionNotice>
        ) : null}
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
