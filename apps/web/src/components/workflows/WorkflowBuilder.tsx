import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow, WorkflowStep } from "@t3tools/contracts/workflows";
import {
  workflowSessionKey,
  workflowDraftIssue,
  workflowEditorDirty,
  updateWorkflowDrafts,
  workflowDraftAtom,
  startNewWorkflowDraft,
  sameWorkflowDefinition,
  type WorkflowScope,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { WorkflowFlow, WorkflowStepEditor } from "./WorkflowFlow";
import {
  useWorkflowDrafts,
  useWorkflowClient,
  useActiveWorkflowView,
  editWorkflowDraft,
  savedWorkflowDraft,
  newWorkflowDraft,
  saveWorkflowDraft,
  confirmWorkflow,
  workflowError,
} from "./workflowState";

type WorkflowBuilderProps = {
  scope: WorkflowScope;
  workflow: RepositoryWorkflow | undefined;
  workflowId?: string | undefined;
  isNew: boolean;
  projects: ReadonlyArray<RelayOrganizationProject>;
  canConfigure: boolean;
  call: ReturnType<typeof useWorkflowClient>;
  refresh: () => void;
};

export function WorkflowBuilder(props: WorkflowBuilderProps) {
  const state = useWorkflowDrafts();
  const id = props.isNew
    ? state.newWorkflowIds[workflowSessionKey(props.scope, "new")]
    : (props.workflowId ?? props.workflow?.workflowId);
  return (
    <WorkflowBuilderEditor
      key={workflowSessionKey(props.scope, `${props.isNew ? "new" : "edit"}:${id ?? ""}`)}
      {...props}
      id={id}
    />
  );
}

function WorkflowBuilderEditor({
  scope,
  workflow,
  isNew,
  projects,
  canConfigure,
  call,
  refresh,
  id,
}: WorkflowBuilderProps & { id: string | undefined }) {
  const navigate = useNavigate();
  const active = useActiveWorkflowView();
  const state = useWorkflowDrafts();
  const key = workflowSessionKey(scope, id ?? "missing");
  const draft = id ? state.editors[key] : undefined;
  const readRequest = useRef<{ draft: WorkflowEditorDraft } | null>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(
    () => () => {
      readRequest.current = null;
    },
    [],
  );
  const form = useRef<HTMLFormElement>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!canConfigure) return;
    if (isNew) {
      startNewWorkflowDraft(appAtomRegistry, scope, () => newWorkflowDraft(projects));
      return;
    }
    if (!id || !workflow) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) =>
      state.editors[key]
        ? state
        : { ...state, editors: { ...state.editors, [key]: savedWorkflowDraft(workflow) } },
    );
  }, [canConfigure, workflow, isNew, projects, scope, key, id]);
  useEffect(() => {
    if (!isNew || !id || !draft?.baseline || !active.current) return;
    const current = appAtomRegistry.get(workflowDraftAtom);
    if (
      current.accountId !== scope.accountId ||
      current.newWorkflowIds[workflowSessionKey(scope, "new")] !== id ||
      !current.editors[key]?.baseline
    )
      return;
    void navigate({
      to: "/workflows/$repositoryId/$workflowId/edit",
      params: { repositoryId: scope.repositoryId, workflowId: id },
      replace: true,
    });
  }, [isNew, id, draft?.baseline, active, scope, key, navigate]);
  useEffect(() => {
    if (!focusField) return;
    const target = form.current?.querySelector<HTMLElement>(
      '[data-workflow-field="' + focusField + '"]',
    );
    if (
      focusField !== "name" &&
      target?.closest("[data-workflow-step]")?.getAttribute("data-workflow-step") !==
        draft?.selectedStepId
    )
      return;
    target?.focus();
  }, [focusField, draft?.selectedStepId]);
  if (!canConfigure)
    return <p>Repository maintainers and organization admins can configure workflows.</p>;
  if (!draft)
    return (
      <p className="text-sm text-muted-foreground">
        {isNew
          ? "Enroll an organization machine with a checkout of this repository before creating a workflow."
          : "Workflow unavailable."}
      </p>
    );
  const pending = draft.operation?.state === "pending";
  const issue = workflowDraftIssue(draft.definition);
  const target = projects.find(
    (project) =>
      project.environmentId === draft.definition.environmentId &&
      project.projectId === draft.definition.projectId,
  );
  const targetLabel = draft.targetConfirmed
    ? target
      ? `${target.machineLabel} · ${target.title}`
      : "Saved execution target is unavailable"
    : "Choose an execution target";
  const edit = (update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft) =>
    editWorkflowDraft(scope, draft.workflowId, update);
  const save = async () => {
    const problem = workflowDraftIssue(draft.definition);
    if (problem) {
      edit((draft) => ({
        ...draft,
        selectedStepId: problem.stepId ?? draft.selectedStepId,
        error: problem.message,
      }));
      setFocusField(problem.field);
      return;
    }
    if (!draft.targetConfirmed) return;
    const saved = await saveWorkflowDraft(scope, draft.workflowId, (payload) =>
      call((client, token) =>
        client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
      ),
    );
    if (!saved || !active.current) return;
    refresh();
  };
  const beginRead = () => {
    const current = appAtomRegistry.get(workflowDraftAtom).editors[key];
    if (
      readRequest.current ||
      !active.current ||
      !current ||
      current.operation?.state === "pending"
    )
      return null;
    const request = { draft: current };
    readRequest.current = request;
    setReading(true);
    setNotice(null);
    return request;
  };
  const ownsRead = (request: NonNullable<typeof readRequest.current>) =>
    active.current &&
    readRequest.current === request &&
    appAtomRegistry.get(workflowDraftAtom).accountId === scope.accountId;
  const finishRead = (request: NonNullable<typeof readRequest.current>) => {
    if (readRequest.current !== request) return;
    readRequest.current = null;
    if (active.current) setReading(false);
  };
  const reload = async () => {
    const request = beginRead();
    if (!request) return;
    try {
      if (!(await confirmWorkflow("Discard unsaved edits and reload the saved workflow?"))) return;
      if (
        !ownsRead(request) ||
        appAtomRegistry.get(workflowDraftAtom).editors[key] !== request.draft
      )
        return;
      const definitions = await call((client, token) =>
        client.listWorkflows({ clerkToken: token, repositoryId: scope.repositoryId }),
      );
      if (!ownsRead(request)) return;
      const saved = definitions.find((entry) => entry.workflowId === request.draft.workflowId);
      let applied = false;
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
        if (!ownsRead(request) || state.editors[key] !== request.draft) return state;
        applied = true;
        return {
          ...state,
          editors: {
            ...state.editors,
            [key]: saved
              ? { ...savedWorkflowDraft(saved), selectedStepId: request.draft.selectedStepId }
              : {
                  ...request.draft,
                  error: "This workflow has no saved version yet. Your draft is retained.",
                },
          },
        };
      });
      if (!applied)
        setNotice("Your draft changed while reload was loading. Your current edits were kept.");
      else if (saved) refresh();
    } catch (cause) {
      if (ownsRead(request))
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) =>
          state.editors[key] === request.draft
            ? {
                ...state,
                editors: {
                  ...state.editors,
                  [key]: { ...request.draft, error: workflowError(cause) },
                },
              }
            : state,
        );
    } finally {
      finishRead(request);
    }
  };
  const reconcile = async () => {
    const request = beginRead();
    if (!request) return;
    const operation = request.draft.operation;
    if (operation?.state !== "uncertain") {
      finishRead(request);
      return;
    }
    try {
      const saved = (
        await call((client, token) =>
          client.listWorkflows({ clerkToken: token, repositoryId: scope.repositoryId }),
        )
      ).find((entry) => entry.workflowId === request.draft.workflowId);
      if (!ownsRead(request)) return;
      const matched =
        !!saved &&
        saved.revision === operation.expectedRevision + 1 &&
        saved.archived === operation.archived &&
        sameWorkflowDefinition(saved.definition, operation.definition);
      let applied = false;
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
        const current = state.editors[key];
        if (
          current?.operation?.requestId !== operation.requestId ||
          current.operation.state !== "uncertain"
        )
          return state;
        applied = true;
        return {
          ...state,
          editors: {
            ...state.editors,
            [key]: matched
              ? { ...current, baseline: saved!, operation: null, error: null }
              : {
                  ...current,
                  error: saved
                    ? "The saved version differs. Keep editing or reload it before saving."
                    : "Save could not be confirmed. Retry uses this same workflow ID.",
                },
          },
        };
      });
      if (applied && matched) refresh();
    } catch (cause) {
      if (ownsRead(request))
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
          const current = state.editors[key];
          return current?.operation?.requestId === operation.requestId &&
            current.operation.state === "uncertain"
            ? {
                ...state,
                editors: { ...state.editors, [key]: { ...current, error: workflowError(cause) } },
              }
            : state;
        });
    } finally {
      finishRead(request);
    }
  };
  const discard = async () => {
    const captured = appAtomRegistry.get(workflowDraftAtom).editors[key];
    if (!captured || captured.operation?.state === "pending") return;
    if (
      workflowEditorDirty(captured) &&
      !(await confirmWorkflow("Discard this workflow's unsaved changes?"))
    )
      return;
    if (!active.current || appAtomRegistry.get(workflowDraftAtom).editors[key] !== captured) return;
    // Leave the new route before removing its slot so its initializer cannot allocate a replacement.
    if (!captured.baseline)
      await navigate({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "workflows" },
      });
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      if (state.editors[key] !== captured) return state;
      if (captured.baseline)
        return {
          ...state,
          editors: { ...state.editors, [key]: savedWorkflowDraft(captured.baseline) },
        };
      const editors = { ...state.editors };
      const newWorkflowIds = { ...state.newWorkflowIds };
      delete editors[key];
      const slot = workflowSessionKey(scope, "new");
      if (newWorkflowIds[slot] === captured.workflowId) delete newWorkflowIds[slot];
      return { ...state, editors, newWorkflowIds };
    });
  };
  const archive = async () => {
    const captured = appAtomRegistry.get(workflowDraftAtom).editors[key];
    const baseline = captured?.baseline;
    if (!captured || !baseline || captured.operation?.state === "pending") return;
    if (
      workflowEditorDirty(captured) &&
      !(await confirmWorkflow(
        "Discard unsaved edits before changing this workflow's archive state?",
      ))
    )
      return;
    if (!active.current || appAtomRegistry.get(workflowDraftAtom).editors[key] !== captured) return;
    edit(() => savedWorkflowDraft(baseline));
    if (
      await saveWorkflowDraft(
        scope,
        captured.workflowId,
        (payload) =>
          call((client, token) =>
            client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
          ),
        !baseline.archived,
      )
    )
      refresh();
  };
  const insert = (index: number, kind: WorkflowStep["kind"]) => {
    const stepId = randomUUID();
    const step: WorkflowStep =
      kind === "agent"
        ? {
            id: stepId,
            kind,
            title: "Agent",
            instruction: "Implement the requested change and verify it.",
            modelSelection: null,
          }
        : kind === "input"
          ? {
              id: stepId,
              kind,
              title: "Human input",
              question: "What should the agent know before continuing?",
              role: "member",
            }
          : { id: stepId, kind, title: "Review changes", role: "maintainer" };
    edit((draft) =>
      draft.definition.steps.length >= 32
        ? draft
        : {
            ...draft,
            selectedStepId: stepId,
            definition: {
              ...draft.definition,
              steps: [
                ...draft.definition.steps.slice(0, index),
                step,
                ...draft.definition.steps.slice(index),
              ],
            },
          },
    );
  };
  return (
    <form
      ref={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-5"
    >
      <fieldset disabled={pending} className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-3">
            <label className="block max-w-xl space-y-1">
              <span className="text-xs text-muted-foreground">Workflow name</span>
              <Input
                aria-label="Workflow name"
                data-workflow-field="name"
                maxLength={120}
                value={draft.definition.name}
                onChange={(event) =>
                  edit((draft) => ({
                    ...draft,
                    definition: { ...draft.definition, name: event.target.value },
                  }))
                }
              />
            </label>
            <div className="max-w-xl space-y-1">
              <p className="text-xs text-muted-foreground">Execution target</p>
              <Select
                value={
                  draft.targetConfirmed
                    ? `${draft.definition.environmentId}:${draft.definition.projectId}`
                    : null
                }
                onValueChange={(value) => {
                  const target = projects.find(
                    (entry) => `${entry.environmentId}:${entry.projectId}` === value,
                  );
                  if (target)
                    edit((draft) => ({
                      ...draft,
                      targetConfirmed: true,
                      definition: {
                        ...draft.definition,
                        environmentId: target.environmentId,
                        projectId: target.projectId,
                      },
                    }));
                }}
              >
                <SelectTrigger aria-label="Execution target">
                  <SelectValue>{targetLabel}</SelectValue>
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
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground" role="status">
              {pending
                ? "Saving…"
                : draft.operation
                  ? "Save unconfirmed"
                  : workflowEditorDirty(draft)
                    ? "Unsaved changes"
                    : "Saved"}
            </span>
            <Button type="submit" disabled={!draft.targetConfirmed}>
              {draft.operation?.state === "uncertain" ? "Retry save" : "Save"}
            </Button>
          </div>
        </div>
        {draft.error || draft.operation?.state === "uncertain" ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">
              {draft.error ??
                "Save could not be confirmed. Check the saved version before retrying."}
            </p>
            <div className="flex flex-wrap gap-2">
              {!draft.operation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => edit((current) => ({ ...current, error: null }))}
                >
                  Keep editing
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reading}
                onClick={() => void reload()}
              >
                Reload saved version
              </Button>
              {draft.operation?.state === "uncertain" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={reading}
                  onClick={() => void reconcile()}
                >
                  Check saved version
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {issue ? (
          <p role="alert" className="text-sm text-warning">
            {issue.message}
          </p>
        ) : null}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
          <section aria-label="Workflow sequence">
            <WorkflowFlow
              definition={draft.definition}
              selectedStepId={draft.selectedStepId}
              invalidStepId={issue?.stepId}
              onSelect={(id) => edit((draft) => ({ ...draft, selectedStepId: id }))}
              onReorder={
                pending
                  ? undefined
                  : (steps) =>
                      edit((draft) => ({ ...draft, definition: { ...draft.definition, steps } }))
              }
              onInsert={pending ? undefined : insert}
            />
          </section>
          <aside
            aria-label="Selected step settings"
            data-workflow-step={draft.selectedStepId}
            className="min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
          >
            <WorkflowStepEditor
              definition={draft.definition}
              selectedId={draft.selectedStepId}
              select={(id) => edit((draft) => ({ ...draft, selectedStepId: id }))}
              change={(steps) =>
                edit((draft) => ({ ...draft, definition: { ...draft.definition, steps } }))
              }
            />
          </aside>
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" variant="ghost" onClick={() => void discard()}>
            Discard changes
          </Button>
          {draft.baseline ? (
            <Button type="button" variant="ghost" onClick={() => void archive()}>
              {draft.baseline.archived ? "Restore workflow" : "Archive workflow"}
            </Button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
