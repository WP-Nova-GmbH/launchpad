import { useId, useRef } from "react";
import { WorkflowAlert } from "./WorkflowAlert";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import styles from "./workflowEditor.module.css";
import {
  UploadIcon,
  BotIcon,
  CircleCheckIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  UserRoundCheckIcon,
  XIcon,
} from "lucide-react";
import {
  WORKFLOW_MAX_STEPS,
  workflowPublishingPrerequisites,
  type WorkflowStep,
  type WorkflowDefinition,
  type WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import {
  workflowModelState,
  workflowVmCodexInstanceId,
  workflowVmModelState,
} from "../settings/workflowModels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

function PublishingStepSettings({
  definition,
  index,
  step,
  targetConfirmed,
  machineCheckoutAvailable,
  openWorkflowSettings,
  insertPushBranch,
  registerField,
}: {
  definition: WorkflowDefinition;
  index: number;
  step: Extract<WorkflowStep, { kind: "action" }>;
  targetConfirmed: boolean;
  machineCheckoutAvailable: boolean;
  openWorkflowSettings: () => void;
  insertPushBranch: () => void;
  registerField: (field: string, node: HTMLElement | null) => void;
}) {
  const descriptionId = useId();
  const warning = (
    title: string,
    description: string,
    repair?: {
      label: string;
      icon: typeof Settings2Icon;
      onClick: () => void;
      disabled?: boolean;
    },
  ) => {
    const RepairIcon = repair?.icon;
    return (
      <div
        role="group"
        aria-label={title}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
        ref={(node) => registerField("repair-warning", node)}
      >
        <WorkflowAlert
          title={title}
          variant="warning"
          actions={
            repair && RepairIcon ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-describedby={descriptionId}
                disabled={repair.disabled}
                ref={repair.disabled ? undefined : (node) => registerField("repair", node)}
                onClick={repair.onClick}
              >
                <RepairIcon aria-hidden />
                {repair.label}
              </Button>
            ) : undefined
          }
        >
          <span id={descriptionId}>{description}</span>
        </WorkflowAlert>
      </div>
    );
  };

  const vm = definition.target.kind === "vm";
  if (vm || !targetConfirmed || !machineCheckoutAvailable) {
    const checkoutUnavailable = !vm && targetConfirmed;
    return warning(
      checkoutUnavailable ? "Machine checkout unavailable" : "Machine target required",
      vm
        ? "This workflow uses a VM. Choose a Machine checkout to publish."
        : checkoutUnavailable
          ? "Choose an available Machine checkout to publish."
          : "Choose a Machine checkout to publish.",
      {
        label: "Open workflow settings",
        icon: Settings2Icon,
        onClick: openWorkflowSettings,
      },
    );
  }

  const { agent, push } = workflowPublishingPrerequisites(definition.steps, index);
  if (!agent)
    return warning("Agent step required", "Add or move an Agent step before this publishing step.");

  const opensPullRequest = step.action === "open_pull_request";
  if (opensPullRequest && !push) {
    const atLimit = definition.steps.length >= WORKFLOW_MAX_STEPS;
    return warning(
      "Push branch step required",
      atLimit
        ? "Remove a step to make room for Push branch, then add it before Open PR."
        : "Add Push branch after the latest Agent step and before Open PR.",
      { label: "Add Push branch", icon: PlusIcon, onClick: insertPushBranch, disabled: atLimit },
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2 font-medium text-success-foreground">
        <CircleCheckIcon size={15} aria-hidden />
        Ready
      </p>
      <p className="text-muted-foreground">
        {opensPullRequest
          ? "Opens or reuses a pull request for the run branch."
          : "Commits the saved result and pushes the run branch."}
      </p>
      <dl className="space-y-2 border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-muted-foreground">Execution target</dt>
          <dd>Machine</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-muted-foreground">
            {opensPullRequest ? "Publishes after" : "Saved result"}
          </dt>
          <dd className="min-w-0 text-right wrap-anywhere">
            {opensPullRequest ? push?.title : agent.title}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function WorkflowStepEditor({
  definition,
  selectedId,
  select,
  change,
  move: moveSteps,
  models,
  vmModels,
  targetConfirmed,
  machineCheckoutAvailable,
  disabled,
  close,
  openWorkflowSettings,
  insertPushBranch,
  registerField,
}: {
  definition: WorkflowDefinition;
  selectedId: string | null;
  select: (id: string) => void;
  change: (steps: ReadonlyArray<WorkflowStep>) => void;
  move: (steps: ReadonlyArray<WorkflowStep>) => void;
  models: ReturnType<typeof workflowModelState>;
  vmModels?: WorkflowVmModelCatalog | null | undefined;
  targetConfirmed: boolean;
  machineCheckoutAvailable: boolean;
  disabled: boolean;
  close: () => void;
  openWorkflowSettings: () => void;
  insertPushBranch: () => void;
  registerField: (field: string, node: HTMLElement | null) => void;
}) {
  const id = useId();
  const removingStep = useRef(false);
  const { entries, modelOptions } = models;
  const index = definition.steps.findIndex((step) => step.id === selectedId);
  const step = definition.steps[index];
  const operationLabel =
    step?.kind === "action" ? (step.action === "push" ? "Push branch" : "Open PR") : null;
  const patch = (update: WorkflowStep) => {
    if (disabled) return;
    change(definition.steps.map((entry) => (entry.id === update.id ? update : entry)));
  };
  const move = (offset: number) => {
    const steps = [...definition.steps];
    const target = index + offset;
    if (disabled || !step || target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    moveSteps(steps);
  };
  const remove = () => {
    if (disabled || !step) return;
    removingStep.current = true;
    change(definition.steps.filter((entry) => entry.id !== step.id));
    select(definition.steps[index + 1]?.id ?? definition.steps[index - 1]?.id ?? "");
  };
  const earlierAgents =
    step?.kind === "review"
      ? definition.steps.slice(0, index).filter((entry) => entry.kind === "agent")
      : [];
  const invalidRework =
    step?.kind === "review" &&
    !earlierAgents.some((entry) => !step.reworkStepId || entry.id === step.reworkStepId);
  const triggerLabel = step?.kind === "agent" ? models.triggerLabel(step) : undefined;
  const vm = definition.target.kind === "vm";
  const vmModelIssue = vm ? models.issues.find((issue) => issue.stepId === step?.id) : undefined;
  return (
    <div className="space-y-3">
      {step ? (
        <div>
          <header className={styles["workflow-inspector-header"]}>
            <span className={styles["workflow-node-icon"]} data-kind={step.kind}>
              {step.kind === "action" ? (
                step.action === "push" ? (
                  <UploadIcon aria-hidden />
                ) : (
                  <PullRequestGlyph.pullRequest aria-hidden />
                )
              ) : step.kind === "agent" ? (
                <BotIcon />
              ) : step.kind === "input" ? (
                <MessageSquareIcon />
              ) : (
                <UserRoundCheckIcon />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <input
                className={styles["workflow-step-title"]}
                aria-label="Step name"
                required
                disabled={disabled}
                maxLength={120}
                data-workflow-field="title"
                ref={(node) => registerField("title", node)}
                value={step.title}
                onChange={(event) => patch({ ...step, title: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {step.kind === "agent"
                  ? "Agent"
                  : step.kind === "input"
                    ? "Human input"
                    : operationLabel
                      ? step.title === operationLabel
                        ? "Publishing"
                        : operationLabel
                      : "Review"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Menu
                onOpenChange={(open) => {
                  if (open) removingStep.current = false;
                }}
              >
                <MenuTrigger
                  disabled={disabled}
                  ref={(node) => registerField("actions", node)}
                  render={
                    <Button type="button" variant="ghost" size="icon" aria-label="Step actions" />
                  }
                >
                  <EllipsisIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" finalFocus={() => !removingStep.current}>
                  <MenuItem disabled={disabled || index === 0} onClick={() => move(-1)}>
                    Move up
                  </MenuItem>
                  <MenuItem
                    disabled={disabled || index === definition.steps.length - 1}
                    onClick={() => move(1)}
                  >
                    Move down
                  </MenuItem>
                  <MenuItem disabled={disabled} variant="destructive" onClick={remove}>
                    Remove step
                  </MenuItem>
                </MenuPopup>
              </Menu>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close settings"
                ref={(node) => registerField("close", node)}
                onClick={close}
              >
                <XIcon />
              </Button>
            </div>
          </header>
          <fieldset disabled={disabled} className={styles["workflow-inspector-fields"]}>
            {step.kind === "input" ? (
              <p className={styles["workflow-checkpoint-note"]}>
                The workflow waits here until someone answers.
              </p>
            ) : null}
            {step.kind === "agent" || step.kind === "input" ? (
              <label
                className={
                  step.kind === "agent"
                    ? `block space-y-1 text-sm ${styles["workflow-agent-instructions"]}`
                    : "block space-y-1 text-sm"
                }
              >
                <span>{step.kind === "agent" ? "Agent instructions" : "Required question"}</span>
                <Textarea
                  ref={(node) =>
                    registerField(step.kind === "agent" ? "instruction" : "question", node)
                  }
                  required
                  rows={6}
                  maxLength={32000}
                  data-workflow-field={step.kind === "agent" ? "instruction" : "question"}
                  value={step.kind === "agent" ? step.instruction : step.question}
                  onChange={(event) =>
                    patch(
                      step.kind === "agent"
                        ? { ...step, instruction: event.target.value }
                        : { ...step, question: event.target.value },
                    )
                  }
                />
              </label>
            ) : null}
            {step.kind === "agent" ? (
              <div className="space-y-2">
                <p className="text-sm">Model</p>
                {vm ? (
                  <>
                    <Select
                      value={
                        vmModelIssue
                          ? null
                          : step.modelSelection
                            ? "model:" + step.modelSelection.model
                            : "default"
                      }
                      onValueChange={(value) => {
                        const model = vmModels?.models.find(
                          (entry) => "model:" + entry.slug === value,
                        );
                        if (value === "default" || model)
                          patch({
                            ...step,
                            modelSelection: model
                              ? { instanceId: workflowVmCodexInstanceId, model: model.slug }
                              : null,
                          });
                      }}
                    >
                      <SelectTrigger
                        aria-label="Managed Codex model"
                        aria-describedby={`${id}-approvals`}
                        ref={(node) => registerField("model", node)}
                      >
                        <SelectValue>{triggerLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="default">Managed default</SelectItem>
                        {vmModels?.models.map((model) => (
                          <SelectItem key={model.slug} value={"model:" + model.slug}>
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {vmModelIssue ? (
                      <WorkflowAlert
                        title="Selected model unavailable"
                        variant="warning"
                        actions={
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => patch({ ...step, modelSelection: null })}
                          >
                            Use managed default
                          </Button>
                        }
                      >
                        {vmModelIssue.detail}
                      </WorkflowAlert>
                    ) : !vmModels ? (
                      <WorkflowAlert title="VM model choices unavailable" variant="info">
                        VM model choices could not be loaded. The managed default is available.
                      </WorkflowAlert>
                    ) : null}
                  </>
                ) : entries[0] ? (
                  <ProviderModelPicker
                    disabled={disabled}
                    triggerClassName="w-full max-w-none sm:max-w-none"
                    activeInstanceId={
                      models.effectiveSelection(step)?.instanceId ?? entries[0].instanceId
                    }
                    model={models.effectiveSelection(step)?.model ?? ""}
                    {...(triggerLabel ? { triggerLabel } : {})}
                    lockedProvider={
                      step.id === models.first?.id ? null : (models.anchor?.driverKind ?? null)
                    }
                    lockedContinuationGroupKey={
                      step.id === models.first?.id
                        ? null
                        : (models.anchor?.continuationGroupKey ?? null)
                    }
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    getModelDisabledReason={(instanceId, model) =>
                      models.disabledReason(instanceId, model, step.id)
                    }
                    onInstanceModelChange={(instanceId, model) =>
                      patch({ ...step, modelSelection: { instanceId, model } })
                    }
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {step.modelSelection
                      ? `${step.modelSelection.instanceId} · ${step.modelSelection.model} (Unverified). `
                      : "Project default. "}
                    Connect to this environment to choose or verify a model.
                  </p>
                )}
                <p id={`${id}-approvals`} className="text-xs text-muted-foreground">
                  Approvals required
                </p>
                {step.modelSelection && !vmModelIssue ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => patch({ ...step, modelSelection: null })}
                  >
                    {vm ? "Use managed default" : "Use project default"}
                  </Button>
                ) : null}
              </div>
            ) : step.kind === "action" ? (
              <PublishingStepSettings
                definition={definition}
                index={index}
                step={step}
                targetConfirmed={targetConfirmed}
                machineCheckoutAvailable={machineCheckoutAvailable}
                openWorkflowSettings={openWorkflowSettings}
                insertPushBranch={insertPushBranch}
                registerField={registerField}
              />
            ) : (
              <div className="space-y-1">
                <p id={`${id}-role`} className="text-sm">
                  {step.kind === "review" ? "Who can review?" : "Who can respond?"}
                </p>
                <Select
                  value={step.role}
                  onValueChange={(role) => {
                    if (role === "member" || role === "maintainer") patch({ ...step, role });
                  }}
                >
                  <SelectTrigger
                    aria-labelledby={`${id}-role`}
                    data-workflow-field="role"
                    ref={(node) => registerField("role", node)}
                  >
                    <SelectValue>
                      {step.role === "member" ? "Any repository member" : "Repository maintainers"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="maintainer">Repository maintainers</SelectItem>
                    <SelectItem value="member">Any repository member</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            )}
            {step.kind === "review" ? (
              <div className="space-y-1">
                <p id={`${id}-rework`} className="text-sm">
                  Send requested changes back to
                </p>
                <Select
                  value={step.reworkStepId ? `agent:${step.reworkStepId}` : "nearest"}
                  onValueChange={(value) =>
                    patch({
                      ...step,
                      reworkStepId: value?.startsWith("agent:") ? value.slice(6) : undefined,
                    })
                  }
                >
                  <SelectTrigger
                    aria-labelledby={`${id}-rework`}
                    aria-invalid={invalidRework || undefined}
                    aria-describedby={invalidRework ? `${id}-rework-issue` : undefined}
                    data-workflow-field="rework"
                    ref={(node) => registerField("rework", node)}
                  >
                    <SelectValue>
                      {step.reworkStepId
                        ? (definition.steps.find((entry) => entry.id === step.reworkStepId)
                            ?.title ?? "Unavailable Agent step")
                        : "Previous Agent step"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="nearest">Previous Agent step</SelectItem>
                    {earlierAgents.map((entry) => (
                      <SelectItem key={entry.id} value={`agent:${entry.id}`}>
                        {entry.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {invalidRework ? (
                  <p id={`${id}-rework-issue`} className="text-xs text-destructive-foreground">
                    {earlierAgents.length
                      ? "Choose an earlier Agent step."
                      : "Add an Agent step before Review."}
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

export function useWorkflowEditorModels(
  definition: WorkflowDefinition,
  vmModels: WorkflowVmModelCatalog | null = null,
) {
  const target = definition.target.kind === "machine" ? definition.target : null;
  const environment = useEnvironment(target?.environmentId ?? null);
  const settings = useEnvironmentSettings(target?.environmentId ?? null);
  const project = useProject(target);
  if (!target) return workflowVmModelState(definition, vmModels);
  return workflowModelState(
    definition,
    environment?.serverConfig?.providers ?? [],
    settings,
    project?.defaultModelSelection,
    environment?.connection.phase === "connected" && !!environment.serverConfig,
  );
}
