import { useId, useRef } from "react";
import { WorkflowAlert } from "./WorkflowAlert";
import { WorkflowReviewReworkPicker } from "./WorkflowReviewReworkPicker";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import styles from "./workflowEditor.module.css";
import {
  ArrowDownIcon,
  ArrowUpIcon,
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
import { workflowModelState, workflowVmModelState } from "../settings/workflowModels";
import { WorkflowAgentModelPicker } from "./WorkflowAgentModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

const moveOptions = [
  {
    offset: -1,
    label: "Move up",
    direction: "Above",
    boundary: "Already the first step",
    Icon: ArrowUpIcon,
  },
  {
    offset: 1,
    label: "Move down",
    direction: "Below",
    boundary: "Already the last step",
    Icon: ArrowDownIcon,
  },
] as const;

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

  const target = definition.target;
  const vm = target.kind === "vm";
  const checkoutUnavailable = !vm && !machineCheckoutAvailable;
  if (!targetConfirmed || checkoutUnavailable) {
    return warning(
      targetConfirmed ? "Machine checkout unavailable" : "Execution target required",
      targetConfirmed
        ? "Choose an available Machine checkout to publish."
        : "Choose an execution target to publish.",
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

  const needsPullRequestsWrite =
    vm &&
    definition.steps.some(
      (candidate) => candidate.kind === "action" && candidate.action === "open_pull_request",
    );

  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2 font-medium text-success-foreground">
        <CircleCheckIcon size={15} aria-hidden />
        {vm ? "Step configured" : "Ready"}
      </p>
      <p className="text-muted-foreground">
        {opensPullRequest
          ? "Opens or reuses a pull request for the run branch."
          : vm
            ? "Commits the saved Agent result and pushes the run branch to GitHub."
            : "Commits the saved result and pushes the run branch."}
      </p>
      <dl className="space-y-2 border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-muted-foreground">Execution target</dt>
          <dd>{vm ? "VM" : "Machine"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-muted-foreground">
            {opensPullRequest ? "Publishes after" : "Saved result"}
          </dt>
          <dd className="min-w-0 text-right wrap-anywhere">
            {opensPullRequest ? push?.title : agent.title}
          </dd>
        </div>
        {vm && opensPullRequest ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs text-muted-foreground">Base branch</dt>
            <dd className="min-w-0 text-right wrap-anywhere">
              {target.baseBranch?.trim() || "Repository default"}
            </dd>
          </div>
        ) : null}
        {vm ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-xs text-muted-foreground">GitHub App access for the run</dt>
            <dd className="shrink-0 text-right">
              Contents write
              {needsPullRequestsWrite ? <span className="block">Pull requests write</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {vm ? (
        <WorkflowAlert variant="info" announce={false} title="GitHub access pending verification">
          GitHub access is checked when the run starts.
        </WorkflowAlert>
      ) : null}
    </div>
  );
}

export function WorkflowStepEditor({
  definition,
  selectedId,
  onRequestRemove,
  onRequestMove,
  change,
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
  onRequestRemove: (step: WorkflowStep) => boolean;
  onRequestMove: (step: WorkflowStep, offset: -1 | 1) => boolean;
  change: (steps: ReadonlyArray<WorkflowStep>) => void;
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
  const skipMenuFocus = useRef(false);
  const index = definition.steps.findIndex((step) => step.id === selectedId);
  const step = definition.steps[index];
  const operationLabel =
    step?.kind === "action" ? (step.action === "push" ? "Push branch" : "Open PR") : null;
  const patch = (update: WorkflowStep) => {
    if (disabled) return;
    change(definition.steps.map((entry) => (entry.id === update.id ? update : entry)));
  };
  const vm = definition.target.kind === "vm";
  const promptError =
    step?.kind === "agent" && !step.instruction.trim()
      ? "Enter instructions for this Agent step."
      : step?.kind === "input" && !step.question.trim()
        ? "Enter a question for this Input step."
        : undefined;
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
                  if (open) skipMenuFocus.current = false;
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
                <MenuPopup
                  align="end"
                  className="w-[min(17rem,calc(100vw-2rem))]"
                  finalFocus={() => !skipMenuFocus.current}
                >
                  {moveOptions.map(({ offset, label, direction, boundary, Icon }) => {
                    const destination = index + offset;
                    const neighbor = definition.steps[destination];
                    const detailId = `${id}-move-${offset}`;
                    const positionId = `${detailId}-position`;
                    return (
                      <MenuItem
                        key={offset}
                        label={label}
                        aria-label={label}
                        aria-describedby={neighbor ? `${detailId} ${positionId}` : detailId}
                        disabled={disabled || !neighbor}
                        onClick={() => {
                          if (!disabled && neighbor)
                            skipMenuFocus.current = onRequestMove(step, offset);
                        }}
                      >
                        <Icon aria-hidden />
                        <span className="grid min-w-0 flex-1 gap-0.5 py-0.5">
                          <span>{label}</span>
                          <span
                            id={detailId}
                            className="wrap-anywhere text-muted-foreground text-xs"
                          >
                            {neighbor
                              ? `${direction} ${neighbor.title.trim() || "Untitled step"}`
                              : boundary}
                          </span>
                        </span>
                        {neighbor ? (
                          <span
                            id={positionId}
                            className="shrink-0 whitespace-nowrap text-muted-foreground text-xs tabular-nums"
                          >
                            Step {destination + 1}
                          </span>
                        ) : null}
                      </MenuItem>
                    );
                  })}
                  <MenuItem
                    disabled={disabled}
                    variant="destructive"
                    onClick={() => {
                      if (!disabled && step) skipMenuFocus.current = onRequestRemove(step);
                    }}
                  >
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
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            Step {index + 1}
          </span>
          <fieldset disabled={disabled} className={styles["workflow-inspector-fields"]}>
            {step.kind === "agent" || step.kind === "input" ? (
              <div
                className={
                  step.kind === "agent"
                    ? `block space-y-1 text-sm ${styles["workflow-agent-instructions"]}`
                    : "block space-y-1 text-sm"
                }
              >
                <label className="block" htmlFor={`${id}-prompt`}>
                  {step.kind === "agent" ? "Agent instructions" : "Question"}
                </label>
                <Textarea
                  id={`${id}-prompt`}
                  aria-invalid={promptError ? true : undefined}
                  aria-describedby={promptError ? `${id}-prompt-issue` : undefined}
                  ref={(node) =>
                    registerField(step.kind === "agent" ? "instruction" : "question", node)
                  }
                  required
                  rows={step.kind === "input" ? 3 : 6}
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
                {step.kind === "input" || promptError ? (
                  <p
                    id={`${id}-prompt-issue`}
                    aria-live={step.kind === "input" ? "polite" : undefined}
                    className="text-xs text-destructive-foreground empty:sr-only"
                  >
                    {promptError}
                  </p>
                ) : null}
              </div>
            ) : null}
            {step.kind === "agent" ? (
              <WorkflowAgentModelPicker
                step={step}
                models={models}
                vm={vm}
                vmModels={vmModels}
                targetConfirmed={targetConfirmed}
                disabled={disabled}
                onChange={(modelSelection) => patch({ ...step, modelSelection })}
                registerControl={(node) => registerField("model", node)}
              />
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
                  {step.kind === "review" ? "Who can review?" : "Who can answer?"}
                </p>
                <Select
                  value={step.role}
                  onValueChange={(role) => {
                    if (role === "member" || role === "maintainer") patch({ ...step, role });
                  }}
                >
                  <SelectTrigger
                    aria-labelledby={`${id}-role`}
                    aria-describedby={step.kind === "input" ? `${id}-role-help` : undefined}
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
                {step.kind === "input" ? (
                  <p id={`${id}-role-help`} className="text-xs text-muted-foreground">
                    The run waits for an answer before continuing.
                  </p>
                ) : null}
              </div>
            )}
            {step.kind === "review" ? (
              <WorkflowReviewReworkPicker
                steps={definition.steps}
                reviewIndex={index}
                reworkStepId={step.reworkStepId}
                disabled={disabled}
                onChange={(reworkStepId) => patch({ ...step, reworkStepId })}
                registerTrigger={(node) => registerField("rework", node)}
              />
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
