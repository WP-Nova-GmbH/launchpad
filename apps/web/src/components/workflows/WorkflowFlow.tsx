import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { UploadIcon, BotIcon, HandIcon, GripVerticalIcon, CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  isTerminalWorkflowJob,
  workflowZones,
  type WorkflowStep,
  type WorkflowDefinition,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import { workflowStepState } from "@t3tools/client-runtime/relay/workflow-session";
import { Button } from "../ui/button";

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
                zone[0]!.kind === "agent" || zone[0]!.kind === "action"
                  ? "border-l-2 border-border pl-3"
                  : "border-l-2 border-warning/50 pl-3"
              }
            >
              <p className="mb-1 text-xs text-muted-foreground">
                {zone[0]!.kind === "agent" || zone[0]!.kind === "action"
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
                    {step.kind === "action" ? (
                      <UploadIcon className="size-4 shrink-0" />
                    ) : step.kind === "agent" ? (
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
                            : step.kind === "action"
                              ? step.action === "push"
                                ? "Push branch"
                                : "Open PR"
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
                const appearance = `flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left ${selected ? "border-ring bg-accent" : current ? (step.kind === "agent" || step.kind === "action" ? "border-ring bg-accent" : "border-warning/60 bg-warning-surface") : "border-transparent"}`;
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
