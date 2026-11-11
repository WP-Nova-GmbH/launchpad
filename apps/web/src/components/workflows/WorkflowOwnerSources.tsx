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
import { RefreshCwIcon } from "lucide-react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SourceFacts, SourceIdentity, confirmChange } from "./WorkflowSources";
export function OwnerSources({
  accountId,
  organizationId,
}: {
  accountId: string;
  organizationId: RelayOrganizationId;
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
  return (
    <section aria-label="Linear for workflows">
      <header className="flex items-center justify-between gap-2 px-4">
        <h3 className="text-sm font-medium">Linear connection</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh workflow sources"
          disabled={state.busy || state.loading}
          onClick={() => void state.refresh()}
        >
          <RefreshCwIcon />
        </Button>
      </header>
      <div className="space-y-4 px-4 py-3">
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
          <p className="text-sm text-muted-foreground">
            {state.loading ? "Loading workflow sources…" : "Refresh to load workflow sources."}
          </p>
        ) : (
          <>
            {!snapshot.configured ? (
              <WorkflowAlert title="Linear workflow connections unavailable" variant="info">
                Ask your relay administrator to configure Linear for this organization.
              </WorkflowAlert>
            ) : !snapshot.connections.length && !exchangeInProgress ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Connect a Linear workspace to use it in automatic triggers.
                </p>
                <Button disabled={disabled} onClick={() => void connect(null)}>
                  Connect Linear workspace
                </Button>
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
                    disabled={
                      disabled ||
                      (exchangeInProgress && snapshot.attempt!.error !== "service_configuration")
                    }
                    onClick={() =>
                      snapshot.attempt!.error === "service_configuration"
                        ? void state.refresh()
                        : void connect(snapshot.attempt!.connectionId)
                    }
                  >
                    {snapshot.attempt.error === "service_configuration"
                      ? "Refresh connection status"
                      : "Retry authorization"}
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
            <div className="divide-y">
              {snapshot.connections.map((source) => (
                <OwnerSourceRow
                  key={source.connectionId}
                  organizationId={organizationId}
                  source={source}
                  snapshot={snapshot}
                  disabled={disabled}
                  reconnect={() => void connect(source.connectionId)}
                  mutate={state.mutate}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
type OwnerState = ReturnType<typeof useWorkflowSources<WorkflowSourceOwner>>;
function OwnerSourceRow({
  organizationId,
  source,
  snapshot,
  disabled,
  reconnect,
  mutate,
}: {
  organizationId: RelayOrganizationId;
  source: WorkflowSource;
  snapshot: WorkflowSourceOwner;
  disabled: boolean;
  reconnect: () => void;
  mutate: OwnerState["mutate"];
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
  const checkConnection = connectedToCurrentApp ? (
    <Button
      size="sm"
      variant={showCheckInline ? "outline" : "ghost"}
      disabled={authorizationBlocked}
      onClick={() => void mutate((c, t) => c.refreshOwner(t, organizationId, source.connectionId))}
    >
      Check connection
    </Button>
  ) : null;
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <SourceIdentity source={source} />
        <SourceFacts source={source} showDelivery />
        {showCheckInline ? checkConnection : null}
        {needsReconnect && canReconnect ? (
          <Button size="sm" disabled={authorizationBlocked} onClick={reconnect}>
            Reconnect Linear
          </Button>
        ) : null}
        {source.status !== "disconnected" ? (
          <details>
            <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
              Connection actions
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {!needsReconnect && canReconnect ? (
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
                onClick={async () => {
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
                }}
              >
                Disconnect
              </Button>
            </div>
          </details>
        ) : null}
      </div>
      <section className="space-y-2 border-t pt-3" aria-label="Repository access">
        <h4 className="text-sm font-medium">Repository access</h4>
        {!grants.length ? (
          <p className="text-sm text-muted-foreground">No repositories have access.</p>
        ) : null}
        {grants.map((g) => (
          <div key={g.grantId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 break-words">
              {g.repositoryName ?? "Repository no longer visible"}
              {g.repositoryName === null ? (
                <span className="block text-xs text-muted-foreground">
                  You can still withdraw this repository's access.
                </span>
              ) : null}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={async () => {
                if (
                  await confirmChange(
                    "Withdraw this repository's source access? Starting and running work may continue.",
                  )
                )
                  await mutate((c, t) => c.withdrawOwner(t, organizationId, g.grantId));
              }}
            >
              Withdraw access
            </Button>
          </div>
        ))}
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
