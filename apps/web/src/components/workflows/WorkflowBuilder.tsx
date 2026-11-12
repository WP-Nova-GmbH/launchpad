import { WorkflowAlert } from "./WorkflowAlert";
import * as Schema from "effect/Schema";
import {
  WORKFLOW_MAX_STEPS,
  WorkflowAutomation,
  workflowPublishingPrerequisites,
} from "@t3tools/contracts/workflows";
import { WorkflowEditorDepartureGuard } from "./WorkflowEditorDepartureGuard";
import { WorkflowTriggerInspector, workflowTriggerLabel } from "./WorkflowTriggerInspector";
import { RepositorySourcesButton } from "./WorkflowSources";
import { OwnerSources } from "./WorkflowOwnerSources";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import styles from "./workflowEditor.module.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RelayOrganizationId, type RelayOrganizationProject } from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflow,
  WorkflowCatalog,
  WorkflowStep,
} from "@t3tools/contracts/workflows";
import {
  workflowSessionKey,
  workflowDraftIssue,
  workflowEditorDirty,
  updateWorkflowDrafts,
  workflowDraftAtom,
  startNewWorkflowDraft,
  discardWorkflowEditor,
  workflowDraftAutomation,
  workflowDraftAutomationResolved,
  normalizeWorkflowAutomation,
  sameWorkflowAutomation,
  sameWorkflowDefinition,
  type WorkflowScope,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { WorkflowStepEditor, useWorkflowEditorModels } from "./WorkflowStepEditor";
import { WorkflowCanvas, workflowInsertionIndex, type WorkflowInsertion } from "./WorkflowCanvas";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import {
  Settings2Icon,
  XIcon,
  PlayIcon,
  MonitorIcon,
  CloudIcon,
  GitBranchIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "lucide-react";

import {
  useWorkflowDrafts,
  useWorkflowClient,
  useActiveWorkflowView,
  editWorkflowDraft,
  selectWorkflowStep,
  savedWorkflowDraft,
  restoreCheckoutIssue,
  newWorkflowDraft,
  saveWorkflowDraft,
  confirmWorkflow,
  workflowError,
} from "./workflowState";

import {
  assertWorkflowSaveSupport,
  matchesWorkflowSave,
  applyWorkflowSaveReceipt,
  normalizeWorkflowDefinitionForSave,
  workflowVmOffSave,
} from "./workflowOperations";

const isWorkflowAutomation = Schema.is(WorkflowAutomation);

type WorkflowBuilderProps = {
  scope: WorkflowScope;
  repositoryName: string;
  workflow: RepositoryWorkflow | undefined;
  workflowId?: string | undefined;
  openExecutionSettings?: boolean;
  isNew: boolean;
  projects: ReadonlyArray<RelayOrganizationProject>;
  projectsUnavailable?: boolean | undefined;
  refreshProjects: () => void;
  vmAuthoring?: WorkflowCatalog["vmAuthoring"];
  vmExecutionAvailable?: boolean;
  vmAutomationAvailable?: boolean;
  codexRefreshVersion?: number;
  canConfigure: boolean;
  call: ReturnType<typeof useWorkflowClient>;
  refresh: () => void;
  automationSupported?: boolean;
  automationReason?: string | null | undefined;
};

export function WorkflowBuilder(props: WorkflowBuilderProps) {
  const state = useWorkflowDrafts();
  const departureKey = workflowSessionKey(
    props.scope,
    props.isNew ? "new" : (props.workflowId ?? props.workflow?.workflowId ?? "missing"),
  );
  const departure = useRef<string | null>(null);
  const isDeparting = useCallback(() => departure.current === departureKey, [departureKey]);
  const onDepart = useCallback(() => {
    departure.current = departureKey;
  }, [departureKey]);
  const id = props.isNew
    ? state.newWorkflowIds[workflowSessionKey(props.scope, "new")]
    : (props.workflowId ?? props.workflow?.workflowId);
  return (
    <WorkflowBuilderEditor
      key={workflowSessionKey(props.scope, `${props.isNew ? "new" : "edit"}:${id ?? ""}`)}
      {...props}
      isDeparting={isDeparting}
      onDepart={onDepart}
      id={id}
    />
  );
}

function WorkflowBuilderEditor({
  scope,
  repositoryName,
  workflow,
  isNew,
  openExecutionSettings = false,
  projects,
  projectsUnavailable,
  refreshProjects,
  vmAuthoring,
  vmAutomationAvailable = false,
  vmExecutionAvailable = false,
  codexRefreshVersion = 0,
  canConfigure,
  call,
  refresh,
  automationSupported = false,
  automationReason,
  isDeparting,
  onDepart,
  id,
}: WorkflowBuilderProps & {
  id: string | undefined;
  isDeparting: () => boolean;
  onDepart: () => void;
}) {
  const navigate = useNavigate();
  const active = useActiveWorkflowView();
  const state = useWorkflowDrafts();
  const key = workflowSessionKey(scope, id ?? "missing");
  const draft = id ? state.editors[key] : undefined;
  const restoreCatalog = useRef({ projects, projectsUnavailable });
  useLayoutEffect(() => {
    restoreCatalog.current = { projects, projectsUnavailable };
  }, [projects, projectsUnavailable]);
  const readRequest = useRef<{ draft: WorkflowEditorDraft } | null>(null);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [codexNotice, setCodexNotice] = useState<string | null>(null);
  const checkCodex =
    canConfigure &&
    !!vmAuthoring &&
    draft?.definition.target.kind === "vm" &&
    draft.targetConfirmed;
  useEffect(() => {
    if (!checkCodex) return;
    let active = true;
    void Promise.resolve()
      .then(() => call((client, token) => client.getCodexVmConnection({ clerkToken: token })))
      .then(
        ({ status }) => {
          if (active)
            setCodexNotice(
              status === "disconnected"
                ? "Connect Codex before running."
                : status === "reconnect_required"
                  ? "Reconnect Codex before running."
                  : null,
            );
        },
        () => {
          if (active) setCodexNotice("Could not check the organization's Codex connection.");
        },
      );
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit workflow refresh retries the VM status lookup.
  }, [call, checkCodex, codexRefreshVersion]);
  useEffect(
    () => () => {
      readRequest.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!canConfigure || isDeparting()) return;
    if (isNew) {
      startNewWorkflowDraft(appAtomRegistry, scope, () =>
        newWorkflowDraft(projects, "review", !!vmAuthoring),
      );
      return;
    }
    if (!id || !workflow) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.editors[key];
      if (!current)
        return {
          ...state,
          editors: { ...state.editors, [key]: savedWorkflowDraft(workflow, automationSupported) },
        };
      if (
        automationSupported &&
        !workflowDraftAutomationResolved(current) &&
        !current.operation &&
        current.baseline?.revision === workflow.revision
      )
        return {
          ...state,
          editors: {
            ...state.editors,
            [key]: {
              ...current,
              automation: normalizeWorkflowAutomation(workflow.automation),
              automationResolved: true,
              baseline: workflow,
            },
          },
        };
      return state;
    });
  }, [
    canConfigure,
    workflow,
    isNew,
    projects,
    scope,
    key,
    id,
    isDeparting,
    automationSupported,
    vmAuthoring,
  ]);
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
    return (
      <div className="p-5">
        <WorkflowAlert
          title="Workflow editing requires access"
          variant="info"
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/workflows/$repositoryId",
                  params: { repositoryId: scope.repositoryId },
                  search: { tab: "workflows" },
                })
              }
            >
              Back to workflows
            </Button>
          }
        >
          Repository maintainers and organization admins can configure workflows.
        </WorkflowAlert>
      </div>
    );
  if (!draft)
    return (
      <div className="p-5">
        <WorkflowAlert
          title={isNew ? "No execution target available" : "Workflow unavailable"}
          variant="warning"
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/workflows/$repositoryId",
                  params: { repositoryId: scope.repositoryId },
                  search: { tab: "workflows" },
                })
              }
            >
              Back to workflows
            </Button>
          }
        >
          {isNew
            ? "Update the relay to create a VM workflow, or enroll an organization machine with a checkout of this repository."
            : "Workflow unavailable."}
        </WorkflowAlert>
      </div>
    );
  const pending = draft.operation?.state === "pending";
  const currentSaved =
    workflow && draft.baseline && workflow.revision > draft.baseline.revision
      ? workflow
      : draft.baseline;
  const archived = !!currentSaved?.archived;
  const issue = workflowDraftIssue(normalizeWorkflowDefinitionForSave(draft.definition));
  const edit = (update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft) =>
    editWorkflowDraft(scope, draft.workflowId, update);
  const save = async (turnOffOnly = false) => {
    if (pending) return;
    if (!draft.operation && !turnOffOnly) {
      const problem = workflowDraftIssue(normalizeWorkflowDefinitionForSave(draft.definition));
      if (problem) {
        edit((draft) => ({
          ...draft,
          selectedStepId: problem.stepId ?? draft.selectedStepId,
          error: problem.message,
        }));
        return;
      }
      if (!draft.targetConfirmed) return;
      const automation = workflowDraftAutomation(draft);
      if (
        automationSupported &&
        (!isWorkflowAutomation(automation) || (automation.enabled && !automation.trigger))
      ) {
        edit((current) => ({
          ...current,
          triggerSetup: true,
          error: "Complete the Linear trigger selections, or remove the trigger before saving.",
        }));
        return;
      }
    }
    const saved = await saveWorkflowDraft(
      scope,
      draft.workflowId,
      (payload) =>
        call((client, token) =>
          client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
        ),
      undefined,
      {
        automationSupported,
        turnOffOnly,
        read: () =>
          call((client, token) =>
            client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
          ),
      },
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
      const catalog = await call((client, token) =>
        client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
      );
      if (!ownsRead(request)) return;
      const saved = catalog.workflows.find(
        (entry) => entry.workflowId === request.draft.workflowId,
      );
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
                  ...savedWorkflowDraft(saved, catalog.automationSupported === true),
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
      const catalog = await call((client, token) =>
        client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
      );
      if (!ownsRead(request)) return;
      assertWorkflowSaveSupport(operation, catalog);
      const saved = catalog.workflows.find(
        (entry) => entry.workflowId === request.draft.workflowId,
      );
      const matched = !!saved && matchesWorkflowSave(saved, operation);
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
              ? applyWorkflowSaveReceipt(current, operation, saved!)
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
    if (captured.operation) {
      await navigate({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "workflows" },
      });
      return;
    }
    if (
      workflowEditorDirty(captured) &&
      !(await confirmWorkflow("Discard this workflow's unsaved changes?"))
    )
      return;
    if (!active.current || appAtomRegistry.get(workflowDraftAtom).editors[key] !== captured) return;
    if (!captured.baseline) {
      onDepart();
      discardWorkflowEditor(appAtomRegistry, scope, captured.workflowId);
      await navigate({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "workflows" },
      });
    } else
      edit(() => savedWorkflowDraft(captured.baseline!, workflowDraftAutomationResolved(captured)));
  };
  const archive = async () => {
    const captured = appAtomRegistry.get(workflowDraftAtom).editors[key];
    const baseline = captured?.baseline;
    if (!captured || !baseline || captured.operation) return;
    const restoreBlocked = () =>
      baseline.archived &&
      !!restoreCheckoutIssue(
        baseline,
        restoreCatalog.current.projects,
        restoreCatalog.current.projectsUnavailable,
      );
    if (restoreBlocked()) return;
    if (
      workflowEditorDirty(captured) &&
      !(await confirmWorkflow(
        "Discard unsaved edits before changing this workflow's archive state?",
      ))
    )
      return;
    if (
      !active.current ||
      appAtomRegistry.get(workflowDraftAtom).editors[key] !== captured ||
      restoreBlocked()
    )
      return;
    edit(() => savedWorkflowDraft(baseline, workflowDraftAutomationResolved(captured)));
    if (
      await saveWorkflowDraft(
        scope,
        captured.workflowId,
        (payload) =>
          call((client, token) =>
            client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
          ),
        !baseline.archived,
        {
          automationSupported,
          read: () =>
            call((client, token) =>
              client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
            ),
        },
      )
    )
      refresh();
  };
  const insert = (
    anchor: WorkflowInsertion,
    kind: WorkflowStep["kind"] | "open_pull_request",
    repairOpenPrId?: string,
  ) => {
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
      const steps = draft.definition.steps;
      const index = workflowInsertionIndex(steps, anchor);
      if (
        index === null ||
        steps.length >= WORKFLOW_MAX_STEPS ||
        (draft.definition.target.kind === "vm" && step.kind === "action")
      )
        return draft;
      if (repairOpenPrId) {
        const openPr = steps[index];
        if (
          !draft.targetConfirmed ||
          draft.selectedStepId !== repairOpenPrId ||
          openPr?.id !== repairOpenPrId ||
          openPr.kind !== "action" ||
          openPr.action !== "open_pull_request"
        )
          return draft;
        const { agent, push } = workflowPublishingPrerequisites(steps, index);
        if (!agent || push) return draft;
      }
      inserted = true;
      return {
        ...draft,
        selectedStepId: repairOpenPrId ?? stepId,
        definition: {
          ...draft.definition,
          steps: [...steps.slice(0, index), step, ...steps.slice(index)],
        },
      };
    });
    return inserted ? stepId : null;
  };
  const vmRunUnavailable = currentSaved?.definition.target.kind === "vm" && !vmExecutionAvailable;
  const runDraft = state.runs[key];
  const hasRunSubmission =
    runDraft?.operation?.targetKind === "vm" ||
    ((archived || vmRunUnavailable) && runDraft?.operation?.state === "uncertain");
  return (
    <WorkflowBuilderWorkspace
      repositoryName={repositoryName}
      openExecutionSettings={openExecutionSettings}
      automationSupported={automationSupported}
      automationReason={automationReason}
      onDepart={onDepart}
      draft={draft}
      projects={projects}
      projectsUnavailable={projectsUnavailable}
      refreshProjects={refreshProjects}
      vmAuthoring={vmAuthoring}
      vmExecutionAvailable={vmExecutionAvailable}
      vmAutomationAvailable={vmAutomationAvailable}
      codexNotice={checkCodex ? codexNotice : null}
      pending={pending}
      archived={archived}
      vmRunUnavailable={vmRunUnavailable}
      hasRunSubmission={hasRunSubmission}
      hasRunInstructions={!!runDraft?.instruction.trim()}
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
  repositoryName,
  openExecutionSettings,
  draft,
  automationSupported,
  automationReason,
  onDepart,
  projects,
  projectsUnavailable,
  refreshProjects,
  vmAuthoring,
  vmExecutionAvailable,
  vmAutomationAvailable,
  codexNotice,
  pending,
  archived,
  vmRunUnavailable,
  hasRunSubmission,
  hasRunInstructions,
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
  repositoryName: string;
  openExecutionSettings: boolean;
  draft: WorkflowEditorDraft;
  automationSupported: boolean;
  automationReason?: string | null | undefined;
  onDepart: () => void;
  projects: ReadonlyArray<RelayOrganizationProject>;
  projectsUnavailable: boolean | undefined;
  refreshProjects: () => void;
  vmExecutionAvailable: boolean;
  vmAuthoring: WorkflowCatalog["vmAuthoring"];
  vmAutomationAvailable: boolean;
  codexNotice: string | null;
  pending: boolean;
  archived: boolean;
  vmRunUnavailable: boolean;
  hasRunSubmission: boolean;
  hasRunInstructions: boolean;
  reading: boolean;
  notice: string | null;
  issue: ReturnType<typeof workflowDraftIssue>;
  edit: (update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft) => void;
  select: (id: string) => void;
  insert: (
    anchor: WorkflowInsertion,
    kind: WorkflowStep["kind"] | "open_pull_request",
    repairOpenPrId?: string,
  ) => string | null;
  save: (turnOffOnly?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  reconcile: () => Promise<void>;
  discard: () => Promise<void>;
  archive: () => Promise<void>;
  scope: WorkflowScope;
}) {
  const navigate = useNavigate();
  const runBlocked = archived || vmRunUnavailable;
  const hasRetainedInstructions = runBlocked && hasRunInstructions;
  const canOpenRun =
    !!draft.baseline && (hasRunSubmission || hasRetainedInstructions || (!pending && !runBlocked));
  const vm = draft.definition.target.kind === "vm" ? draft.definition.target : null;
  const models = useWorkflowEditorModels(draft.definition, vmAuthoring?.models);
  const [settingsOpen, setSettingsOpen] = useState(
    openExecutionSettings || (!!vmAuthoring && !draft.targetConfirmed),
  );
  const triggerOpen = draft.triggerSetup === true && !(openExecutionSettings && settingsOpen);
  const setTriggerOpen = (open: boolean) =>
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const key = workflowSessionKey(scope, draft.workflowId),
        current = state.editors[key];
      return current
        ? { ...state, editors: { ...state.editors, [key]: { ...current, triggerSetup: open } } }
        : state;
    });
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
  const settingsId = useId();
  const executionTargetControl = useRef<HTMLButtonElement>(null);
  const saveControl = useRef<HTMLButtonElement>(null);
  const fields = useRef(new Map<string, HTMLElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const selected = draft.definition.steps.find((step) => step.id === draft.selectedStepId);
  const panelOpen = triggerOpen || settingsOpen || !!selected;
  const publishingIssueInInspector =
    issue?.publishing === true &&
    !triggerOpen &&
    !settingsOpen &&
    selected?.kind === "action" &&
    (issue.stepId === selected.id || !!vm);
  const editorIssue = publishingIssueInInspector ? null : issue;
  const editorError =
    publishingIssueInInspector && !draft.operation && draft.error === issue?.message
      ? null
      : draft.error;
  const machine = draft.definition.target.kind === "machine" ? draft.definition.target : null;
  const automation = workflowDraftAutomation(draft);
  const offSave =
    automationSupported && !archived && !draft.operation ? workflowVmOffSave(draft) : null;
  const hasOtherEdits =
    !!offSave &&
    (!sameWorkflowDefinition(
      normalizeWorkflowDefinitionForSave(draft.definition),
      offSave.definition,
    ) ||
      !sameWorkflowAutomation({ ...automation, enabled: false }, offSave.automation));
  const vmTriggerUnavailable = !!vm && draft.targetConfirmed && !vmAutomationAvailable;
  const target = projects.find(
    (project) =>
      project.environmentId === machine?.environmentId && project.projectId === machine?.projectId,
  );
  const targetLabel = draft.targetConfirmed
    ? vm
      ? `VM · ${vm.baseBranch ?? "Repository default"}`
      : target
        ? `${target.machineLabel} · ${target.title}`
        : "Saved execution target is unavailable"
    : "Choose an execution target";
  const restoreIssue = draft.baseline?.archived
    ? restoreCheckoutIssue(draft.baseline, projects, projectsUnavailable)
    : null;
  const restoreWarning =
    restoreIssue === "unavailable"
      ? "Reload Machine checkouts before restoring this workflow."
      : draft.targetConfirmed && (target || vm)
        ? "Save the execution target before restoring this workflow."
        : "Choose and save an available execution target before restoring this workflow.";
  const canChooseVm = !!vmAuthoring && (vmAutomationAvailable || !automation.enabled);
  const showCheckout = (!vmAuthoring || !!machine) && projects.length > 0;
  const machineSettingsField = showCheckout
    ? "checkout"
    : vmAuthoring && projects.length
      ? "target:machine"
      : projectsUnavailable
        ? "refresh-checkouts"
        : "close-settings";
  const hasPublishingSteps = draft.definition.steps.some((step) => step.kind === "action");
  const recoveryField =
    !projectsUnavailable && !projects.length && canChooseVm && !hasPublishingSteps
      ? "target:vm"
      : machineSettingsField;
  const entryFocus = useRef<WorkflowFieldFocus | null>(
    openExecutionSettings
      ? { field: pending ? "close-settings" : recoveryField, stepId: null }
      : null,
  );
  const machineDescription = projects.length
    ? "Use an enrolled repository checkout."
    : projectsUnavailable
      ? "Machine checkouts could not be loaded."
      : "No enrolled checkout for this repository.";
  const vmDescription = !canChooseVm
    ? "Turn off automatic triggering before choosing VM."
    : hasPublishingSteps
      ? "Publishing requires Machine. Remove publishing steps to use VM."
      : !vmExecutionAvailable
        ? "VM runs are unavailable."
        : "Run in a managed workspace.";
  const registerField = useCallback((field: string, node: HTMLElement | null) => {
    if (node) fields.current.set(field, node);
    else fields.current.delete(field);
  }, []);
  const panelKey = triggerOpen
    ? "trigger"
    : settingsOpen
      ? "workflow"
      : selected
        ? `step:${selected.id}`
        : null;
  const setFocusRequest = (request: WorkflowFieldFocus | null) => {
    focusRequest.current = request;
    setFocusVersion(++focusEpoch.current);
  };
  const focusPending = useCallback(() => {
    const request = focusRequest.current;
    if (!mounted.current || !request) return false;
    const expectedPanel =
      request.field === "add-step"
        ? null
        : request.stepId
          ? `step:${request.stepId}`
          : request.field.startsWith("trigger:")
            ? "trigger"
            : "workflow";
    if (request.field !== "name" && panelIdentity.current !== expectedPanel) {
      focusRequest.current = null;
      return false;
    }
    const key = request.stepId ? `${request.stepId}:${request.field}` : request.field;
    const focusableField = (key: string) => {
      const node = fields.current.get(key);
      return node?.isConnected && !node.matches(':disabled, [aria-disabled="true"]')
        ? node
        : undefined;
    };
    const node =
      focusableField(key) ??
      (request.field === "repair" ? focusableField(`${request.stepId}:repair-warning`) : undefined);
    focusRequest.current = null;
    if (!node) return false;
    node.focus({ preventScroll: request.field !== "repair" && request.field !== "repair-warning" });
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
    focusRequest.current = entryFocus.current;
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
    setTriggerOpen(false);
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select(id);
  };
  const canvasTrigger = () =>
    workspace.current?.querySelector<HTMLButtonElement>(
      '[aria-label="Configure workflow trigger"]',
    );
  const inspectorReturnTarget = () => {
    if (returnFocus.current?.isConnected) return returnFocus.current;
    if (triggerOpen) return canvasTrigger();
    return settingsOpen ? executionTargetControl.current : null;
  };
  const close = () => {
    returnFocus.current = inspectorReturnTarget() ?? null;
    setFocusRequest(null);
    setSettingsOpen(false);
    setTriggerOpen(false);
    select("");
    returnFocus.current?.focus();
  };
  const openSettings = () => {
    setTriggerOpen(false);
    setFocusRequest(null);
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select("");
    setSettingsOpen(true);
  };
  const openMachineSettings = () => {
    openSettings();
    setFocusRequest({ field: machineSettingsField, stepId: null });
  };
  const focusIssue = (problem: NonNullable<typeof issue>) => {
    setFocusRequest({
      field: problem.publishing ? "repair" : problem.field,
      stepId: problem.stepId,
    });
  };
  const reviewIssueAction = editorIssue ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (!editorIssue.stepId && editorIssue.field !== "name") openSettings();
        else {
          choose(editorIssue.stepId ?? "");
          if (editorIssue.publishing) returnFocus.current = saveControl.current;
        }
        focusIssue(editorIssue);
      }}
    >
      {editorIssue.publishing ? "Review publishing step" : "Review settings"}
    </Button>
  ) : null;
  const insertPushBranch = () => {
    if (selected?.kind !== "action" || selected.action !== "open_pull_request") return;
    const preceding = draft.definition.steps[draft.definition.steps.indexOf(selected) - 1];
    if (preceding && insert({ after: preceding }, "action", selected.id)) {
      setFocusRequest({ field: "title", stepId: selected.id });
    }
  };
  const openTrigger = (opener?: HTMLElement | null) => {
    setFocusRequest(null);
    setSettingsOpen(false);
    select("");
    returnFocus.current = opener ?? canvasTrigger() ?? null;
    setTriggerOpen(true);
  };
  const submit = async (submitter?: HTMLElement) => {
    if (pending) return;
    if (draft.operation?.state === "uncertain") {
      setFocusRequest(null);
      await save();
      return;
    }
    if (offSave && !hasOtherEdits && !automation.enabled) {
      await save(true);
      return;
    }
    const problem = issue;
    if (problem) {
      if (problem.publishing) returnFocus.current = submitter ?? saveControl.current;
      edit((current) => ({ ...current, error: problem.message }));
      setSettingsOpen(false);
      setTriggerOpen(false);
      select(problem.stepId ?? "");
      focusIssue(problem);
      return;
    }
    if (automationSupported && !workflowDraftAutomationResolved(draft)) {
      edit((current) => ({
        ...current,
        error:
          "Refresh or reload the saved workflow before saving automation. Your edits are retained.",
      }));
      return;
    }
    const triggerOpener = submitter ?? (triggerOpen ? returnFocus.current : null);
    if (vmTriggerUnavailable && automation.enabled) {
      openTrigger(triggerOpener);
      edit((current) => ({
        ...current,
        error: "Automatic VM runs are unavailable. Turn off automatic triggering before saving.",
      }));
      return;
    }
    if (
      automationSupported &&
      (!isWorkflowAutomation(automation) || (automation.enabled && !automation.trigger))
    ) {
      openTrigger(triggerOpener);
      edit((current) => ({
        ...current,
        error: "Complete the Linear trigger selections, or remove the trigger before saving.",
      }));
      return;
    }
    if (!draft.targetConfirmed || (machine && !target && !draft.baseline) || (vm && !vmAuthoring)) {
      openSettings();
      edit((current) => ({
        ...current,
        error:
          vm && !vmAuthoring
            ? "Update the relay to save a VM workflow."
            : "Choose an available execution target before saving.",
      }));
      setFocusRequest({
        field: showCheckout
          ? "checkout"
          : vmAuthoring && projects.length
            ? "target:machine"
            : canChooseVm
              ? "target:vm"
              : "close-settings",
        stepId: null,
      });
      return;
    }
    const modelIssue = vm ? models.issues[0] : undefined;
    if (modelIssue) {
      setTriggerOpen(false);
      setSettingsOpen(false);
      select(modelIssue.stepId);
      setFocusRequest({ field: "model", stepId: modelIssue.stepId });
      return;
    }
    setFocusRequest(null);
    await save();
  };
  const panel = triggerOpen ? (
    <WorkflowTriggerInspector
      scope={scope}
      automation={draft.automation ?? draft.baseline?.automation}
      savedAutomation={draft.baseline?.automation}
      unsaved={workflowEditorDirty(draft)}
      retrySave={draft.operation?.state === "uncertain"}
      onSave={() => void submit()}
      onChooseMachine={openMachineSettings}
      supported={automationSupported}
      vmTarget={!!vm && draft.targetConfirmed}
      vmAutomationAvailable={vmAutomationAvailable}
      onSaveOff={
        offSave && (vmTriggerUnavailable || hasOtherEdits) ? () => void save(true) : undefined
      }
      hasOtherEdits={hasOtherEdits}
      resolved={workflowDraftAutomationResolved(draft)}
      registerField={registerField}
      disabled={pending || archived}
      onChange={(automation) => edit((current) => ({ ...current, automation }))}
      onClose={close}
    />
  ) : settingsOpen ? (
    <div>
      <header className={styles["workflow-settings-header"]}>
        <Settings2Icon size={18} aria-hidden />
        <h2 className="min-w-0 flex-1 text-sm font-medium">Workflow settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close settings"
          ref={(node) => registerField("close-settings", node)}
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      <fieldset disabled={pending} className="min-w-0">
        <section className={styles["workflow-settings-execution"]}>
          <h3 id={`${settingsId}-target`} className="text-sm font-medium">
            Execution target
          </h3>
          {vmAuthoring ? (
            <>
              {!machine && !draft.targetConfirmed ? (
                <p className="text-xs text-muted-foreground">Choose a target</p>
              ) : null}
              <RadioGroup
                aria-labelledby={`${settingsId}-target`}
                disabled={pending}
                value={machine ? "machine" : draft.targetConfirmed ? "vm" : null}
                onKeyDownCapture={(event) => {
                  const radio = event.target;
                  if (
                    event.key !== " " ||
                    !(radio instanceof HTMLElement) ||
                    radio.getAttribute("role") !== "radio" ||
                    radio.getAttribute("aria-disabled") === "true"
                  )
                    return;

                  // Base UI's non-native radio cancels Space before its click handler can select it.
                  event.preventDefault();
                  event.stopPropagation();
                  radio.click();
                }}
                onValueChange={(value) => {
                  if (value === "vm") {
                    edit((current) => {
                      if (!vmAutomationAvailable && workflowDraftAutomation(current).enabled)
                        return current;
                      const { lastVmTarget, ...draft } = current;
                      const target = draft.definition.target;
                      const savedTarget = draft.baseline?.definition.target;
                      return {
                        ...draft,
                        targetConfirmed: true,
                        error: null,
                        definition: {
                          ...draft.definition,
                          target:
                            target.kind === "vm"
                              ? target
                              : (lastVmTarget ??
                                (savedTarget?.kind === "vm"
                                  ? savedTarget
                                  : { kind: "vm", baseBranch: null })),
                        },
                      };
                    });
                    return;
                  }
                  const project = projects[0];
                  if (value === "machine" && project)
                    edit((current) => {
                      const lastVmTarget = current.definition.target;
                      if (lastVmTarget.kind === "machine") return current;
                      return {
                        ...current,
                        lastVmTarget,
                        targetConfirmed: projects.length === 1,
                        error: null,
                        definition: {
                          ...current.definition,
                          target: {
                            kind: "machine",
                            environmentId: project.environmentId,
                            projectId: project.projectId,
                          },
                        },
                      };
                    });
                }}
              >
                <label
                  htmlFor={`${settingsId}-machine`}
                  className={styles["workflow-settings-option"]}
                >
                  <RadioGroupItem
                    id={`${settingsId}-machine`}
                    value="machine"
                    disabled={!projects.length}
                    aria-labelledby={`${settingsId}-machine-label`}
                    aria-describedby={`${settingsId}-machine-description`}
                    ref={(node) => registerField("target:machine", node)}
                  />
                  <MonitorIcon size={15} aria-hidden />
                  <span className="min-w-0">
                    <span id={`${settingsId}-machine-label`} className="font-medium">
                      Machine
                    </span>
                    <small id={`${settingsId}-machine-description`}>{machineDescription}</small>
                  </span>
                </label>
                <label htmlFor={`${settingsId}-vm`} className={styles["workflow-settings-option"]}>
                  <RadioGroupItem
                    id={`${settingsId}-vm`}
                    value="vm"
                    disabled={!canChooseVm}
                    aria-labelledby={`${settingsId}-vm-label`}
                    aria-describedby={`${settingsId}-vm-description`}
                    ref={(node) => registerField("target:vm", node)}
                  />
                  <CloudIcon size={15} aria-hidden />
                  <span className="min-w-0">
                    <span id={`${settingsId}-vm-label`} className="font-medium">
                      VM
                    </span>
                    <small id={`${settingsId}-vm-description`}>{vmDescription}</small>
                  </span>
                </label>
              </RadioGroup>
            </>
          ) : vm ? (
            <p className="text-xs text-warning-foreground">
              Update the relay to save a VM workflow.
            </p>
          ) : null}
          {showCheckout ? (
            <div className={styles["workflow-settings-field"]}>
              <label htmlFor={`${settingsId}-checkout`}>Checkout</label>
              {draft.targetConfirmed && machine && !target ? (
                <p className="text-warning-foreground" id={`${settingsId}-checkout-warning`}>
                  Saved checkout unavailable. Choose another checkout.
                </p>
              ) : null}
              <Select
                disabled={pending}
                value={
                  draft.targetConfirmed && target
                    ? `${target.environmentId}:${target.projectId}`
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
                        target: {
                          kind: "machine",
                          environmentId: next.environmentId,
                          projectId: next.projectId,
                        },
                      },
                    }));
                }}
              >
                <SelectTrigger
                  id={`${settingsId}-checkout`}
                  aria-describedby={
                    draft.targetConfirmed && machine && !target
                      ? `${settingsId}-checkout-warning`
                      : undefined
                  }
                  ref={(node) => registerField("checkout", node)}
                >
                  <SelectValue>
                    {draft.targetConfirmed && target ? targetLabel : "Choose a checkout"}
                  </SelectValue>
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
          ) : null}
          {!projects.length && projectsUnavailable ? (
            <div className="space-y-2">
              {!vmAuthoring ? (
                <p className="text-xs text-warning-foreground">{machineDescription}</p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                ref={(node) => registerField("refresh-checkouts", node)}
                onClick={refreshProjects}
              >
                Retry loading checkouts
              </Button>
            </div>
          ) : !projects.length && (machine || (!vmAuthoring && !vm)) ? (
            <p className="text-xs text-muted-foreground">
              {!vmAuthoring ? `${machineDescription} ` : null}
              {canChooseVm && vmExecutionAvailable && !hasPublishingSteps
                ? "Choose VM or enroll a checkout to run this workflow."
                : "Enroll a checkout to run this workflow."}
            </p>
          ) : null}
          {vm && draft.targetConfirmed ? (
            <label className={styles["workflow-settings-field"]}>
              <span>Base branch</span>
              <Input
                ref={(node) => registerField("baseBranch", node)}
                value={vm.baseBranch ?? ""}
                placeholder="Repository default"
                onChange={(event) => {
                  const baseBranch = event.target.value || null;
                  edit((current) => ({
                    ...current,
                    definition: { ...current.definition, target: { kind: "vm", baseBranch } },
                  }));
                }}
              />
            </label>
          ) : null}
        </section>
        <section className={styles["workflow-settings-row"]} aria-label="Repository">
          <h3 className="text-sm font-medium">Repository</h3>
          <RepositorySourcesButton
            repositoryId={scope.repositoryId}
            repositoryName={repositoryName}
            connectionSettings={
              <OwnerSources
                accountId={scope.accountId}
                organizationId={RelayOrganizationId.make(scope.organizationId)}
              />
            }
          />
        </section>
        <footer className={styles["workflow-settings-row"]}>
          {restoreIssue ? (
            <p
              id={`${settingsId}-restore-warning`}
              role="status"
              className="basis-full text-xs text-warning-foreground"
            >
              {restoreWarning}
            </p>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => void discard()}>
            Discard changes
          </Button>
          {draft.baseline ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!!draft.operation || !!restoreIssue}
              aria-describedby={restoreIssue ? `${settingsId}-restore-warning` : undefined}
              onClick={() => void archive()}
            >
              {draft.baseline.archived ? "Restore workflow" : "Archive workflow"}
            </Button>
          ) : null}
        </footer>
      </fieldset>
    </div>
  ) : selected ? (
    <WorkflowStepEditor
      key={selected.id}
      definition={draft.definition}
      selectedId={selected.id}
      models={models}
      vmModels={vmAuthoring?.models}
      targetConfirmed={draft.targetConfirmed}
      machineCheckoutAvailable={!!target}
      disabled={pending}
      close={close}
      openWorkflowSettings={openMachineSettings}
      insertPushBranch={insertPushBranch}
      registerField={(field, node) => registerField(`${selected.id}:${field}`, node)}
      select={(id) => {
        select(id);
        if (id) {
          setFocusRequest({ field: "title", stepId: id });
        } else {
          returnFocus.current = fields.current.get("add-step") ?? null;
          setFocusRequest({ field: "add-step", stepId: null });
        }
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
        const submitter = event.nativeEvent?.submitter;
        void submit(submitter instanceof HTMLElement ? submitter : undefined);
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={styles["workflow-target-summary"]}
                    ref={executionTargetControl}
                    aria-label={`Execution target: ${targetLabel}`}
                    onClick={openSettings}
                  />
                }
              >
                {vm && draft.targetConfirmed ? <CloudIcon /> : <MonitorIcon />}
                <span>{vm && draft.targetConfirmed ? "VM" : targetLabel}</span>
                {vm && draft.targetConfirmed ? (
                  <>
                    <GitBranchIcon aria-hidden />
                    <span>{vm.baseBranch ?? "Repository default"}</span>
                  </>
                ) : null}
                <ChevronDownIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>{targetLabel}</TooltipPopup>
            </Tooltip>
            <span>{draft.definition.steps.length} steps</span>
            {archived ? <span>Archived</span> : null}
            <span>
              {automationSupported && workflowDraftAutomationResolved(draft)
                ? `Saved automatic triggering: ${draft.baseline?.automation?.enabled ? "On" : "Off"}`
                : "Automation state unavailable"}
            </span>
          </div>
        </div>
        <WorkflowEditorDepartureGuard
          scope={scope}
          id={draft.workflowId}
          reading={reading}
          onDiscard={onDepart}
          onCheckSavedVersion={reconcile}
        />
        <div className={styles["workflow-editor-actions"]}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Workflow settings"
            onClick={openSettings}
          >
            <Settings2Icon />
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!canOpenRun}
            aria-describedby={vmRunUnavailable ? "workflow-vm-run-unavailable" : undefined}
            onClick={() => {
              if (canOpenRun)
                void navigate({
                  to: "/workflows/$repositoryId/$workflowId/run",
                  params: { repositoryId: scope.repositoryId, workflowId: draft.workflowId },
                });
            }}
          >
            {hasRunSubmission || hasRetainedInstructions ? (
              <ChevronRightIcon aria-hidden />
            ) : (
              <PlayIcon aria-hidden />
            )}
            {hasRunSubmission
              ? "View run submission"
              : hasRetainedInstructions
                ? "View retained instructions"
                : "Run"}
          </Button>
          <div className="flex items-center gap-2">
            <span role="status" className="text-xs text-muted-foreground">
              {pending
                ? "Saving…"
                : draft.operation
                  ? "Save needs retry"
                  : workflowEditorDirty(draft)
                    ? "Unsaved changes"
                    : "Saved"}
            </span>
            <Button type="submit" disabled={pending} ref={saveControl}>
              {draft.operation?.state === "uncertain" ? "Retry save" : "Save"}
            </Button>
          </div>
        </div>
      </div>
      {vmRunUnavailable ||
      codexNotice ||
      editorError ||
      draft.operation?.state === "uncertain" ||
      notice ||
      editorIssue ||
      models.issues.length ? (
        <div className={styles["workflow-editor-notices"]}>
          {vmRunUnavailable ? (
            <div id="workflow-vm-run-unavailable">
              <WorkflowAlert
                title="VM execution unavailable"
                variant="info"
                actions={
                  <Button type="button" size="sm" variant="outline" onClick={openSettings}>
                    Review execution target
                  </Button>
                }
              >
                Running VM workflows is not available yet. You can keep editing and saving this
                workflow.
              </WorkflowAlert>
            </div>
          ) : null}
          {codexNotice ? (
            <WorkflowAlert
              title="VM account needs attention"
              variant="warning"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => navigate({ to: "/settings/organization" })}
                >
                  Organization settings
                </Button>
              }
            >
              {codexNotice}
            </WorkflowAlert>
          ) : null}
          {editorError || draft.operation?.state === "uncertain" ? (
            <WorkflowAlert
              title={
                draft.operation?.state === "uncertain"
                  ? "Save not confirmed"
                  : editorIssue?.message === editorError
                    ? "Check workflow settings"
                    : "Could not save workflow"
              }
              actions={
                <>
                  {!draft.operation &&
                  editorIssue?.publishing &&
                  editorIssue.message === editorError
                    ? reviewIssueAction
                    : null}
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
                </>
              }
            >
              {editorError ??
                "Save could not be confirmed. Check the saved version before retrying."}{" "}
              Your edits are kept.
            </WorkflowAlert>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {editorIssue && editorIssue.message !== editorError ? (
            <WorkflowAlert
              title="Check workflow settings"
              variant="warning"
              actions={reviewIssueAction}
            >
              {editorIssue.message}
            </WorkflowAlert>
          ) : null}
          {models.issues.length ? (
            <WorkflowAlert
              title="Agent models need attention"
              variant="warning"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const first = models.issues[0];
                    if (!first) return;
                    choose(first.stepId);
                    setFocusRequest({ field: "model", stepId: first.stepId });
                  }}
                >
                  Review model settings
                </Button>
              }
            >
              <details>
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
            </WorkflowAlert>
          ) : null}
        </div>
      ) : null}
      <div className={styles["workflow-editor-body"]}>
        <WorkflowCanvas
          addStepRef={(node) => registerField("add-step", node)}
          triggerLabel={workflowTriggerLabel(workflowDraftAutomation(draft).trigger)}
          triggerSelected={triggerOpen}
          triggerIssue={automationReason}
          onTrigger={() => openTrigger()}
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
            setTriggerOpen(false);
            const inserted = insert(anchor, kind);
            if (inserted) setFocusRequest({ field: "title", stepId: inserted });
          }}
          onOverview={close}
          panelOpen={panelOpen}
        />
        {docked && panelOpen ? (
          <aside
            aria-label={
              triggerOpen
                ? "Trigger settings"
                : settingsOpen
                  ? "Workflow settings"
                  : "Selected step settings"
            }
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
                return inspectorReturnTarget() ?? true;
              }}
            >
              <SheetTitle className="sr-only">
                {triggerOpen
                  ? "Trigger settings"
                  : settingsOpen
                    ? "Workflow settings"
                    : "Selected step settings"}
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
