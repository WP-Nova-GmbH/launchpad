import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useCallback, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { WorkflowAutomation, type WorkflowTrigger } from "@t3tools/contracts/workflows";
import {
  RelayOrganizationId,
  type WorkflowRepositorySources,
  type WorkflowSourceError,
  type WorkflowSourceMetadataPage,
  type WorkflowSourceSelection,
  type WorkflowSourceMetadataQuery,
} from "@t3tools/contracts/relay";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import {
  normalizeWorkflowAutomation,
  sameWorkflowAutomation,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxStatus,
} from "../ui/combobox";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { WorkflowAlert } from "./WorkflowAlert";
import { OwnerSources } from "./WorkflowOwnerSources";
import { RepositorySourcesPanel } from "./WorkflowSources";
import styles from "./workflowEditor.module.css";

type RegisterField = (field: string, node: HTMLElement | null) => void;
const isWorkflowAutomation = Schema.is(WorkflowAutomation);

type TriggerSelectionSnapshot = {
  trigger: WorkflowTrigger | null;
  grantKey: string;
  sourceKey: string;
  criteria: WorkflowSourceSelection | null;
  lastKnownCriteria?: WorkflowSourceSelection | null;
};

const mergeTriggerSelection = (
  previous: TriggerSelectionSnapshot | null,
  next: TriggerSelectionSnapshot,
): TriggerSelectionSnapshot =>
  !next.criteria && previous?.trigger === next.trigger && previous.grantKey === next.grantKey
    ? { ...next, lastKnownCriteria: previous.criteria ?? previous.lastKnownCriteria ?? null }
    : next;

export const workflowTriggerLabel = (trigger: WorkflowTrigger | null | undefined) =>
  !trigger
    ? "Manual run"
    : trigger.event === "issue_created"
      ? "Linear issue created"
      : "Linear issue enters status";

