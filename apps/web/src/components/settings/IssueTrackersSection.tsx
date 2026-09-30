import type {
  RelayConnectJiraRequest,
  RelayIssueTrackerConnection,
  RelayIssueTrackerConnections,
  RelayIssueTrackerService,
  RelayStartLinearResponse,
} from "@t3tools/contracts/relay";
import { ArrowUpRightIcon, CheckIcon, CircleDotIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

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
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export interface IssueTrackersSectionProps {
  readonly isAdmin: boolean;
  readonly organizationName: string;
  readonly snapshot: RelayIssueTrackerConnections | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly startLinear: () => Promise<RelayStartLinearResponse>;
  readonly connectJira: (input: RelayConnectJiraRequest) => Promise<void>;
  readonly disconnect: (service: RelayIssueTrackerService) => Promise<void>;
}

const SERVICE_NAMES = { linear: "Linear", jira: "Jira" } as const;
const SERVICES = ["linear", "jira"] as const;
const JIRA_SETUP_URL =
  "https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/";

function connectionDescription(
  service: RelayIssueTrackerService,
  connection?: RelayIssueTrackerConnection,
) {
  if (connection?.status === "connecting")
    return "Finish connecting in your browser, then refresh.";
  if (connection?.status === "reconnect_required") {
    return connection.accountLabel
      ? `${connection.accountLabel} · Sign in again to read issues.`
      : "Sign in again to read issues.";
  }
  if (connection?.status === "connected")
    return connection.accountLabel ?? "Shared with your organization.";
  return service === "linear"
    ? "Read issues from a shared Linear workspace."
    : "Read issues from a shared Jira Cloud site.";
}

/** The actual settings surface, kept separate from authentication for client rendering and previews. */
export function IssueTrackersSection({
  isAdmin,
  organizationName,
  snapshot,
  loading,
  error,
  refresh,
  startLinear,
  connectJira,
  disconnect,
}: IssueTrackersSectionProps) {
  const [dialog, setDialog] = useState<RelayIssueTrackerService | null>(null);
  const [disconnectService, setDisconnectService] = useState<RelayIssueTrackerService | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [issue, setIssue] = useState("");
  const fieldId = useId();
  const linearConnected = snapshot?.connections.some(
    (entry) => entry.service === "linear" && entry.status === "connected",
  );

  useEffect(() => {
    if (dialog === "linear" && authorizationUrl && linearConnected) {
      setDialog(null);
      setAuthorizationUrl(null);
    }
  }, [authorizationUrl, dialog, linearConnected]);

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setDisconnectService(null);
    setApiKey("");
    setAuthorizationUrl(null);
    setDialogError(null);
  };

  const showConnect = (service: RelayIssueTrackerService) => {
    setDialogError(null);
    setAuthorizationUrl(null);
    setDialog(service);
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

  return (
    <SettingsSection
      {...searchableSetting("organization-issue-trackers")}
      icon={<CircleDotIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh issue trackers"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      }
    >
      <div className="space-y-1 px-3 py-3 sm:px-4">
        <p className="text-sm text-muted-foreground">Shared issue access for {organizationName}.</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Read-only, in chats on organization-managed executors. Personal machines and external
          OpenCode servers are not supported yet.
        </p>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {error}
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
              title={name}
              description={connectionDescription(service, connection)}
              status={
                connection ? (
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
                        : "Connecting"}
                  </Badge>
                ) : !available ? (
                  "Linear is not configured on this Launchpad. Ask its operator to enable it."
                ) : null
              }
              control={
                isAdmin ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {connection ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setDialogError(null);
                          setDisconnectService(service);
                        }}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                    {connection?.status !== "connected" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !available}
                        onClick={() => showConnect(service)}
                      >
                        {connection ? "Reconnect" : "Connect"}
                      </Button>
                    ) : null}
                  </div>
                ) : !connection || connection.status !== "connected" ? (
                  <span className="text-xs text-muted-foreground">
                    Ask an admin to {connection ? "reconnect" : "connect"}.
                  </span>
                ) : null
              }
            />
          );
        })
      )}
      <Dialog
        open={isAdmin && dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              void run(async () => {
                if (dialog === "linear") {
                  const result = await startLinear();
                  setAuthorizationUrl(result.authorizationUrl);
                  window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
                } else if (dialog === "jira") {
                  await connectJira({
                    siteUrl: siteUrl.trim(),
                    apiKey: apiKey.trim(),
                    issue: issue.trim(),
                  });
                  setApiKey("");
                  setDialog(null);
                }
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Connect {dialog === "jira" ? "Jira" : "Linear"}</DialogTitle>
              <DialogDescription>
                Share read-only issue access with {organizationName}.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {dialog === "jira" ? (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor={`${fieldId}-site`} className="text-sm font-medium">
                      Jira site
                    </label>
                    <Input
                      nativeInput
                      id={`${fieldId}-site`}
                      type="url"
                      required
                      placeholder="https://your-team.atlassian.net"
                      value={siteUrl}
                      onChange={(event) => setSiteUrl(event.currentTarget.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`${fieldId}-key`} className="text-sm font-medium">
                      Service account API key
                    </label>
                    <Input
                      nativeInput
                      id={`${fieldId}-key`}
                      type="password"
                      autoComplete="off"
                      required
                      value={apiKey}
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      disabled={busy}
                      aria-describedby={`${fieldId}-key-note`}
                    />
                    <p
                      id={`${fieldId}-key-note`}
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      An Atlassian admin must enable API key access for the MCP server.{" "}
                      <a
                        href={JIRA_SETUP_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        Setup instructions
                      </a>
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`${fieldId}-issue`} className="text-sm font-medium">
                      Issue to verify access
                    </label>
                    <Input
                      nativeInput
                      id={`${fieldId}-issue`}
                      required
                      placeholder="PROJ-123"
                      value={issue}
                      onChange={(event) => setIssue(event.currentTarget.value)}
                      disabled={busy}
                      aria-describedby={`${fieldId}-issue-note`}
                    />
                    <p
                      id={`${fieldId}-issue-note`}
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      An issue key or URL from this site. Launchpad reads it once to check access.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Authorize the Launchpad app in Linear. Your organization shares the workspace
                    access you grant.
                  </p>
                  <div className="flex items-start gap-2 text-sm">
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p>Read issues by ID or link. No issue edits, comments, or automatic jobs.</p>
                  </div>
                  {authorizationUrl ? (
                    <p role="status" className="text-sm leading-relaxed text-muted-foreground">
                      Finish in Linear, then return here. If the browser did not open,{" "}
                      <a
                        href={authorizationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        open Linear
                      </a>
                      .
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
              <Button type="button" variant="ghost" disabled={busy} onClick={closeDialog}>
                {authorizationUrl ? "Close" : "Cancel"}
              </Button>
              {authorizationUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={loading || busy}
                  onClick={() => void refresh()}
                >
                  Check connection
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (dialog === "jira" && (!siteUrl.trim() || !apiKey.trim() || !issue.trim()))
                  }
                >
                  {busy
                    ? dialog === "jira"
                      ? "Checking access…"
                      : "Opening Linear…"
                    : dialog === "jira"
                      ? "Connect Jira"
                      : "Continue to Linear"}
                  {dialog === "linear" && !busy ? <ArrowUpRightIcon className="size-3.5" /> : null}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={isAdmin && disconnectService !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              Disconnect {disconnectService ? SERVICE_NAMES[disconnectService] : "issue tracker"}?
            </DialogTitle>
            <DialogDescription>
              New issue reads will stop for everyone in {organizationName}. Content already
              retrieved stays in chat history.
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
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!disconnectService) return;
                const service = disconnectService;
                void run(async () => {
                  await disconnect(service);
                  setDisconnectService(null);
                });
              }}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
