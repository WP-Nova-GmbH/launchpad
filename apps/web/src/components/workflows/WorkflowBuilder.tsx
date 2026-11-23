import { WorkflowAlert } from "./WorkflowAlert";
import * as Schema from "effect/Schema";
import {
  WORKFLOW_MAX_STEPS,
  WorkflowAutomation,
  WorkflowStep as WorkflowStepSchema,
  WorkflowTarget as WorkflowTargetSchema,
  workflowPublishingPrerequisites,
} from "@t3tools/contracts/workflows";
import { WorkflowEditorDepartureGuard } from "./WorkflowEditorDepartureGuard";
import { WorkflowTriggerInspector, workflowTriggerLabel } from "./WorkflowTriggerInspector";
import { WorkflowCheckoutPicker } from "./WorkflowCheckoutPicker";
import { WorkflowVmBaseBranch } from "./WorkflowVmBaseBranch";
import { WorkflowTargetSwitchNotice } from "./WorkflowTargetSwitchNotice";
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
  WorkflowTarget,
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
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { WorkflowStepEditor, useWorkflowEditorModels } from "./WorkflowStepEditor";
import { WorkflowStepMoveDialog } from "./WorkflowStepMoveDialog";
import {
  workflowMoveStepTitle,
  workflowStepMoveImpacts,
  type WorkflowStepMoveImpact,
} from "./workflowStepMove";
import { WorkflowStepRemovalDialog } from "./WorkflowStepRemovalDialog";
import { workflowStepRemovalImpacts, type WorkflowStepRemovalImpact } from "./workflowStepRemoval";
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
  ToggleLeftIcon,
  RefreshCwIcon,
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
  workflowSaveRevisionMatches,
  applyWorkflowSaveReceipt,
  normalizeWorkflowDefinitionForSave,
  workflowVmOffSave,
} from "./workflowOperations";

const isWorkflowAutomation = Schema.is(WorkflowAutomation);
const equivalentWorkflowSteps = Schema.toEquivalence(Schema.Array(WorkflowStepSchema));
const equivalentWorkflowTargets = Schema.toEquivalence(WorkflowTargetSchema);

function adjacentWorkflowStepMove(
  steps: ReadonlyArray<WorkflowStep>,
  stepId: string,
  offset: -1 | 1,
) {
  const index = steps.findIndex((step) => step.id === stepId);
  const destinationIndex = index + offset;
  const step = steps[index];
  const destination = steps[destinationIndex];
  if (!step || !destination) return null;
  const nextSteps = [...steps];
  nextSteps[index] = destination;
  nextSteps[destinationIndex] = step;
  return { step, destination, destinationIndex, nextSteps };
}

type DiscardReloadStatus = "loading" | "failed" | "draft-changed" | null;

