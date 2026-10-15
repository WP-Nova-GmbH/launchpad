import { RepositorySourcesButton } from "./WorkflowSources";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import styles from "./workflowEditor.module.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { WorkflowStepEditor, useWorkflowEditorModels } from "./WorkflowStepEditor";
import { WorkflowCanvas, workflowInsertionIndex, type WorkflowInsertion } from "./WorkflowCanvas";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Settings2Icon, XIcon, PlayIcon, MonitorIcon, ChevronDownIcon } from "lucide-react";

import {
  useWorkflowDrafts,
  useWorkflowClient,
  useActiveWorkflowView,
  editWorkflowDraft,
  selectWorkflowStep,
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
  const archived =
    workflow && draft.baseline && workflow.revision > draft.baseline.revision
      ? workflow.archived
      : !!draft.baseline?.archived;
  const issue = workflowDraftIssue(draft.definition);
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
              ? {
                  ...savedWorkflowDraft(saved),
                  selectedStepId: saved.definition.steps.some(
                    (step) => step.id === request.draft.selectedStepId,
                  )
                    ? request.draft.selectedStepId
                    : "",
                }
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
    if (!captured || captured.operation) return;
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
    if (!captured || !baseline || captured.operation) return;
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
  const insert = (anchor: WorkflowInsertion, kind: WorkflowStep["kind"] | "open_pull_request") => {
    const stepId = randomUUID();
    const step: WorkflowStep =
      kind === "action" || kind === "open_pull_request"
        ? {
            id: stepId,
            kind: "action",
            title: kind === "open_pull_request" ? "Open PR" : "Push branch",
            action: kind === "open_pull_request" ? "open_pull_request" : "push",
          }
        : kind === "agent"
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
    let inserted = false;
    edit((draft) => {
      const index = workflowInsertionIndex(draft.definition.steps, anchor);
      if (index === null || draft.definition.steps.length >= 32) return draft;
      inserted = true;
      return {
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
      };
    });
    return inserted ? stepId : null;
  };
  return (
    <WorkflowBuilderWorkspace
      draft={draft}
      projects={projects}
      pending={pending}
      archived={archived}
      reading={reading}
      notice={notice}
      issue={issue}
      edit={edit}
      select={(selectedId) => selectWorkflowStep(scope, draft.workflowId, selectedId)}
      insert={insert}
      save={save}
      reload={reload}
      reconcile={reconcile}
      discard={discard}
      archive={archive}
      scope={scope}
    />
  );
}

type WorkflowFieldFocus = {
  field: string;
  stepId: string | null;
  selection?: {
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
    scrollTop: number;
  };
};

