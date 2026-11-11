import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
  type RelayOrganizationId,
  type WorkflowSource,
  type WorkflowSourceOwner,
  type WorkflowSourceAuthorization,
} from "@t3tools/contracts/relay";
import { useCallback, useState } from "react";
import { EllipsisIcon, RefreshCwIcon } from "lucide-react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { randomUUID } from "../../lib/utils";
import type { SettingsRow as OrganizationSettingsRow } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SourceFacts, SourceIdentity, confirmChange } from "./WorkflowSources";

const repositoryNameKey = (name: string) => name.trim().replace(/\s+/gu, " ").toLowerCase();

export function OwnerSources({
  accountId,
  organizationId,
  settingsRow: SettingsRow,
}: {
  accountId: string;
  organizationId: RelayOrganizationId;
  settingsRow?: typeof OrganizationSettingsRow;
}) {
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) => client.owner(token, organizationId),
    [organizationId],
  );
  const state = useWorkflowSources<WorkflowSourceOwner>(accountId, read);
  const [authorization, setAuthorization] =
    useState<WorkflowSourceAuthorization["authorization"]>(null);
  const snapshot = state.snapshot,
    disabled = state.busy || state.loading || state.unverified;
  const exchangeInProgress = snapshot?.exchangeInProgress === true;
  const authorizationBlocked = disabled || exchangeInProgress;
  const matches = (
    link: WorkflowSourceAuthorization["authorization"],
    current: WorkflowSourceOwner,
  ) =>
    link !== null &&
    current.applicationId === link.applicationId &&
    current.attempt?.attemptId === link.attemptId &&
    current.attempt.status === "pending" &&
    current.attempt.canResume;
  const activeAuthorization =
    !authorizationBlocked && snapshot && matches(authorization, snapshot) ? authorization : null;
  const connect = async (connectionId: string | null, resumeId?: string) => {
    if (!snapshot) return;
    const result = await state.mutate((client, token) =>
      client.begin(token, organizationId, {
        attemptId: resumeId ?? randomUUID(),
        expectedVersion: snapshot.version,
        connectionId,
      }),
    );
    if (!result) return;
    const link = result.result.authorization;
    if (link && matches(link, result.snapshot)) {
      setAuthorization(link);
      window.open(link.url, "_blank", "noopener,noreferrer");
    }
  };
  const connections = snapshot?.connections ?? [];
  const duplicateRepositoryNames = new Set<string>();
  for (const names of [
    snapshot?.repositories.map(({ name }) => name),
    snapshot?.withdrawableGrants.map(({ repositoryName }) => repositoryName),
  ]) {
    const seen = new Set<string>();
    for (const name of names ?? []) {
      if (name === null) continue;
      const key = repositoryNameKey(name);
      if (seen.has(key)) duplicateRepositoryNames.add(key);
      else seen.add(key);
    }
  }
  const hasAuthorizationNotice =
    snapshot?.attempt?.status === "pending" ||
    snapshot?.attempt?.status === "exchanging" ||
    snapshot?.attempt?.status === "failed";
  const serviceConfigurationFailure =
    snapshot?.attempt?.status === "failed" && snapshot.attempt.error === "service_configuration";
  const retryFirstAuthorization =
    SettingsRow &&
    serviceConfigurationFailure &&
    snapshot.configured &&
    !connections.length &&
    !exchangeInProgress;
  const refreshFailedAuthorization = serviceConfigurationFailure && !retryFirstAuthorization;
  const showSettingsRefresh = !state.error && !serviceConfigurationFailure;
  const refreshButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Refresh workflow sources"
      disabled={state.busy || state.loading}
      onClick={() => void state.refresh()}
    >
      <RefreshCwIcon aria-hidden />
    </Button>
  );
  const connectWorkspace =
    snapshot?.configured &&
    !connections.length &&
    !exchangeInProgress &&
    (!SettingsRow || !hasAuthorizationNotice) ? (
      <Button
        size={SettingsRow ? "sm" : "default"}
        disabled={disabled}
        onClick={() => void connect(null)}
      >
        Connect Linear workspace
      </Button>
    ) : null;
  const notices = (
    <>
      {state.error ? (
        <WorkflowAlert
          title="Could not update Linear connections"
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || state.loading}
              onClick={() => void state.refresh()}
            >
              Retry connections
            </Button>
          }
        >
          {state.error}
          {snapshot ? " Showing last available status." : ""}
        </WorkflowAlert>
      ) : null}
      {!snapshot ? (
        SettingsRow ? null : (
          <p className="text-sm text-muted-foreground">
            {state.loading ? "Loading workflow sources…" : "Refresh to load workflow sources."}
          </p>
        )
      ) : (
        <>
          {!snapshot.configured ? (
            <WorkflowAlert title="Linear workflow connections unavailable" variant="info">
              Ask your relay administrator to configure Linear for this organization.
            </WorkflowAlert>
          ) : !SettingsRow && connectWorkspace ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Connect a Linear workspace to use it in automatic triggers.
              </p>
              {connectWorkspace}
            </div>
          ) : null}
          {snapshot.attempt && ["pending", "exchanging"].includes(snapshot.attempt.status) ? (
            <div className="space-y-2">
              <p className="text-sm">
                {exchangeInProgress
                  ? "Finishing Linear authorization…"
                  : "Waiting for Linear authorization."}
              </p>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setAuthorization(null);
                  void state.mutate((c, t) =>
                    c.cancel(t, organizationId, snapshot.attempt!.attemptId),
                  );
                }}
              >
                Cancel authorization
              </Button>
            </div>
          ) : exchangeInProgress ? (
            <p role="status" className="text-sm">
              Finishing Linear authorization…
            </p>
          ) : null}
          {snapshot.attempt?.status === "pending" &&
          snapshot.attempt.canResume &&
          !activeAuthorization ? (
            <Button
              variant="outline"
              disabled={authorizationBlocked}
              onClick={() =>
                void connect(snapshot.attempt!.connectionId, snapshot.attempt!.attemptId)
              }
            >
              Continue authorization
            </Button>
          ) : null}
          {snapshot.attempt?.status === "failed" ? (
            <WorkflowAlert
              title="Linear authorization did not finish"
              variant="warning"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || (exchangeInProgress && !refreshFailedAuthorization)}
                  onClick={() =>
                    refreshFailedAuthorization
                      ? void state.refresh()
                      : void connect(
                          retryFirstAuthorization ? null : snapshot.attempt!.connectionId,
                        )
                  }
                >
                  {refreshFailedAuthorization ? "Refresh connection status" : "Retry authorization"}
                </Button>
              }
            >
              {snapshot.attempt.error === "service_configuration"
                ? "Linear service configuration needs attention. Retry after it is restored."
                : "Authorization did not complete. Check the connection and try again."}
            </WorkflowAlert>
          ) : null}
          {activeAuthorization ? (
            <a
              href={activeAuthorization.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Continue authorization in Linear
            </a>
          ) : null}
        </>
      )}
    </>
  );
  return (
    <section aria-label="Linear for workflows">
      {!SettingsRow ? (
        <header className="flex items-center justify-between gap-2 px-4">
          <h3 className="text-sm font-medium">Linear connection</h3>
          {refreshButton}
        </header>
      ) : !connections.length ? (
        <SettingsRow
          title="Linear"
          description={
            !snapshot && !state.error ? (
              <span role="status">Reading connection…</span>
            ) : snapshot?.configured ? (
              "Use Linear issues to trigger workflows."
            ) : undefined
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              {connectWorkspace}
              {showSettingsRefresh ? refreshButton : null}
            </div>
          }
        />
      ) : null}
      <div className={SettingsRow ? undefined : "space-y-4 px-4 py-3"}>
        {SettingsRow ? (
          <div className="space-y-3 px-3 py-3 empty:hidden sm:px-4">{notices}</div>
        ) : (
          notices
        )}
        {snapshot && connections.length > 0 ? (
          <div className="divide-y divide-border/50">
            {connections.map((source) => (
              <OwnerSourceRow
                key={source.connectionId}
                organizationId={organizationId}
                source={source}
                snapshot={snapshot}
                duplicateRepositoryNames={duplicateRepositoryNames}
                disabled={disabled}
                reconnect={() => void connect(source.connectionId)}
                mutate={state.mutate}
                settings={
                  SettingsRow
                    ? {
                        Row: SettingsRow,
                        stale: state.error !== null,
                        refreshing: state.loading,
                        refresh: showSettingsRefresh ? state.refresh : undefined,
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
type OwnerState = ReturnType<typeof useWorkflowSources<WorkflowSourceOwner>>;
function OwnerSourceRow({
  organizationId,
  source,
  snapshot,
  duplicateRepositoryNames,
  disabled,
  reconnect,
  mutate,
  settings,
}: {
  organizationId: RelayOrganizationId;
  source: WorkflowSource;
  snapshot: WorkflowSourceOwner;
  duplicateRepositoryNames: ReadonlySet<string>;
  disabled: boolean;
  reconnect: () => void;
  mutate: OwnerState["mutate"];
  settings:
    | {
        Row: typeof OrganizationSettingsRow;
        stale: boolean;
        refreshing: boolean;
        refresh: OwnerState["refresh"] | undefined;
      }
    | undefined;
}) {
  const [repo, setRepo] = useState<string | null>(null);
  const current = snapshot.grants.filter((g) => g.connectionId === source.connectionId);
  const eligible = snapshot.repositories.filter(
    (r) => !current.some((g) => g.repositoryId === r.repositoryId && !g.revoked),
  );
  const authorizationBlocked = disabled || snapshot.exchangeInProgress;
  const needsReconnect = source.status !== "connected";
  const canReconnect = snapshot.configured && source.health.code !== "service_configuration";
  const grants = snapshot.withdrawableGrants.filter((g) => g.connectionId === source.connectionId);
  const connectedToCurrentApp =
    !needsReconnect && snapshot.configured && source.applicationId === snapshot.applicationId;
  const showCheckInline = source.health.code !== "healthy";
  const check = () => void mutate((c, t) => c.refreshOwner(t, organizationId, source.connectionId));
  const checkConnection = connectedToCurrentApp ? (
    <Button
      size="sm"
      variant={showCheckInline ? "outline" : "ghost"}
      disabled={authorizationBlocked}
      onClick={check}
    >
      Check connection
    </Button>
  ) : null;
  const reconnectInline = needsReconnect && canReconnect;
  const reconnectInMenu = !needsReconnect && canReconnect;
  const checkInMenu = !showCheckInline && connectedToCurrentApp;
  const canDisconnect = source.status !== "disconnected";
  const disconnect = async () => {
    if (
      await confirmChange(
        "Disconnect this Linear source? Future events and queued starts will be blocked. Starting and running work may continue; use Cancel run to stop it.",
      )
    )
      await mutate((c, t) =>
        c.disconnect(t, organizationId, {
          connectionId: source.connectionId,
          expectedEpoch: source.authorizationEpoch,
        }),
      );
  };
  const recovery = (
    <>
      {showCheckInline ? checkConnection : null}
      {reconnectInline ? (
        <Button size="sm" disabled={authorizationBlocked} onClick={reconnect}>
          Reconnect Linear
        </Button>
      ) : null}
    </>
  );
  const health = WorkflowSources.sourceHealthLabel(source);
  const refresh = settings?.refresh;
  const hasMenuActions = refresh || checkInMenu || reconnectInMenu;
  return (
    <div className={settings ? undefined : "space-y-4"}>
      {settings ? (
        <settings.Row
          title={<span className="wrap-anywhere">{source.workspaceName}</span>}
          description={
            source.status === "connected" ? (
              <>
                {source.viewerName && source.viewerName !== source.workspaceName
                  ? `Connected to Linear as ${source.viewerName}. `
                  : "Linear workspace. "}
                {WorkflowSources.sourceDeliveryLabel(source)}
              </>
            ) : (
              "Linear workspace"
            )
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              <span role="status">
                <Badge
                  variant={
                    disabled || settings.stale || source.status === "disconnected"
                      ? "secondary"
                      : health === "Connected"
                        ? "success"
                        : "warning"
                  }
                >
                  {settings.refreshing ? "Checking status…" : health}
                </Badge>
              </span>
              {recovery}
              {hasMenuActions || canDisconnect ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Linear connection actions for ${source.workspaceName}`}
                        disabled={disabled}
                      />
                    }
                  >
                    <EllipsisIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {refresh ? (
                      <MenuItem disabled={disabled} onClick={() => void refresh()}>
                        <RefreshCwIcon aria-hidden />
                        Refresh status
                      </MenuItem>
                    ) : null}
                    {checkInMenu ? (
                      <MenuItem disabled={authorizationBlocked} onClick={check}>
                        Check connection
                      </MenuItem>
                    ) : null}
                    {reconnectInMenu ? (
                      <MenuItem disabled={authorizationBlocked} onClick={reconnect}>
                        Reconnect Linear
                      </MenuItem>
                    ) : null}
                    {canDisconnect ? (
                      <>
                        {hasMenuActions ? <MenuSeparator /> : null}
                        <MenuItem
                          variant="destructive"
                          disabled={disabled}
                          onClick={() => void disconnect()}
                        >
                          Disconnect
                        </MenuItem>
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          }
        />
      ) : (
        <div className="space-y-3">
          <SourceIdentity source={source} />
          <SourceFacts source={source} showDelivery />
          {recovery}
          {canDisconnect ? (
            <details>
              <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
                Connection actions
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {reconnectInMenu ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={authorizationBlocked}
                    onClick={reconnect}
                  >
                    Reconnect Linear
                  </Button>
                ) : null}
                {showCheckInline ? null : checkConnection}
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={disabled}
                  onClick={disconnect}
                >
                  Disconnect
                </Button>
              </div>
            </details>
          ) : null}
        </div>
      )}
      <section
        className={
          settings
            ? "space-y-1 border-t border-border/50 px-3 py-3 sm:px-4"
            : "space-y-2 border-t pt-3"
        }
        aria-label="Repository access"
      >
        <h4
          className={settings ? "text-xs font-medium text-muted-foreground" : "text-sm font-medium"}
        >
          Repository access
        </h4>
        {grants.length ? (
          <ul className={settings ? "divide-y divide-border/50" : "space-y-2"}>
            {grants.map((grant) => {
              const name = grant.repositoryName;
              const disambiguate =
                name !== null && duplicateRepositoryNames.has(repositoryNameKey(name));
              const repositoryId =
                disambiguate && grant.repositoryRemote === undefined
                  ? current.find((entry) => entry.grantId === grant.grantId)?.repositoryId
                  : undefined;
              const repositoryDetail = disambiguate
                ? (grant.repositoryRemote ??
                  (repositoryId ? `Repository ID ${repositoryId}` : `Grant ID ${grant.grantId}`))
                : undefined;
              const repositoryLabel = repositoryDetail ? `${name} (${repositoryDetail})` : name;
              return (
                <li
                  key={grant.grantId}
                  className={
                    settings
                      ? "flex min-h-10 items-center justify-between gap-3 py-1.5 sm:min-h-9"
                      : "flex flex-wrap items-center gap-2 text-sm"
                  }
                >
                  <div className="min-w-0 flex-1 wrap-anywhere">
                    <span className={settings ? "font-mono text-xs" : undefined}>
                      {name ?? "Repository no longer visible"}
                    </span>
                    {repositoryDetail ? (
                      <p className="text-xs text-muted-foreground">{repositoryDetail}</p>
                    ) : null}
                    {name === null ? (
                      <p className="text-xs text-muted-foreground">
                        You can still withdraw this repository's access.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size={settings ? "xs" : "sm"}
                    variant={settings ? "outline" : "ghost"}
                    aria-label={
                      repositoryLabel ? `Withdraw access for ${repositoryLabel}` : undefined
                    }
                    disabled={disabled}
                    onClick={async () => {
                      if (
                        await confirmChange(
                          repositoryLabel
                            ? `Withdraw source access for ${repositoryLabel}? Starting and running work may continue.`
                            : "Withdraw this repository's source access? Starting and running work may continue.",
                        )
                      )
                        await mutate((c, t) => c.withdrawOwner(t, organizationId, grant.grantId));
                    }}
                  >
                    Withdraw access
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p
            className={settings ? "text-xs text-muted-foreground" : "text-sm text-muted-foreground"}
          >
            No repositories have access.
          </p>
        )}
        {connectedToCurrentApp && eligible.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select value={repo} onValueChange={setRepo} disabled={authorizationBlocked}>
                <SelectTrigger aria-label={`Repository allowed to use ${source.workspaceName}`}>
                  <SelectValue placeholder="Choose repository">
                    {eligible.find((r) => r.repositoryId === repo)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {eligible.map((r) => (
                    <SelectItem key={r.repositoryId} value={r.repositoryId}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                authorizationBlocked || !repo || !eligible.some((r) => r.repositoryId === repo)
              }
              onClick={() => {
                if (repo)
                  void mutate((c, t) =>
                    c.allow(t, RelayRepositoryId.make(repo), {
                      connectionId: source.connectionId,
                      grantId: randomUUID(),
                      previousGrantId:
                        current.findLast((g) => g.repositoryId === repo)?.grantId ?? null,
                    }),
                  );
              }}
            >
              Allow repository
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
