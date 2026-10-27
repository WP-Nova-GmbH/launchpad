import { useAuth } from "@clerk/react";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  RelayRepositoryId,
  type WorkflowSource,
  type WorkflowRepositorySources,
} from "@t3tools/contracts/relay";
import { useCallback, useState } from "react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { randomUUID } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
export const confirmChange = (message: string) =>
  requestConfirmDialog(message) ?? Promise.resolve(window.confirm(message));
export function SourceIdentity({ source }: { source: WorkflowSource }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="break-words text-sm font-medium">{source.workspaceName}</p>
      <p className="break-words text-xs text-muted-foreground">
        {source.viewerName} · {WorkflowSources.sourceHealthLabel(source)}
      </p>
      <p className="text-xs text-muted-foreground">{WorkflowSources.sourceDeliveryLabel(source)}</p>
    </div>
  );
}
export function RepositorySourcesButton({ repositoryId }: { repositoryId: string }) {
  const { userId } = useAuth();
  const [open, setOpen] = useState(false);
  if (!userId) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Workflow sources
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup>
          <SheetHeader>
            <SheetTitle>Workflow sources</SheetTitle>
            <SheetDescription>
              Allow this repository to use a connected Linear workspace.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto p-4">
            {open ? (
              <RepositorySources
                key={userId + ":" + repositoryId}
                accountId={userId}
                repositoryId={RelayRepositoryId.make(repositoryId)}
              />
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
export function RepositorySources({
  accountId,
  repositoryId,
}: {
  accountId: string;
  repositoryId: RelayRepositoryId;
}) {
  const read = useCallback(
    (c: WorkflowSources.Client, t: string) => c.repository(t, repositoryId),
    [repositoryId],
  );
  const state = useWorkflowSources<WorkflowRepositorySources>(accountId, read);
  const snapshot = state.snapshot,
    disabled = state.busy || state.loading || state.unverified;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Repository access</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.busy || state.loading}
          onClick={() => void state.refresh()}
        >
          Refresh sources
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
          {snapshot ? " Showing last available status." : ""}
        </p>
      ) : null}
      {!snapshot ? (
        <p className="text-sm text-muted-foreground">
          {state.loading ? "Loading sources…" : "Refresh to retry."}
        </p>
      ) : (
        <>
          {!snapshot.configured ? (
            <p className="text-sm text-muted-foreground">
              Native Linear workflow connections are not configured.
            </p>
          ) : null}
          {snapshot.sources.map(({ source, grant }) => (
            <div key={grant.grantId} className="space-y-2 border-b pb-3">
              <SourceIdentity source={source} />
              <p className="break-words text-xs text-muted-foreground">
                {source.ownerUserId === accountId
                  ? "Owned by you"
                  : `Owner: ${source.ownerLabel ?? source.ownerUserId}`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void state.mutate((c, t) => c.refreshRepository(t, repositoryId, grant.grantId))
                  }
                >
                  Retry connection
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={async () => {
                    if (
                      await confirmChange(
                        "Withdraw this repository's source access? Future events and queued starts will be blocked. Starting and running work may continue.",
                      )
                    )
                      await state.mutate((c, t) => c.withdraw(t, repositoryId, grant.grantId));
                  }}
                >
                  Withdraw access
                </Button>
              </div>
              {source.status === "reconnect_required" ? (
                <p className="text-xs text-muted-foreground">
                  {source.ownerUserId === accountId
                    ? "Reconnect this workspace in Account connections."
                    : "Ask the connection owner to reconnect this workspace."}
                </p>
              ) : null}
            </div>
          ))}
          {!snapshot.sources.length ? (
            <p className="text-sm text-muted-foreground">No sources allowed for this repository.</p>
          ) : null}
          {snapshot.eligible.map(({ source, previousGrantId }) => (
            <div key={source.connectionId} className="flex flex-wrap items-start gap-2">
              <SourceIdentity source={source} />
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !snapshot.configured}
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
          <p className="text-sm text-muted-foreground">
            Use Connect Linear in trigger settings, or Account connections, to manage your
            workspaces. Only an owner can allow new repository use.
          </p>
        </>
      )}
    </div>
  );
}