export function WorkflowTriggerInspector({
  scope,
  automation,
  savedAutomation,
  unsaved = false,
  supported,
  vmTarget = false,
  vmAutomationAvailable = false,
  hasOtherEdits = false,
  resolved = true,
  disabled,
  onChange,
  onClose,
  onSave,
  onReviewSave,
  onSaveOff,
  onChooseMachine,
  registerField,
}: {
  scope: WorkflowScope;
  automation: WorkflowAutomation | undefined;
  savedAutomation?: WorkflowAutomation | undefined;
  unsaved?: boolean;
  supported: boolean;
  vmTarget?: boolean;
  vmAutomationAvailable?: boolean;
  hasOtherEdits?: boolean;
  resolved?: boolean;
  disabled: boolean;
  onChange: (automation: WorkflowAutomation) => void;
  onClose: () => void;
  onSave: () => void;
  onReviewSave?: (() => void) | undefined;
  onSaveOff?: (() => void) | undefined;
  onChooseMachine: () => void;
  registerField?: RegisterField | undefined;
}) {
  const value = automation ?? normalizeWorkflowAutomation();
  const vmTriggerUnavailable = vmTarget && !vmAutomationAvailable;
  const trigger = value.trigger;
  const validAutomation = isWorkflowAutomation(value);
  const complete = !!trigger && validAutomation;
  const triggerDirty = !sameWorkflowAutomation(value, savedAutomation);
  const savedRunsOn = savedAutomation?.enabled === true;
  const removalPending = !trigger && !!savedAutomation?.trigger;
  const turnOffPending = complete && savedRunsOn && !value.enabled;
  const turnOffDescriptionId = useId();
  const [connectionsOpen, setConnectionsOpen] = useState<"connect" | "access" | null>(null);
  const [reconnectKey, setReconnectKey] = useState<string | null>(null);
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) => client.repository(token, scope.repositoryId),
    [scope.repositoryId],
  );
  const sources = useWorkflowSources<WorkflowRepositorySources>(scope.accountId, read);
  const source = sources.snapshot?.sources.find(
    (entry) =>
      entry.source.organizationId === scope.organizationId &&
      entry.grant.grantId === trigger?.grantId &&
      entry.source.connectionId === trigger.connectionId,
  );
  const grantKey = JSON.stringify([
    scope.accountId,
    scope.organizationId,
    scope.repositoryId,
    source?.source.connectionId,
    source?.source.workspaceId,
    source?.grant.grantId,
    source?.grant.generation,
  ]);
  const sourceKey = JSON.stringify([grantKey, source?.source.authorizationEpoch]);
  const refreshSource = sources.refresh;
  const requireReconnect = () => {
    setReconnectKey(sourceKey);
    void refreshSource();
  };
  const sourceVerified = !!sources.snapshot && !sources.readFailed && !sources.unverified;
  const connectionUnknown = sources.loading || !sourceVerified;
  const reconnectRequired =
    !!source && (reconnectKey === sourceKey || source.source.status !== "connected");
  const sourceHealth = source ? WorkflowSources.sourceHealthLabel(source.source) : null;
  const connected = !reconnectRequired && sourceHealth === "Connected";
  const sourceBlocked = !!trigger && sourceVerified && !connected;
  const canAllow = sources.snapshot?.canAllow === true;
  const canManage = sources.snapshot?.canManage === true;
  const canCheckConnection = canManage && sources.snapshot?.configured === true;
  const connectionSheet =
    (connectionsOpen === "connect" && !canAllow) || (connectionsOpen === "access" && !canManage)
      ? null
      : connectionsOpen;
  const openConnections = (view: "connect" | "access") => {
    setConnectionsOpen(view);
    if (view === "access") void sources.refresh();
  };
  const readSelection = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      trigger?.teamId && connected && !vmTriggerUnavailable && supported && resolved
        ? client
            .selection(token, scope.repositoryId, {
              grantId: trigger.grantId,
              teamId: trigger.teamId,
              labelIds: trigger.labelIds,
              ...(trigger.event === "entered_status" && trigger.stateId
                ? { stateId: trigger.stateId }
                : {}),
            })
            .pipe(Effect.map((criteria) => ({ trigger, grantKey, sourceKey, criteria })))
        : Effect.succeed({ trigger, grantKey, sourceKey, criteria: null }),
    [
      scope.repositoryId,
      trigger,
      connected,
      vmTriggerUnavailable,
      supported,
      resolved,
      grantKey,
      sourceKey,
    ],
  );
  const selected = useWorkflowSources<TriggerSelectionSnapshot>(scope.accountId, readSelection, {
    mergeSnapshot: mergeTriggerSelection,
  });
  const selection =
    sourceVerified &&
    source &&
    !source.grant.revoked &&
    selected.snapshot?.trigger === trigger &&
    selected.snapshot?.grantKey === grantKey
      ? selected.snapshot
      : null;
  // Access can remain granted when the authorization expires. Keep names for display only.
  const criteria = connected && selection?.sourceKey === sourceKey ? selection.criteria : null;
  const displayCriteria =
    criteria ??
    (reconnectRequired && source?.source.health.code !== "service_configuration"
      ? (selection?.criteria ?? selection?.lastKnownCriteria)
      : null);
  const canEnable =
    complete &&
    connected &&
    !connectionUnknown &&
    !selected.loading &&
    !selected.error &&
    !selected.unverified &&
    criteria?.authorizationEpoch === source?.source.authorizationEpoch &&
    criteria?.issues.length === 0 &&
    criteria.deliveryReady;
  const update = (next: WorkflowTrigger) => onChange({ ...value, trigger: next });
  const teamName = criteria?.team?.name;
  const statusName = criteria?.state?.name;
  const labelNames = trigger?.labelIds.map(
    (id) => displayCriteria?.labels.find((label) => label.id === id)?.name,
  );
  const namedLabels =
    labelNames?.length && labelNames.every((name) => name !== undefined)
      ? labelNames.join(", ")
      : null;
  const ruleLabels =
    namedLabels ?? (labelNames?.length ? `${labelNames.length} selected` : "Any labels");
  const eventLabel =
    trigger?.event === "entered_status" ? "Issue enters a status" : "Issue is created";
  const summary =
    trigger && criteria && teamName && (trigger.event === "issue_created" || statusName)
      ? `Matches issues ${trigger.event === "issue_created" ? "created" : `that enter ${statusName}`} in ${teamName}${namedLabels ? ` with all labels: ${namedLabels}` : labelNames?.length ? " with all selected labels" : ""}.`
      : null;
  const unavailable = !supported || !resolved || vmTriggerUnavailable;
  const editableRule = !unavailable && sourceVerified && connected;
  const canSaveOff = !!onSaveOff && !onReviewSave;
  const reviewSave = onReviewSave ? (
    <Button type="button" size="sm" onClick={onReviewSave}>
      Review save status
    </Button>
  ) : null;
  const saveOff = canSaveOff ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-describedby={turnOffDescriptionId}
      onClick={onSaveOff}
    >
      Turn off automatic runs
    </Button>
  ) : null;
  const turnOffDescription = hasOtherEdits
    ? "Stops new automatic runs and keeps your other workflow edits in the draft."
    : "Stops new automatic runs. Existing jobs continue.";
  const removalDescription = savedRunsOn
    ? vmTriggerUnavailable
      ? "The saved rule is still enabled. Save the workflow to remove it."
      : "The saved rule can still start runs until you save the removal."
    : "Save the workflow to remove the saved rule.";
  const incompleteRuleHint =
    trigger && !complete && editableRule
      ? trigger.event === "entered_status"
        ? "Choose a team and status."
        : "Choose a team."
      : null;
  const footerStatus = removalPending
    ? ["Trigger removal pending", removalDescription]
    : turnOffPending
      ? [
          "Turns off when saved",
          canSaveOff ? "Save workflow also applies your other edits." : "Existing jobs continue.",
        ]
      : trigger && value.enabled && !savedRunsOn
        ? ["Turns on when saved", incompleteRuleHint]
        : incompleteRuleHint
          ? ["Complete the rule", incompleteRuleHint]
          : canEnable && triggerDirty && value.enabled
            ? ["Updates the rule when saved"]
            : null;
  const savedStatusUnknown = !supported || !resolved;
  const savedRunStatus = savedStatusUnknown
    ? "Saved status unknown"
    : !savedAutomation?.trigger
      ? "No saved rule"
      : savedRunsOn
        ? "Saved rule on"
        : "Saved rule off";
  const stageTurnOff = sourceBlocked && value.enabled && !canSaveOff && !onReviewSave;
  const cancelTriggerEdits = () => onChange(normalizeWorkflowAutomation(savedAutomation));
  const retrySelection = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled || selected.loading}
      onClick={() => void selected.refresh()}
    >
      <RefreshCwIcon aria-hidden /> Check again
    </Button>
  );
  return (
    <div>
      <header className={styles["workflow-inspector-header"]}>
        <span className={styles["workflow-node-icon"]}>
          <ZapIcon aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-base font-semibold">Trigger</h2>
          <p role="status" aria-atomic="true">
            <Badge size="sm" variant={savedStatusUnknown ? "warning" : "secondary"}>
              {savedRunStatus}
            </Badge>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-4">
          {!unavailable ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Trigger actions"
                  />
                }
              >
                <EllipsisIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  aria-label="Refresh workspace access"
                  disabled={disabled || sources.busy || sources.loading}
                  onClick={() => void sources.refresh()}
                >
                  Refresh workspace access
                </MenuItem>
                {sourceBlocked && source && canManage ? (
                  <MenuItem disabled={disabled} onClick={() => openConnections("access")}>
                    Manage access
                  </MenuItem>
                ) : null}
                {canSaveOff ? (
                  <MenuItem
                    aria-label="Turn off automatic runs"
                    aria-describedby={turnOffDescriptionId}
                    disabled={disabled}
                    onClick={onSaveOff}
                  >
                    <span className="grid gap-0.5">
                      Turn off automatic runs
                      <span
                        id={turnOffDescriptionId}
                        className="wrap-anywhere text-xs text-muted-foreground"
                      >
                        {turnOffDescription}
                      </span>
                    </span>
                  </MenuItem>
                ) : stageTurnOff ? (
                  <MenuItem
                    disabled={disabled}
                    onClick={() => onChange({ ...value, enabled: false })}
                  >
                    Turn off on save
                  </MenuItem>
                ) : null}
                {triggerDirty ? (
                  <MenuItem disabled={disabled} onClick={cancelTriggerEdits}>
                    Discard trigger edits
                  </MenuItem>
                ) : null}
                {trigger ? (
                  <MenuItem
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => onChange({ enabled: false, trigger: null })}
                  >
                    Remove trigger
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close trigger settings"
            onClick={onClose}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      </header>
      {!supported ? (
        <div className={styles["workflow-trigger-section"]}>
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
          </WorkflowAlert>
        </div>
      ) : !resolved ? (
        <div className={styles["workflow-trigger-section"]}>
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
        </div>
      ) : vmTriggerUnavailable ? (
        <div className={styles["workflow-trigger-section"]}>
          <WorkflowAlert
            title="Automatic VM runs unavailable"
            variant="warning"
            actions={
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={onChooseMachine}
                >
                  Choose a Machine target
                </Button>
                {reviewSave ?? saveOff}
                {value.enabled && !onSaveOff && !onReviewSave ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onChange({ ...value, enabled: false })}
                  >
                    Turn off automatic runs
                  </Button>
                ) : null}
              </>
            }
          >
            <p>Automatic runs for VM workflows are unavailable for this repository.</p>
            {removalPending ? <p>Trigger removal pending. {removalDescription}</p> : null}
            {saveOff ? (
              <p id={turnOffDescriptionId} className="text-xs text-muted-foreground">
                {turnOffDescription}
              </p>
            ) : null}
          </WorkflowAlert>
        </div>
      ) : (
        <>
          {!removalPending ? (
            <section className={styles["workflow-trigger-section"]} aria-label="Trigger connection">
              {source && !sourceBlocked ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pointer-coarse:gap-y-3">
                  <Link2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 wrap-anywhere">
                    <p className="text-sm font-medium">{source.source.workspaceName}</p>
                    <p className="text-xs text-muted-foreground">Linear</p>
                  </div>
                  {!connectionUnknown && connected ? (
                    <Badge variant="success">Connected</Badge>
                  ) : null}
                  {canManage ? (
                    <Button
                      type="button"
                      size="compact"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => openConnections("access")}
                    >
                      Manage access
                    </Button>
                  ) : null}
                </div>
              ) : !trigger ? (
                <h3 className="text-sm font-medium">Linear workspace</h3>
              ) : null}
              {!source && !connectionUnknown && sources.snapshot?.sources.length ? (
                <Select
                  value=""
                  disabled={disabled}
                  onValueChange={(id) => {
                    const next = sources.snapshot?.sources.find(
                      (entry) => entry.grant.grantId === id,
                    );
                    if (next && id !== trigger?.grantId) {
                      update({
                        provider: "linear",
                        connectionId: next.source.connectionId,
                        grantId: next.grant.grantId,
                        teamId: "",
                        event: "issue_created",
                        labelIds: [],
                      });
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label="Linear workspace"
                    ref={(node) => registerField?.("trigger:source", node)}
                  >
                    <SelectValue>Choose a workspace</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {sources.snapshot.sources.map((entry) => (
                      <SelectItem key={entry.grant.grantId} value={entry.grant.grantId}>
                        {entry.source.workspaceName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              {sources.error && (!source || !sourceBlocked) ? (
                <WorkflowAlert
                  title="Could not check the workspace"
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled || sources.loading}
                      onClick={() => void sources.refresh()}
                    >
                      <RefreshCwIcon aria-hidden /> Retry connection check
                    </Button>
                  }
                >
                  {sources.error} Your saved trigger and selections are unchanged.
                </WorkflowAlert>
              ) : connectionUnknown && (!source || !sourceBlocked) ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Checking workspace access…
                </p>
              ) : trigger && !source ? (
                <WorkflowAlert
                  title="Repository source access unavailable"
                  variant="warning"
                  actions={
                    canAllow ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => openConnections("access")}
                      >
                        Manage source access
                      </Button>
                    ) : null
                  }
                >
                  {canAllow
                    ? "Allow this repository to use Linear again, then select the new grant."
                    : "Ask an organization admin to restore this repository's Linear access."}
                </WorkflowAlert>
              ) : source && reconnectRequired ? (
                <WorkflowAlert
                  title={`Reconnect ${source.source.workspaceName}`}
                  variant="warning"
                  actions={
                    canAllow ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => openConnections("connect")}
                      >
                        Reconnect Linear
                      </Button>
                    ) : null
                  }
                >
                  {canAllow
                    ? "Reconnect Linear to use this workspace for automatic runs."
                    : "Ask an organization admin to reconnect Linear."}
                </WorkflowAlert>
              ) : source && !connected ? (
                <WorkflowAlert
                  title={sourceHealth ?? "Linear unavailable"}
                  variant="warning"
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        disabled ||
                        sources.busy ||
                        sources.loading ||
                        (canCheckConnection && sources.snapshot?.exchangeInProgress)
                      }
                      onClick={() => {
                        if (canCheckConnection) {
                          void sources.mutate((client, token) =>
                            client.refreshRepository(
                              token,
                              scope.repositoryId,
                              source.grant.grantId,
                            ),
                          );
                        } else {
                          void sources.refresh();
                        }
                      }}
                    >
                      <RefreshCwIcon aria-hidden />
                      {canCheckConnection ? "Check connection" : "Refresh status"}
                    </Button>
                  }
                >
                  {sources.error ??
                    (source.source.health.code === "service_configuration" ||
                    !sources.snapshot?.configured
                      ? "Ask an environment administrator to check the Linear service configuration."
                      : !canCheckConnection
                        ? "Ask a repository maintainer to check this Linear connection."
                        : source.source.health.code === "rate_limited"
                          ? "Check the connection again after Linear’s rate limit resets."
                          : "Check the connection again before editing the rule.")}
                </WorkflowAlert>
              ) : null}
              {!connectionUnknown && !source && !trigger ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {sources.snapshot?.sources.length
                      ? "Choose the Linear workspace for this repository."
                      : canAllow && sources.snapshot?.eligible.length
                        ? "Allow this repository to use the connected Linear workspace."
                        : !sources.snapshot?.configured
                          ? "Linear is unavailable for this organization."
                          : canAllow
                            ? "Connect a Linear workspace in Organization settings."
                            : "Ask an organization admin to allow this repository to use Linear."}
                  </p>
                  {canAllow && sources.snapshot?.configured && !sources.snapshot.sources.length ? (
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          openConnections(sources.snapshot?.eligible.length ? "access" : "connect")
                        }
                      >
                        {sources.snapshot?.eligible.length
                          ? "Allow this repository"
                          : "Connect Linear"}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}
          {editableRule &&
          !connectionUnknown &&
          trigger?.teamId &&
          (selected.error ||
            criteria?.issues.length ||
            (!selected.loading && criteria && !criteria.deliveryReady)) ? (
            <div className={styles["workflow-trigger-section"]}>
              {selected.error ? (
                <WorkflowAlert title="Could not verify trigger selections" actions={retrySelection}>
                  {selected.error} Saved selections are retained.
                </WorkflowAlert>
              ) : criteria?.issues.length ? (
                <WorkflowAlert
                  title="Check trigger selections"
                  variant="warning"
                  actions={retrySelection}
                >
                  <ul className="list-inside list-disc space-y-1">
                    {criteria.issues.map((issue) => (
                      <li key={issue.field}>{issue.message}</li>
                    ))}
                  </ul>
                </WorkflowAlert>
              ) : !selected.loading && criteria && !criteria.deliveryReady ? (
                <WorkflowAlert
                  title="Automatic runs unavailable"
                  variant="warning"
                  actions={retrySelection}
                >
                  Ask your environment administrator to enable automatic Linear runs on this relay.
                </WorkflowAlert>
              ) : null}
            </div>
          ) : null}
          {editableRule && trigger ? (
            <fieldset
              disabled={disabled || connectionUnknown}
              className={styles["workflow-trigger-section"]}
            >
              <div className="space-y-1">
                <p className="text-sm font-medium">Event</p>
                <Select
                  value={trigger.event}
                  onValueChange={(event) => {
                    if (event === trigger.event) return;
                    if (event === "entered_status") update({ ...trigger, event, stateId: "" });
                    else if (event === "issue_created") {
                      const { connectionId, grantId, teamId, labelIds } = trigger;
                      update({
                        provider: "linear",
                        connectionId,
                        grantId,
                        teamId,
                        labelIds,
                        event,
                      });
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label="Linear event"
                    ref={(node) => registerField?.("trigger:event", node)}
                  >
                    <SelectValue>{eventLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="issue_created">Issue is created</SelectItem>
                    <SelectItem value="entered_status">Issue enters a status</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <MetadataPicker
                key={sourceKey}
                scope={scope}
                grantId={trigger.grantId}
                kind="teams"
                label="Team"
                disabled={disabled}
                checkingAccess={sources.loading}
                refreshSource={refreshSource}
                onReconnectRequired={requireReconnect}
                registerField={registerField}
                value={trigger.teamId}
                selectedName={criteria?.team?.name}
                onChoose={(id) => {
                  if (id === trigger.teamId) return;
                  const globalLabels =
                    criteria?.labels
                      .filter((label) => label.teamId === null)
                      .map((label) => label.id) ?? [];
                  update({
                    ...trigger,
                    teamId: id,
                    labelIds: globalLabels,
                    ...(trigger.event === "entered_status" ? { stateId: "" } : {}),
                  });
                }}
              />
              {trigger.teamId && trigger.event === "entered_status" ? (
                <MetadataPicker
                  key={`${sourceKey}:${trigger.teamId}:states`}
                  scope={scope}
                  grantId={trigger.grantId}
                  teamId={trigger.teamId}
                  kind="states"
                  label="Status"
                  disabled={disabled}
                  checkingAccess={sources.loading}
                  refreshSource={refreshSource}
                  onReconnectRequired={requireReconnect}
                  registerField={registerField}
                  value={trigger.stateId}
                  selectedName={criteria?.state?.name}
                  onChoose={(stateId) => update({ ...trigger, stateId })}
                />
              ) : null}
              {trigger.teamId ? (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">Labels</p>
                    <span className="text-xs text-muted-foreground">Optional</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pointer-coarse:gap-4">
                    {trigger.labelIds.map((id, index) => {
                      const name =
                        criteria?.labels.find((label) => label.id === id)?.name ??
                        `Label ${index + 1}`;
                      return (
                        <Button
                          key={id}
                          type="button"
                          size="sm-multiline"
                          variant="outline"
                          className="max-w-full"
                          aria-label={`Remove label ${name}`}
                          onClick={() =>
                            update({
                              ...trigger,
                              labelIds: trigger.labelIds.filter((label) => label !== id),
                            })
                          }
                        >
                          <span className="min-w-0 wrap-anywhere">{name}</span>
                          <XIcon aria-hidden />
                        </Button>
                      );
                    })}
                    <MetadataPicker
                      key={`${sourceKey}:${trigger.teamId}:labels`}
                      scope={scope}
                      grantId={trigger.grantId}
                      teamId={trigger.teamId}
                      kind="labels"
                      label="Add labels"
                      addedIds={trigger.labelIds}
                      registerField={registerField}
                      value=""
                      disabled={disabled || trigger.labelIds.length >= 100}
                      checkingAccess={sources.loading}
                      refreshSource={refreshSource}
                      onReconnectRequired={requireReconnect}
                      onChoose={(id) => {
                        if (!trigger.labelIds.includes(id) && trigger.labelIds.length < 100)
                          update({ ...trigger, labelIds: [...trigger.labelIds, id] });
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {summary ? <p className={styles["workflow-trigger-summary"]}>{summary}</p> : null}
              {complete &&
              !connectionUnknown &&
              !selected.error &&
              (selected.loading || !criteria) ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Checking trigger settings…
                </p>
              ) : null}
            </fieldset>
          ) : trigger ? (
            <section className={styles["workflow-trigger-section"]}>
              <h3 className="text-sm font-medium">{triggerDirty ? "Draft rule" : "Saved rule"}</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 wrap-anywhere text-xs">
                <dt className="text-muted-foreground">Event</dt>
                <dd>{eventLabel}</dd>
                <dt className="text-muted-foreground">Team</dt>
                <dd>
                  {displayCriteria?.team?.name ??
                    (trigger.teamId ? "Selected team" : "No team selected")}
                </dd>
                {trigger.event === "entered_status" ? (
                  <>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      {displayCriteria?.state?.name ??
                        (trigger.stateId ? "Selected status" : "No status selected")}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Labels</dt>
                <dd>{ruleLabels}</dd>
              </dl>
            </section>
          ) : null}
          <footer className={styles["workflow-trigger-section"]}>
            {trigger && !sourceBlocked ? (
              <label className="flex min-h-7 cursor-pointer items-center justify-between gap-3 text-sm font-medium pointer-coarse:min-h-11">
                Automatic runs on save
                <Switch
                  size="sm"
                  aria-label="Automatic runs on save"
                  checked={value.enabled}
                  disabled={disabled || (!value.enabled && !canEnable)}
                  ref={(node) => registerField?.("trigger:enabled", node)}
                  onCheckedChange={(enabled) => onChange({ ...value, enabled })}
                />
              </label>
            ) : null}
            {vmTarget && trigger && !sourceBlocked ? (
              <p className="text-xs text-muted-foreground">
                Automatic VM runs can use this repository’s workflow variables and secrets.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div
                className={footerStatus ? "min-w-0 flex-1 basis-28 space-y-1 text-xs" : "sr-only"}
                role="status"
              >
                {footerStatus ? (
                  <>
                    <p className="font-medium">{footerStatus[0]}</p>
                    {footerStatus[1] ? (
                      <p className="text-muted-foreground">{footerStatus[1]}</p>
                    ) : null}
                  </>
                ) : null}
              </div>
              {sourceBlocked && !footerStatus ? (
                <p className="text-xs text-muted-foreground">
                  Manual runs use the workflow’s Run action.
                </p>
              ) : null}
              {!sourceBlocked || unsaved || triggerDirty || onReviewSave ? (
                <div className="ms-auto">
                  {reviewSave ?? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        disabled ||
                        !validAutomation ||
                        (value.enabled && triggerDirty && !canEnable)
                      }
                      onClick={onSave}
                    >
                      Save workflow
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </footer>
        </>
      )}
      <Sheet
        open={connectionSheet !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConnectionsOpen(null);
            void sources.refresh();
          }
        }}
      >
        <SheetPopup>
          <SheetHeader>
            <SheetTitle>
              {connectionSheet === "connect" ? "Connect Linear" : "Repository access"}
            </SheetTitle>
            <SheetDescription>
              Connect a workspace, then allow this repository to use it. Connection and access
              changes apply immediately. Your trigger draft is kept until Save.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 space-y-6 overflow-y-auto p-4">
            {connectionSheet === "connect" ? (
              <>
                <OwnerSources
                  key={JSON.stringify([scope.accountId, scope.organizationId])}
                  accountId={scope.accountId}
                  organizationId={RelayOrganizationId.make(scope.organizationId)}
                />
                <Button type="button" variant="outline" onClick={() => openConnections("access")}>
                  Continue to repository access
                </Button>
              </>
            ) : connectionSheet === "access" ? (
              <>
                <RepositorySourcesPanel
                  repositoryId={scope.repositoryId}
                  state={sources}
                  onManageConnection={() => openConnections("connect")}
                />
                {canAllow &&
                sources.snapshot?.sources.some(({ source }) => source.status === "connected") ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={sources.busy || connectionUnknown}
                    onClick={() => openConnections("connect")}
                  >
                    Manage Linear connection
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

type MetadataPage = WorkflowSourceMetadataPage & { cursor: string | null };
const mergeMetadataPage = (previous: MetadataPage | null, page: MetadataPage) =>
  previous && page.cursor
    ? {
        ...page,
        items: [
          ...new Map([...previous.items, ...page.items].map((item) => [item.id, item])).values(),
        ],
      }
    : page;

const discardMetadataOnError = (code: WorkflowSourceError["code"] | undefined) =>
  code === "reconnect_required" || code === "invalid_input" || code === "conflict";

function MetadataPicker({
  scope,
  grantId,
  teamId,
  kind,
  label,
  value,
  addedIds,
  selectedName,
  onChoose,
  registerField,
  disabled = false,
  checkingAccess,
  refreshSource,
  onReconnectRequired,
}: {
  scope: WorkflowScope;
  grantId: string;
  teamId?: string;
  kind: WorkflowSourceMetadataQuery["kind"];
  label: string;
  value: string;
  addedIds?: ReadonlyArray<string>;
  selectedName?: string | undefined;
  onChoose: (id: string) => void;
  registerField?: RegisterField | undefined;
  disabled?: boolean;
  checkingAccess: boolean;
  refreshSource: () => Promise<void>;
  onReconnectRequired: () => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      client
        .metadata(token, scope.repositoryId, {
          grantId,
          kind,
          ...(teamId ? { teamId } : {}),
          ...(cursor ? { cursor } : {}),
        })
        .pipe(Effect.map((page) => ({ ...page, cursor }))),
    [scope.repositoryId, grantId, kind, teamId, cursor],
  );
  const {
    snapshot: page,
    error,
    errorCode,
    loading,
    refresh,
  } = useWorkflowSources(scope.accountId, read, {
    mergeSnapshot: mergeMetadataPage,
    discardSnapshotOnError: discardMetadataOnError,
  });
  const reconnectRequired = errorCode === "reconnect_required";
  const reportReconnectRequired = useEffectEvent(onReconnectRequired);
  useLayoutEffect(() => {
    if (reconnectRequired) reportReconnectRequired();
  }, [reconnectRequired]);
  const recheckSource =
    errorCode === "conflict" || (cursor !== null && errorCode === "invalid_input");
  const pending = loading || (!error && page?.cursor !== cursor);
  const nextCursor = page?.nextCursor;
  const addingLabels = kind === "labels";
  const optionLabel = kind === "states" ? "statuses" : kind;
  const savedOption = kind === "teams" ? "Saved team" : "Saved status";
  const name = selectedName ?? page?.items.find((item) => item.id === value)?.name;
  const items = page?.items ?? [];
  const options =
    page && value && !items.some((item) => item.id === value)
      ? [{ id: value, name: name ?? savedOption }, ...items]
      : items;
  const hasFooter = pending || error || nextCursor;
  const action = recheckSource ? "Reload" : error ? "Retry" : "Load more";
  const loadOptions = async () => {
    searchInput.current?.focus({ preventScroll: true });
    if (recheckSource) await refreshSource();
    if (!error && nextCursor) {
      setCursor(nextCursor);
    } else if (!page && cursor) {
      setCursor(null);
    } else {
      await refresh();
    }
  };
  return (
    <div className={addingLabels ? "min-w-0" : "grid min-w-0 gap-1"}>
      {addingLabels ? null : <p className="text-sm font-medium">{label}</p>}
      <Combobox
        items={options}
        value={options.find((item) => item.id === value) ?? null}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(item) => item.name}
        isItemEqualToValue={(a, b) => a.id === b.id}
        disabled={disabled}
        onValueChange={(item) => {
          if (!checkingAccess && item) onChoose(item.id);
        }}
      >
        <ComboboxTrigger
          render={
            addingLabels ? (
              <Button type="button" variant="ghost" size="compact" />
            ) : (
              <Button type="button" variant="outline" />
            )
          }
          aria-label={label}
          ref={(node) => registerField?.(`trigger:${kind}`, node)}
        >
          {addingLabels ? (
            <>
              <PlusIcon aria-hidden />
              {label}
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-left">
                {name ?? (value ? savedOption : `Choose ${label.toLowerCase()}`)}
              </span>
              <ChevronDownIcon aria-hidden />
            </>
          )}
        </ComboboxTrigger>
        <ComboboxPopup>
          <ComboboxSearchInput
            ref={searchInput}
            aria-label={`Search loaded ${optionLabel}`}
            placeholder={`Search loaded ${optionLabel}…`}
          />
          <ComboboxEmpty>
            {page
              ? nextCursor
                ? "No matches in loaded options"
                : query.trim()
                  ? `No matching ${optionLabel}`
                  : `No ${optionLabel} available`
              : null}
          </ComboboxEmpty>
          <ComboboxList>
            {(item: { id: string; name: string }) => {
              const added = addedIds?.includes(item.id) ?? false;
              return (
                <ComboboxItem
                  key={item.id}
                  value={item}
                  disabled={added || checkingAccess}
                  aria-label={added ? `${item.name}, already added` : undefined}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {added || item.id === value ? <CheckIcon aria-hidden /> : null}
                </ComboboxItem>
              );
            }}
          </ComboboxList>
          <div
            className={`flex shrink-0 flex-wrap items-center justify-between ${hasFooter ? "border-t border-border/70" : ""}`}
          >
            <ComboboxStatus>
              {pending ? (
                error ? (
                  "Retrying…"
                ) : (
                  `Loading ${page ? "more " : ""}${optionLabel}…`
                )
              ) : error ? (
                <span className="text-warning-foreground">
                  {recheckSource
                    ? `Reload ${optionLabel} to refresh the options.`
                    : `Couldn’t load ${cursor ? "more " : ""}${optionLabel}`}
                </span>
              ) : null}
            </ComboboxStatus>
            {!pending && !reconnectRequired && (error || nextCursor) ? (
              <div className="ml-auto px-3 py-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={disabled || checkingAccess}
                  aria-label={`${action}${action === "Retry" ? " loading" : ""} ${optionLabel}`}
                  onClick={() => void loadOptions()}
                >
                  {action}
                </Button>
              </div>
            ) : null}
          </div>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
