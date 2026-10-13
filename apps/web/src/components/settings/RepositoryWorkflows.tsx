import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  clearAcknowledgedWorkflowDraft,
  workflowManualControlState,
  workflowManualSubmission,
  type WorkflowManualSubmission,
} from "@t3tools/client-runtime/relay/workflow-responses";
import { TurnId } from "@t3tools/contracts";
import type { RelayRepository, RelayOrganizationProject } from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  workflowDefinitionError,
  workflowZones,
  type WorkflowStep,
  type RepositoryWorkflow,
  type RepositoryWorkflowJob,
  type RepositoryWorkflowJobSummary,
  type WorkflowDefinition,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { ArrowDownIcon, BotIcon, GripVerticalIcon, HandIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { randomUUID } from "../../lib/utils";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject } from "../../state/entities";
import { workflowModelState } from "./workflowModels";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

export function WorkflowFlow({
  definition,
  job,
  selectedStepId,
  onSelect,
  onReorder,
}: {
  definition: WorkflowDefinition;
  job?: RepositoryWorkflowJob;
  selectedStepId?: string | undefined;
  onSelect?: (id: string) => void;
  onReorder?: (steps: ReadonlyArray<WorkflowStep>) => void;
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
        <ol className="space-y-2" aria-label="Workflow steps">
          <li className="rounded-lg border border-dashed p-3 text-sm">
            <PlayIcon className="mr-2 inline size-4" />
            Manual run
          </li>
          {workflowZones(definition.steps).map((zone) => (
            <li key={zone[0]!.id}>
              <div aria-hidden="true" className="mb-2 flex justify-center text-muted-foreground">
                <ArrowDownIcon className="size-4" />
              </div>
              <div
                className={
                  zone[0]!.kind === "agent"
                    ? "rounded-xl border bg-muted/30 p-4"
                    : "rounded-xl border border-warning/40 bg-warning-surface p-4"
                }
              >
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {zone[0]!.kind === "agent" ? "Automatic work" : "Human intervention"}
                </p>
                {zone.map((step) => {
                  const progress = job?.progress?.steps?.find((entry) => entry.stepId === step.id);
                  return (
                    <SortableWorkflowStep
                      key={step.id}
                      id={step.id}
                      title={step.title}
                      enabled={!!onReorder}
                    >
                      <div className="flex items-center gap-2">
                        {step.kind === "agent" ? (
                          <BotIcon className="size-4" />
                        ) : (
                          <HandIcon className="size-4" />
                        )}
                        {onSelect ? (
                          <Button
                            type="button"
                            size="sm"
                            variant={selectedStepId === step.id ? "secondary" : "ghost"}
                            onClick={() => onSelect(step.id)}
                          >
                            {step.title || step.kind}
                          </Button>
                        ) : (
                          <span className="font-medium">{step.title}</span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {progress
                          ? progress.status
                          : step.kind === "agent"
                            ? "Agent follows your instructions"
                            : `${step.kind === "input" ? "Input" : "Review"} by ${step.role === "member" ? "any repository member" : "a repository maintainer"}`}
                      </p>
                    </SortableWorkflowStep>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
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
  children: React.ReactNode;
}) {
  const { setNodeRef, transform, transition, attributes, listeners } = useSortable({
    id,
    disabled: !enabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition,
      }}
      className="flex items-start gap-2 py-1"
    >
      {enabled ? (
        <button
          type="button"
          aria-label={`Reorder ${title}`}
          className="mt-1 cursor-grab touch-none rounded p-1 focus-visible:outline-2"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

function WorkflowStepEditor({
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
  const add = (kind: WorkflowStep["kind"]) => {
    const id = randomUUID();
    const added: WorkflowStep =
      kind === "agent"
        ? {
            id,
            kind,
            title: "Agent",
            instruction: "Implement the requested change and verify it.",
            modelSelection: null,
          }
        : kind === "input"
          ? {
              id,
              kind,
              title: "Human input",
              question: "What should the agent know before continuing?",
              role: "member",
            }
          : { id, kind, title: "Review changes", role: "maintainer" };
    change([...definition.steps, added]);
    select(id);
  };
  const validation = workflowDefinitionError(definition.steps);
  const triggerLabel = step?.kind === "agent" ? models.triggerLabel(step) : undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(["agent", "review", "input"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="outline"
            disabled={definition.steps.length >= 32}
            onClick={() => add(kind)}
          >
            Add {kind}
          </Button>
        ))}
      </div>
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
                  <SelectValue />
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
                <SelectTrigger aria-label="Rework target">
                  <SelectValue />
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

export function RepositoryWorkflows({
  repository,
  canConfigure,
}: {
  repository: RelayRepository;
  canConfigure: boolean;
}) {
  const { getToken, userId } = useAuth();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [workflows, setWorkflows] = useState<ReadonlyArray<RepositoryWorkflow>>([]);
  const [jobs, setJobs] = useState<ReadonlyArray<RepositoryWorkflowJobSummary>>([]);
  const [projects, setProjects] = useState<ReadonlyArray<RelayOrganizationProject>>([]);
  const [targetConfirmed, setTargetConfirmed] = useState(false);
  const [draft, setDraft] = useState<RepositoryWorkflow | null>(null);
  const [selectedJob, setSelectedJob] = useState<RepositoryWorkflowJob | null>(null);
  const [runWorkflow, setRunWorkflow] = useState<RepositoryWorkflow | null>(null);
  const [instruction, setInstruction] = useState("");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const manualIntent = useRef<WorkflowManualSubmission | null>(null);
  const manualState = workflowManualControlState(selectedJob);
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const call = useCallback(
    async <A,>(
      operation: (
        client: Client,
        clerkToken: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ) => {
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token) throw new Error("Sign in to Launchpad Connect to use workflows.");
      const result = await runtime.runPromiseExit(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => operation(client, token)),
        ),
      );
      if (Exit.isFailure(result)) throw Cause.squash(result.cause);
      return result.value;
    },
    [getToken],
  );
  const load = useCallback(async () => {
    const [definitions, jobList, catalog] = await Promise.all([
      call((client, clerkToken) =>
        client.listWorkflows({ clerkToken, repositoryId: repository.repositoryId }),
      ),
      call((client, clerkToken) =>
        client.listWorkflowJobs({ clerkToken, repositoryId: repository.repositoryId }),
      ),
      call((client, clerkToken) => client.listOrganizationProjects({ clerkToken })),
    ]);
    if (!mounted.current) return;
    setWorkflows(definitions);
    setJobs(jobList);
    setProjects(
      catalog.filter(
        (project) =>
          project.repositoryCanonicalKey !== null &&
          repository.canonicalKeys.includes(project.repositoryCanonicalKey),
      ),
    );
    setLoaded(true);
  }, [call, repository]);
  const perform = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The workflow request failed. Your draft has been retained.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (expanded)
      void load().catch((cause) => {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Could not load workflows.");
      });
  }, [expanded, load]);
  const selectedJobId = selectedJob?.jobId;
  const selectedJobStatus = selectedJob?.status;
  useEffect(() => {
    if (
      !expanded ||
      !selectedJobId ||
      !selectedJobStatus ||
      isTerminalWorkflowJob(selectedJobStatus)
    )
      return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await call((client, clerkToken) =>
          client.getWorkflowJob({
            clerkToken,
            repositoryId: repository.repositoryId,
            jobId: selectedJobId,
          }),
        );
        if (!disposed) {
          setSelectedJob(next);
          setJobs((previous) => previous.map((job) => (job.jobId === next.jobId ? next : job)));
        }
      } catch {
        /* Keep the last acknowledged state during a disconnect. */
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [expanded, selectedJobId, selectedJobStatus, call, repository.repositoryId]);
  const patchDraft = (update: Partial<WorkflowDefinition>) =>
    setDraft((previous) =>
      previous ? { ...previous, definition: { ...previous.definition, ...update } } : previous,
    );
  const create = () => {
    const target = projects[0];
    if (!target) {
      setError("Enroll an organization environment with a checkout of this repository first.");
      return;
    }
    setSelectedStepId(null);
    setTargetConfirmed(projects.length === 1);
    setSelectedJob(null);
    setRunWorkflow(null);
    setDraft({
      workflowId: randomUUID(),
      organizationId: repository.organizationId,
      repositoryId: repository.repositoryId,
      revision: 0,
      archived: false,
      createdAt: "",
      updatedAt: "",
      definition: {
        name: "New workflow",
        environmentId: target.environmentId,
        projectId: target.projectId,
        steps: [
          {
            id: "agent",
            kind: "agent",
            title: "Agent",
            instruction: "Implement the requested change and verify it.",
            modelSelection: null,
          },
          { id: "review", kind: "review", title: "Review changes", role: "maintainer" },
        ],
      },
    });
  };
  const openResult = (job: RepositoryWorkflowJob) => {
    if (!job.progress || job.progress.hasThread === false) return;
    const ref = { environmentId: job.environmentId, threadId: job.progress.threadId };
    if (job.progress.checkpoint && job.progress.checkpoint.kind !== "input") {
      useDiffPanelStore.getState().selectTurn(ref, TurnId.make(job.progress.checkpoint.turnId));
      useRightPanelStore.getState().open(ref, "diff");
    }
    void navigate({ to: "/$environmentId/$threadId", params: ref });
  };
  const respond = (
    operation:
      | "approve"
      | "input"
      | "request_changes"
      | "cancel"
      | "retry_preparation"
      | "retry_cancellation"
      | "pause"
      | "resume",
  ) =>
    void perform(async () => {
      if (!selectedJob) return;
      const checkpoint = selectedJob.progress?.checkpoint;
      if (["approve", "input", "request_changes"].includes(operation) && !checkpoint) return;
      if (operation === "pause" || operation === "resume")
        manualIntent.current = workflowManualSubmission(
          manualIntent.current,
          selectedJob,
          operation,
          randomUUID,
        );
      const payload =
        operation === "pause" || operation === "resume"
          ? manualIntent.current!.control
          : operation === "input" || operation === "request_changes"
            ? {
                operation,
                checkpointId: checkpoint!.checkpointId,
                expectedRevision: selectedJob.progress!.revision,
                text: responseDrafts[checkpoint!.checkpointId] ?? "",
              }
            : operation === "approve"
              ? ({
                  operation,
                  checkpointId: checkpoint!.checkpointId,
                  expectedRevision: selectedJob.progress!.revision,
                } as const)
              : operation === "retry_preparation" || operation === "retry_cancellation"
                ? { operation, expectedRevision: selectedJob.progress!.revision }
                : { operation };
      const submitted = {
        checkpointId: checkpoint?.checkpointId ?? null,
        operation,
        userId,
        text: "text" in payload ? (payload.text ?? null) : null,
      };
      const next = await call((client, clerkToken) =>
        client.respondToWorkflowJob({
          clerkToken,
          repositoryId: repository.repositoryId,
          jobId: selectedJob.jobId,
          payload,
        }),
      );
      setSelectedJob(next);
      setResponseDrafts((previous) =>
        clearAcknowledgedWorkflowDraft(previous, submitted, next.progress),
      );
      await load();
    });
  return (
    <div className="space-y-3 border-t pt-3">
      <Button
        size="sm"
        variant="outline"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        Workflows and jobs
      </Button>
      {expanded ? (
        <div className="space-y-4">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(load)}>
              Refresh
            </Button>
            {canConfigure ? (
              <Button size="sm" disabled={busy || !loaded} onClick={create}>
                Create workflow
              </Button>
            ) : null}
          </div>
          {!loaded ? (
            <p className="text-sm text-muted-foreground">Loading workflows…</p>
          ) : workflows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create a workflow to run an agent and pause for human review.
            </p>
          ) : (
            workflows.map((workflow) => (
              <div
                key={workflow.workflowId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <span className="font-medium">
                  {workflow.definition.name}
                  {workflow.archived ? " · Archived" : ""}
                </span>
                <div className="flex gap-2">
                  {canConfigure ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelectedStepId(null);
                        setTargetConfirmed(true);
                        setDraft(workflow);
                        setSelectedJob(null);
                        setRunWorkflow(null);
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={workflow.archived || busy}
                    onClick={() => {
                      setRunWorkflow(workflow);
                      setDraft(null);
                      setSelectedJob(null);
                      setInstruction("");
                    }}
                  >
                    Run
                  </Button>
                </div>
              </div>
            ))
          )}
          {draft ? (
            <form
              className="grid gap-4 rounded-xl border p-4 lg:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!targetConfirmed || workflowDefinitionError(draft.definition.steps)) return;
                void perform(async () => {
                  const saved = await call((client, clerkToken) =>
                    client.saveWorkflow({
                      clerkToken,
                      repositoryId: repository.repositoryId,
                      payload: {
                        workflowId: draft.workflowId,
                        expectedRevision: draft.revision,
                        definition: draft.definition,
                        archived: draft.archived,
                      },
                    }),
                  );
                  setDraft(saved);
                  await load();
                });
              }}
            >
              <WorkflowFlow
                definition={draft.definition}
                selectedStepId={selectedStepId ?? draft.definition.steps[0]?.id}
                onSelect={setSelectedStepId}
                onReorder={(steps) => patchDraft({ steps })}
              />
              <div className="space-y-3">
                <label className="block space-y-1 text-sm">
                  <span>Workflow name</span>
                  <Input
                    required
                    maxLength={120}
                    value={draft.definition.name}
                    onChange={(event) => patchDraft({ name: event.target.value })}
                  />
                </label>
                <div className="space-y-1">
                  <p className="text-sm">Execution environment and project</p>
                  <Select
                    value={
                      targetConfirmed
                        ? `${draft.definition.environmentId}:${draft.definition.projectId}`
                        : null
                    }
                    onValueChange={(value) => {
                      const project = projects.find(
                        (entry) => `${entry.environmentId}:${entry.projectId}` === value,
                      );
                      if (project) {
                        setTargetConfirmed(true);
                        patchDraft({
                          environmentId: project.environmentId,
                          projectId: project.projectId,
                        });
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Execution environment and project">
                      <SelectValue placeholder="Choose an environment and project" />
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((project) => (
                        <SelectItem
                          key={`${project.environmentId}:${project.projectId}`}
                          value={`${project.environmentId}:${project.projectId}`}
                        >
                          {project.machineLabel} · {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Runs in its own worktree, using the project's default Codex or Claude model and
                    setup.
                  </p>
                </div>
                <WorkflowStepEditor
                  definition={draft.definition}
                  selectedId={selectedStepId}
                  select={setSelectedStepId}
                  change={(steps) => patchDraft({ steps })}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="submit"
                    disabled={
                      busy || !targetConfirmed || !!workflowDefinitionError(draft.definition.steps)
                    }
                  >
                    Save workflow
                  </Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>
                    Close editor
                  </Button>
                  {draft.revision > 0 ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const saved = await call((client, clerkToken) =>
                            client.saveWorkflow({
                              clerkToken,
                              repositoryId: repository.repositoryId,
                              payload: {
                                workflowId: draft.workflowId,
                                expectedRevision: draft.revision,
                                definition: draft.definition,
                                archived: !draft.archived,
                              },
                            }),
                          );
                          setDraft(saved);
                          await load();
                        })
                      }
                    >
                      {draft.archived ? "Restore" : "Archive"}
                    </Button>
                  ) : null}
                </div>
              </div>
            </form>
          ) : null}
          {runWorkflow ? (
            <form
              className="space-y-3 rounded-lg border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const job = await call((client, clerkToken) =>
                    client.runWorkflow({
                      clerkToken,
                      repositoryId: repository.repositoryId,
                      payload: { workflowId: runWorkflow.workflowId, instruction },
                    }),
                  );
                  setSelectedJob(job);
                  setRunWorkflow(null);
                  await load();
                });
              }}
            >
              <p className="font-medium">Run {runWorkflow.definition.name}</p>
              <label className="block space-y-1 text-sm">
                <span>What should this run accomplish?</span>
                <Textarea
                  required
                  rows={3}
                  maxLength={32000}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  Run workflow
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRunWorkflow(null)}
                >
                  Close
                </Button>
              </div>
            </form>
          ) : null}
          {jobs.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Repository jobs</h4>
              {jobs.map((job) => (
                <div
                  key={job.jobId}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{job.instruction}</p>
                    <p className="text-xs text-muted-foreground">
                      {job.status.replaceAll("_", " ")} · {new Date(job.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void perform(async () => {
                        setDraft(null);
                        setRunWorkflow(null);
                        setSelectedJob(
                          await call((client, clerkToken) =>
                            client.getWorkflowJob({
                              clerkToken,
                              repositoryId: repository.repositoryId,
                              jobId: job.jobId,
                            }),
                          ),
                        );
                      })
                    }
                  >
                    View
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {selectedJob ? (
            <section aria-label="Job detail" className="space-y-3 rounded-xl border p-4">
              <div className="flex justify-between gap-2">
                <h4 className="font-medium">
                  {selectedJob.workflow?.definition.name ?? "Queued workflow"}
                </h4>
                <Button size="sm" variant="ghost" onClick={() => setSelectedJob(null)}>
                  Close
                </Button>
              </div>
              <p className="text-sm">{selectedJob.instruction}</p>
              <p className="text-sm font-medium">{selectedJob.status.replaceAll("_", " ")}</p>
              {manualState.message ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {manualState.message}
                </p>
              ) : null}
              {selectedJob.progress?.manualPause?.state === "paused" ? (
                <p className="text-sm text-muted-foreground">
                  Next: {manualState.status?.replaceAll("_", " ")}
                </p>
              ) : null}
              {selectedJob.detail ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {selectedJob.detail}
                </p>
              ) : null}
              {selectedJob.workflow ? (
                <WorkflowFlow definition={selectedJob.workflow.definition} job={selectedJob} />
              ) : null}
              {(manualState.status === "awaiting_input" ||
                manualState.status === "awaiting_review") &&
              (canConfigure || selectedJob.progress?.checkpoint?.role === "member") &&
              selectedJob.progress?.checkpoint &&
              !selectedJob.progress.approvalPending ? (
                <div className="space-y-2">
                  <label className="block space-y-1 text-sm">
                    <span>
                      {selectedJob.progress?.checkpoint?.kind === "input"
                        ? selectedJob.progress.checkpoint.question
                        : "Feedback for requested changes"}
                    </span>
                    <Textarea
                      rows={3}
                      maxLength={8000}
                      value={responseDrafts[selectedJob.progress!.checkpoint!.checkpointId] ?? ""}
                      onChange={(event) =>
                        setResponseDrafts((previous) => ({
                          ...previous,
                          [selectedJob.progress!.checkpoint!.checkpointId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      manualState.checkpointBlocked ||
                      !(responseDrafts[selectedJob.progress!.checkpoint!.checkpointId] ?? "").trim()
                    }
                    onClick={() =>
                      respond(manualState.status === "awaiting_input" ? "input" : "request_changes")
                    }
                  >
                    {manualState.status === "awaiting_input" ? "Submit answer" : "Request changes"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Your draft is kept until the environment acknowledges it.
                  </p>
                </div>
              ) : null}
              {selectedJob.progress?.responses?.length ? (
                <details>
                  <summary className="text-sm font-medium">Recent checkpoint history</summary>
                  <ol className="mt-2 space-y-2">
                    {selectedJob.progress.responses.map((response) => (
                      <li key={response.checkpointId} className="rounded-lg border p-2 text-sm">
                        <p>
                          {selectedJob.workflow?.definition.steps.find(
                            (step) => step.id === response.stepId,
                          )?.title ?? response.stepId}{" "}
                          · {response.operation.replaceAll("_", " ")} · attempt{" "}
                          {response.generation + 1}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {response.userId} · {new Date(response.createdAt).toLocaleString()}
                        </p>
                        {response.text ? (
                          <p className="whitespace-pre-wrap">{response.text}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {selectedJob.progress && selectedJob.progress.hasThread !== false ? (
                  <Button size="sm" variant="outline" onClick={() => openResult(selectedJob)}>
                    {selectedJob.progress.checkpoint?.kind === "input" ||
                    !selectedJob.progress.checkpoint
                      ? "Inspect agent conversation"
                      : "Inspect saved result and diff"}
                  </Button>
                ) : null}
                {(canConfigure || selectedJob.progress?.checkpoint?.role === "member") &&
                (manualState.status === "awaiting_review" ||
                  (canConfigure &&
                    selectedJob.status === "finishing" &&
                    selectedJob.progress?.retryableApproval)) ? (
                  <Button
                    size="sm"
                    disabled={
                      busy || manualState.checkpointBlocked || selectedJob.progress?.approvalPending
                    }
                    onClick={() => respond("approve")}
                  >
                    {selectedJob.progress?.approvalPending
                      ? "Approval pending"
                      : selectedJob.progress?.retryableApproval
                        ? selectedJob.status === "finishing"
                          ? "Retry completion"
                          : "Retry approval"
                        : "Approve result"}
                  </Button>
                ) : null}
                {canConfigure &&
                manualState.status === "paused" &&
                selectedJob.progress?.retryablePreparation ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || manualState.checkpointBlocked}
                    onClick={() => respond("retry_preparation")}
                  >
                    Retry preparation
                  </Button>
                ) : null}
                {canConfigure && (manualState.canPause || manualState.canResume) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => respond(manualState.canResume ? "resume" : "pause")}
                  >
                    {manualState.canResume ? "Resume workflow" : "Pause workflow"}
                  </Button>
                ) : null}
                {canConfigure && !isTerminalWorkflowJob(selectedJob.status) ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={
                      busy ||
                      (selectedJob.status === "cancelling" &&
                        !selectedJob.progress?.retryableCancellation)
                    }
                    onClick={() =>
                      respond(selectedJob.status === "cancelling" ? "retry_cancellation" : "cancel")
                    }
                  >
                    {selectedJob.status === "cancelling"
                      ? selectedJob.progress?.retryableCancellation
                        ? "Retry cancellation"
                        : "Cancellation pending"
                      : "Cancel job"}
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
