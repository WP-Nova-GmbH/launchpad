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
  UploadIcon,
  GitBranchIcon,
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
import {
  Fragment,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import {
  workflowPublishingPrerequisites,
  workflowZones,
  type WorkflowDefinition,
  isAutomaticWorkflowStep,
  type WorkflowStep,
} from "@t3tools/contracts/workflows";
import type { workflowModelState } from "../settings/workflowModels";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";

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
  addStepRef,
  triggerLabel = "Manual run",
  triggerSelected = false,
  triggerIssue,
  onTrigger,
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
  addStepRef?: Ref<HTMLButtonElement> | undefined;
  triggerLabel?: string;
  triggerSelected?: boolean;
  triggerIssue?: string | null | undefined;
  onTrigger?: () => void;
  selectedStepId: string;
  invalidStepId: string | null | undefined;
  models: ReturnType<typeof workflowModelState>;
  pending: boolean;
  onSelect: (id: string) => void;
  onReorder: (steps: ReadonlyArray<WorkflowStep>) => boolean;
  onInsert: (anchor: WorkflowInsertion, kind: WorkflowStep["kind"] | "open_pull_request") => void;
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
          triggerRef={addStepRef}
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
          <CanvasBadge
            description={
              triggerLabel === "Manual run" ? "Manual run" : "Manual run or a Linear event"
            }
          >
            Starts when
          </CanvasBadge>
          <button
            type="button"
            className={styles["workflow-start-marker"]}
            aria-label="Configure workflow trigger"
            aria-pressed={triggerSelected}
            onClick={onTrigger}
          >
            <PlayIcon size={14} />
            {triggerLabel}
            {triggerIssue ? <AlertCircleIcon size={14} aria-label={triggerIssue} /> : null}
          </button>
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
              const kind = isAutomaticWorkflowStep(zone[0]!) ? "agent" : zone[0]!.kind;
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
                        ? (models.triggerLabel(step) ??
                          models.effectiveSelection(step)?.model ??
                          "Project default")
                        : step.kind === "action"
                          ? step.action === "push"
                            ? "Commit and push branch"
                            : "Open pull request"
                          : step.role === "member"
                            ? "Repository members"
                            : "Maintainers";
                    return (
                      <div key={step.id} className={styles["workflow-canvas-row"]}>
                        {zoneIndex === 0 ? (
                          <CanvasBadge
                            description={
                              kind === "agent"
                                ? "Automatic steps continue the work"
                                : kind === "input"
                                  ? "Waits for an answer"
                                  : "Waits for approval"
                            }
                          >
                            {kind === "agent" ? (
                              <BotIcon aria-hidden />
                            ) : kind === "input" ? (
                              <MessageSquareIcon aria-hidden />
                            ) : (
                              <UserRoundCheckIcon aria-hidden />
                            )}
                            {kind === "agent"
                              ? "Automatic"
                              : kind === "input"
                                ? "Human input"
                                : "Human review"}
                          </CanvasBadge>
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
      </div>
    </section>
  );
}

function CanvasBadge({ children, description }: { children: ReactNode; description: string }) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const descriptionId = `${triggerId}-description`;

  return (
    <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
      <TooltipTrigger
        id={triggerId}
        closeOnClick={false}
        render={
          <button
            type="button"
            className={styles["workflow-zone-label"]}
            aria-describedby={descriptionId}
            onClick={() => setOpen(true)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <span id={descriptionId} hidden>
        {description}
      </span>
      <TooltipPopup>
        <span aria-hidden>{description}</span>
      </TooltipPopup>
    </Tooltip>
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
          <span className={styles["workflow-node-copy"]}>
            <strong>{step.title || "Untitled step"}</strong>
            <span>{summary}</span>
          </span>
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
      <button
        type="button"
        ref={setActivatorNodeRef}
        disabled={disabled}
        className={styles["workflow-reorder-handle"]}
        aria-label={`Reorder ${step.title || "Untitled step"}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon aria-hidden />
      </button>
    </div>
  );
}

function InsertMenu({
  definition,
  anchor,
  disabled,
  onInsert,
  label,
  triggerRef,
  toolbar = false,
}: {
  definition: WorkflowDefinition;
  anchor: WorkflowInsertion;
  disabled: boolean;
  onInsert: (anchor: WorkflowInsertion, kind: WorkflowStep["kind"] | "open_pull_request") => void;
  label: string;
  triggerRef?: Ref<HTMLButtonElement> | undefined;
  toolbar?: boolean;
}) {
  const contextId = useId();
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
        ref={triggerRef}
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
      <MenuPopup
        align={toolbar ? "start" : "center"}
        aria-describedby={contextId}
        className="w-[min(22rem,calc(100vw-2rem))]"
        finalFocus={() => !inserted.current}
      >
        <InsertStepOptions
          steps={definition.steps}
          anchor={captured ?? anchor}
          contextId={contextId}
          onChoose={(kind) => {
            if (valid && captured) {
              inserted.current = true;
              onInsert(captured, kind);
            }
            setCaptured(null);
          }}
        />
      </MenuPopup>
    </Menu>
  );
}

function InsertStepOptions({
  steps,
  anchor,
  contextId,
  onChoose,
}: {
  steps: ReadonlyArray<WorkflowStep>;
  anchor: WorkflowInsertion;
  contextId: string;
  onChoose: (kind: WorkflowStep["kind"] | "open_pull_request") => void;
}) {
  const index = workflowInsertionIndex(steps, anchor);
  if (index === null) return null;
  const previous = steps[index - 1];
  const { agent, push } = workflowPublishingPrerequisites(steps, index);
  const needsAgent = agent ? null : "Needs an earlier Agent step.";
  const options = [
    {
      kind: "agent",
      label: "Agent step",
      Icon: BotIcon,
      detail: "Run an agent with your instructions.",
      advisory: null,
    },
    {
      kind: "input",
      label: "Human input",
      Icon: MessageSquareIcon,
      detail: "Pause until someone answers a question.",
      advisory: null,
    },
    {
      kind: "review",
      label: "Human review",
      Icon: UserRoundCheckIcon,
      detail: "Pause for approval or requested changes.",
      advisory: needsAgent,
    },
    {
      kind: "action",
      label: "Push branch",
      Icon: GitBranchIcon,
      detail: "Commit changes and push the run branch.",
      advisory: needsAgent,
    },
    {
      kind: "open_pull_request",
      label: "Open PR",
      Icon: PullRequestGlyph.pullRequest,
      detail: push
        ? "Open a pull request from the pushed branch."
        : "Open a pull request on GitHub.",
      advisory: !agent
        ? "Needs an Agent followed by Push branch."
        : !push
          ? `Needs Push branch after step ${steps.indexOf(agent) + 1}.`
          : null,
    },
  ] as const;
  return (
    <>
      <div className="space-y-0.5 px-2 py-1.5">
        <p className="font-medium text-sm">Add a step</p>
        <div id={contextId} className="space-y-0.5 text-xs">
          <p className="text-muted-foreground">
            {previous ? `After step ${index}` : "After Trigger"}
          </p>
          {previous ? (
            <p className="wrap-anywhere">{previous.title.trim() || "Untitled step"}</p>
          ) : null}
        </div>
      </div>
      <MenuSeparator />
      {options.map(({ kind, label, Icon, detail, advisory }) => (
        <Fragment key={kind}>
          {kind === "action" ? <MenuSeparator /> : null}
          <MenuItem
            className="items-start"
            label={label}
            aria-label={label}
            aria-describedby={`${contextId}-${kind}`}
            onClick={() => onChoose(kind)}
          >
            <Icon aria-hidden className="mt-0.5" />
            <span className="grid min-w-0 gap-0.5 py-0.5">
              <span>{label}</span>
              <span id={`${contextId}-${kind}`} className="grid gap-0.5 text-xs">
                <span className="text-muted-foreground">{detail}</span>
                {advisory ? (
                  <span className="flex items-start gap-1 wrap-anywhere text-warning-foreground">
                    <AlertCircleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                    {advisory}
                  </span>
                ) : null}
              </span>
            </span>
          </MenuItem>
        </Fragment>
      ))}
    </>
  );
}
