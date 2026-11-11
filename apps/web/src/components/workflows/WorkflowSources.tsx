import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
  type WorkflowSource,
  type WorkflowRepositorySources,
} from "@t3tools/contracts/relay";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  GitForkIcon,
  Link2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { randomUUID } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { WorkflowAlert } from "./WorkflowAlert";

type RepositorySourceState = ReturnType<typeof useWorkflowSources<WorkflowRepositorySources>>;

export const confirmChange = (message: string) =>
  requestConfirmDialog(message) ?? Promise.resolve(window.confirm(message));

export function SourceIdentity({ source }: { source: WorkflowSource }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Link2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 wrap-anywhere">
        <p className="text-sm font-medium">{source.workspaceName}</p>
        <p className="text-xs text-muted-foreground">
          {source.status === "connected" &&
          source.viewerName &&
          source.viewerName !== source.workspaceName
            ? `Linear workspace, connected as ${source.viewerName}`
            : "Linear workspace"}
        </p>
      </div>
    </div>
  );
}

export function SourceFacts({
  source,
  repositoryAccess,
  showDelivery,
}: {
  source: WorkflowSource;
  repositoryAccess?: "Allowed" | "Not allowed";
  showDelivery: boolean;
}) {
  const health = WorkflowSources.sourceHealthLabel(source);
  return (
    <dl className="divide-y border-y text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
        <dt className="text-muted-foreground">Connection</dt>
        <dd
          className={
            health === "Connected"
              ? "flex items-center gap-1.5 text-success-foreground"
              : "flex items-center gap-1.5 text-warning-foreground"
          }
        >
          {health === "Connected" ? (
            <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          {health}
        </dd>
      </div>
      {repositoryAccess ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
          <dt className="text-muted-foreground">Repository access</dt>
          <dd className="font-medium">{repositoryAccess}</dd>
        </div>
      ) : null}
      {showDelivery && source.status === "connected" ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
          <dt className="text-muted-foreground">Event delivery</dt>
          <dd>{source.delivery === "verified" ? "Verified for observed teams" : "Not verified"}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function SourcesRefreshButton({ state }: { state: RepositorySourceState }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label="Refresh sources"
      title="Refresh sources"
      disabled={state.busy || state.loading}
      onClick={() => void state.refresh()}
    >
      <RefreshCwIcon aria-hidden />
    </Button>
  );
}

export function RepositorySourcesButton({
  repositoryId,
  repositoryName,
  connectionSettings,
}: {
  repositoryId: string;
  repositoryName: string;
  connectionSettings?: ReactNode;
}) {
  const { userId } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!userId) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Workflow sources
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup>
          {open ? (
            <RepositorySources
              key={userId + ":" + repositoryId}
              accountId={userId}
              repositoryId={RelayRepositoryId.make(repositoryId)}
              repositoryName={repositoryName}
              connectionSettings={connectionSettings}
              onManageConnection={() => {
                setOpen(false);
                void navigate({ to: "/settings/organization", hash: "workflow-sources" });
              }}
            />
          ) : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}

export function RepositorySources({
  accountId,
  repositoryId,
  repositoryName,
  connectionSettings,
  onManageConnection,
}: {
  accountId: string;
  repositoryId: RelayRepositoryId;
  repositoryName?: string;
  connectionSettings?: ReactNode;
  onManageConnection?: (() => void) | undefined;
}) {
  const read = useCallback(
    (c: WorkflowSources.Client, t: string) => c.repository(t, repositoryId),
    [repositoryId],
  );
  const state = useWorkflowSources<WorkflowRepositorySources>(accountId, read);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const inSheet = repositoryName !== undefined;
  const hasLocalSettings = connectionSettings != null;
  const managingConnection =
    hasLocalSettings && showConnectionSettings && state.snapshot?.canAllow === true;
  return (
    <>
      {inSheet ? (
        <div className="relative border-b">
          <SheetHeader>
            <div className="pe-16 wrap-anywhere">
              <SheetTitle>Workflow sources</SheetTitle>
              <SheetDescription className="mt-1.5">
                <GitForkIcon aria-hidden className="me-1.5 inline size-3.5 align-[-2px]" />
                {repositoryName}
              </SheetDescription>
            </div>
          </SheetHeader>
          {managingConnection ? null : (
            <div className="absolute end-12 top-2.5">
              <SourcesRefreshButton state={state} />
            </div>
          )}
        </div>
      ) : null}
      <div className={inSheet ? "min-h-0 overflow-y-auto p-4 sm:p-6" : undefined}>
        {managingConnection ? (
          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setShowConnectionSettings(false);
                void state.refresh();
              }}
            >
              Back to repository access
            </Button>
            {connectionSettings}
          </div>
        ) : (
          <RepositorySourcesPanel
            repositoryId={repositoryId}
            state={state}
            showRefresh={!inSheet}
            onManageConnection={
              hasLocalSettings ? () => setShowConnectionSettings(true) : onManageConnection
            }
          />
        )}
      </div>
    </>
  );
}

export function RepositorySourcesPanel({
  repositoryId,
  state,
  showRefresh = true,
  onManageConnection,
}: {
  repositoryId: RelayRepositoryId;
  state: RepositorySourceState;
  showRefresh?: boolean;
  onManageConnection?: (() => void) | undefined;
}) {
  const { snapshot } = state;
  const disabled = state.busy || state.loading || state.unverified;
  const empty = snapshot?.configured && !snapshot.sources.length && !snapshot.eligible.length;
  return (
    <div className="space-y-4">
      {showRefresh ? (
        <div className="flex items-center justify-end">
          <SourcesRefreshButton state={state} />
        </div>
      ) : null}
      {state.error ? (
        <WorkflowAlert
          title="Could not refresh repository sources"
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || state.loading}
              onClick={() => void state.refresh()}
            >
              Retry source refresh
            </Button>
          }
        >
          {state.error}
          {snapshot ? " Showing last available status." : ""}
        </WorkflowAlert>
      ) : null}
      {!snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.loading ? "Loading sources…" : "Refresh to load workflow sources."}
        </p>
      ) : (
        <>
          {!snapshot.configured ? (
            <WorkflowAlert title="Workflow sources unavailable" variant="info">
              Ask your relay administrator to configure Linear for this organization.
            </WorkflowAlert>
          ) : null}
          {snapshot.sources.map(({ source, grant }) => {
            const needsReconnect = source.status !== "connected";
            const showCheckInline = source.health.code !== "healthy";
            const checkConnection =
              snapshot.canManage && snapshot.configured && !needsReconnect ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || snapshot.exchangeInProgress}
                  onClick={() =>
                    void state.mutate((c, t) => c.refreshRepository(t, repositoryId, grant.grantId))
                  }
                >
                  Check connection
                </Button>
              ) : null;
            return (
              <div key={grant.grantId} className="space-y-3">
                <SourceIdentity source={source} />
                <SourceFacts source={source} repositoryAccess="Allowed" showDelivery />
                {showCheckInline ? checkConnection : null}
                {needsReconnect && snapshot.configured ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {snapshot.canAllow
                        ? "Reconnect Linear to restore automatic triggers from this workspace."
                        : "Ask an organization admin to reconnect Linear."}
                    </p>
                    {snapshot.canAllow && onManageConnection ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={disabled || snapshot.exchangeInProgress}
                        onClick={onManageConnection}
                      >
                        Reconnect Linear <ArrowRightIcon aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {snapshot.canManage ? (
                  <details>
                    <summary className="cursor-pointer py-1 text-sm text-muted-foreground">
                      Source actions
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {showCheckInline ? null : checkConnection}
                      <Button
                        size="sm"
                        variant="ghost-destructive"
                        disabled={disabled}
                        onClick={async () => {
                          if (
                            await confirmChange(
                              "Withdraw this repository's source access? Future events and queued starts will be blocked. Starting and running work may continue.",
                            )
                          )
                            await state.mutate((c, t) =>
                              c.withdraw(t, repositoryId, grant.grantId),
                            );
                        }}
                      >
                        Withdraw access
                      </Button>
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}
          {snapshot.canAllow &&
            snapshot.eligible.map(({ source, previousGrantId }) => (
              <div key={source.connectionId} className="space-y-3">
                <SourceIdentity source={source} />
                <SourceFacts source={source} repositoryAccess="Not allowed" showDelivery={false} />
                <Button
                  size="sm"
                  disabled={
                    disabled || !!state.error || !snapshot.configured || snapshot.exchangeInProgress
                  }
                  onClick={async () => {
                    await state.mutate((c, t) =>
                      c.allow(t, repositoryId, {
                        connectionId: source.connectionId,
                        grantId: randomUUID(),
                        previousGrantId,
                      }),
                    );
                  }}
                >
                  Allow repository
                </Button>
              </div>
            ))}
          {empty ? (
            <p className="text-sm text-muted-foreground">
              {snapshot.exchangeInProgress
                ? "Finishing Linear authorization…"
                : snapshot.canAllow
                  ? "No Linear source is available for this repository."
                  : "Ask an organization admin to allow this repository to use Linear."}
            </p>
          ) : null}
          {snapshot.configured &&
          !snapshot.sources.length &&
          snapshot.canAllow &&
          onManageConnection ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || !!state.error || snapshot.exchangeInProgress}
              onClick={onManageConnection}
            >
              Manage Linear connection
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
