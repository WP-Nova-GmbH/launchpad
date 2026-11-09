import { WorkflowAlert } from "./WorkflowAlert";
import * as Effect from "effect/Effect";
import { useCallback, useState } from "react";
import type { WorkflowAutomation, WorkflowTrigger } from "@t3tools/contracts/workflows";
import type {
  WorkflowRepositorySources,
  WorkflowSourceMetadataPage,
  WorkflowSourceSelection,
  WorkflowSourceMetadataQuery,
} from "@t3tools/contracts/relay";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  normalizeWorkflowAutomation,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { OwnerSources } from "./WorkflowOwnerSources";
import { RepositorySources } from "./WorkflowSources";
import { XIcon, ZapIcon } from "lucide-react";
import styles from "./workflowEditor.module.css";

type RegisterField = (field: string, node: HTMLElement | null) => void;

export const workflowTriggerLabel = (trigger: WorkflowTrigger | null | undefined) =>
  !trigger
    ? "Manual run"
    : trigger.event === "issue_created"
      ? "Linear issue created"
      : "Linear issue enters status";

export function WorkflowTriggerInspector({
  scope,
  automation,
  supported,
  vmTarget = false,
  resolved = true,
  disabled,
  onChange,
  onClose,
  registerField,
}: {
  scope: WorkflowScope;
  automation: WorkflowAutomation | undefined;
  supported: boolean;
  vmTarget?: boolean;
  resolved?: boolean;
  disabled: boolean;
  onChange: (automation: WorkflowAutomation) => void;
  onClose: () => void;
  registerField?: RegisterField | undefined;
}) {
  const value = automation ?? normalizeWorkflowAutomation();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) => client.repository(token, scope.repositoryId),
    [scope.repositoryId],
  );
  const sources = useWorkflowSources<WorkflowRepositorySources>(scope.accountId, read);
  const trigger = value.trigger;
  const source = sources.snapshot?.sources.find(
    (entry) =>
      entry.grant.grantId === trigger?.grantId &&
      entry.source.connectionId === trigger?.connectionId,
  );
  const update = (next: WorkflowTrigger) => onChange({ ...value, trigger: next });
  return (
    <div>
      <header className={styles["workflow-inspector-header"]}>
        <ZapIcon size={20} />
        <h2 className="min-w-0 flex-1 text-sm font-medium">Starts when</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close trigger settings"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>
      <div className={styles["workflow-inspector-fields"]}>
        <p className="text-sm text-muted-foreground">
          {vmTarget
            ? "Automatic triggering is unavailable for VM workflows."
            : "Manual Run is always available. Automatic triggering changes after Save."}
        </p>
        {!supported ? (
          <WorkflowAlert
            title="Automatic triggering unavailable"
            variant="warning"
            actions={
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Back to workflow
              </Button>
            }
          >
            Update the relay to configure automatic triggering. Its automation state is unavailable.
            Manual runs remain available.
          </WorkflowAlert>
        ) : null}
        {supported && !resolved ? (
          <WorkflowAlert
            title="Saved trigger needs refreshing"
            variant="warning"
            actions={
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Back to workflow
              </Button>
            }
          >
            Refresh or reload the saved workflow before editing automatic triggering. Your
            selections are kept.
          </WorkflowAlert>
        ) : null}
        <fieldset disabled={disabled || !supported || !resolved} className="space-y-4">
          <Button
            type="button"
            variant={value.enabled ? "default" : "outline"}
            aria-pressed={value.enabled}
            disabled={vmTarget && !value.enabled}
            ref={(node) => registerField?.("trigger:enabled", node)}
            onClick={() => {
              if (!vmTarget || value.enabled) onChange({ ...value, enabled: !value.enabled });
            }}
          >
            Automatic triggering:{" "}
            {supported && resolved ? (value.enabled ? "On" : "Off") : "Unavailable"}
          </Button>
          <div className="space-y-2">
            <p className="text-sm font-medium">Linear workspace</p>
            <Select
              value={source?.grant.grantId ?? ""}
              onValueChange={(id) => {
                const next = sources.snapshot?.sources.find((entry) => entry.grant.grantId === id);
                if (next && id !== trigger?.grantId)
                  update({
                    provider: "linear",
                    connectionId: next.source.connectionId,
                    grantId: next.grant.grantId,
                    teamId: "",
                    event: "issue_created",
                    labelIds: [],
                  });
              }}
            >
              <SelectTrigger
                aria-label="Linear workspace"
                ref={(node) => registerField?.("trigger:source", node)}
              >
                <SelectValue>
                  {source
                    ? `${source.source.workspaceName} · ${source.source.ownerLabel ?? source.source.viewerName}`
                    : trigger
                      ? "Saved source is unavailable"
                      : "Choose a workspace"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {sources.snapshot?.sources.map((entry) => (
                  <SelectItem key={entry.grant.grantId} value={entry.grant.grantId}>
                    {entry.source.workspaceName} ·{" "}
                    {entry.source.ownerLabel ?? entry.source.viewerName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {source && WorkflowSources.sourceHealthLabel(source.source) !== "Connected" ? (
              <WorkflowAlert
                title="Linear source needs attention"
                variant="warning"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConnectionsOpen(true)}
                  >
                    Manage source access
                  </Button>
                }
              >
                {WorkflowSources.sourceHealthLabel(source.source)}. The source owner can reconnect
                below.
              </WorkflowAlert>
            ) : null}
            {trigger && !source && !sources.loading ? (
              <WorkflowAlert
                title="Repository source access unavailable"
                variant="warning"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConnectionsOpen(true)}
                  >
                    Manage source access
                  </Button>
                }
              >
                The saved repository grant is unavailable. Restore repository permission or choose a
                source explicitly.
              </WorkflowAlert>
            ) : null}
            {sources.error ? (
              <WorkflowAlert
                title="Could not load Linear workspaces"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={sources.loading}
                    onClick={() => void sources.refresh()}
                  >
                    Retry workspaces
                  </Button>
                }
              >
                {sources.error}
              </WorkflowAlert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConnectionsOpen(true)}
              >
                Connect Linear / repository access
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={sources.loading}
                onClick={() => void sources.refresh()}
              >
                Refresh
              </Button>
            </div>
          </div>
          {trigger && source ? (
            <TriggerSelections
              key={`${scope.repositoryId}:${trigger.grantId}:${source.source.authorizationEpoch}`}
              scope={scope}
              trigger={trigger}
              onChange={update}
              registerField={registerField}
            />
          ) : null}
          {trigger ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange({ enabled: false, trigger: null })}
            >
              Remove automatic trigger
            </Button>
          ) : null}
        </fieldset>
      </div>
      <Sheet
        open={connectionsOpen}
        onOpenChange={(open) => {
          setConnectionsOpen(open);
          if (!open) void sources.refresh();
        }}
      >
        <SheetPopup>
          <SheetHeader>
            <SheetTitle>Connect Linear</SheetTitle>
            <SheetDescription>
              Connect your workspace, then explicitly allow this repository to use it. Return here
              after authorization.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 space-y-6 overflow-y-auto p-4">
            {connectionsOpen ? (
              <>
                <OwnerSources accountId={scope.accountId} />
                <RepositorySources accountId={scope.accountId} repositoryId={scope.repositoryId} />
              </>
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function TriggerSelections({
  scope,
  trigger,
  onChange,
  registerField,
}: {
  scope: WorkflowScope;
  registerField?: RegisterField | undefined;
  trigger: WorkflowTrigger;
  onChange: (trigger: WorkflowTrigger) => void;
}) {
  return (
    <>
      <SelectedCriteria
        key={JSON.stringify([
          trigger.teamId,
          trigger.event,
          trigger.event === "entered_status" ? trigger.stateId : null,
          [...trigger.labelIds].sort(),
        ])}
        scope={scope}
        trigger={trigger}
        onChange={onChange}
        registerField={registerField}
      />
    </>
  );
}
function SelectedCriteria({
  scope,
  trigger,
  onChange,
  registerField,
}: {
  scope: WorkflowScope;
  registerField?: RegisterField | undefined;
  trigger: WorkflowTrigger;
  onChange: (trigger: WorkflowTrigger) => void;
}) {
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      trigger.teamId
        ? client.selection(token, scope.repositoryId, {
            grantId: trigger.grantId,
            teamId: trigger.teamId,
            labelIds: trigger.labelIds,
            ...(trigger.event === "entered_status" && trigger.stateId
              ? { stateId: trigger.stateId }
              : {}),
          })
        : Effect.succeed<WorkflowSourceSelection>({
            authorizationEpoch: 0,
            team: null,
            state: null,
            labels: [],
            issues: [],
            deliveryReady: false,
          }),
    [scope.repositoryId, trigger],
  );
  const selected = useWorkflowSources<WorkflowSourceSelection>(scope.accountId, read);
  const criteria = selected.snapshot;
  return (
    <>
      <MetadataPicker
        key={trigger.grantId}
        scope={scope}
        grantId={trigger.grantId}
        kind="teams"
        registerField={registerField}
        label="Team"
        value={trigger.teamId}
        selectedName={criteria?.team?.name}
        onChoose={(id) => {
          if (id === trigger.teamId) return;
          const globalLabels =
            criteria?.labels.filter((label) => label.teamId === null).map((label) => label.id) ??
            [];
          onChange({
            ...trigger,
            teamId: id,
            labelIds: globalLabels,
            ...(trigger.event === "entered_status" ? { stateId: "" } : {}),
          });
        }}
      />
      {trigger.teamId ? (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium">Event</p>
            <Select
              value={trigger.event}
              onValueChange={(event) => {
                if (event === trigger.event) return;
                if (event === "entered_status") onChange({ ...trigger, event, stateId: "" });
                else if (event === "issue_created") {
                  const { connectionId, grantId, teamId, labelIds } = trigger;
                  onChange({ provider: "linear", connectionId, grantId, teamId, labelIds, event });
                }
              }}
            >
              <SelectTrigger
                aria-label="Linear event"
                ref={(node) => registerField?.("trigger:event", node)}
              >
                <SelectValue>
                  {trigger.event === "issue_created" ? "Issue created" : "Issue enters status"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="issue_created">Issue created</SelectItem>
                <SelectItem value="entered_status">Issue enters status</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {trigger.event === "entered_status" ? (
            <MetadataPicker
              scope={scope}
              grantId={trigger.grantId}
              teamId={trigger.teamId}
              kind="states"
              registerField={registerField}
              label="Status"
              value={trigger.stateId}
              selectedName={criteria?.state?.name}
              onChoose={(stateId) => onChange({ ...trigger, stateId })}
            />
          ) : null}
          <MetadataPicker
            scope={scope}
            grantId={trigger.grantId}
            teamId={trigger.teamId}
            kind="labels"
            registerField={registerField}
            label="Labels (all must match)"
            value=""
            onChoose={(id) => {
              if (!trigger.labelIds.includes(id))
                onChange({ ...trigger, labelIds: [...trigger.labelIds, id] });
            }}
          />
          {trigger.labelIds.map((id) => (
            <div key={id} className="flex items-center justify-between gap-2 text-sm">
              <span>{criteria?.labels.find((label) => label.id === id)?.name ?? id}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove label ${criteria?.labels.find((label) => label.id === id)?.name ?? id}`}
                onClick={() =>
                  onChange({
                    ...trigger,
                    labelIds: trigger.labelIds.filter((label) => label !== id),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {criteria?.issues.length ? (
            <WorkflowAlert title="Check trigger selections" variant="warning">
              <ul className="list-inside list-disc space-y-1">
                {criteria.issues.map((issue) => (
                  <li key={issue.field}>{issue.message}</li>
                ))}
              </ul>
            </WorkflowAlert>
          ) : null}
          {selected.error ? (
            <WorkflowAlert
              title="Could not verify trigger selections"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={selected.loading}
                  onClick={() => void selected.refresh()}
                >
                  Retry selection check
                </Button>
              }
            >
              {selected.error} Saved selections are retained.
            </WorkflowAlert>
          ) : null}
          {!selected.loading && criteria && !criteria.deliveryReady ? (
            <WorkflowAlert title="Event delivery not verified" variant="warning">
              Issue creation and status-entry delivery must be verified for this team before
              enabling. After delivery is configured, retry the selection check below.
            </WorkflowAlert>
          ) : null}
          {!selected.error ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={selected.loading}
              onClick={() => void selected.refresh()}
            >
              Retry selection check
            </Button>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Pages are fetched on request; an exact selected lookup supplies names beyond the current page. */
function MetadataPicker({
  scope,
  grantId,
  teamId,
  kind,
  label,
  value,
  selectedName,
  onChoose,
  registerField,
}: {
  scope: WorkflowScope;
  grantId: string;
  teamId?: string;
  kind: WorkflowSourceMetadataQuery["kind"];
  label: string;
  value: string;
  selectedName?: string | undefined;
  onChoose: (id: string) => void;
  registerField?: RegisterField | undefined;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      client.metadata(token, scope.repositoryId, {
        grantId,
        kind,
        ...(teamId ? { teamId } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    [scope.repositoryId, grantId, kind, teamId, cursor],
  );
  const state = useWorkflowSources<WorkflowSourceMetadataPage>(scope.accountId, read);
  const name = selectedName ?? state.snapshot?.items.find((item) => item.id === value)?.name;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <Select
        value={value}
        disabled={state.loading}
        onValueChange={(id) => {
          if (id) onChoose(id);
        }}
      >
        <SelectTrigger aria-label={label} ref={(node) => registerField?.(`trigger:${kind}`, node)}>
          <SelectValue>
            {name ??
              (value
                ? `Selected: ${value}`
                : `Choose ${kind === "labels" ? "a label" : label.toLowerCase()}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {value && !state.snapshot?.items.some((item) => item.id === value) ? (
            <SelectItem value={value}>{name ?? value}</SelectItem>
          ) : null}
          {state.snapshot?.items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {state.error ? (
        <WorkflowAlert
          title={`Could not load ${label.toLowerCase()}`}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={state.loading}
              onClick={() => void state.refresh()}
            >
              Retry
            </Button>
          }
        >
          {state.error} Your selected value is kept.
        </WorkflowAlert>
      ) : null}
      <div className="flex gap-2">
        {state.snapshot?.nextCursor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={state.loading}
            onClick={() => setCursor(state.snapshot?.nextCursor ?? undefined)}
          >
            More {kind}
          </Button>
        ) : null}
        {cursor ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={state.loading}
            onClick={() => setCursor(undefined)}
          >
            First page
          </Button>
        ) : null}
      </div>
    </div>
  );
}
