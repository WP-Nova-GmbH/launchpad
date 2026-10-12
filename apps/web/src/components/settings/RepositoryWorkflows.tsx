import { useAuth } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import { TurnId } from "@t3tools/contracts";
import type { RelayRepository, RelayOrganizationProject } from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  type RepositoryWorkflow,
  type RepositoryWorkflowJob,
  type RepositoryWorkflowJobSummary,
  type WorkflowDefinition,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { ArrowDownIcon, BotIcon, HandIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { randomUUID } from "../../lib/utils";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

export function WorkflowFlow({
  definition,
  job,
}: {
  definition: WorkflowDefinition;
  job?: RepositoryWorkflowJob;
}) {
  const status = job?.status;
  return (
    <ol className="space-y-2" aria-label="Workflow steps">
      <li className="rounded-lg border border-dashed p-3 text-sm">
        <PlayIcon className="mr-2 inline size-4" />
        Manual run
      </li>
      <li aria-hidden="true" className="flex justify-center text-muted-foreground">
        <ArrowDownIcon className="size-4" />
      </li>
      <li className="rounded-xl border bg-muted/30 p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Automatic work
        </p>
        <div className="flex items-center gap-2">
          <BotIcon className="size-4" />
          <span className="font-medium">{definition.steps[0].title}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {status === "preparing"
            ? "Preparing worktree and setup"
            : status === "running"
              ? "Agent is working"
              : job?.progress?.checkpoint
                ? "Result saved"
                : "Agent follows your instructions"}
        </p>
      </li>
      <li aria-hidden="true" className="flex justify-center text-muted-foreground">
        <ArrowDownIcon className="size-4" />
      </li>
      <li className="rounded-xl border border-warning/40 bg-warning-surface p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-warning-foreground">
          Human intervention
        </p>
        <div className="flex items-center gap-2">
          <HandIcon className="size-4" />
          <span className="font-medium">{definition.steps[1].title}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {status === "awaiting_review"
            ? "Waiting for a repository maintainer"
            : status === "done"
              ? "Approved"
              : "A repository maintainer reviews the saved result"}
        </p>
      </li>
    </ol>
  );
}

export function RepositoryWorkflows({
  repository,
  canConfigure,
}: {
  repository: RelayRepository;
  canConfigure: boolean;
}) {
  const { getToken } = useAuth();
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
    if (!job.progress) return;
    const ref = { environmentId: job.environmentId, threadId: job.progress.threadId };
    if (job.progress.checkpoint) {
      useDiffPanelStore.getState().selectTurn(ref, TurnId.make(job.progress.checkpoint.turnId));
      useRightPanelStore.getState().open(ref, "diff");
    }
    void navigate({ to: "/$environmentId/$threadId", params: ref });
  };
  const respond = (operation: "approve" | "cancel" | "retry_preparation" | "retry_cancellation") =>
    void perform(async () => {
      if (!selectedJob) return;
      const checkpoint = selectedJob.progress?.checkpoint;
      if (operation === "approve" && !checkpoint) return;
      const payload =
        operation === "approve"
          ? ({
              operation,
              checkpointId: checkpoint!.checkpointId,
              expectedRevision: selectedJob.progress!.revision,
            } as const)
          : operation === "retry_preparation" || operation === "retry_cancellation"
            ? { operation, expectedRevision: selectedJob.progress!.revision }
            : { operation };
      const next = await call((client, clerkToken) =>
        client.respondToWorkflowJob({
          clerkToken,
          repositoryId: repository.repositoryId,
          jobId: selectedJob.jobId,
          payload,
        }),
      );
      setSelectedJob(next);
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
                if (!targetConfirmed) return;
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
              <WorkflowFlow definition={draft.definition} />
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
                <label className="block space-y-1 text-sm">
                  <span>Agent step name</span>
                  <Input
                    required
                    maxLength={120}
                    value={draft.definition.steps[0].title}
                    onChange={(event) =>
                      patchDraft({
                        steps: [
                          { ...draft.definition.steps[0], title: event.target.value },
                          draft.definition.steps[1],
                        ],
                      })
                    }
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Agent instructions</span>
                  <Textarea
                    required
                    rows={5}
                    maxLength={32000}
                    value={draft.definition.steps[0].instruction}
                    onChange={(event) =>
                      patchDraft({
                        steps: [
                          { ...draft.definition.steps[0], instruction: event.target.value },
                          draft.definition.steps[1],
                        ],
                      })
                    }
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Review step name</span>
                  <Input
                    required
                    maxLength={120}
                    value={draft.definition.steps[1].title}
                    onChange={(event) =>
                      patchDraft({
                        steps: [
                          draft.definition.steps[0],
                          { ...draft.definition.steps[1], title: event.target.value },
                        ],
                      })
                    }
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" type="submit" disabled={busy || !targetConfirmed}>
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
              {selectedJob.detail ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {selectedJob.detail}
                </p>
              ) : null}
              {selectedJob.workflow ? (
                <WorkflowFlow definition={selectedJob.workflow.definition} job={selectedJob} />
              ) : null}
              <div className="flex flex-wrap gap-2">
                {selectedJob.progress ? (
                  <Button size="sm" variant="outline" onClick={() => openResult(selectedJob)}>
                    Inspect saved result and diff
                  </Button>
                ) : null}
                {canConfigure && selectedJob.status === "awaiting_review" ? (
                  <Button
                    size="sm"
                    disabled={busy || selectedJob.progress?.approvalPending}
                    onClick={() => respond("approve")}
                  >
                    {selectedJob.progress?.approvalPending
                      ? "Approval pending"
                      : selectedJob.progress?.retryableApproval
                        ? "Retry approval"
                        : "Approve result"}
                  </Button>
                ) : null}
                {canConfigure &&
                selectedJob.status === "paused" &&
                selectedJob.progress?.retryablePreparation ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => respond("retry_preparation")}
                  >
                    Retry preparation
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
