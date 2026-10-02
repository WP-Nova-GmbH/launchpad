import type {
  RelaySelectJiraSiteRequest,
  RelayStartJiraResponse,
  RelayIssueTrackerConnection,
  RelayIssueTrackerConnections,
  RelayIssueTrackerService,
  RelayStartLinearResponse,
} from "@t3tools/contracts/relay";
import { CircleDotIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../ui/badge";
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
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export interface IssueTrackersSectionProps {
  readonly snapshot: RelayIssueTrackerConnections | null;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly unverified: boolean;
  readonly confirmLinearReplacement: (proposalId: string) => Promise<void>;
  readonly cancelLinearReplacement: (proposalId: string) => Promise<void>;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly startLinear: () => Promise<RelayStartLinearResponse>;
  readonly startJira: () => Promise<RelayStartJiraResponse>;
  readonly selectJiraSite: (input: RelaySelectJiraSiteRequest) => Promise<void>;
  readonly cancelJiraSelection: (authorizationId: string) => Promise<void>;
  readonly disconnect: (service: RelayIssueTrackerService) => Promise<void>;
}

const SERVICE_NAMES = { linear: "Linear", jira: "Jira" } as const;
const SERVICES = ["linear", "jira"] as const;

function connectionDescription(
  service: RelayIssueTrackerService,
  connection?: RelayIssueTrackerConnection,
) {
  if (connection?.authorization?.phase === "selecting_site")
    return connection.accountLabel
      ? `${connection.accountLabel} · Choose a site to finish the new connection.`
      : "Choose a Jira site to finish connecting.";
  if (connection?.status === "connecting")
    return "Not connected yet. Finish setup in your browser, then refresh.";
  if (connection?.status === "reconnect_required") {
    return connection.accountLabel
      ? `${connection.accountLabel} · Sign in again to read issues.`
      : "Sign in again to read issues.";
  }
  if (connection?.status === "connected")
    return connection.accountLabel ?? "Connected to your account.";
  return service === "linear"
    ? "Read issues from your Linear workspace."
    : "Read issues from your Jira Cloud site.";
}

/** The actual settings surface, kept separate from authentication for client rendering and previews. */
export function IssueTrackersSection({
  snapshot,
  loading,
  mutating,
  unverified,
  confirmLinearReplacement,
  cancelLinearReplacement,
  error,
  refresh,
  startLinear,
  startJira,
  selectJiraSite,
  cancelJiraSelection,
  disconnect,
}: IssueTrackersSectionProps) {
  const [dialog, setDialog] = useState<RelayIssueTrackerService | null>(null);
  const [disconnectService, setDisconnectService] = useState<RelayIssueTrackerService | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [review, setReview] = useState<RelayIssueTrackerConnection["replacement"]>(undefined);
  const [siteChoice, setSiteChoice] = useState<RelaySelectJiraSiteRequest | null>(null);
  const fieldId = useId();
  const providerName = dialog === "jira" ? "Atlassian" : "Linear";
  const authorizing = snapshot?.connections.find((entry) => entry.service === dialog);
  const choosingJiraSite =
    dialog === "jira" &&
    authorizing?.authorization?.phase === "selecting_site" &&
    authorizing.jiraSites !== undefined;
  const selectedCloudId =
    siteChoice?.authorizationId === authorizing?.authorization?.id
      ? (siteChoice?.cloudId ?? "")
      : "";
  const linear = snapshot?.connections.find((entry) => entry.service === "linear");
  const cancellingSetup =
    snapshot?.connections.find((entry) => entry.service === disconnectService)?.status ===
    "connecting";
  const disabled = busy || mutating || unverified;
  const reviewIsCurrent = review !== undefined && review.id === linear?.replacement?.id;

  // Connected describes the active workspace, even throughout a new OAuth flow.
  // Close only when our exact authorization attempt disappears or is superseded.
  const connectDialogOpen =
    dialog !== null && (!authorizationId || authorizing?.authorization?.id === authorizationId);
  const dialogOpen = connectDialogOpen || review !== undefined || disconnectService !== null;
  // A refresh can close the dialog before a failed mutation reports its error.
  const sectionError = error ?? (dialogOpen ? null : dialogError);

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setDisconnectService(null);
    setReview(undefined);
    setAuthorizationUrl(null);
    setAuthorizationId(null);
    setDialogError(null);
  };

  const showConnect = (service: RelayIssueTrackerService) => {
    setDialogError(null);
    setAuthorizationUrl(null);
    setAuthorizationId(null);
    setDialog(service);
    void run(() => beginAuthorization(service));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setDialogError(null);
    try {
      await action();
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "Could not update the connection.");
    } finally {
      setBusy(false);
    }
  };

  const beginAuthorization = async (service: RelayIssueTrackerService) => {
    const result = await (service === "jira" ? startJira() : startLinear());
    setAuthorizationUrl(result.authorizationUrl);
    setAuthorizationId(result.authorizationId);
    window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <SettingsSection
      {...searchableSetting("personal-issue-trackers")}
      icon={<CircleDotIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh issue trackers"
          disabled={loading || busy || mutating}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      }
    >
      <div className="space-y-1 px-3 py-3 sm:px-4">
        <p className="text-sm text-muted-foreground">Your personal Jira and Linear connections.</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Read-only access for messages you send in local and managed chats. Other people use their
          own connections. Retrieved content remains visible to everyone in the chat.
        </p>
      </div>
      {unverified ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          Could not verify the current connection. Refresh to check. Connection details below are
          last known.
        </p>
      ) : null}
      {sectionError ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {sectionError}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status" className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {loading ? "Loading issue trackers…" : "Refresh to load your connections."}
        </p>
      ) : (
        SERVICES.map((service) => {
          const connection = snapshot.connections.find((entry) => entry.service === service);
          const available = service !== "linear" || snapshot.linearAvailable;
          const name = SERVICE_NAMES[service];
          return (
            <SettingsRow
              key={service}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {name}
                  {connection ? (
                    <Badge
                      variant={
                        connection.status === "connected"
                          ? "success"
                          : connection.status === "reconnect_required"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {connection.status === "connected"
                        ? "Connected"
                        : connection.status === "reconnect_required"
                          ? "Sign-in required"
                          : "Setup incomplete"}
                    </Badge>
                  ) : null}
                </span>
              }
              description={connectionDescription(service, connection)}
              status={
                !connection && !available
                  ? "Linear is not configured on this Launchpad. Ask its operator to enable it."
                  : null
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  {connection ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        setDialogError(null);
                        setDisconnectService(service);
                      }}
                    >
                      {connection.status === "connecting" ? "Cancel setup" : "Disconnect"}
                    </Button>
                  ) : null}
                  {service === "jira" && connection?.jiraSites && connection.authorization ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        setDialogError(null);
                        setAuthorizationUrl(null);
                        setAuthorizationId(connection.authorization!.id);
                        setSiteChoice(null);
                        setDialog("jira");
                      }}
                    >
                      Choose site
                    </Button>
                  ) : null}
                  {service === "linear" && connection?.replacement ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        setDialogError(null);
                        setReview(connection.replacement);
                      }}
                    >
                      Review change
                    </Button>
                  ) : null}
                  {(connection?.status !== "connected" || service === "linear") &&
                  !connection?.jiraSites ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || !available}
                      onClick={() => showConnect(service)}
                    >
                      {connection?.status === "connected"
                        ? "Change workspace"
                        : connection?.status === "connecting"
                          ? "Try again"
                          : connection
                            ? "Reconnect"
                            : "Connect"}
                    </Button>
                  ) : null}
                </div>
              }
            />
          );
        })
      )}
      <Dialog
        open={connectDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !choosingJiraSite || !selectedCloudId || !authorizing.authorization)
                return;
              const authorizationId = authorizing.authorization.id;
              void run(() => selectJiraSite({ authorizationId, cloudId: selectedCloudId }));
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {choosingJiraSite
                  ? "Choose Jira site"
                  : authorizationUrl
                    ? `Waiting for ${providerName}`
                    : dialogError
                      ? `Could not open ${providerName}`
                      : `Connecting to ${providerName}`}
              </DialogTitle>
              <DialogDescription>
                Connect your account for read-only issue access.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {choosingJiraSite ? (
                <RadioGroup
                  aria-label="Jira site"
                  value={selectedCloudId}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (typeof value === "string" && authorizing.authorization)
                      setSiteChoice({
                        authorizationId: authorizing.authorization.id,
                        cloudId: value,
                      });
                  }}
                >
                  {authorizing.jiraSites?.map((site, index) => (
                    <label
                      key={site.cloudId}
                      htmlFor={`${fieldId}-site-${index}`}
                      className="flex cursor-pointer items-center gap-3 rounded-md border p-3"
                    >
                      <RadioGroupItem id={`${fieldId}-site-${index}`} value={site.cloudId} />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">
                          {site.accountLabel}
                        </span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {new URL(site.siteUrl).hostname}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              ) : (
                <>
                  <p role="status" className="text-sm leading-relaxed text-muted-foreground">
                    {authorizationUrl
                      ? `Finish in ${providerName}, then return here.`
                      : busy
                        ? `Opening ${providerName}…`
                        : "Try again to open the sign-in page."}
                  </p>
                  {authorizationUrl ? (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      If the browser did not open,{" "}
                      <a
                        href={authorizationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        open {providerName}
                      </a>
                      .
                    </p>
                  ) : null}
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Only messages you send can use this connection.
                  </p>
                  {dialog === "linear" && linear?.accountLabel ? (
                    <p className="text-sm text-muted-foreground">
                      {linear.accountLabel} remains selected until you confirm a different
                      workspace.
                    </p>
                  ) : null}
                </>
              )}
              {dialogError || error ? (
                <p role="alert" className="text-sm text-destructive">
                  {dialogError ?? error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || mutating}
                onClick={closeDialog}
              >
                Close
              </Button>
              {choosingJiraSite ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void run(async () => {
                        if (authorizing.authorization)
                          await cancelJiraSelection(authorizing.authorization.id);
                      })
                    }
                  >
                    Cancel setup
                  </Button>
                  <Button type="submit" disabled={disabled || !selectedCloudId}>
                    {busy ? "Connecting…" : "Connect"}
                  </Button>
                </>
              ) : authorizationUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || busy || mutating}
                  onClick={() => void refresh()}
                >
                  Check connection
                </Button>
              ) : dialogError ? (
                <Button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (dialog) void run(() => beginAuthorization(dialog));
                  }}
                >
                  Try again
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={review !== undefined}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Replace Linear workspace?</DialogTitle>
            <DialogDescription>
              Change your connected workspace. Future issue reads will use the new workspace.
              Existing chat history will remain available.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Current workspace</dt>
                <dd className="font-medium">{review?.currentAccountLabel}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">New workspace</dt>
                <dd className="font-medium">{review?.accountLabel}</dd>
              </div>
            </dl>
            {!reviewIsCurrent ? (
              <p role="status" className="text-sm text-muted-foreground">
                This change is no longer available. Close this dialog to see the current connection.
              </p>
            ) : null}
            {dialogError || unverified ? (
              <p role="alert" className="text-sm text-destructive">
                {unverified
                  ? "Could not verify the current connection. Close this dialog and refresh to check."
                  : dialogError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={disabled || !reviewIsCurrent}
              onClick={() => {
                if (!review || disabled || !reviewIsCurrent) return;
                void run(async () => {
                  await cancelLinearReplacement(review.id);
                  setReview(undefined);
                });
              }}
            >
              Cancel change
            </Button>
            <Button
              disabled={disabled || !reviewIsCurrent}
              onClick={() => {
                if (!review || disabled || !reviewIsCurrent) return;
                void run(async () => {
                  await confirmLinearReplacement(review.id);
                  setReview(undefined);
                });
              }}
            >
              {busy ? "Updating…" : "Replace"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={disconnectService !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {cancellingSetup ? "Cancel" : "Disconnect"}{" "}
              {disconnectService ? SERVICE_NAMES[disconnectService] : "issue tracker"}
              {cancellingSetup ? " setup" : ""}?
            </DialogTitle>
            <DialogDescription>
              {cancellingSetup
                ? "This setup is unfinished. Cancel it and start again when you’re ready."
                : "New issue reads using your connection will stop. Content already retrieved stays in chat history."}
            </DialogDescription>
          </DialogHeader>
          {dialogError ? (
            <DialogPanel>
              <p role="alert" className="text-sm text-destructive">
                {dialogError}
              </p>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" disabled={busy || mutating} onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                if (!disconnectService || disabled) return;
                const service = disconnectService;
                void run(async () => {
                  await disconnect(service);
                  setDisconnectService(null);
                });
              }}
            >
              {busy
                ? cancellingSetup
                  ? "Cancelling…"
                  : "Disconnecting…"
                : cancellingSetup
                  ? "Cancel setup"
                  : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
