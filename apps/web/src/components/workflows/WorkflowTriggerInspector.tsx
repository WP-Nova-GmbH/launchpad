import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useCallback, useState } from "react";
import { WorkflowAutomation, type WorkflowTrigger } from "@t3tools/contracts/workflows";
import {
  RelayOrganizationId,
  type WorkflowRepositorySources,
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
  resolved = true,
  disabled,
  retrySave = false,
  onChange,
  onClose,
  onSave,
  onChooseMachine,
  registerField,
}: {
  scope: WorkflowScope;
  automation: WorkflowAutomation | undefined;
  savedAutomation?: WorkflowAutomation | undefined;
  unsaved?: boolean;
  supported: boolean;
  vmTarget?: boolean;
  resolved?: boolean;
  disabled: boolean;
  retrySave?: boolean;
  onChange: (automation: WorkflowAutomation) => void;
  onClose: () => void;
  onSave: () => void;
  onChooseMachine: () => void;
  registerField?: RegisterField | undefined;
}) {
  const value = automation ?? normalizeWorkflowAutomation();
  const trigger = value.trigger;
  const validAutomation = isWorkflowAutomation(value);
  const complete = !!trigger && validAutomation;
  const triggerDirty = !sameWorkflowAutomation(value, savedAutomation);
  const [connectionsOpen, setConnectionsOpen] = useState<"connect" | "access" | null>(null);
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
  const connectionUnknown =
    sources.loading || !!sources.error || sources.unverified || !sources.snapshot;
  const sourceHealth = source ? WorkflowSources.sourceHealthLabel(source.source) : null;
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
  const sourceKey = JSON.stringify([
    scope.accountId,
    scope.organizationId,
    scope.repositoryId,
    source?.source.connectionId,
    source?.grant.grantId,
    source?.grant.generation,
    source?.source.authorizationEpoch,
  ]);
  const readSelection = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      trigger?.teamId && connected && !vmTarget && supported && resolved
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
    [scope.repositoryId, trigger, connected, vmTarget, supported, resolved, sourceKey],
  );
  const selected = useWorkflowSources<{
    trigger: WorkflowTrigger | null;
    sourceKey: string;
    criteria: WorkflowSourceSelection | null;
  }>(scope.accountId, readSelection);
  // Keep the controls mounted while ensuring a previous rule cannot enable the new one.
  const criteria =
    !connectionUnknown &&
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
  const unavailable = !supported || !resolved || vmTarget;
  const editableRule = !unavailable && !!source && !connectionUnknown;
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
      ) : vmTarget ? (
        <div className={styles["workflow-trigger-section"]}>
          <WorkflowAlert
            title="Automatic runs need a Machine target"
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
                {value.enabled ? (
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
            This workflow uses a VM. Manual runs remain available. Choose a Machine target to
            configure automatic runs.
          </WorkflowAlert>
        </div>
      ) : (
        <>
          <section className={styles["workflow-trigger-section"]} aria-label="Trigger connection">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Connection</h3>
              {source && !connectionUnknown ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh workspace access"
                    disabled={disabled || sources.loading}
                    onClick={() => void sources.refresh()}
                  >
                    <RefreshCwIcon />
                  </Button>
                </div>
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
              disabled={disabled || !connected}
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
                        registerField={registerField}
                        value=""
                        disabled={trigger.labelIds.length >= 100}
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
            <div className="space-y-1 text-xs" aria-live="polite">
              <p className="font-medium">
                {connectionUnknown
                  ? "Connection status unknown"
                  : !trigger
                    ? "Connection setup needed"
                    : !complete
                      ? "Complete the rule to save it"
                      : !canEnable
                        ? selected.loading || !criteria
                          ? "Checking trigger readiness…"
                          : "Cannot enable yet"
                        : value.enabled
                          ? savedAutomation?.enabled
                            ? "Ready to save rule"
                            : "Ready to enable"
                          : "Automatic runs are off"}
              </p>
              <p className="text-muted-foreground">
                Currently {savedAutomation?.enabled ? "on" : "off"}.{" "}
                {triggerDirty
                  ? value.enabled
                    ? savedAutomation?.enabled
                      ? "Saving will update the rule for future events."
                      : "Saving will enable automatic runs with this rule."
                    : savedAutomation?.enabled
                      ? "Saving will stop new automatic runs. Existing jobs are preserved."
                      : "Saving will keep automatic runs off."
                  : value.enabled
                    ? "Future matching events can start this workflow."
                    : "Manual runs remain available."}
              </p>
              {complete && !value.enabled && !canEnable ? (
                <p className="text-muted-foreground">
                  You can save this rule off. Verify readiness before enabling.
                </p>
              ) : null}
              {!complete && trigger ? (
                <p className="text-muted-foreground">
                  Choose a team{trigger.event === "entered_status" ? " and status" : ""}, or remove
                  the incomplete trigger to save the workflow without it.
                </p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {retrySave
                ? "Retry saves the captured workflow change. Newer edits stay in your draft."
                : "Save applies all pending workflow changes. Only future matching events will start runs."}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {triggerDirty ? (
                <div className="mr-auto">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    onClick={() => onChange(normalizeWorkflowAutomation(savedAutomation))}
                  >
                    Cancel trigger edits
                  </Button>
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={
                  disabled ||
                  (!retrySave &&
                    (!validAutomation || (value.enabled && triggerDirty && !canEnable)))
                }
                onClick={onSave}
              >
                {retrySave ? "Retry save" : "Save workflow"}
              </Button>
            </div>
            {trigger ? (
              <div>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-destructive"
                  disabled={disabled}
                  onClick={() => onChange({ enabled: false, trigger: null })}
                >
                  Remove {complete ? "automatic" : "incomplete"} trigger
                </Button>
              </div>
            ) : null}
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
                <RepositorySourcesPanel repositoryId={scope.repositoryId} state={sources} />
                {canAllow ? (
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

/** Search is bounded to the current page; an exact selected lookup supplies names from other pages. */
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
  disabled = false,
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
  disabled?: boolean;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const queryKey = JSON.stringify([grantId, teamId, kind, cursor]);
  const read = useCallback(
    (client: WorkflowSources.Client, token: string) =>
      client
        .metadata(token, scope.repositoryId, {
          grantId,
          kind,
          ...(teamId ? { teamId } : {}),
          ...(cursor ? { cursor } : {}),
        })
        .pipe(Effect.map((page) => ({ key: queryKey, page }))),
    [scope.repositoryId, grantId, kind, teamId, cursor, queryKey],
  );
  const state = useWorkflowSources<{ key: string; page: WorkflowSourceMetadataPage }>(
    scope.accountId,
    read,
  );
  const page = state.snapshot?.key === queryKey ? state.snapshot.page : null;
  const name = selectedName ?? page?.items.find((item) => item.id === value)?.name;
  const items = page?.items ?? [];
  const options =
    value && !items.some((item) => item.id === value)
      ? [{ id: value, name: name ?? value }, ...items]
      : items;
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
      <Combobox
        items={options}
        value={options.find((item) => item.id === value) ?? null}
        itemToStringLabel={(item) => item.name}
        isItemEqualToValue={(a, b) => a.id === b.id}
        disabled={disabled || state.loading || !!state.error}
        onValueChange={(item) => {
          if (item) onChoose(item.id);
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
            aria-label={`Search ${kind} on this page`}
            placeholder="Search this page…"
          />
          <ComboboxEmpty>No matches on this page.</ComboboxEmpty>
          <ComboboxList>
            {(item: { id: string; name: string }) => (
              <ComboboxItem key={item.id} value={item}>
                {item.name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {state.error ? (
        <WorkflowAlert
          title={`Could not load ${label.toLowerCase()}`}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || state.loading}
              onClick={() => void state.refresh()}
            >
              Retry {label.toLowerCase()}
            </Button>
          }
        >
          {state.error} Your selected value is kept.
        </WorkflowAlert>
      ) : null}
      {page?.nextCursor || cursor ? (
        <div className="flex flex-wrap gap-2">
          {page?.nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || state.loading}
              onClick={() => setCursor(page.nextCursor ?? undefined)}
            >
              More {kind}
            </Button>
          ) : null}
          {cursor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || state.loading}
              onClick={() => setCursor(undefined)}
            >
              First page
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