function matchesDiscardedDraft(current: WorkflowEditorDraft, confirmed: WorkflowEditorDraft) {
  // Inspector navigation only changes selectedStepId and triggerSetup.
  return (
    current.workflowId === confirmed.workflowId &&
    current.baseline === confirmed.baseline &&
    current.definition === confirmed.definition &&
    current.automation === confirmed.automation &&
    current.automationResolved === confirmed.automationResolved &&
    current.targetConfirmed === confirmed.targetConfirmed &&
    current.lastVmTarget === confirmed.lastVmTarget &&
    current.lastMachineTarget === confirmed.lastMachineTarget &&
    current.lastVmBaseBranch === confirmed.lastVmBaseBranch &&
    current.operation === confirmed.operation &&
    current.saveRecovery === confirmed.saveRecovery &&
    current.error === confirmed.error
  );
}

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
  organizationAdmin?: boolean;
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
      key={workflowSessionKey(props.scope, id ? `editor:${id}` : props.isNew ? "new" : "missing")}
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
  organizationAdmin = false,
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
  const [departurePending, setDeparturePending] = useState(false);
  const state = useWorkflowDrafts();
  const key = workflowSessionKey(scope, id ?? "missing");
  const retainedDraft = id ? state.editors[key] : undefined;
  const runDraft = state.runs[key];
  const branchFailure =
    runDraft?.error &&
    !runDraft.operation &&
    runDraft.vmStartFailure?.kind === "base-branch-unavailable"
      ? runDraft.vmStartFailure
      : undefined;
  const rejectedRevision = runDraft?.vmStartFailureRevision ?? 0;
  const workflowRevision = workflow?.revision ?? 0;
  const [latestKnownRevision, setLatestKnownRevision] = useState(workflowRevision);
  if (workflowRevision > latestKnownRevision) setLatestKnownRevision(workflowRevision);
  const latestSavedRevision = useRef(latestKnownRevision);
  useLayoutEffect(() => {
    latestSavedRevision.current = latestKnownRevision;
  }, [latestKnownRevision]);
  const restoreCatalog = useRef({ projects, projectsUnavailable });
  useLayoutEffect(() => {
    restoreCatalog.current = { projects, projectsUnavailable };
  }, [projects, projectsUnavailable]);
  const readRequest = useRef<{ draft: WorkflowEditorDraft } | null>(null);
  const [reading, setReading] = useState(false);
  // Render the latest saved target before the inspector chooses its initial focus.
  const recoveredDraft =
    canConfigure &&
    openExecutionSettings &&
    branchFailure &&
    !reading &&
    workflow &&
    workflow.revision >= Math.max(rejectedRevision, latestKnownRevision) &&
    retainedDraft?.baseline &&
    workflow.revision > retainedDraft.baseline.revision &&
    !retainedDraft.operation &&
    !workflowEditorDirty(retainedDraft)
      ? savedWorkflowDraft(workflow, automationSupported)
      : undefined;
  const draft = recoveredDraft ?? retainedDraft;
  useLayoutEffect(() => {
    if (!recoveredDraft || isDeparting()) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) =>
      state.editors[key] === retainedDraft
        ? { ...state, editors: { ...state.editors, [key]: recoveredDraft } }
        : state,
    );
  }, [recoveredDraft, retainedDraft, scope.accountId, key, isDeparting]);
  const [notice, setNotice] = useState<string | null>(null);
  const [discardReloadStatus, setDiscardReloadStatus] = useState<DiscardReloadStatus>(null);
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
    if (!isNew || !id || !draft?.baseline || !active.current || isDeparting() || departurePending)
      return;
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
  }, [isNew, id, draft?.baseline, active, isDeparting, departurePending, scope, key, navigate]);
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
  const discardSavedRevision = Math.max(currentSaved?.revision ?? 0, latestKnownRevision);
  const archived = !!currentSaved?.archived;
  const issue = workflowDraftIssue(normalizeWorkflowDefinitionForSave(draft.definition));
  const edit = (update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft) =>
    editWorkflowDraft(scope, draft.workflowId, update);
  const save = async (turnOffOnly = false) => {
    const current = appAtomRegistry.get(workflowDraftAtom).editors[key];
    if (
      pending ||
      readRequest.current ||
      (current?.operation?.state === "uncertain" && current.saveRecovery !== "retryable")
    )
      return;
    if (!draft.operation && !turnOffOnly) {
      if (issue || !draft.targetConfirmed) return;
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
    setDiscardReloadStatus(null);
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
  const reload = async (confirmedDraft?: WorkflowEditorDraft, minimumRevision?: number) => {
    const request = beginRead();
    if (!request) return;
    try {
      if (
        confirmedDraft
          ? request.draft !== confirmedDraft
          : !(await confirmWorkflow("Discard unsaved edits and reload the saved workflow?"))
      )
        return;
      if (
        !ownsRead(request) ||
        appAtomRegistry.get(workflowDraftAtom).editors[key] !== request.draft
      )
        return;
      if (minimumRevision !== undefined) setDiscardReloadStatus("loading");
      const catalog = await call((client, token) =>
        client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
      );
      if (!ownsRead(request)) return;
      const saved = catalog.workflows.find(
        (entry) => entry.workflowId === request.draft.workflowId,
      );
      if (
        minimumRevision !== undefined &&
        (!saved || saved.revision < Math.max(minimumRevision, latestSavedRevision.current))
      ) {
        setDiscardReloadStatus("failed");
        return;
      }
      let applied = false;
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
        const current = state.editors[key];
        if (!ownsRead(request) || !current) return state;
        if (
          current !== request.draft &&
          (minimumRevision === undefined || !matchesDiscardedDraft(current, request.draft))
        )
          return state;
        applied = true;
        return {
          ...state,
          editors: {
            ...state.editors,
            [key]: saved
              ? {
                  ...savedWorkflowDraft(saved, catalog.automationSupported === true),
                  selectedStepId: saved.definition.steps.some(
                    (step) => step.id === current.selectedStepId,
                  )
                    ? current.selectedStepId
                    : "",
                  ...(minimumRevision !== undefined && current.triggerSetup === true
                    ? { triggerSetup: true }
                    : {}),
                }
              : {
                  ...request.draft,
                  error: "This workflow has no saved version yet. Your draft is retained.",
                },
          },
        };
      });
      if (minimumRevision !== undefined) {
        setDiscardReloadStatus(applied ? null : "draft-changed");
      } else if (!applied) {
        setNotice("Your draft changed while reload was loading. Your current edits were kept.");
      }
      if (applied && saved) refresh();
    } catch (cause) {
      if (minimumRevision !== undefined) {
        if (ownsRead(request)) setDiscardReloadStatus("failed");
        return;
      }
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
        if (current?.operation !== operation) return state;
        applied = true;
        return {
          ...state,
          editors: {
            ...state.editors,
            [key]: matched
              ? applyWorkflowSaveReceipt(current, operation, saved!)
              : {
                  ...current,
                  saveRecovery: workflowSaveRevisionMatches(saved, operation)
                    ? "retryable"
                    : "conflict",
                  error: null,
                },
          },
        };
      });
      if (applied && matched) refresh();
    } catch (cause) {
      if (ownsRead(request))
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
          const current = state.editors[key];
          return current?.operation === operation
            ? {
                ...state,
                editors: {
                  ...state.editors,
                  [key]: { ...current, saveRecovery: "check-failed", error: workflowError(cause) },
                },
              }
            : state;
        });
    } finally {
      finishRead(request);
    }
  };
  const discard = async (confirmedDraft?: WorkflowEditorDraft, reloadRevision?: number) => {
    const captured = appAtomRegistry.get(workflowDraftAtom).editors[key];
    if (
      !active.current ||
      readRequest.current ||
      !captured ||
      captured.operation?.state === "pending" ||
      (confirmedDraft && captured !== confirmedDraft)
    )
      return;
    if (captured.operation) {
      await navigate({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "workflows" },
      });
      return;
    }
    const baseline = captured.baseline;
    if (baseline && discardSavedRevision > baseline.revision) {
      if (confirmedDraft && reloadRevision === discardSavedRevision)
        await reload(confirmedDraft, reloadRevision);
      return;
    }
    if (!confirmedDraft && workflowEditorDirty(captured)) return;
    setNotice(null);
    if (!baseline) {
      onDepart();
      discardWorkflowEditor(appAtomRegistry, scope, captured.workflowId);
      await navigate({
        to: "/workflows/$repositoryId",
        params: { repositoryId: scope.repositoryId },
        search: { tab: "workflows" },
      });
    } else edit(() => savedWorkflowDraft(baseline, workflowDraftAutomationResolved(captured)));
  };
  const archive = async (confirmedDraft?: WorkflowEditorDraft) => {
    const captured = appAtomRegistry.get(workflowDraftAtom).editors[key];
    const baseline = captured?.baseline;
    if (!captured || !baseline || captured.operation) return;
    if (
      confirmedDraft
        ? confirmedDraft !== captured ||
          baseline.archived ||
          currentSaved?.revision !== baseline.revision
        : !baseline.archived
    )
      return;
    const restoreBlocked = () =>
      baseline.archived &&
      !!restoreCheckoutIssue(
        baseline,
        restoreCatalog.current.projects,
        restoreCatalog.current.projectsUnavailable,
      );
    if (restoreBlocked()) return;
    if (
      baseline.archived &&
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
    if (baseline.archived)
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
      if (index === null || steps.length >= WORKFLOW_MAX_STEPS) return draft;
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
  const savedTarget = currentSaved?.definition.target;
  const unavailableSavedBranch =
    branchFailure &&
    currentSaved &&
    currentSaved.revision >= Math.max(rejectedRevision, latestKnownRevision) &&
    savedTarget?.kind === "vm" &&
    savedTarget.baseBranch === branchFailure.branch
      ? branchFailure.branch
      : undefined;
  const hasRunSubmission =
    runDraft?.operation?.targetKind === "vm" ||
    ((archived || vmRunUnavailable) && runDraft?.operation?.state === "uncertain");
  return (
    <WorkflowBuilderWorkspace
      repositoryName={repositoryName}
      organizationAdmin={organizationAdmin}
      openExecutionSettings={openExecutionSettings}
      automationSupported={automationSupported}
      automationReason={automationReason}
      onDepart={onDepart}
      onDeparturePendingChange={setDeparturePending}
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
      savedRevision={currentSaved?.revision}
      latestSavedTarget={savedTarget}
      unavailableSavedBranch={unavailableSavedBranch}
      discardSavedRevision={discardSavedRevision}
      discardReloadStatus={discardReloadStatus}
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
  scrollIntoView?: boolean;
  selection?: {
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
    scrollTop: number;
  };
};

function WorkflowBuilderWorkspace({
  repositoryName,
  organizationAdmin,
  openExecutionSettings,
  draft,
  automationSupported,
  automationReason,
  onDepart,
  onDeparturePendingChange,
  projects,
  projectsUnavailable,
  refreshProjects,
  vmAuthoring,
  vmExecutionAvailable,
  vmAutomationAvailable,
  codexNotice,
  pending,
  archived,
  savedRevision,
  latestSavedTarget,
  unavailableSavedBranch,
  discardSavedRevision,
  discardReloadStatus,
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
  organizationAdmin: boolean;
  openExecutionSettings: boolean;
  draft: WorkflowEditorDraft;
  automationSupported: boolean;
  automationReason?: string | null | undefined;
  onDepart: () => void;
  onDeparturePendingChange: (pending: boolean) => void;
  projects: ReadonlyArray<RelayOrganizationProject>;
  projectsUnavailable: boolean | undefined;
  refreshProjects: () => void;
  vmExecutionAvailable: boolean;
  vmAuthoring: WorkflowCatalog["vmAuthoring"];
  vmAutomationAvailable: boolean;
  codexNotice: string | null;
  pending: boolean;
  archived: boolean;
  savedRevision: number | undefined;
  latestSavedTarget: WorkflowTarget | undefined;
  unavailableSavedBranch: string | null | undefined;
  discardSavedRevision: number;
  discardReloadStatus: DiscardReloadStatus;
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
  reload: (confirmedDraft?: WorkflowEditorDraft) => Promise<void>;
  reconcile: () => Promise<void>;
  discard: (confirmedDraft?: WorkflowEditorDraft, reloadRevision?: number) => Promise<void>;
  archive: (confirmedDraft?: WorkflowEditorDraft) => Promise<void>;
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
      return current && (current.triggerSetup === true) !== open
        ? { ...state, editors: { ...state.editors, [key]: { ...current, triggerSetup: open } } }
        : state;
    });
  // Measure before mounting a panel so a retained desktop selection never opens a transient Sheet.
  const [docked, setDocked] = useState<boolean | null>(null);
  const [machineEnrollmentGuideOpen, setMachineEnrollmentGuideOpen] = useState(false);
  const focusRequest = useRef<WorkflowFieldFocus | null>(null);
  const [focusVersion, setFocusVersion] = useState(0);
  const focusEpoch = useRef(0);
  const [movementVersion, setMovementVersion] = useState(0);
  const [stepMove, setStepMove] = useState<{
    step: WorkflowStep;
    destination: WorkflowStep;
    destinationIndex: number;
    offset: -1 | 1;
    steps: ReadonlyArray<WorkflowStep>;
    impacts: ReadonlyArray<WorkflowStepMoveImpact>;
  } | null>(null);
  const [stepRemoval, setStepRemoval] = useState<{
    step: WorkflowStep;
    steps: ReadonlyArray<WorkflowStep>;
    impacts: ReadonlyArray<WorkflowStepRemovalImpact>;
  } | null>(null);
  const stepConfirmationOpen = !!(stepMove || stepRemoval);
  const stepRemovalApplied = useRef(false);
  const [lastStepRemoval, setLastStepRemoval] = useState<{
    steps: ReadonlyArray<WorkflowStep>;
    name: string;
  } | null>(null);
  const [lastStepMove, setLastStepMove] = useState<{
    steps: ReadonlyArray<WorkflowStep>;
    stepId: string;
    message: string;
  } | null>(null);
  const removalNotice =
    lastStepRemoval?.steps === draft.definition.steps ? `${lastStepRemoval.name} removed` : "";
  const moveNotice =
    lastStepMove?.steps === draft.definition.steps && lastStepMove.stepId === draft.selectedStepId
      ? lastStepMove.message
      : "";
  const stepNotice = removalNotice || moveNotice;
  const presentation = useRef<boolean | null>(null);
  const panelIdentity = useRef<string | null>(null);
  const sheetReady = useRef(false);
  const mounted = useRef(true);
  const workspace = useRef<HTMLFormElement>(null);
  const settingsId = useId();
  const nameErrorId = `${settingsId}-name-error`;
  const targetSwitchStatusId = `${settingsId}-target-switch-status`;
  const executionTargetControl = useRef<HTMLButtonElement>(null);
  const saveControl = useRef<HTMLButtonElement>(null);
  const saveRecoveryControl = useRef<HTMLButtonElement>(null);
  const discardControl = useRef<HTMLButtonElement>(null);
  const keepEditingControl = useRef<HTMLButtonElement>(null);
  const [discardConfirmation, setDiscardConfirmation] = useState<{
    draft: WorkflowEditorDraft;
    open: boolean;
  } | null>(null);
  const discardBaseline = discardConfirmation?.draft.baseline;
  const newerSavedVersion = !!draft.baseline && discardSavedRevision > draft.baseline.revision;
  const discardDialogOpen =
    discardConfirmation?.open === true && discardConfirmation.draft === draft;
  const discardNeedsReload = !!discardBaseline && discardSavedRevision > discardBaseline.revision;
  const retryDiscardReload =
    discardReloadStatus === "failed" || discardReloadStatus === "draft-changed";
  const discardReloadFeedbackId = `${settingsId}-discard-reload`;
  const discardReloadFeedback = discardReloadStatus ? (
    <p
      id={discardReloadFeedbackId}
      role={retryDiscardReload ? "alert" : "status"}
      className={
        retryDiscardReload
          ? "basis-full text-xs text-destructive-foreground"
          : "basis-full text-xs text-muted-foreground"
      }
    >
      {discardReloadStatus === "loading"
        ? "Reloading saved version…"
        : discardReloadStatus === "failed"
          ? "Could not reload the saved version. Your draft is kept."
          : "Your draft changed during reload. Your current edits are kept."}
    </p>
  ) : null;
  const discardHasEdits = !!discardConfirmation && workflowEditorDirty(discardConfirmation.draft);
  const discardName =
    discardBaseline?.definition.name ?? discardConfirmation?.draft.definition.name.trim();
  useLayoutEffect(() => {
    if (discardDialogOpen && discardNeedsReload) keepEditingControl.current?.focus();
  }, [discardDialogOpen, discardNeedsReload]);
  const closeDiscardConfirmation = () =>
    setDiscardConfirmation((current) => (current ? { ...current, open: false } : null));
  const archiveControl = useRef<HTMLButtonElement>(null);
  const cancelArchiveControl = useRef<HTMLButtonElement>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    draft: WorkflowEditorDraft;
    open: boolean;
  } | null>(null);
  const archiveDiscardsEdits =
    !!archiveConfirmation && workflowEditorDirty(archiveConfirmation.draft);
  const archiveBaseline = archiveConfirmation?.draft.baseline;
  const archiveDisablesAutomation = archiveBaseline?.automation?.enabled === true;
  const archiveVersionChanged =
    !!archiveBaseline && savedRevision !== undefined && savedRevision > archiveBaseline.revision;
  const archiveDialogOpen =
    archiveConfirmation?.open === true && archiveConfirmation.draft === draft;
  useLayoutEffect(() => {
    if (archiveDialogOpen && archiveVersionChanged) cancelArchiveControl.current?.focus();
  }, [archiveDialogOpen, archiveVersionChanged]);
  const closeArchiveConfirmation = () =>
    setArchiveConfirmation((current) => (current ? { ...current, open: false } : null));
  const recoveringSave = draft.operation?.state === "uncertain";
  const saveConflict = draft.saveRecovery === "conflict";
  const saveRetryable = draft.saveRecovery === "retryable";
  const saveCheckFailed = draft.saveRecovery === "check-failed";
  const retryingSave = pending && saveRetryable;
  const showSaveRecovery = recoveringSave || retryingSave;
  const focusedRecoveryRemoval = useRef<HTMLButtonElement | null>(null);
  const registerSaveRecoveryControl = useCallback((node: HTMLButtonElement | null) => {
    saveRecoveryControl.current = node;
    if (!node) return;
    return () => {
      if (node.ownerDocument.activeElement === node) focusedRecoveryRemoval.current = node;
      saveRecoveryControl.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const previous = focusedRecoveryRemoval.current;
    if (!previous) return;
    const { activeElement, body } = previous.ownerDocument;
    if (activeElement !== body && activeElement !== previous) {
      focusedRecoveryRemoval.current = null;
      return;
    }
    const target = saveRecoveryControl.current ?? saveControl.current;
    if (!target || target.disabled) return;
    focusedRecoveryRemoval.current = null;
    target.focus();
  });
  const fields = useRef(new Map<string, HTMLElement>());
  const focusedCheckoutRemoval = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const targetModelReview = useRef<string | null>(null);
  const questionReviewControl = useRef<HTMLButtonElement>(null);
  const questionFocusPending = useRef(false);
  const selected = draft.definition.steps.find((step) => step.id === draft.selectedStepId);
  const removalBlockedReason = stepRemoval
    ? pending
      ? "Wait for the save to finish before removing this step."
      : selected?.id !== stepRemoval.step.id ||
          (stepRemoval.steps !== draft.definition.steps &&
            !equivalentWorkflowSteps(stepRemoval.steps, draft.definition.steps))
        ? "Workflow steps changed. Keep the step and reopen Remove step to review the current effects."
        : null
    : null;
  const moveBlockedReason = stepMove
    ? pending
      ? "Wait for the save to finish before moving this step."
      : selected?.id !== stepMove.step.id ||
          (stepMove.steps !== draft.definition.steps &&
            !equivalentWorkflowSteps(stepMove.steps, draft.definition.steps))
        ? "Workflow steps changed. Keep the current order and reopen Step actions to review the move."
        : null
    : null;
  const panelOpen = triggerOpen || settingsOpen || !!selected;
  const publishingIssueInInspector =
    issue?.publishing === true &&
    !triggerOpen &&
    !settingsOpen &&
    selected?.kind === "action" &&
    issue.stepId === selected.id;
  const missingName = !draft.definition.name.trim();
  const invalidStep = draft.definition.steps.find((step) => step.id === issue?.stepId);
  const missingStepPrompt =
    (issue?.field === "instruction" &&
      invalidStep?.kind === "agent" &&
      !invalidStep.instruction.trim()) ||
    (issue?.field === "question" && invalidStep?.kind === "input" && !invalidStep.question.trim());
  const questionInInspector =
    issue?.field === "question" && issue.stepId === selected?.id && !triggerOpen && !settingsOpen;
  const showPromptNotice = missingStepPrompt && !questionInInspector;
  const fieldValidationIssue =
    (issue?.field === "name" && missingName) ||
    (issue?.field === "baseBranch" && settingsOpen && !triggerOpen) ||
    missingStepPrompt;
  const editorIssue = publishingIssueInInspector || fieldValidationIssue ? null : issue;
  const editorError =
    !draft.operation &&
    (publishingIssueInInspector || fieldValidationIssue) &&
    draft.error === issue?.message
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
  const baselineTarget = draft.baseline?.definition.target;
  const baselineMachine = baselineTarget?.kind === "machine" ? baselineTarget : null;
  const savedMachine = latestSavedTarget?.kind === "machine" ? latestSavedTarget : null;
  const targetSwitch =
    baselineTarget && baselineTarget.kind !== draft.definition.target.kind
      ? draft.definition.target.kind
      : undefined;
  const targetVersionConflict =
    newerSavedVersion &&
    !!baselineTarget &&
    (!equivalentWorkflowTargets(baselineTarget, draft.definition.target) ||
      (!!latestSavedTarget && !equivalentWorkflowTargets(baselineTarget, latestSavedTarget)));
  const unavailableMachineTarget =
    !!machine &&
    !target &&
    (!savedMachine ||
      machine.environmentId !== savedMachine.environmentId ||
      machine.projectId !== savedMachine.projectId);
  const showMachineEnrollment =
    !projects.length &&
    !projectsUnavailable &&
    ((latestSavedTarget?.kind === "vm" && !!vm && !!vmAuthoring && draft.targetConfirmed) ||
      targetSwitch === "machine");
  const modelIssues =
    targetSwitch === "vm" && draft.targetConfirmed
      ? draft.definition.steps.flatMap((step) => {
          if (step.kind !== "agent") return [];
          const issue = models.issues.find((entry) => entry.stepId === step.id);
          if (issue) return [issue];
          const detail = step.modelSelection ? null : models.defaultDisabledReason(step);
          return detail ? [{ stepId: step.id, title: step.title, detail }] : [];
        })
      : models.issues;
  const switchDestination =
    targetSwitch &&
    draft.targetConfirmed &&
    !draft.operation &&
    !targetVersionConflict &&
    !unavailableMachineTarget &&
    (!vm || (!!vmAuthoring && !(vmTriggerUnavailable && automation.enabled))) &&
    issue?.field !== "baseBranch"
      ? targetSwitch
      : undefined;
  const showSwitchNotice = !!switchDestination && settingsOpen && !triggerOpen;
  const showEditorModelIssues = modelIssues.length > 0 && !showSwitchNotice;
  const agentSteps = draft.definition.steps.filter((step) => step.kind === "agent");
  const usesDefaultModels =
    !!switchDestination &&
    !modelIssues.length &&
    agentSteps.length > 0 &&
    agentSteps.every(({ modelSelection }) => !modelSelection);
  const checkoutWarning =
    draft.targetConfirmed && machine && !target && !projectsUnavailable
      ? latestSavedTarget?.kind === "machine" &&
        latestSavedTarget.environmentId === machine.environmentId &&
        latestSavedTarget.projectId === machine.projectId
        ? "Saved checkout unavailable"
        : "Selected checkout unavailable"
      : null;
  const vmBranchLabel =
    vm?.baseBranch === null
      ? "Repository default"
      : vm?.baseBranch?.trim() || "Branch name required";
  const targetLabel = draft.targetConfirmed
    ? vm
      ? `VM · ${vmBranchLabel}`
      : target
        ? `${target.machineLabel} · ${target.title}`
        : (checkoutWarning ?? "Machine checkouts could not be loaded")
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
  const savedMachineFallback =
    baselineMachine && savedMachine && equivalentWorkflowTargets(baselineMachine, savedMachine)
      ? baselineMachine
      : null;
  const canChooseMachine = projects.length > 0 || (!!vm && !!savedMachineFallback);
  const showCheckout = (!vmAuthoring || !!machine) && projects.length > 0;
  const targetSwitchStatus = draft.operation
    ? ""
    : targetVersionConflict
      ? "A newer version is saved. Reload the saved workflow before switching targets."
      : targetSwitch === "machine" &&
          showCheckout &&
          (!draft.targetConfirmed || unavailableMachineTarget)
        ? "Choose a checkout before saving the switch."
        : switchDestination && (switchDestination === "machine" || !modelIssues.length)
          ? `Save to switch this workflow to ${switchDestination === "vm" ? "VM" : "Machine"}.`
          : "";
  const machineSettingsField = showCheckout
    ? "checkout"
    : vmAuthoring && projects.length
      ? "target:machine"
      : projectsUnavailable || showMachineEnrollment
        ? "refresh-checkouts"
        : "close-settings";
  const recoveryField =
    !projectsUnavailable && !projects.length && canChooseVm ? "target:vm" : machineSettingsField;
  const branchRecoveryField =
    vm && draft.targetConfirmed && unavailableSavedBranch !== undefined
      ? vm.baseBranch === null
        ? "baseBranch:default"
        : "baseBranch"
      : null;
  const entryFocus = useRef<WorkflowFieldFocus | null>(
    openExecutionSettings
      ? {
          field: pending ? "close-settings" : (branchRecoveryField ?? recoveryField),
          stepId: null,
          scrollIntoView: !pending && branchRecoveryField !== null,
        }
      : null,
  );
  const machineDescription = projects.length
    ? "Use an enrolled repository checkout."
    : projectsUnavailable
      ? "Machine checkouts could not be loaded."
      : savedMachine
        ? "The saved Machine checkout is unavailable."
        : "No enrolled checkout for this repository.";
  const vmDescription = !canChooseVm
    ? "Turn off automatic triggering before choosing VM."
    : !vmExecutionAvailable
      ? "VM runs are unavailable."
      : "Run in a managed workspace.";
  const registerField = useCallback((field: string, node: HTMLElement | null) => {
    if (node) fields.current.set(field, node);
    else fields.current.delete(field);
  }, []);
  const registerCheckoutRecoveryField = useCallback((field: string, node: HTMLElement | null) => {
    if (!node) return;
    fields.current.set(field, node);
    return () => {
      if (node.ownerDocument.activeElement === node) focusedCheckoutRemoval.current = node;
      if (fields.current.get(field) === node) fields.current.delete(field);
    };
  }, []);
  const registerCheckoutRefresh = useCallback(
    (node: HTMLButtonElement | null) => registerCheckoutRecoveryField("refresh-checkouts", node),
    [registerCheckoutRecoveryField],
  );
  const registerMachineEnrollmentGuide = useCallback(
    (node: HTMLElement | null) => registerCheckoutRecoveryField("machine-enrollment-guide", node),
    [registerCheckoutRecoveryField],
  );
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
      (request.field === "repair"
        ? focusableField(`${request.stepId}:repair-warning`)
        : request.field === "refresh-checkouts"
          ? (focusableField(machineSettingsField) ?? focusableField("close-settings"))
          : undefined);
    focusRequest.current = null;
    if (!node) return false;
    node.focus({
      preventScroll:
        !request.scrollIntoView && request.field !== "repair" && request.field !== "repair-warning",
    });
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
  }, [machineSettingsField]);
  const restoreCheckoutFocus = useCallback(() => {
    const previous = focusedCheckoutRemoval.current;
    if (!previous || panelIdentity.current !== "workflow") return false;
    focusedCheckoutRemoval.current = null;
    const { activeElement, body } = previous.ownerDocument;
    if (focusRequest.current || (activeElement !== previous && activeElement !== body))
      return false;
    focusRequest.current = { field: "refresh-checkouts", stepId: null, scrollIntoView: true };
    return focusPending();
  }, [focusPending]);
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
    if (panelKey !== "workflow") focusedCheckoutRemoval.current = null;
    else if (docked === true || sheetReady.current) restoreCheckoutFocus();
  });
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
  const applyStepMove = (
    steps: ReadonlyArray<WorkflowStep>,
    stepId: string,
    nextSteps: ReadonlyArray<WorkflowStep>,
  ) => {
    let applied = false;
    edit((current) => {
      if (current.definition.steps !== steps || current.selectedStepId !== stepId) return current;
      applied = true;
      return { ...current, definition: { ...current.definition, steps: nextSteps } };
    });
    if (applied) setMovementVersion((version) => version + 1);
    return applied;
  };
  const requestStepMove = (step: WorkflowStep, offset: -1 | 1) => {
    if (pending || stepConfirmationOpen || selected?.id !== step.id) return false;
    const steps = draft.definition.steps;
    const move = adjacentWorkflowStepMove(steps, step.id, offset);
    if (!move) return false;
    const impacts = workflowStepMoveImpacts(steps, move.nextSteps);
    if (!impacts.length) {
      applyStepMove(steps, step.id, move.nextSteps);
      return false;
    }
    setStepMove({
      step: move.step,
      destination: move.destination,
      destinationIndex: move.destinationIndex,
      offset,
      steps,
      impacts,
    });
    return true;
  };
  const confirmStepMove = () => {
    if (!stepMove || moveBlockedReason) return;
    const steps = draft.definition.steps;
    const move = adjacentWorkflowStepMove(steps, stepMove.step.id, stepMove.offset);
    if (!move || !applyStepMove(steps, stepMove.step.id, move.nextSteps)) return;
    setLastStepMove({
      steps: move.nextSteps,
      stepId: move.step.id,
      message: `Moved ${stepMove.offset === -1 ? "above" : "below"} ${workflowMoveStepTitle(move.destination)}`,
    });
    setStepMove(null);
  };
  const removeStep = (step: WorkflowStep, impact?: WorkflowStepRemovalImpact) => {
    const steps = draft.definition.steps;
    const index = steps.findIndex((entry) => entry.id === step.id);
    if (index < 0) return false;
    const nextId = impact?.step.id ?? steps[index + 1]?.id ?? steps[index - 1]?.id ?? "";
    const remaining = steps.filter((entry) => entry.id !== step.id);
    let applied = false;
    edit((current) => {
      if (current.definition.steps !== steps || current.selectedStepId !== step.id) return current;
      applied = true;
      return {
        ...current,
        definition: { ...current.definition, steps: remaining },
        selectedStepId: nextId,
      };
    });
    if (!applied) return false;
    setLastStepRemoval(impact ? null : { steps: remaining, name: step.title.trim() || "Step" });
    if (nextId) {
      const field =
        !impact || impact.kind === "publishing-retargeted" || impact.kind === "review-result"
          ? "title"
          : impact.kind === "publishing-agent"
            ? "repair-warning"
            : impact.kind === "publishing-push"
              ? "repair"
              : "rework";
      setFocusRequest({ field, stepId: nextId, scrollIntoView: !!impact });
    } else {
      returnFocus.current = fields.current.get("add-step") ?? null;
      setFocusRequest({ field: "add-step", stepId: null });
    }
    return true;
  };
  const requestStepRemoval = (step: WorkflowStep) => {
    if (pending || stepConfirmationOpen || selected?.id !== step.id) return false;
    const steps = draft.definition.steps;
    const impacts = workflowStepRemovalImpacts(steps, step.id);
    if (!impacts.length) return removeStep(step);
    stepRemovalApplied.current = false;
    setStepRemoval({ step, steps, impacts });
    return true;
  };
  const choose = (id: string) => {
    targetModelReview.current = null;
    setLastStepRemoval(null);
    setLastStepMove(null);
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
    const opener = returnFocus.current;
    if (opener?.isConnected && !opener.matches(':disabled, [aria-disabled="true"]')) return opener;
    const fallback =
      (pending || reading ? null : (saveRecoveryControl.current ?? saveControl.current)) ??
      executionTargetControl.current;
    const questionStepId = opener?.getAttribute("data-workflow-question-review");
    if (questionStepId) {
      const action = questionReviewControl.current;
      return action?.getAttribute("data-workflow-question-review") === questionStepId &&
        !action.disabled
        ? action
        : fallback;
    }
    if (opener?.matches("[data-workflow-validation-action]"))
      return (
        workspace.current?.querySelector<HTMLButtonElement>(
          "[data-workflow-validation-action]:not(:disabled)",
        ) ?? fallback
      );
    if (triggerOpen) return canvasTrigger();
    return settingsOpen ? executionTargetControl.current : null;
  };
  const stepActionsReturnTarget = () => {
    if (!mounted.current) return false;
    const actions = fields.current.get(`${selected?.id}:actions`);
    if (actions?.isConnected && !actions.matches(':disabled, [aria-disabled="true"]'))
      return actions;
    return inspectorReturnTarget() ?? true;
  };
  const restoreQuestionFocus = () => {
    if (!questionFocusPending.current) return;
    questionFocusPending.current = false;
    inspectorReturnTarget()?.focus();
  };
  useEffect(() => {
    if (docked && !panelOpen) restoreQuestionFocus();
  });
  const close = () => {
    const reviewedModel = targetModelReview.current;
    if (reviewedModel) {
      targetModelReview.current = null;
      const nextModel =
        modelIssues.find(({ stepId }) => stepId === reviewedModel) ?? modelIssues[0];
      returnFocus.current = executionTargetControl.current;
      setSettingsOpen(true);
      setTriggerOpen(false);
      select("");
      setFocusRequest({
        field:
          switchDestination && nextModel ? `target-model:${nextModel.stepId}` : "close-settings",
        stepId: null,
        scrollIntoView: !!(switchDestination && nextModel),
      });
      return;
    }
    // The question action remounts after closing.
    const questionOpener = !!returnFocus.current?.getAttribute("data-workflow-question-review");
    questionFocusPending.current = questionOpener;
    if (!questionOpener) returnFocus.current = inspectorReturnTarget() ?? null;
    setFocusRequest(null);
    setSettingsOpen(false);
    setTriggerOpen(false);
    select("");
    if (!questionOpener) returnFocus.current?.focus();
  };
  const openSettings = () => {
    targetModelReview.current = null;
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
      scrollIntoView: missingStepPrompt || problem.field === "baseBranch",
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
  const reviewModel = (stepId: string, opener?: HTMLElement) => {
    choose(stepId);
    if (opener) returnFocus.current = opener;
    setFocusRequest({ field: "model", stepId, scrollIntoView: true });
  };
  const reviewTargetModel = (stepId: string) => {
    reviewModel(stepId, executionTargetControl.current ?? undefined);
    targetModelReview.current = stepId;
  };
  const insertPushBranch = () => {
    if (selected?.kind !== "action" || selected.action !== "open_pull_request") return;
    const preceding = draft.definition.steps[draft.definition.steps.indexOf(selected) - 1];
    if (preceding && insert({ after: preceding }, "action", selected.id)) {
      setFocusRequest({ field: "title", stepId: selected.id });
    }
  };
  const openTrigger = (opener?: HTMLElement | null) => {
    targetModelReview.current = null;
    setFocusRequest(null);
    setSettingsOpen(false);
    select("");
    returnFocus.current = opener ?? canvasTrigger() ?? null;
    setTriggerOpen(true);
  };
  const submit = async (submitter?: HTMLElement) => {
    if (pending || reading) return;
    if (recoveringSave) {
      saveRecoveryControl.current?.focus();
      return;
    }
    if (targetVersionConflict) {
      if (!settingsOpen || triggerOpen) openSettings();
      setFocusRequest({ field: "reload-target", stepId: null, scrollIntoView: true });
      return;
    }
    if (offSave && !hasOtherEdits && !automation.enabled) {
      await save(true);
      return;
    }
    const problem = issue;
    if (problem) {
      if (problem.field === "baseBranch") {
        if (!settingsOpen || triggerOpen) openSettings();
        focusIssue(problem);
        return;
      }
      if (problem.field === "name" && missingName)
        returnFocus.current = fields.current.get("name") ?? null;
      else if (problem.publishing || missingStepPrompt)
        returnFocus.current = submitter ?? saveControl.current;
      if (!fieldValidationIssue) edit((current) => ({ ...current, error: problem.message }));
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
    if (!draft.targetConfirmed || unavailableMachineTarget || (vm && !vmAuthoring)) {
      openSettings();
      edit((current) => ({
        ...current,
        error:
          vm && !vmAuthoring
            ? "Update the relay to save a VM workflow."
            : "Choose an available execution target before saving.",
      }));
      setFocusRequest({
        field:
          machine && (showCheckout || projectsUnavailable || showMachineEnrollment)
            ? machineSettingsField
            : vmAuthoring && projects.length
              ? "target:machine"
              : canChooseVm
                ? "target:vm"
                : "close-settings",
        stepId: null,
      });
      return;
    }
    const modelIssue = vm ? modelIssues[0] : undefined;
    if (modelIssue) {
      if (showSwitchNotice) reviewTargetModel(modelIssue.stepId);
      else reviewModel(modelIssue.stepId, submitter ?? saveControl.current ?? undefined);
      return;
    }
    setFocusRequest(null);
    await save();
  };
  const discardReloadOutsideSettings =
    discardReloadFeedback && (triggerOpen || !settingsOpen) ? (
      <div className="flex flex-wrap items-center gap-2">
        {discardReloadFeedback}
        {retryDiscardReload ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby={discardReloadFeedbackId}
            onClick={() => {
              openSettings();
              setFocusRequest({ field: "discard-changes", stepId: null, scrollIntoView: true });
            }}
          >
            Open workflow settings
          </Button>
        ) : null}
      </div>
    ) : null;
  const discardReloadInSheet = docked === false && panelOpen ? discardReloadOutsideSettings : null;
  const discardReloadInEditor = discardReloadInSheet ? null : discardReloadOutsideSettings;
  const panel = triggerOpen ? (
    <WorkflowTriggerInspector
      scope={scope}
      automation={draft.automation ?? draft.baseline?.automation}
      savedAutomation={draft.baseline?.automation}
      unsaved={workflowEditorDirty(draft)}
      onSave={() => void submit()}
      onReviewSave={
        recoveringSave
          ? () => {
              setFocusRequest(null);
              returnFocus.current = saveRecoveryControl.current;
              setTriggerOpen(false);
              select("");
              if (docked) returnFocus.current?.focus();
            }
          : undefined
      }
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
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 id={`${settingsId}-target`} className="text-sm font-medium">
              Execution target
            </h3>
            {latestSavedTarget ? (
              <p id={`${settingsId}-saved-target`} className="text-xs text-muted-foreground">
                Saved target{" "}
                <strong className="font-medium text-foreground">
                  {latestSavedTarget.kind === "machine" ? "Machine" : "VM"}
                </strong>
              </p>
            ) : null}
          </div>
          {vmAuthoring ? (
            <>
              {!machine && !draft.targetConfirmed ? (
                <p className="text-xs text-muted-foreground">Choose a target</p>
              ) : null}
              <RadioGroup
                aria-labelledby={`${settingsId}-target`}
                aria-describedby={latestSavedTarget ? `${settingsId}-saved-target` : undefined}
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
                        ...(target.kind === "machine"
                          ? { lastMachineTarget: { target, confirmed: current.targetConfirmed } }
                          : {}),
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
                  if (value !== "machine" || !canChooseMachine) return;
                  edit((current) => {
                    const { lastMachineTarget, ...draft } = current;
                    const lastVmTarget = draft.definition.target;
                    if (lastVmTarget.kind === "machine") return current;
                    const project = projects[0];
                    const machineTarget = project
                      ? (lastMachineTarget?.target ??
                        baselineMachine ?? {
                          kind: "machine" as const,
                          environmentId: project.environmentId,
                          projectId: project.projectId,
                        })
                      : savedMachineFallback;
                    if (!machineTarget) return current;
                    return {
                      ...draft,
                      lastVmTarget,
                      targetConfirmed:
                        !project ||
                        (lastMachineTarget?.confirmed ??
                          (!!baselineMachine || projects.length === 1)),
                      error: null,
                      definition: { ...draft.definition, target: machineTarget },
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
                    disabled={!canChooseMachine}
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
          ) : vm || latestSavedTarget ? (
            <p className="text-xs text-muted-foreground">
              {vm
                ? "Update the relay to save a VM workflow."
                : "VM workflow settings are unavailable on this relay."}
            </p>
          ) : null}
          {showCheckout ? (
            <WorkflowCheckoutPicker
              id={`${settingsId}-checkout`}
              projects={projects}
              selected={draft.targetConfirmed ? (target ?? null) : null}
              warning={checkoutWarning}
              disabled={pending}
              triggerRef={(node) => registerField("checkout", node)}
              onChoose={(next) =>
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
                }))
              }
            />
          ) : checkoutWarning && !showMachineEnrollment ? (
            <WorkflowAlert variant="warning" title={checkoutWarning}>
              Your workflow edits are kept.
            </WorkflowAlert>
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
                ref={registerCheckoutRefresh}
                onClick={refreshProjects}
              >
                Retry loading checkouts
              </Button>
            </div>
          ) : showMachineEnrollment ? (
            <WorkflowAlert
              title="No Machine checkout available"
              variant={targetSwitch === "machine" ? "warning" : "info"}
              announce={false}
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  ref={registerCheckoutRefresh}
                  onClick={refreshProjects}
                >
                  Refresh checkouts
                </Button>
              }
            >
              {organizationAdmin ? (
                <>
                  <p>Connect an organization machine with a checkout of this repository.</p>
                  <details className="mt-2" open={machineEnrollmentGuideOpen}>
                    <summary
                      id={`${settingsId}-machine-enrollment-guide`}
                      ref={registerMachineEnrollmentGuide}
                      className="cursor-pointer font-medium"
                      onClick={(event) => {
                        event.preventDefault();
                        setMachineEnrollmentGuideOpen((open) => !open);
                      }}
                    >
                      Where to connect
                    </summary>
                    <p className="mt-1">Settings → Organization → Machines</p>
                    <p className="mt-1">
                      Choose Connect your own machine, then open this repository as a project on
                      that machine.
                    </p>
                  </details>
                </>
              ) : (
                "Ask an organization admin to connect a machine with a checkout of this repository."
              )}
            </WorkflowAlert>
          ) : !projects.length && (machine || (!vmAuthoring && !vm)) ? (
            <p className="text-xs text-muted-foreground">
              {!vmAuthoring ? `${machineDescription} ` : null}
              {canChooseVm && vmExecutionAvailable
                ? "Choose VM or enroll a checkout to run this workflow."
                : "Enroll a checkout to run this workflow."}
            </p>
          ) : null}
          {vm && draft.targetConfirmed ? (
            <WorkflowVmBaseBranch
              id={settingsId}
              baseBranch={vm.baseBranch}
              unavailableSavedBranch={unavailableSavedBranch}
              disabled={pending}
              registerField={registerField}
              onChange={(nextBranch) =>
                edit((current) => {
                  const target = current.definition.target;
                  if (target.kind !== "vm") return current;
                  const baseBranch =
                    nextBranch === "" && target.baseBranch === null
                      ? (current.lastVmBaseBranch ?? "")
                      : nextBranch;
                  return {
                    ...current,
                    lastVmBaseBranch:
                      baseBranch === null ? (target.baseBranch ?? undefined) : undefined,
                    definition: { ...current.definition, target: { ...target, baseBranch } },
                  };
                })
              }
            />
          ) : null}
          {usesDefaultModels ? (
            <p className="text-xs text-muted-foreground">
              Agent models use the {vm ? "managed default" : "project default"}.
            </p>
          ) : null}
          {switchDestination ? (
            <WorkflowTargetSwitchNotice
              destination={switchDestination}
              steps={draft.definition.steps}
              issues={modelIssues}
              disabled={pending}
              registerReviewButton={(stepId, node) => registerField(`target-model:${stepId}`, node)}
              onReviewModel={reviewTargetModel}
            />
          ) : null}
          <p
            id={targetSwitchStatusId}
            role="status"
            className={targetSwitchStatus ? "text-xs text-muted-foreground" : "sr-only"}
          >
            {targetSwitchStatus}
          </p>
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
          <Button
            ref={(node) => {
              discardControl.current = node;
              registerField("reload-target", node);
              registerField("discard-changes", node);
            }}
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled={reading || undefined}
            aria-describedby={
              [
                targetVersionConflict && !draft.operation ? targetSwitchStatusId : null,
                discardReloadStatus ? discardReloadFeedbackId : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onClick={() => {
              if (reading) return;
              if (draft.operation || (!workflowEditorDirty(draft) && !newerSavedVersion))
                void discard();
              else setDiscardConfirmation({ draft, open: true });
            }}
          >
            {retryDiscardReload
              ? "Retry reload"
              : targetVersionConflict && !draft.operation
                ? "Reload saved version"
                : "Discard changes"}
          </Button>
          <AlertDialog
            open={discardDialogOpen}
            onOpenChange={(open) => {
              if (!open) closeDiscardConfirmation();
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setDiscardConfirmation(null);
            }}
          >
            <AlertDialogPopup
              variant="scrollable"
              initialFocus={keepEditingControl}
              finalFocus={() =>
                discardControl.current && !discardControl.current.matches(":disabled")
                  ? discardControl.current
                  : (fields.current.get("close-settings") ?? executionTargetControl.current)
              }
            >
              <AlertDialogHeader
                className="min-h-0 overflow-y-auto overscroll-contain"
                tabIndex={0}
              >
                <AlertDialogTitle>
                  {discardNeedsReload
                    ? "Newer saved version available"
                    : discardBaseline
                      ? "Discard unsaved edits?"
                      : "Discard draft?"}
                </AlertDialogTitle>
                <AlertDialogDescription
                  render={<div />}
                  className="space-y-3 wrap-anywhere"
                  aria-live="polite"
                >
                  {discardBaseline ? (
                    <p>
                      {discardNeedsReload
                        ? "Load the latest saved version of "
                        : "Restore the saved version of "}
                      <strong className="font-medium text-popover-foreground">{discardName}</strong>
                      {discardNeedsReload
                        ? discardHasEdits
                          ? " and discard your unsaved edits."
                          : "."
                        : " and keep the editor open."}
                    </p>
                  ) : (
                    <p>
                      {discardName ? (
                        <>
                          Remove the{" "}
                          <strong className="font-medium text-popover-foreground">
                            {discardName}
                          </strong>{" "}
                          draft
                        </>
                      ) : (
                        "Remove this workflow draft"
                      )}{" "}
                      and return to Workflows.
                    </p>
                  )}
                  {discardNeedsReload && discardHasEdits ? (
                    <Alert role={undefined} controlAlignment="first-line">
                      <RefreshCwIcon aria-hidden />
                      <AlertDescription>
                        Your edits stay in the editor if reload fails.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="shrink-0">
                <Button
                  ref={keepEditingControl}
                  type="button"
                  variant="outline"
                  onClick={closeDiscardConfirmation}
                >
                  Keep editing
                </Button>
                <Button
                  key={discardNeedsReload ? "reload" : "discard"}
                  type="button"
                  variant={discardHasEdits ? "destructive" : "default"}
                  disabled={reading}
                  onClick={() => {
                    if (!discardDialogOpen) return;
                    closeDiscardConfirmation();
                    void discard(
                      discardConfirmation.draft,
                      discardNeedsReload ? discardSavedRevision : undefined,
                    );
                  }}
                >
                  {discardNeedsReload
                    ? discardHasEdits
                      ? "Discard edits and reload"
                      : "Reload saved version"
                    : discardBaseline
                      ? "Discard edits"
                      : "Discard draft"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          {draft.baseline ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!!draft.operation || !!restoreIssue}
              aria-describedby={restoreIssue ? `${settingsId}-restore-warning` : undefined}
              ref={archiveControl}
              onClick={() => {
                if (draft.baseline?.archived) void archive();
                else setArchiveConfirmation({ draft, open: true });
              }}
            >
              {draft.baseline.archived ? "Restore workflow" : "Archive workflow"}
            </Button>
          ) : null}
          <AlertDialog
            open={archiveDialogOpen}
            onOpenChange={(open) => {
              if (!open) closeArchiveConfirmation();
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setArchiveConfirmation(null);
            }}
          >
            <AlertDialogPopup
              variant="scrollable"
              initialFocus={cancelArchiveControl}
              finalFocus={() =>
                archiveControl.current && !archiveControl.current.disabled
                  ? archiveControl.current
                  : (fields.current.get("close-settings") ?? executionTargetControl.current)
              }
            >
              <AlertDialogHeader
                className="min-h-0 overflow-y-auto overscroll-contain"
                tabIndex={0}
              >
                <AlertDialogTitle>
                  {archiveVersionChanged ? "Saved version changed" : "Archive workflow?"}
                </AlertDialogTitle>
                <AlertDialogDescription
                  render={<div />}
                  className="space-y-3 wrap-anywhere"
                  aria-live="polite"
                >
                  {archiveVersionChanged ? (
                    <p>
                      Reload the saved workflow before archiving.
                      {archiveDiscardsEdits
                        ? " Your edits are still in this draft. Reloading replaces them with the saved version."
                        : null}
                    </p>
                  ) : (
                    <>
                      <p>
                        Archiving{" "}
                        <strong className="font-medium text-popover-foreground">
                          {archiveBaseline?.definition.name}
                        </strong>{" "}
                        prevents new runs and keeps its run history available.
                        {!archiveDiscardsEdits && !archiveDisablesAutomation
                          ? " You can restore it from Archived workflows."
                          : null}
                      </p>
                      {archiveDisablesAutomation ? (
                        <Alert role={undefined} controlAlignment="first-line">
                          <ToggleLeftIcon aria-hidden />
                          <AlertTitle>Automatic triggering turns off</AlertTitle>
                          <AlertDescription>
                            It stays off after you restore the workflow.
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      {archiveDiscardsEdits ? (
                        <WorkflowAlert
                          title="Your unsaved edits will be lost"
                          variant="warning"
                          announce={false}
                        >
                          Archiving uses the last saved version.
                        </WorkflowAlert>
                      ) : null}
                    </>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="shrink-0">
                <Button
                  ref={cancelArchiveControl}
                  type="button"
                  variant="outline"
                  onClick={closeArchiveConfirmation}
                >
                  {archiveDiscardsEdits || archiveVersionChanged ? "Keep editing" : "Cancel"}
                </Button>
                {archiveVersionChanged ? (
                  <Button
                    key="reload"
                    type="button"
                    variant={archiveDiscardsEdits ? "destructive" : "default"}
                    disabled={reading}
                    onClick={() => {
                      if (!archiveDialogOpen) return;
                      closeArchiveConfirmation();
                      void reload(archiveConfirmation.draft);
                    }}
                  >
                    {archiveDiscardsEdits ? "Discard edits and reload" : "Reload saved version"}
                  </Button>
                ) : (
                  <Button
                    key="archive"
                    type="button"
                    variant={archiveDiscardsEdits ? "destructive" : "default"}
                    onClick={() => {
                      if (!archiveDialogOpen) return;
                      closeArchiveConfirmation();
                      void archive(archiveConfirmation.draft);
                    }}
                  >
                    {archiveDiscardsEdits ? "Discard edits and archive" : "Archive workflow"}
                  </Button>
                )}
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          {discardReloadFeedback}
        </footer>
      </fieldset>
    </div>
  ) : selected ? (
    <>
      <p
        role="status"
        className={
          stepNotice ? "border-b px-4 py-2 text-xs wrap-anywhere text-muted-foreground" : "sr-only"
        }
      >
        {stepNotice}
      </p>
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
        onRequestRemove={requestStepRemoval}
        change={(steps) => {
          reorder(steps);
        }}
        onRequestMove={requestStepMove}
      />
    </>
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
            aria-invalid={missingName || undefined}
            aria-describedby={missingName ? nameErrorId : undefined}
            placeholder="Workflow name"
            data-workflow-field="name"
            required
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
          {missingName ? (
            <p id={nameErrorId} role="alert" className="mt-1 text-xs text-destructive-foreground">
              Enter a workflow name.
            </p>
          ) : null}
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
                    <span>{vmBranchLabel}</span>
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
          onDepart={onDepart}
          onDeparturePendingChange={onDeparturePendingChange}
          onCheckSavedVersion={reconcile}
          saveRecoveryFocusRef={saveRecoveryControl}
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
          {!showSaveRecovery ? (
            <div className="flex items-center gap-2">
              <span role="status" className="text-xs text-muted-foreground">
                {pending ? "Saving…" : workflowEditorDirty(draft) ? "Unsaved changes" : "Saved"}
              </span>
              <Button type="submit" disabled={pending || reading} ref={saveControl}>
                Save
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {vmRunUnavailable ||
      codexNotice ||
      editorError ||
      showSaveRecovery ||
      notice ||
      discardReloadInEditor ||
      editorIssue ||
      showPromptNotice ||
      showEditorModelIssues ? (
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
          {showSaveRecovery ? (
            <WorkflowAlert
              title={
                retryingSave
                  ? "Retrying save…"
                  : saveConflict
                    ? "Saved version changed"
                    : saveRetryable
                      ? "Save didn’t land"
                      : "Save not confirmed"
              }
              variant={saveRetryable ? "info" : "warning"}
              actions={
                <>
                  {saveConflict || saveCheckFailed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={reading}
                      onClick={() => void reload()}
                    >
                      Reload saved version
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    ref={registerSaveRecoveryControl}
                    aria-disabled={reading || retryingSave}
                    onClick={() => {
                      if (reading || retryingSave) return;
                      if (saveConflict) fields.current.get("name")?.focus();
                      else if (saveRetryable) void save();
                      else void reconcile();
                    }}
                  >
                    {saveConflict
                      ? "Keep editing"
                      : saveRetryable
                        ? "Retry original save"
                        : "Check saved version"}
                  </Button>
                </>
              }
            >
              {retryingSave
                ? "Edits made since the original attempt stay in your draft."
                : saveConflict
                  ? "Your edits are still in this draft. Reloading replaces them with the saved version."
                  : saveRetryable
                    ? "The saved version is unchanged. Edits made since that attempt stay in your draft."
                    : "The save may have completed. Your edits are still in the draft."}
              {editorError ? <p>{editorError}</p> : null}
            </WorkflowAlert>
          ) : editorError ? (
            <WorkflowAlert
              title={
                editorIssue?.message === editorError
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
                </>
              }
            >
              {editorError} Your edits are kept.
            </WorkflowAlert>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {discardReloadInEditor}
          {editorIssue && editorIssue.message !== editorError ? (
            <WorkflowAlert
              title="Check workflow settings"
              variant="warning"
              actions={reviewIssueAction}
            >
              {editorIssue.message}
            </WorkflowAlert>
          ) : null}
          {showPromptNotice && issue && invalidStep ? (
            <WorkflowAlert
              title={issue.field === "question" ? "Add a question" : "Add Agent instructions"}
              variant="warning"
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  data-workflow-validation-action
                  data-workflow-question-review={
                    issue.field === "question" ? invalidStep.id : undefined
                  }
                  ref={issue.field === "question" ? questionReviewControl : undefined}
                  onClick={(event) => {
                    choose(invalidStep.id);
                    returnFocus.current = event.currentTarget;
                    focusIssue(issue);
                  }}
                >
                  {issue.field === "question" ? "Review question" : "Review Agent instructions"}
                </Button>
              }
            >
              {invalidStep.title}
            </WorkflowAlert>
          ) : null}
          {vm && showEditorModelIssues ? (
            <WorkflowTargetSwitchNotice
              steps={draft.definition.steps}
              issues={modelIssues}
              disabled={pending}
              onReviewModel={reviewModel}
            />
          ) : showEditorModelIssues ? (
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
                    reviewModel(first.stepId);
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
            inert={stepConfirmationOpen}
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
            modal={!stepConfirmationOpen}
            onOpenChange={(open) => {
              if (!open && !stepConfirmationOpen && presentation.current === false) close();
            }}
            onOpenChangeComplete={(open) => {
              if (!open && !panelOpen && presentation.current === false) restoreQuestionFocus();
            }}
          >
            <SheetPopup
              inert={stepConfirmationOpen}
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
                // The confirmation owns focus when the docked inspector becomes a sheet.
                if (stepConfirmationOpen) return false;
                // Restore once before interaction; animation completion must not replay a caret.
                return !(focusPending() || restoreCheckoutFocus());
              }}
              finalFocus={() => {
                if (
                  !mounted.current ||
                  stepConfirmationOpen ||
                  presentation.current !== false ||
                  returnFocus.current?.getAttribute("data-workflow-question-review")
                )
                  return false;
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
              {discardReloadInSheet ? (
                <div className="shrink-0 border-t px-3.5 py-2.5">{discardReloadInSheet}</div>
              ) : null}
            </SheetPopup>
          </Sheet>
        ) : null}
      </div>
      {stepMove ? (
        <WorkflowStepMoveDialog
          step={stepMove.step}
          destination={stepMove.destination}
          destinationIndex={stepMove.destinationIndex}
          offset={stepMove.offset}
          impacts={stepMove.impacts}
          blockedReason={moveBlockedReason}
          onKeep={() => setStepMove(null)}
          onMove={confirmStepMove}
          finalFocus={stepActionsReturnTarget}
        />
      ) : null}
      {stepRemoval ? (
        <WorkflowStepRemovalDialog
          step={stepRemoval.step}
          steps={stepRemoval.steps}
          impacts={stepRemoval.impacts}
          blockedReason={removalBlockedReason}
          onKeep={() => setStepRemoval(null)}
          onRemove={() => {
            if (removalBlockedReason || !removeStep(stepRemoval.step, stepRemoval.impacts[0]))
              return;
            stepRemovalApplied.current = true;
            setStepRemoval(null);
          }}
          finalFocus={() => !stepRemovalApplied.current && stepActionsReturnTarget()}
        />
      ) : null}
    </form>
  );
}
