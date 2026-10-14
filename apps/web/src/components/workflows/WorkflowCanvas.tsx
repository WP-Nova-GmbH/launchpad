import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import styles from "./workflowEditor.module.css";
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BotIcon,
  MessageSquareIcon,
  UserRoundCheckIcon,
  GripVerticalIcon,
  PlayIcon,
  PlusIcon,
  MinusIcon,
  MaximizeIcon,
  ChevronDownIcon,
  AlertCircleIcon,
} from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  workflowZones,
  type WorkflowDefinition,
  type WorkflowStep,
} from "@t3tools/contracts/workflows";
import type { workflowModelState } from "../settings/workflowModels";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";

export type WorkflowInsertion = { edge: "start" | "end" } | { after: WorkflowStep };

/** Resolve menu positions against the current sequence, never a captured array index. */
export function workflowInsertionIndex(
  steps: ReadonlyArray<WorkflowStep>,
  anchor: WorkflowInsertion,
) {
  if ("edge" in anchor) return anchor.edge === "start" ? 0 : steps.length;
  const index = steps.findIndex((step) => step === anchor.after);
  return index < 0 ? null : index + 1;
}

export function WorkflowCanvas({
  definition,
  selectedStepId,
  invalidStepId,
  models,
  pending,
  onSelect,
  onReorder,
  onInsert,
  onOverview,
  panelOpen,
  movementVersion = 0,
}: {
  definition: WorkflowDefinition;
  selectedStepId: string;
  invalidStepId: string | null | undefined;
  models: ReturnType<typeof workflowModelState>;
  pending: boolean;
  onSelect: (id: string) => void;
  onReorder: (steps: ReadonlyArray<WorkflowStep>) => boolean;
  onInsert: (anchor: WorkflowInsertion, kind: WorkflowStep["kind"]) => void;
  onOverview: () => void;
  panelOpen: boolean;
  movementVersion?: number;
}) {
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const selected = definition.steps.find((step) => step.id === selectedStepId);
  const atLimit = definition.steps.length >= 32;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const revealTarget = useRef(selectedStepId);
  const reordered = useRef<{ stepId: string; steps: ReadonlyArray<WorkflowStep> } | null>(null);
  const reveal = useCallback((stepId: string) => {
    const scroll = viewport.current;
    const node = nodes.current.get(stepId);
    if (!scroll || !node) return;
    const bounds = scroll.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (rect.top < bounds.top + 16) scroll.scrollTop += rect.top - bounds.top - 16;
    else if (rect.bottom > bounds.bottom - 16) scroll.scrollTop += rect.bottom - bounds.bottom + 16;
  }, []);
  useLayoutEffect(() => {
    revealTarget.current = selectedStepId;
    reveal(selectedStepId);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- These deliberate viewport actions reset reveal ownership.
  }, [selectedStepId, zoom, panelOpen, movementVersion, reveal]);
  useLayoutEffect(() => {
    const request = reordered.current;
    reordered.current = null;
    if (request?.steps === definition.steps) {
      revealTarget.current = request.stepId;
      reveal(request.stepId);
    } else if (!definition.steps.some((step) => step.id === revealTarget.current)) {
      revealTarget.current = selectedStepId;
    }
  }, [definition.steps, selectedStepId, reveal]);
  useLayoutEffect(() => {
    if (!viewport.current || typeof ResizeObserver === "undefined") return;
    // The adopted drop keeps ownership when a cleared notice resizes the viewport later.
    const observer = new ResizeObserver(() => reveal(revealTarget.current));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [reveal]);
  return (
    <section
      className={styles["workflow-canvas"]}
      aria-label="Workflow sequence"
      style={{ "--workflow-zoom": zoom / 100 } as CSSProperties}
    >
      <div className={styles["workflow-canvas-toolbar"]}>
        <InsertMenu
          definition={definition}
          anchor={selected ? { after: selected } : { edge: "end" }}
          disabled={pending || atLimit}
          onInsert={onInsert}
          label={selected ? `Add a step after ${selected.title}` : "Add a step at the end"}
          toolbar
        />
        {atLimit ? <span className="text-xs text-muted-foreground">Maximum 32 steps</span> : null}
      </div>
      <div
        ref={viewport}
        className={styles["workflow-canvas-scroll"]}
        tabIndex={0}
        aria-label="Scrollable workflow canvas"
      >
        <div className={styles["workflow-start"]}>
          <div className={styles["workflow-zone-label"]}>
            <strong>Starts when</strong>
            <span>Someone runs this workflow</span>
          </div>
          <span className={styles["workflow-start-marker"]}>
            <PlayIcon size={14} />
            Manual run
          </span>
        </div>
        <DndContext
          sensors={sensors}
          onDragCancel={() => {
            reordered.current = null;
          }}
          onDragEnd={({ active, over }) => {
            reordered.current = null;
            if (pending || !over || active.id === over.id) return;
            const from = definition.steps.findIndex((step) => step.id === active.id);
            const to = definition.steps.findIndex((step) => step.id === over.id);
            if (from < 0 || to < 0) return;
            const steps = arrayMove([...definition.steps], from, to);
            reordered.current = { stepId: String(active.id), steps };
            if (!onReorder(steps)) reordered.current = null;
          }}
        >
          <SortableContext
            items={definition.steps.map((step) => step.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className={styles["workflow-start-insert"]}>
              <InsertMenu
                definition={definition}
                anchor={{ edge: "start" }}
                disabled={pending || atLimit}
                onInsert={onInsert}
                label="Insert step at position 1"
              />
            </div>
            {workflowZones(definition.steps).map((zone) => {
              const kind = zone[0]!.kind;
              return (
                <section
                  key={zone[0]!.id}
                  className={styles["workflow-zone"]}
                  data-kind={kind}
                  aria-label={
                    kind === "agent"
                      ? "Automatic work"
                      : kind === "input"
                        ? "Human input"
                        : "Human review"
                  }
                >
                  {zone.map((step, zoneIndex) => {
                    const index = definition.steps.findIndex((entry) => entry.id === step.id);
                    const warning = models.issues.find((issue) => issue.stepId === step.id);
                    const summary =
                      step.kind === "agent"
                        ? `Agent · ${models.triggerLabel(step) ?? models.effectiveSelection(step)?.model ?? "Project default"}`
                        : step.role === "member"
                          ? "Repository members"
                          : "Maintainers";
                    return (
                      <div key={step.id} className={styles["workflow-canvas-row"]}>
                        {zoneIndex === 0 ? (
                          <div className={styles["workflow-zone-label"]}>
                            <strong>
                              {kind === "agent" ? (
                                <BotIcon />
                              ) : kind === "input" ? (
                                <MessageSquareIcon />
                              ) : (
                                <UserRoundCheckIcon />
                              )}
                              {kind === "agent"
                                ? "Automatic"
                                : kind === "input"
                                  ? "Human input"
                                  : "Human review"}
                            </strong>
                            <span>
                              {kind === "agent"
                                ? "Agent continues the work"
                                : kind === "input"
                                  ? "Waits for an answer"
                                  : "Waits for approval"}
                            </span>
                          </div>
                        ) : null}
                        <CanvasNode
                          step={step}
                          index={index}
                          selected={step.id === selectedStepId}
                          disabled={pending}
                          summary={summary}
                          warning={
                            invalidStepId === step.id
                              ? "Check this step’s settings"
                              : warning?.detail
                          }
                          select={(id) => {
                            revealTarget.current = id;
                            onSelect(id);
                          }}
                          register={(node) => {
                            if (node) nodes.current.set(step.id, node);
                            else nodes.current.delete(step.id);
                          }}
                        />
                        <div className={styles["workflow-connection-slot"]}>
                          <InsertMenu
                            definition={definition}
                            anchor={{ after: step }}
                            disabled={pending || atLimit}
                            onInsert={onInsert}
                            label={`Insert step after ${step.title || "Untitled step"} (position ${index + 2})`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}
            {!definition.steps.length ? (
              <p className={styles["workflow-empty"]}>Add an Agent step to start your workflow.</p>
            ) : null}
          </SortableContext>
        </DndContext>
      </div>
      <div className={styles["workflow-canvas-footer"]}>
        <div className={styles["workflow-canvas-controls"]}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            disabled={zoom <= 85}
            onClick={() => setZoom((value) => Math.max(85, value - 5))}
          >
            <MinusIcon />
          </Button>
          <output aria-label="Diagram zoom">{zoom}%</output>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            disabled={zoom >= 125}
            onClick={() => setZoom((value) => Math.min(125, value + 5))}
          >
            <PlusIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Show workflow overview"
            onClick={() => {
              reordered.current = null;
              revealTarget.current = "";
              onOverview();
              setZoom(100);
              viewport.current?.scrollTo({ top: 0 });
            }}
          >
            <MaximizeIcon />
          </Button>
        </div>
        <span className={styles["workflow-canvas-hint"]}>Select a step to edit its settings</span>
      </div>
    </section>
  );
}

function CanvasNode({
  step,
  index,
  selected,
  disabled,
  summary,
  warning,
  select,
  register,
}: {
  step: WorkflowStep;
  index: number;
  selected: boolean;
  disabled: boolean;
  summary: string;
  warning: string | undefined;
  select: (id: string) => void;
  register: (node: HTMLDivElement | null) => void;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, attributes, listeners, isDragging } =
    useSortable({ id: step.id, disabled });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        register(node);
      }}
      className={styles["workflow-node-wrap"]}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        disabled={disabled}
        className={styles["workflow-reorder-handle"]}
        aria-label={`Reorder ${step.title || "Untitled step"}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon />
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={styles["workflow-node"]}
              aria-pressed={selected}
              aria-label={`Step ${index + 1}: ${step.title || "Untitled step"}`}
              onClick={() => select(step.id)}
            />
          }
        >
          <span className={styles["workflow-node-icon"]} data-kind={step.kind}>
            {step.kind === "agent" ? (
              <BotIcon />
            ) : step.kind === "input" ? (
              <MessageSquareIcon />
            ) : (
              <UserRoundCheckIcon />
            )}
          </span>
          <span className={styles["workflow-node-copy"]}>
            <strong>{step.title || "Untitled step"}</strong>
            <span>{summary}</span>
          </span>
          <span className={styles["workflow-node-number"]}>{index + 1}</span>
          {warning ? (
            <AlertCircleIcon className={styles["workflow-node-warning"]} aria-label={warning}>
              <title>{warning}</title>
            </AlertCircleIcon>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup>
          {step.title || "Untitled step"}
          <p>{summary}</p>
          {warning ? <p>{warning}</p> : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function InsertMenu({
  definition,
  anchor,
  disabled,
  onInsert,
  label,
  toolbar = false,
}: {
  definition: WorkflowDefinition;
  anchor: WorkflowInsertion;
  disabled: boolean;
  onInsert: (anchor: WorkflowInsertion, kind: WorkflowStep["kind"]) => void;
  label: string;
  toolbar?: boolean;
}) {
  const [captured, setCaptured] = useState<WorkflowInsertion | null>(null);
  const inserted = useRef(false);
  const valid =
    captured !== null && workflowInsertionIndex(definition.steps, captured) !== null && !disabled;
  if (captured && !valid) setCaptured(null);
  return (
    <Menu
      open={valid}
      onOpenChange={(open) => {
        if (open) inserted.current = false;
        setCaptured(open ? anchor : null);
      }}
    >
      <MenuTrigger
        render={
          toolbar ? (
            <Button type="button" variant="outline" size="sm" />
          ) : (
            <button type="button" className={styles["workflow-insert"]} />
          )
        }
        disabled={disabled}
        aria-label={label}
      >
        <PlusIcon />
        {toolbar ? (
          <>
            {" "}
            Add a step
            <ChevronDownIcon />
          </>
        ) : null}
      </MenuTrigger>
      <MenuPopup finalFocus={() => !inserted.current}>
        {(["agent", "input", "review"] as const).map((kind) => (
          <MenuItem
            key={kind}
            onClick={() => {
              if (valid && captured) {
                inserted.current = true;
                onInsert(captured, kind);
              }
              setCaptured(null);
            }}
          >
            {kind === "agent" ? (
              <BotIcon />
            ) : kind === "input" ? (
              <MessageSquareIcon />
            ) : (
              <UserRoundCheckIcon />
            )}
            {kind === "agent" ? "Agent step" : kind === "input" ? "Human input" : "Human review"}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