function WorkflowBuilderWorkspace({
  draft,
  projects,
  pending,
  archived,
  reading,
  notice,
  issue,
  edit,
  select,
  insert,
  save,
  reload,
  reconcile,
  discard,
  archive,
  scope,
}: {
  draft: WorkflowEditorDraft;
  projects: ReadonlyArray<RelayOrganizationProject>;
  pending: boolean;
  archived: boolean;
  reading: boolean;
  notice: string | null;
  issue: ReturnType<typeof workflowDraftIssue>;
  edit: (update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft) => void;
  select: (id: string) => void;
  insert: (
    anchor: WorkflowInsertion,
    kind: WorkflowStep["kind"] | "open_pull_request",
  ) => string | null;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  reconcile: () => Promise<void>;
  discard: () => Promise<void>;
  archive: () => Promise<void>;
  scope: WorkflowScope;
}) {
  const navigate = useNavigate();
  const models = useWorkflowEditorModels(draft.definition);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Measure before mounting a panel so a retained desktop selection never opens a transient Sheet.
  const [docked, setDocked] = useState<boolean | null>(null);
  const focusRequest = useRef<WorkflowFieldFocus | null>(null);
  const [focusVersion, setFocusVersion] = useState(0);
  const focusEpoch = useRef(0);
  const [movementVersion, setMovementVersion] = useState(0);
  const presentation = useRef<boolean | null>(null);
  const panelIdentity = useRef<string | null>(null);
  const sheetReady = useRef(false);
  const mounted = useRef(true);
  const workspace = useRef<HTMLFormElement>(null);
  const fields = useRef(new Map<string, HTMLElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const selected = draft.definition.steps.find((step) => step.id === draft.selectedStepId);
  const panelOpen = settingsOpen || !!selected;
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
  const registerField = useCallback((field: string, node: HTMLElement | null) => {
    if (node) fields.current.set(field, node);
    else fields.current.delete(field);
  }, []);
  const panelKey = settingsOpen ? "workflow" : selected ? `step:${selected.id}` : null;
  const setFocusRequest = (request: WorkflowFieldFocus | null) => {
    focusRequest.current = request;
    setFocusVersion(++focusEpoch.current);
  };
  const focusPending = useCallback(() => {
    const request = focusRequest.current;
    if (!mounted.current || !request) return false;
    const expectedPanel = request.stepId ? `step:${request.stepId}` : "workflow";
    if (request.field !== "name" && panelIdentity.current !== expectedPanel) {
      focusRequest.current = null;
      return false;
    }
    const key = request.stepId ? `${request.stepId}:${request.field}` : request.field;
    const node = fields.current.get(key);
    focusRequest.current = null;
    if (!node?.isConnected || node.matches(":disabled")) return false;
    node.focus({ preventScroll: true });
    if (
      request.selection &&
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
    ) {
      node.setSelectionRange(
        request.selection.start,
        request.selection.end,
        request.selection.direction,
      );
      node.scrollTop = request.selection.scrollTop;
    }
    return true;
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      focusRequest.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (focusVersion !== focusEpoch.current) return;
    panelIdentity.current = panelKey;
    if (!panelOpen) sheetReady.current = false;
    if (docked === true || !panelOpen || sheetReady.current) focusPending();
  }, [panelKey, panelOpen, docked, focusVersion, focusPending]);
  useLayoutEffect(() => {
    if (!workspace.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = (entry?.contentRect.width ?? 0) >= 920;
      if (next === presentation.current) return;
      const active = document.activeElement;
      const identity = panelIdentity.current;
      if (presentation.current !== null && identity && active instanceof HTMLElement) {
        const key = [...fields.current].find(([, node]) => node === active)?.[0];
        const stepId = identity.startsWith("step:") ? identity.slice(5) : null;
        if (key && key !== "name" && (!stepId || key.startsWith(`${stepId}:`))) {
          const request: WorkflowFieldFocus = {
            field: stepId ? key.slice(stepId.length + 1) : key,
            stepId,
          };
          if (
            (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
            active.selectionStart !== null &&
            active.selectionEnd !== null
          )
            request.selection = {
              start: active.selectionStart,
              end: active.selectionEnd,
              direction: active.selectionDirection ?? "none",
              scrollTop: active.scrollTop,
            };
          focusRequest.current = request;
        }
      }
      // Set this before unmounting Sheet so its cleanup cannot return focus to the canvas.
      setFocusVersion(++focusEpoch.current);
      presentation.current = next;
      sheetReady.current = false;
      setDocked(next);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const reorder = (steps: ReadonlyArray<WorkflowStep>) => {
    edit((current) => ({ ...current, definition: { ...current.definition, steps } }));
    const current = appAtomRegistry.get(workflowDraftAtom);
    return (
      current.accountId === scope.accountId &&
      current.editors[workflowSessionKey(scope, draft.workflowId)]?.definition.steps === steps
    );
  };
  const choose = (id: string) => {
    setFocusRequest(null);
    setSettingsOpen(false);
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select(id);
  };
  const close = () => {
    setFocusRequest(null);
    setSettingsOpen(false);
    select("");
    returnFocus.current?.focus();
  };
  const openSettings = () => {
    setFocusRequest(null);
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select("");
    setSettingsOpen(true);
  };
  const submit = async () => {
    if (pending) return;
    const problem = workflowDraftIssue(draft.definition);
    if (problem) {
      edit((current) => ({ ...current, error: problem.message }));
      setSettingsOpen(false);
      select(problem.stepId ?? "");
      setFocusRequest({ field: problem.field, stepId: problem.stepId });
      return;
    }
    if (!draft.targetConfirmed || !target) {
      select("");
      setSettingsOpen(true);
      edit((current) => ({
        ...current,
        error: "Choose an available execution target before saving.",
      }));
      setFocusRequest({ field: "target", stepId: null });
      return;
    }
    setFocusRequest(null);
    await save();
  };
  const panel = settingsOpen ? (
    <div>
      <header className={styles["workflow-inspector-header"]}>
        <Settings2Icon size={20} />
        <h2 className="min-w-0 flex-1 text-sm font-medium">Workflow settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close settings"
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      <fieldset disabled={pending} className={styles["workflow-inspector-fields"]}>
        <div className="space-y-2">
          <RepositorySourcesButton repositoryId={scope.repositoryId} />
          <p className="text-sm">Execution target</p>
          <Select
            value={
              draft.targetConfirmed
                ? `${draft.definition.environmentId}:${draft.definition.projectId}`
                : null
            }
            onValueChange={(value) => {
              const next = projects.find(
                (entry) => `${entry.environmentId}:${entry.projectId}` === value,
              );
              if (next)
                edit((current) => ({
                  ...current,
                  targetConfirmed: true,
                  definition: {
                    ...current.definition,
                    environmentId: next.environmentId,
                    projectId: next.projectId,
                  },
                }));
            }}
          >
            <SelectTrigger
              aria-label="Execution target"
              ref={(node) => registerField("target", node)}
            >
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
        <Button type="button" variant="outline" onClick={() => void discard()}>
          Discard changes
        </Button>
        {draft.baseline ? (
          <Button
            type="button"
            variant="ghost"
            disabled={!!draft.operation}
            onClick={() => void archive()}
          >
            {draft.baseline.archived ? "Restore workflow" : "Archive workflow"}
          </Button>
        ) : null}
      </fieldset>
    </div>
  ) : selected ? (
    <WorkflowStepEditor
      key={selected.id}
      definition={draft.definition}
      selectedId={selected.id}
      models={models}
      disabled={pending}
      close={close}
      registerField={(field, node) => registerField(`${selected.id}:${field}`, node)}
      select={(id) => {
        select(id);
        setFocusRequest(id ? { field: "title", stepId: id } : null);
      }}
      change={(steps) => {
        reorder(steps);
      }}
      move={(steps) => {
        if (reorder(steps)) setMovementVersion((version) => version + 1);
      }}
    />
  ) : null;
  return (
    <form
      ref={workspace}
      noValidate
      className={styles["workflow-editor"]}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className={styles["workflow-editor-header"]}>
        <div className={styles["workflow-editor-identity"]}>
          <input
            className={styles["workflow-editor-title"]}
            aria-label="Workflow name"
            data-workflow-field="name"
            ref={(node) => registerField("name", node)}
            maxLength={120}
            disabled={pending}
            value={draft.definition.name}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                definition: { ...current.definition, name: event.target.value },
              }))
            }
          />
          <p className="text-xs text-muted-foreground">
            <span role="status">
              {pending
                ? "Saving…"
                : draft.operation
                  ? "Save unconfirmed"
                  : workflowEditorDirty(draft)
                    ? "Unsaved changes"
                    : "Saved"}
            </span>{" "}
            · {draft.definition.steps.length} steps{archived ? " · Archived" : ""}
          </p>
        </div>
        <div className={styles["workflow-editor-actions"]}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={styles["workflow-target-summary"]}
                  onClick={openSettings}
                />
              }
            >
              <MonitorIcon />
              <span>{targetLabel}</span>
              <ChevronDownIcon />
            </TooltipTrigger>
            <TooltipPopup>{targetLabel}</TooltipPopup>
          </Tooltip>

          <Button
            type="button"
            variant="outline"
            disabled={pending || !draft.baseline || archived}
            onClick={() => {
              if (!pending && draft.baseline && !archived)
                void navigate({
                  to: "/workflows/$repositoryId/$workflowId/run",
                  params: { repositoryId: scope.repositoryId, workflowId: draft.workflowId },
                });
            }}
          >
            <PlayIcon />
            Run
          </Button>
          <Button type="submit" disabled={pending}>
            {draft.operation?.state === "uncertain" ? "Retry save" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Workflow settings"
            onClick={openSettings}
          >
            <Settings2Icon />
          </Button>
        </div>
      </div>
      {draft.error ||
      draft.operation?.state === "uncertain" ||
      notice ||
      issue ||
      models.issues.length ? (
        <div className={styles["workflow-editor-notices"]}>
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
                    disabled={pending}
                    onClick={() => edit((current) => ({ ...current, error: null }))}
                  >
                    Keep editing
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || reading}
                  onClick={() => void reload()}
                >
                  Reload saved version
                </Button>
                {draft.operation?.state === "uncertain" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || reading}
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
          {models.issues.length ? (
            <details className="text-xs text-warning">
              <summary>
                {models.issues.length} Agent model{" "}
                {models.issues.length === 1 ? "warning" : "warnings"}
              </summary>
              {models.issues.map((issue) => (
                <p key={issue.stepId} className="mt-1">
                  {issue.title}: {issue.detail}
                </p>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
      <div className={styles["workflow-editor-body"]}>
        <WorkflowCanvas
          definition={draft.definition}
          selectedStepId={draft.selectedStepId}
          invalidStepId={issue?.stepId}
          models={models}
          pending={pending}
          onSelect={choose}
          onReorder={reorder}
          movementVersion={movementVersion}
          onInsert={(anchor, kind) => {
            setSettingsOpen(false);
            const inserted = insert(anchor, kind);
            if (inserted) setFocusRequest({ field: "title", stepId: inserted });
          }}
          onOverview={close}
          panelOpen={panelOpen}
        />
        {docked && panelOpen ? (
          <aside
            aria-label={settingsOpen ? "Workflow settings" : "Selected step settings"}
            data-workflow-step={selected?.id}
            className={styles["workflow-inspector"]}
          >
            {panel}
          </aside>
        ) : null}
        {docked === false ? (
          <Sheet
            open={panelOpen}
            onOpenChange={(open) => {
              if (!open && presentation.current === false) close();
            }}
          >
            <SheetPopup
              showCloseButton={false}
              initialFocus={() => {
                if (
                  !mounted.current ||
                  presentation.current !== false ||
                  !panelIdentity.current ||
                  focusVersion !== focusEpoch.current
                )
                  return false;
                sheetReady.current = true;
                // Restore once before interaction; animation completion must not replay a caret.
                return !focusPending();
              }}
              finalFocus={() => {
                if (!mounted.current || presentation.current !== false) return false;
                return returnFocus.current?.isConnected
                  ? returnFocus.current
                  : (workspace.current?.querySelector('[aria-label="Workflow settings"]') ?? true);
              }}
            >
              <SheetTitle className="sr-only">
                {settingsOpen ? "Workflow settings" : "Selected step settings"}
              </SheetTitle>
              <div className="min-h-0 overflow-y-auto" data-workflow-step={selected?.id}>
                {panel}
              </div>
            </SheetPopup>
          </Sheet>
        ) : null}
      </div>
    </form>
  );
}
