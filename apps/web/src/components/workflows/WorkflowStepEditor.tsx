import { useEnvironments } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import styles from "./workflowEditor.module.css";
import { UploadIcon, BotIcon, MessageSquareIcon, UserRoundCheckIcon, XIcon } from "lucide-react";
import type { WorkflowStep, WorkflowDefinition } from "@t3tools/contracts/workflows";
import { workflowModelState } from "../settings/workflowModels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function WorkflowStepEditor({
  definition,
  selectedId,
  select,
  change,
  move: moveSteps,
  models,
  disabled,
  close,
  registerField,
}: {
  definition: WorkflowDefinition;
  selectedId: string | null;
  select: (id: string) => void;
  change: (steps: ReadonlyArray<WorkflowStep>) => void;
  move: (steps: ReadonlyArray<WorkflowStep>) => void;
  models: ReturnType<typeof workflowModelState>;
  disabled: boolean;
  close: () => void;
  registerField: (field: string, node: HTMLElement | null) => void;
}) {
  const { entries, modelOptions } = models;
  const index = definition.steps.findIndex((step) => step.id === selectedId);
  const step = definition.steps[index];
  const patch = (update: WorkflowStep) =>
    change(definition.steps.map((entry) => (entry.id === update.id ? update : entry)));
  const move = (offset: number) => {
    const steps = [...definition.steps];
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    moveSteps(steps);
  };
  const triggerLabel = step?.kind === "agent" ? models.triggerLabel(step) : undefined;
  return (
    <div className="space-y-3">
      {step ? (
        <div>
          <header className={styles["workflow-inspector-header"]}>
            <span className={styles["workflow-node-icon"]} data-kind={step.kind}>
              {step.kind === "action" ? (
                <UploadIcon />
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
                    : step.kind === "action"
                      ? step.action === "push"
                        ? "Push branch"
                        : "Open PR"
                      : "Human review"}{" "}
                · Step {index + 1}
              </p>
            </div>
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
          </header>
          <fieldset disabled={disabled} className={styles["workflow-inspector-fields"]}>
            {step.kind === "input" || step.kind === "review" ? (
              <p className={styles["workflow-checkpoint-note"]} data-kind={step.kind}>
                {step.kind === "input"
                  ? "The workflow waits here until someone answers."
                  : "The workflow waits here until someone approves or requests changes."}
              </p>
            ) : null}
            {step.kind === "agent" || step.kind === "input" ? (
              <label className="block space-y-1 text-sm">
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
                <p className="text-sm">Model · approvals required</p>
                {entries[0] ? (
                  <ProviderModelPicker
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
                {step.modelSelection ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => patch({ ...step, modelSelection: null })}
                  >
                    Use project default
                  </Button>
                ) : null}
              </div>
            ) : step.kind === "action" ? (
              <p className="text-sm text-muted-foreground">
                {step.action === "push"
                  ? "Commits the saved result and pushes the job branch. Retries reuse the prepared commit."
                  : "Opens or reuses this job's pull request."}
              </p>
            ) : (
              <div className="space-y-1">
                <p className="text-sm">Who can respond?</p>
                <Select
                  value={step.role}
                  onValueChange={(role) => {
                    if (role === "member" || role === "maintainer") patch({ ...step, role });
                  }}
                >
                  <SelectTrigger
                    aria-label="Checkpoint role"
                    data-workflow-field="role"
                    ref={(node) => registerField("role", node)}
                  >
                    <SelectValue>
                      {step.role === "member" ? "Repository members" : "Maintainers"}
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
                <p className="text-sm">Request changes returns to</p>
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
                    aria-label="Rework target"
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
                    {definition.steps
                      .slice(0, index)
                      .filter((entry) => entry.kind === "agent")
                      .map((entry) => (
                        <SelectItem key={entry.id} value={`agent:${entry.id}`}>
                          {entry.title}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={index === 0}
                onClick={() => move(-1)}
              >
                Move up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={index === definition.steps.length - 1}
                onClick={() => move(1)}
              >
                Move down
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  change(definition.steps.filter((entry) => entry.id !== step.id));
                  select(definition.steps[index + 1]?.id ?? definition.steps[index - 1]?.id ?? "");
                }}
              >
                Remove step
              </Button>
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

export function useWorkflowEditorModels(definition: WorkflowDefinition) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (entry) => entry.environmentId === definition.environmentId,
  );
  const settings = useEnvironmentSettings(definition.environmentId);
  const project = useProject({
    environmentId: definition.environmentId,
    projectId: definition.projectId,
  });
  return workflowModelState(
    definition,
    environment?.serverConfig?.providers ?? [],
    settings,
    project?.defaultModelSelection,
    environment?.connection.phase === "connected" && !!environment.serverConfig,
  );
}
