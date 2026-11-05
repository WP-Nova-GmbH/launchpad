import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
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
import { SourceIdentity, confirmChange } from "./WorkflowSources";
export function OwnerSources({ accountId }: { accountId: string }) {
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) => client.owner(token),
    [],
  );
  const state = useWorkflowSources<WorkflowSourceOwner>(accountId, read);
  const [authorization, setAuthorization] =
    useState<WorkflowSourceAuthorization["authorization"]>(null);
  const snapshot = state.snapshot,
    disabled = state.busy || state.loading || state.unverified;
  const matches = (
    link: WorkflowSourceAuthorization["authorization"],
    current: WorkflowSourceOwner,
  ) =>
    link !== null &&
    current.applicationId === link.applicationId &&
    current.attempt?.attemptId === link.attemptId &&
    current.attempt.status === "pending";
  const activeAuthorization =
    !disabled && snapshot && matches(authorization, snapshot) ? authorization : null;
  const connect = async (connectionId: string | null, resumeId?: string) => {
    if (!snapshot) return;
    const result = await state.mutate((client, token) =>
      client.begin(token, {
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
    <section aria-label="Your Linear connections">
      <header className="flex items-center justify-between gap-2 px-4">
        <h3 className="text-sm font-medium">Your Linear connections</h3>
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
                    setAuthorization(null);
                    void state.mutate((c, t) => c.cancel(t, snapshot.attempt!.attemptId));
                  }}
                >
                  Cancel authorization
                </Button>
              </div>
            ) : null}
            {snapshot.attempt?.status === "pending" && !activeAuthorization ? (
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
    </section>
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
      {snapshot.withdrawableGrants
        .filter((g) => g.connectionId === source.connectionId)
        .map((g) => (
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
