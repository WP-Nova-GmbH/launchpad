import { useAuth } from "@clerk/react";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
  type WorkflowSource,
  type WorkflowSourceOwner,
} from "@t3tools/contracts/relay";
import { useCallback, useState } from "react";
import { LinkIcon, RefreshCwIcon } from "lucide-react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SourceIdentity, confirmChange } from "../workflows/WorkflowSources";
export function WorkflowSourcesSettings() {
  const { isLoaded, userId } = useAuth();
  return userId && isLoaded ? (
    <OwnerSources key={userId} accountId={userId} />
  ) : (
    <SettingsSection {...searchableSetting("workflow-sources")}>
      <p className="px-4 py-3 text-sm text-muted-foreground">Sign in to manage workflow sources.</p>
    </SettingsSection>
  );
}
function OwnerSources({ accountId }: { accountId: string }) {
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) => client.owner(token),
    [],
  );
  const state = useWorkflowSources<WorkflowSourceOwner>(accountId, read);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const snapshot = state.snapshot,
    disabled = state.busy || state.loading || state.unverified;
  const connect = async (connectionId: string | null, resumeId?: string) => {
    if (!snapshot) return;
    const result = await state.mutate((client, token) =>
      client.begin(token, {
        attemptId: resumeId ?? randomUUID(),
        expectedVersion: snapshot.version,
        connectionId,
      }),
    );
    if (result?.authorizationUrl) {
      setAuthorizationUrl(result.authorizationUrl);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <SettingsSection
      {...searchableSetting("workflow-sources")}
      icon={<LinkIcon />}
      headerAction={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh workflow sources"
          disabled={state.busy || state.loading}
          onClick={() => void state.refresh()}
        >
          <RefreshCwIcon />
        </Button>
      }
    >
      <div className="space-y-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Connect a Linear workspace and allow repositories to use it for workflows. Read access
          only.
        </p>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
            {snapshot ? " Showing last available status." : ""}
          </p>
        ) : null}
        {!snapshot ? (
          <p className="text-sm text-muted-foreground">
            {state.loading ? "Loading workflow sources…" : "Refresh to load workflow sources."}
          </p>
        ) : (
          <>
            {!snapshot.configured ? (
              <p className="text-sm text-muted-foreground">
                Linear workflow connections are not available on this relay yet.
              </p>
            ) : (
              <Button disabled={disabled} onClick={() => void connect(null)}>
                Connect Linear workspace
              </Button>
            )}
            {snapshot.attempt && ["pending", "exchanging"].includes(snapshot.attempt.status) ? (
              <div className="space-y-2">
                <p className="text-sm">
                  {snapshot.attempt.status === "exchanging"
                    ? "Finishing Linear authorization…"
                    : "Waiting for Linear authorization."}
                </p>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    setAuthorizationUrl(null);
                    void state.mutate((c, t) => c.cancel(t, snapshot.attempt!.attemptId));
                  }}
                >
                  Cancel authorization
                </Button>
              </div>
            ) : null}
            {snapshot.attempt?.status === "pending" && !authorizationUrl ? (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void connect(snapshot.attempt!.connectionId, snapshot.attempt!.attemptId)
                }
              >
                Continue authorization
              </Button>
            ) : null}
            {snapshot.attempt?.status === "failed" ? (
              <p role="status" className="text-sm text-muted-foreground">
                {snapshot.attempt.error === "service_configuration"
                  ? "Linear service configuration needs attention. Retry after it is restored."
                  : "Authorization did not complete. Your existing sources were preserved."}
              </p>
            ) : null}
            {authorizationUrl && snapshot.attempt?.status === "pending" ? (
              <a
                href={authorizationUrl}
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
                  source={source}
                  snapshot={snapshot}
                  disabled={disabled}
                  reconnect={() => void connect(source.connectionId)}
                  mutate={state.mutate}
                />
              ))}
            </div>
            {!snapshot.connections.length ? (
              <p className="text-sm text-muted-foreground">No workflow sources connected.</p>
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
type OwnerState = ReturnType<typeof useWorkflowSources<WorkflowSourceOwner>>;
function OwnerSourceRow({
  source,
  snapshot,
  disabled,
  reconnect,
  mutate,
}: {
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
  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <SourceIdentity source={source} />
        <div className="flex flex-wrap gap-2">
          {snapshot.configured && source.health.code !== "service_configuration" ? (
            <Button size="sm" variant="outline" disabled={disabled} onClick={reconnect}>
              Reconnect
            </Button>
          ) : null}
          {source.status === "connected" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void mutate((c, t) => c.refreshOwner(t, source.connectionId))}
            >
              Retry connection
            </Button>
          ) : null}
          {source.status !== "disconnected" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={async () => {
                if (
                  await confirmChange(
                    "Disconnect this Linear source? Future events and queued starts will be blocked. Starting and running work may continue; use Cancel run to stop it.",
                  )
                )
                  await mutate((c, t) =>
                    c.disconnect(t, {
                      connectionId: source.connectionId,
                      expectedEpoch: source.authorizationEpoch,
                    }),
                  );
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      {current
        .filter((g) => !g.revoked)
        .map((g) => (
          <div key={g.grantId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 break-words">
              {snapshot.repositories.find((r) => r.repositoryId === g.repositoryId)?.name ??
                "Allowed repository"}
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
                  await mutate((c, t) => c.withdrawOwner(t, g.grantId));
              }}
            >
              Withdraw access
            </Button>
          </div>
        ))}
      {source.status === "connected" &&
      snapshot.configured &&
      source.applicationId === snapshot.applicationId &&
      eligible.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select value={repo} onValueChange={setRepo}>
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
            disabled={disabled || !repo || !eligible.some((r) => r.repositoryId === repo)}
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
    </div>
  );
}
