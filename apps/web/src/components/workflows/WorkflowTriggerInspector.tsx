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
import { CheckIcon, ChevronDownIcon, RefreshCwIcon, XIcon, ZapIcon } from "lucide-react";
import { useWorkflowSources } from "../../cloud/workflowSources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
      entry.source.connectionId === trigger?.connectionId,
  );
  const sourceKey = JSON.stringify([
    scope.accountId,
    scope.organizationId,
    scope.repositoryId,
    source?.source.connectionId,
    source?.grant.grantId,
    source?.grant.generation,
    source?.source.authorizationEpoch,
  ]);
  const refreshSource = sources.refresh;
  const requireReconnect = () => {
    setReconnectKey(sourceKey);
    void refreshSource();
  };
  const sourceVerified = !!sources.snapshot && !sources.error && !sources.unverified;
  const connectionUnknown = sources.loading || !sourceVerified;
  const sourceHealth =
    reconnectKey === sourceKey
      ? "Reconnect required"
      : source
        ? WorkflowSources.sourceHealthLabel(source.source)
        : null;
  const connected = sourceHealth === "Connected";
  const canAllow = sources.snapshot?.canAllow === true;
  const canManage = sources.snapshot?.canManage === true;
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
            .pipe(Effect.map((criteria) => ({ trigger, sourceKey, criteria })))
        : Effect.succeed({ trigger, sourceKey, criteria: null }),
    [scope.repositoryId, trigger, connected, vmTriggerUnavailable, supported, resolved, sourceKey],
  );
  const selected = useWorkflowSources<{
    trigger: WorkflowTrigger | null;
    sourceKey: string;
    criteria: WorkflowSourceSelection | null;
  }>(scope.accountId, readSelection);
  // Keep the controls mounted while ensuring a previous rule cannot enable the new one.
  const criteria =
    sourceVerified &&
    connected &&
    selected.snapshot?.trigger === trigger &&
    selected.snapshot?.sourceKey === sourceKey
      ? (selected.snapshot?.criteria ?? null)
      : null;
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
  const summary = trigger
    ? `When an issue ${trigger.event === "issue_created" ? "is created" : `enters ${criteria?.state?.name ?? (trigger.stateId || "a status you choose")}`} in ${criteria?.team?.name ?? (trigger.teamId || "a team you choose")}${trigger.labelIds.length ? ` with all labels: ${trigger.labelIds.map((id) => criteria?.labels.find((label) => label.id === id)?.name ?? id).join(", ")}` : ", with any labels"}.`
    : null;
  const unavailable = !supported || !resolved || vmTriggerUnavailable;
  const editableRule = !unavailable && sourceVerified && connected;
  const reviewSave = onReviewSave ? (
    <Button type="button" size="sm" onClick={onReviewSave}>
      Review save status
    </Button>
  ) : null;
  const saveOff =
    onSaveOff && !onReviewSave ? (
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
  const turnOffDescription = (
    <p id={turnOffDescriptionId} className="text-xs text-muted-foreground">
      {hasOtherEdits
        ? "Stops new automatic runs and keeps your other workflow edits in the draft."
        : "Stops new automatic runs. Existing jobs continue."}
    </p>
  );
  const removalDescription = savedRunsOn
    ? vmTriggerUnavailable
      ? "The saved rule is still enabled. Save the workflow to remove it."
      : "The saved rule can still start runs until you save the removal."
    : "Save the workflow to remove the saved rule.";
  const footerStatus = removalPending
    ? ["Trigger removal pending", removalDescription]
    : !trigger
      ? null
      : !complete
        ? [
            "Complete the rule to save it",
            trigger.event === "entered_status" ? "Choose a team and status." : "Choose a team.",
          ]
        : turnOffPending
          ? [
              "Turn-off pending",
              saveOff
                ? "Save workflow also applies your other edits."
                : "Saving will stop new automatic runs. Existing jobs continue.",
            ]
          : connectionUnknown
            ? ["Connection status unknown"]
            : !canEnable
              ? [
                  selected.loading || (!criteria && !selected.error && editableRule)
                    ? "Checking trigger readiness…"
                    : "Cannot enable yet",
                  !value.enabled ? "You can save the rule with automatic runs off." : undefined,
                ]
              : triggerDirty && value.enabled
                ? savedRunsOn
                  ? ["Ready to save rule", "Saving will update this rule for future events."]
                  : ["Ready to enable", "Saving will enable this rule for future matching events."]
                : null;
  const cancelTriggerEdits = () => onChange(normalizeWorkflowAutomation(savedAutomation));
  const retrySelection = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled || selected.loading}
      onClick={() => void selected.refresh()}
    >
      <RefreshCwIcon aria-hidden /> Check readiness again
    </Button>
  );
  return (
    <div>
      <header className={styles["workflow-inspector-header"]}>
        <ZapIcon size={20} aria-hidden />
        <h2 className="min-w-0 flex-1 text-sm font-medium">Automatic trigger</h2>
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
      <div className={styles["workflow-trigger-section"]}>
        <p role="status" className="text-xs text-muted-foreground">
          {unsaved || triggerDirty ? "Unsaved changes" : "Saved"}
        </p>
        <p className="text-xs text-muted-foreground">Manual runs are always available.</p>
      </div>
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
            {saveOff ? turnOffDescription : null}
          </WorkflowAlert>
        </div>
      ) : (
        <>
          <section className={styles["workflow-trigger-section"]} aria-label="Trigger connection">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Connection</h3>
              {!sources.error ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Refresh workspace access"
                  disabled={disabled || sources.busy || sources.loading}
                  onClick={() => void sources.refresh()}
                >
                  <RefreshCwIcon />
                </Button>
              ) : null}
            </div>
            {source ? <p className="text-sm font-medium">{source.source.workspaceName}</p> : null}
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
            {sources.error ? (
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
            ) : connectionUnknown ? (
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
            ) : source && !connected ? (
              <WorkflowAlert
                title="Linear source needs attention"
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
                      Review connection
                    </Button>
                  ) : null
                }
              >
                {sourceHealth}.{" "}
                {canAllow
                  ? "Reconnect this workspace in Organization settings."
                  : "Ask an organization admin to reconnect Linear."}
              </WorkflowAlert>
            ) : connected ? (
              <div className="grid gap-1 text-xs text-success-foreground">
                <span className="inline-flex items-center gap-2">
                  <CheckIcon size={14} aria-hidden />
                  Connected
                </span>
                <span className="inline-flex items-center gap-2">
                  <CheckIcon size={14} aria-hidden />
                  Repository access allowed
                </span>
              </div>
            ) : null}
            {!connectionUnknown ? (
              <>
                {!source ? (
                  <p className="text-xs text-muted-foreground">
                    {sources.snapshot?.sources.length
                      ? "Choose the Linear workspace allowed for this repository."
                      : canAllow && sources.snapshot?.eligible.length
                        ? "Allow this repository to use the connected Linear workspace."
                        : !sources.snapshot?.configured
                          ? "Linear is unavailable for this organization."
                          : canAllow
                            ? "Connect a Linear workspace in Organization settings."
                            : "Ask an organization admin to allow this repository to use Linear."}
                  </p>
                ) : null}
                {(!source &&
                  canAllow &&
                  sources.snapshot?.configured &&
                  !sources.snapshot.sources.length) ||
                (source && canManage) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={source ? "ghost" : "outline"}
                      disabled={disabled}
                      onClick={() =>
                        openConnections(
                          !source && !sources.snapshot?.eligible.length ? "connect" : "access",
                        )
                      }
                    >
                      {source
                        ? "Manage access"
                        : sources.snapshot?.eligible.length
                          ? "Allow this repository"
                          : "Connect Linear"}
                    </Button>
                  </div>
                ) : null}
                {!source ? (
                  <p className="text-xs text-muted-foreground">
                    Connection and access changes apply immediately. Trigger changes apply when the
                    workflow is saved.
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
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
                  title="Event delivery not verified"
                  variant="warning"
                  actions={retrySelection}
                >
                  <p>
                    The relay has not verified event delivery for{" "}
                    {criteria.team?.name ?? "this team"}. Ask your environment administrator to
                    verify Linear event delivery, then check readiness again.
                  </p>
                </WorkflowAlert>
              ) : null}
            </div>
          ) : null}
          {editableRule && trigger ? (
            <fieldset
              disabled={disabled || connectionUnknown}
              className={styles["workflow-trigger-section"]}
            >
              <h3 className="text-sm font-medium">Rule</h3>
              <div className="space-y-2">
                <p className="text-sm font-medium">When</p>
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
                    <SelectValue>
                      {trigger.event === "issue_created"
                        ? "An issue is created"
                        : "An issue enters a status"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="issue_created">An issue is created</SelectItem>
                    <SelectItem value="entered_status">An issue enters a status</SelectItem>
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
                  {trigger.labelIds.length ? (
                    <div className="flex flex-wrap gap-2">
                      {trigger.labelIds.map((id) => {
                        const name = criteria?.labels.find((label) => label.id === id)?.name ?? id;
                        return (
                          <Button
                            key={id}
                            type="button"
                            size="xs"
                            variant="outline"
                            aria-label={`Remove label ${name}`}
                            onClick={() =>
                              update({
                                ...trigger,
                                labelIds: trigger.labelIds.filter((label) => label !== id),
                              })
                            }
                          >
                            {name}
                            <XIcon aria-hidden />
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {trigger.labelIds.length
                      ? "All selected labels must match."
                      : "No label filter. Any issue matching this event in the team can start a run."}
                  </p>
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Add labels
                    </summary>
                    <div className="mt-3">
                      <MetadataPicker
                        key={`${sourceKey}:${trigger.teamId}:labels`}
                        scope={scope}
                        grantId={trigger.grantId}
                        teamId={trigger.teamId}
                        kind="labels"
                        label="Label"
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
                  </details>
                </div>
              ) : null}
              <p className={styles["workflow-trigger-summary"]}>{summary}</p>
            </fieldset>
          ) : trigger ? (
            <section className={styles["workflow-trigger-section"]}>
              <h3 className="text-sm font-medium">Saved selections</h3>
              <p className={styles["workflow-trigger-summary"]}>{summary}</p>
              <p className="text-xs text-muted-foreground">
                Your selections are kept while the workspace is unavailable.
              </p>
            </section>
          ) : null}
          <footer className={styles["workflow-trigger-section"]}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Automatic runs</h3>
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="sr-only">Automatic runs. </span>
                {savedAutomation ? "Saved" : "Before saving"}
                <Badge variant={savedRunsOn ? "success" : "secondary"}>
                  {savedRunsOn ? "On" : "Off"}
                </Badge>
              </p>
            </div>
            {trigger ? (
              <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox
                  aria-label="Enable automatic runs when saved"
                  checked={value.enabled}
                  disabled={disabled || (!value.enabled && !canEnable)}
                  ref={(node) => registerField?.("trigger:enabled", node)}
                  onCheckedChange={(enabled) => onChange({ ...value, enabled })}
                />
                Enable automatic runs when saved
              </label>
            ) : null}
            {vmTarget && trigger ? (
              <p className="text-xs text-muted-foreground">
                Automatic VM runs can use this repository’s workflow variables and secrets.
              </p>
            ) : null}
            <div className={footerStatus ? "space-y-1 text-xs" : "sr-only"} role="status">
              {footerStatus ? (
                <>
                  <p className="font-medium">{footerStatus[0]}</p>
                  {footerStatus[1] ? (
                    <p className="text-muted-foreground">{footerStatus[1]}</p>
                  ) : null}
                </>
              ) : null}
            </div>
            {saveOff ? (
              <div className="grid justify-items-start gap-2 border-t pt-3">
                {turnOffDescription}
                {saveOff}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {trigger || triggerDirty ? (
                <div className="mr-auto flex flex-wrap items-center gap-1">
                  {triggerDirty && !removalPending ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={disabled}
                      onClick={cancelTriggerEdits}
                    >
                      Cancel trigger edits
                    </Button>
                  ) : null}
                  {trigger || removalPending ? (
                    <Button
                      type="button"
                      variant={removalPending ? "ghost" : "ghost-destructive"}
                      size="xs"
                      disabled={disabled}
                      onClick={
                        removalPending
                          ? cancelTriggerEdits
                          : () => onChange({ enabled: false, trigger: null })
                      }
                    >
                      {removalPending
                        ? "Cancel trigger edits"
                        : `Remove ${complete ? "automatic" : "incomplete"} trigger`}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {reviewSave ?? (
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    disabled || !validAutomation || (value.enabled && triggerDirty && !canEnable)
                  }
                  onClick={onSave}
                >
                  Save workflow
                </Button>
              )}
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
  const optionLabel = kind === "states" ? "statuses" : kind;
  const name = selectedName ?? page?.items.find((item) => item.id === value)?.name;
  const items = page?.items ?? [];
  const options =
    page && value && !items.some((item) => item.id === value)
      ? [{ id: value, name: name ?? value }, ...items]
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
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
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
          render={<Button type="button" variant="outline" />}
          aria-label={label}
          ref={(node) => registerField?.(`trigger:${kind}`, node)}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {name ??
              (value
                ? `Selected: ${value}`
                : `Choose ${kind === "labels" ? "a label" : label.toLowerCase()}`)}
          </span>
          <ChevronDownIcon aria-hidden />
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
