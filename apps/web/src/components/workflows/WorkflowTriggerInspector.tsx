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
  resolved = true,
  disabled,
  onChange,
  onClose,
  registerField,
}: {
  scope: WorkflowScope;
  automation: WorkflowAutomation | undefined;
  supported: boolean;
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
          Manual Run is always available. Automatic triggering changes after Save.
        </p>
        {!supported ? (
          <p role="alert">
            Update the relay to configure automatic triggering. Its automation state is unavailable.
          </p>
        ) : null}
        {supported && !resolved ? (
          <p role="alert">
            Refresh or reload the saved workflow before editing automatic triggering.
          </p>
        ) : null}
        <fieldset disabled={disabled || !supported || !resolved} className="space-y-4">
          <Button
            type="button"
            variant={value.enabled ? "default" : "outline"}
            aria-pressed={value.enabled}
            ref={(node) => registerField?.("trigger:enabled", node)}
            onClick={() => onChange({ ...value, enabled: !value.enabled })}
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
              <p role="alert" className="text-sm text-warning">
                {WorkflowSources.sourceHealthLabel(source.source)}. The source owner can reconnect
                below.
              </p>
            ) : null}
            {trigger && !source && !sources.loading ? (
              <p role="alert" className="text-sm text-warning">
                The saved repository grant is unavailable. Restore repository permission or choose a
                source explicitly.
              </p>
            ) : null}
            {sources.error ? (
              <p role="alert" className="text-sm text-destructive">
                {sources.error}
              </p>
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
          {criteria?.issues.map((issue) => (
            <p key={issue.field} role="alert" className="text-sm text-warning">
              {issue.message}
            </p>
          ))}
          {selected.error ? (
            <p role="alert" className="text-sm text-destructive">
              {selected.error} Saved selections are retained.
            </p>
          ) : null}
          {!selected.loading && criteria && !criteria.deliveryReady ? (
            <p className="text-sm text-warning">
              Issue creation and status-entry delivery must be verified for this team before
              enabling.
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={selected.loading}
            onClick={() => void selected.refresh()}
          >
            Retry selection check
          </Button>
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
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
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
        {state.error ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={state.loading}
            onClick={() => void state.refresh()}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
