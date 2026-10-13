import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BotIcon, HandIcon, GripVerticalIcon, CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  isTerminalWorkflowJob,
  workflowZones,
  workflowDefinitionError,
  type WorkflowStep,
  type WorkflowDefinition,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { workflowStepState } from "@t3tools/client-runtime/relay/workflow-session";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import { workflowModelState } from "../settings/workflowModels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function WorkflowFlow({
  definition,
  job,
  selectedStepId,
  invalidStepId,
  onSelect,
  onReorder,
  onInsert,
}: {
  definition: WorkflowDefinition;
  job?: RepositoryWorkflowJob | undefined;
  selectedStepId?: string | undefined;
  invalidStepId?: string | null | undefined;
  onSelect?: (id: string) => void;
  onReorder?: ((steps: ReadonlyArray<WorkflowStep>) => void) | undefined;
  onInsert?: ((index: number, kind: WorkflowStep["kind"]) => void) | undefined;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      onDragEnd={({ active, over }) => {
        if (!onReorder || !over || active.id === over.id) return;
        const from = definition.steps.findIndex((step) => step.id === active.id);
        const to = definition.steps.findIndex((step) => step.id === over.id);
        if (from >= 0 && to >= 0) onReorder(arrayMove([...definition.steps], from, to));
      }}
    >
      <SortableContext
        items={definition.steps.map((step) => step.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-3" aria-label="Workflow steps">
          {onInsert ? (
            <WorkflowInsert
              index={0}
              disabled={definition.steps.length >= 32}
              onInsert={onInsert}
            />
          ) : null}
          {workflowZones(definition.steps).map((zone) => (
            <section
              key={zone[0]!.id}
              className={
                zone[0]!.kind === "agent"
                  ? "border-l-2 border-border pl-3"
                  : "border-l-2 border-warning/50 pl-3"
              }
            >
              <p className="mb-1 text-xs text-muted-foreground">
                {zone[0]!.kind === "agent"
                  ? "Automatic work"
                  : zone[0]!.kind === "input"
                    ? "Human input"
                    : "Human review"}
              </p>
              {zone.map((step) => {
                const index = definition.steps.findIndex((entry) => entry.id === step.id);
                const state = workflowStepState(job, step.id);
                const current =
                  !!job &&
                  !isTerminalWorkflowJob(job.status) &&
                  (job.progress?.checkpoint?.stepId === step.id ||
                    job.progress?.stepId === step.id);
                const selected = selectedStepId === step.id;
                const row = (
                  <>
                    <span className="w-5 shrink-0 text-xs text-muted-foreground">
                      {state === "completed" ? <CheckIcon className="size-4" /> : index + 1}
                    </span>
                    {step.kind === "agent" ? (
                      <BotIcon className="size-4 shrink-0" />
                    ) : (
                      <HandIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {step.title || "Untitled step"}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {job
                          ? state === "pending"
                            ? "Upcoming"
                            : state
                          : step.kind === "agent"
                            ? "Agent"
                            : step.role === "member"
                              ? "Repository members"
                              : "Maintainers"}
                      </span>
                    </span>
                    {invalidStepId === step.id ? (
                      <span className="text-xs text-destructive">Check settings</span>
                    ) : null}
                  </>
                );
                const appearance = `flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left ${selected ? "border-ring bg-accent" : current ? (step.kind === "agent" ? "border-ring bg-accent" : "border-warning/60 bg-warning-surface") : "border-transparent"}`;
                return (
                  <div key={step.id}>
                    <SortableWorkflowStep id={step.id} title={step.title} enabled={!!onReorder}>
                      {onSelect ? (
                        <button
                          type="button"
                          aria-pressed={selected}
                          className={`${appearance} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
                          onClick={() => onSelect(step.id)}
                        >
                          {row}
                        </button>
                      ) : (
                        <div className={appearance} aria-current={current ? "step" : undefined}>
                          {row}
                        </div>
                      )}
                    </SortableWorkflowStep>
                    {onInsert ? (
                      <WorkflowInsert
                        index={index + 1}
                        disabled={definition.steps.length >= 32}
                        onInsert={onInsert}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function WorkflowInsert({
  index,
  disabled,
  onInsert,
}: {
  index: number;
  disabled: boolean;
  onInsert: (index: number, kind: WorkflowStep["kind"]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={`Insert step at position ${index + 1}`}
      >
        + Add step
      </Button>
      {disabled && index === 0 ? (
        <p className="text-xs text-muted-foreground">Maximum 32 steps.</p>
      ) : null}
      {open && !disabled ? (
        <div className="flex flex-wrap gap-1">
          {(["agent", "review", "input"] as const).map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onInsert(index, kind);
                setOpen(false);
              }}
            >
              {kind === "agent" ? "Agent" : kind === "review" ? "Review" : "Input"}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SortableWorkflowStep({
  id,
  title,
  enabled,
  children,
}: {
  id: string;
  title: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, transform, transition, attributes, listeners } = useSortable({
    id,
    disabled: !enabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-1"
    >
      {enabled ? (
        <button
          type="button"
          aria-label={`Reorder ${title}`}
          className="cursor-grab touch-none rounded p-1 focus-visible:outline-2"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function WorkflowStepEditor({
  definition,
  selectedId,
  select,
  change,
}: {
  definition: WorkflowDefinition;
  selectedId: string | null;
  select: (id: string) => void;
  change: (steps: ReadonlyArray<WorkflowStep>) => void;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (entry) => entry.environmentId === definition.environmentId,
  );
  const settings = useEnvironmentSettings(definition.environmentId);
  const project = useProject({
    environmentId: definition.environmentId,
    projectId: definition.projectId,
  });
  const models = workflowModelState(
    definition,
    environment?.serverConfig?.providers ?? [],
    settings,
    project?.defaultModelSelection,
    environment?.connection.phase === "connected" && !!environment.serverConfig,
  );
  const { entries, modelOptions } = models;
  const index = Math.max(
    0,
    definition.steps.findIndex((step) => step.id === selectedId),
  );
  const step = definition.steps[index];
  const patch = (update: WorkflowStep) =>
    change(definition.steps.map((entry) => (entry.id === update.id ? update : entry)));
  const move = (offset: number) => {
    const steps = [...definition.steps];
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    change(steps);
  };
  const validation = workflowDefinitionError(definition.steps);
  const triggerLabel = step?.kind === "agent" ? models.triggerLabel(step) : undefined;
  return (
    <div className="space-y-3">
      {validation ? (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      ) : null}
      {models.issues.map((issue) => (
        <p key={issue.stepId} className="text-sm text-warning">
          {issue.title}: {issue.detail}
        </p>
      ))}
      {step ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">
            {step.kind === "agent" ? "Agent" : step.kind === "input" ? "Input" : "Review"} settings
          </p>
          <label className="block space-y-1 text-sm">
            <span>Step name</span>
            <Input
              required
              maxLength={120}
              data-workflow-field="title"
              value={step.title}
              onChange={(event) => patch({ ...step, title: event.target.value })}
            />
          </label>
          {step.kind === "agent" || step.kind === "input" ? (
            <label className="block space-y-1 text-sm">
              <span>{step.kind === "agent" ? "Agent instructions" : "Required question"}</span>
              <Textarea
                required
                rows={4}
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
          ) : (
            <div className="space-y-1">
              <p className="text-sm">Who can respond?</p>
              <Select
                value={step.role}
                onValueChange={(role) => {
                  if (role === "member" || role === "maintainer") patch({ ...step, role });
                }}
              >
                <SelectTrigger aria-label="Checkpoint role">
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
                <SelectTrigger aria-label="Rework target" data-workflow-field="rework">
                  <SelectValue>
                    {step.reworkStepId
                      ? (definition.steps.find((entry) => entry.id === step.reworkStepId)?.title ??
                        "Unavailable Agent step")
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
                select(definition.steps.find((entry) => entry.id !== step.id)?.id ?? "");
              }}
            >
              Remove step
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
