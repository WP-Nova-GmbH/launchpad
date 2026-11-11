import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  workflowCatalogRevisionAtom,
  normalizeWorkflowAutomation,
  workflowDraftAutomation,
  workflowDraftAutomationResolved,
  sameWorkflowAutomation,
  sameWorkflowDefinition,
  updateWorkflowDrafts,
  workflowSessionKey,
  type WorkflowScope,
  type WorkflowEditorDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  WorkflowConflictError,
  WorkflowInvalidError,
  SaveRepositoryWorkflow,
  WorkflowTarget,
  type RepositoryWorkflow,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type RepositoryWorkflowJob,
  type RunRepositoryWorkflow,
} from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";

export class WorkflowRequestNotSentError extends Error {}

const workflowError = (cause: unknown) => {
  if (isRequestFailed(cause) && (isConflict(cause.cause) || isInvalid(cause.cause)))
    return cause.cause.message;
  if (cause instanceof Error && cause.message.includes("saveWorkflow"))
    return "Save could not be confirmed. Your edits are retained. Retry to check the saved version.";
  return cause instanceof Error ? cause.message : "The request could not be completed.";
};
const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isConflict = Schema.is(WorkflowConflictError);
const isInvalid = Schema.is(WorkflowInvalidError);
function definitiveRejection(cause: unknown) {
  return (
    isRequestFailed(cause) &&
    cause.transportFailed !== true &&
    (isConflict(cause.cause) ||
      isInvalid(cause.cause) ||
      (!!cause.relayError &&
        [
          "auth_invalid",
          "tenancy_forbidden",
          "tenancy_not_found",
          "tenancy_conflict",
          "tenancy_invalid",
        ].includes(cause.relayError.code)))
  );
}

type SaveOptions = {
  readonly automationSupported: boolean;
  readonly read: () => Promise<WorkflowCatalog>;
  readonly turnOffOnly?: boolean;
};
type SaveOperation = NonNullable<WorkflowEditorDraft["operation"]>;
const sameWorkflowTarget = Schema.toEquivalence(WorkflowTarget);

export function normalizeWorkflowDefinitionForSave(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const target = definition.target;
  if (target.kind !== "vm") return definition;
  const baseBranch = target.baseBranch?.trim() || null;
  return baseBranch === target.baseBranch
    ? definition
    : { ...definition, target: { ...target, baseBranch } };
}

export function workflowVmOffSave(draft: WorkflowEditorDraft) {
  const baseline = draft.baseline;
  if (
    !baseline ||
    baseline.archived ||
    baseline.definition.target.kind !== "vm" ||
    !baseline.automation?.enabled
  )
    return null;
  return {
    definition: baseline.definition,
    automation: { ...baseline.automation, enabled: false },
  };
}

export function assertWorkflowSaveSupport(operation: SaveOperation, catalog?: WorkflowCatalog) {
  if (typeof operation.includesAutomation !== "boolean")
    throw new Error(
      "Reload the saved version or discard local changes before retrying this older Save.",
    );
  if (operation.includesAutomation && catalog?.automationSupported !== true)
    throw new Error("This relay does not support automation controls. Update the relay and retry.");
}

export function matchesWorkflowSave(saved: RepositoryWorkflow, operation: SaveOperation) {
  return (
    typeof operation.includesAutomation === "boolean" &&
    saved.revision === operation.expectedRevision + 1 &&
    saved.archived === operation.archived &&
    sameWorkflowDefinition(saved.definition, operation.definition) &&
    (!operation.includesAutomation ||
      (saved.automation !== undefined &&
        sameWorkflowAutomation(saved.automation, operation.automation)))
  );
}

/** Apply only fields still equal to the captured request, preserving later edits independently. */
export function applyWorkflowSaveReceipt(
  current: WorkflowEditorDraft,
  operation: SaveOperation,
  saved: RepositoryWorkflow,
): WorkflowEditorDraft {
  const unchangedAutomation = sameWorkflowAutomation(
    workflowDraftAutomation(current),
    operation.automation,
  );
  const sameTarget = sameWorkflowTarget(current.definition.target, operation.definition.target);
  return {
    ...current,
    ...(sameWorkflowDefinition(current.definition, operation.definition)
      ? { definition: saved.definition }
      : {}),
    ...(unchangedAutomation
      ? {
          automation: normalizeWorkflowAutomation(saved.automation),
          automationResolved:
            saved.automation !== undefined || operation.includesAutomation === true,
        }
      : {}),
    baseline: saved,
    targetConfirmed: sameTarget ? true : current.targetConfirmed,
    operation: null,
    error: null,
  };
}

/** A retry first checks the original captured write; detached completions only invalidate reads. */
export async function saveWorkflowDraft(
  scope: WorkflowScope,
  id: string,
  save: (payload: typeof SaveRepositoryWorkflow.Type) => Promise<RepositoryWorkflow>,
  archived?: boolean,
  options?: SaveOptions,
) {
  const key = workflowSessionKey(scope, id);
  const draft = appAtomRegistry.get(workflowDraftAtom).editors[key];
  if (!draft || draft.operation?.state === "pending") return null;
  const automationSupported = options?.automationSupported === true;
  const previous = draft.operation;
  const offOnly = !previous && options?.turnOffOnly === true ? workflowVmOffSave(draft) : null;
  if (!previous && options?.turnOffOnly && (!offOnly || !automationSupported)) return null;
  if (!draft.operation && automationSupported && !workflowDraftAutomationResolved(draft)) {
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: {
        ...state.editors,
        [key]: {
          ...draft,
          error:
            "Refresh or reload the saved workflow before saving automation. Your edits are retained.",
        },
      },
    }));
    return null;
  }
  const nextArchived = archived ?? draft.baseline?.archived ?? false;
  const automation = offOnly?.automation ?? { ...workflowDraftAutomation(draft) };
  // Both archive and restore deliberately stay Off, before capturing the expected receipt.
  if (archived !== undefined || nextArchived) automation.enabled = false;
  const operation = previous
    ? {
        ...previous,
        state: "pending" as const,
      }
    : {
        requestId: randomUUID(),
        state: "pending" as const,
        definition: offOnly?.definition ?? normalizeWorkflowDefinitionForSave(draft.definition),
        automation,
        includesAutomation: automationSupported,
        archived: nextArchived,
        expectedRevision: draft.baseline?.revision ?? 0,
      };
  const accepted = updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: {
      ...state.editors,
      [key]: {
        ...draft,
        ...(!previous && !offOnly ? { definition: operation.definition } : {}),
        ...(offOnly
          ? { automation: { ...workflowDraftAutomation(draft), enabled: false } }
          : archived !== undefined
            ? { automation: normalizeWorkflowAutomation(operation.automation) }
            : {}),
        operation,
        error: null,
      },
    },
  }));
  if (!accepted) return null;
  const ownsOperation = () => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    return state.accountId === scope.accountId && state.editors[key]?.operation === operation;
  };
  try {
    if (previous && typeof operation.includesAutomation !== "boolean")
      assertWorkflowSaveSupport(operation);
    let saved: RepositoryWorkflow | undefined;
    if (previous && options) {
      const catalog = await options.read();
      if (!ownsOperation()) return null;
      assertWorkflowSaveSupport(operation, catalog);
      const current = catalog.workflows.find((entry) => entry.workflowId === id);
      if (current && matchesWorkflowSave(current, operation)) saved = current;
      else if ((current?.revision ?? 0) !== operation.expectedRevision)
        throw new Error(
          "The saved workflow differs. Reload its saved version before saving again; your edits are retained.",
        );
    }
    if (previous && !options && operation.includesAutomation) assertWorkflowSaveSupport(operation);
    if (!ownsOperation()) return null;
    saved ??= await save({
      workflowId: draft.workflowId,
      expectedRevision: operation.expectedRevision,
      definition: operation.definition,
      archived: operation.archived,
      ...(operation.includesAutomation ? { automation: operation.automation } : {}),
    });
    if (saved.workflowId !== id || !matchesWorkflowSave(saved, operation))
      throw new Error(
        "Save could not be confirmed. Your edits are retained. Retry to check the saved version.",
      );
    if (appAtomRegistry.get(workflowDraftAtom).accountId === scope.accountId)
      appAtomRegistry.set(
        workflowCatalogRevisionAtom,
        appAtomRegistry.get(workflowCatalogRevisionAtom) + 1,
      );
    const receipt = saved;
    let applied = false;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.editors[key];
      if (current?.operation !== operation) return state;
      applied = true;
      return {
        ...state,
        editors: { ...state.editors, [key]: applyWorkflowSaveReceipt(current, operation, receipt) },
      };
    });
    return applied ? saved : null;
  } catch (cause) {
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.editors[key];
      if (current?.operation !== operation) return state;
      return {
        ...state,
        editors: {
          ...state.editors,
          [key]: {
            ...current,
            operation: definitiveRejection(cause) ? null : { ...operation, state: "uncertain" },
            error: workflowError(cause),
          },
        },
      };
    });
    return null;
  }
}

export async function runWorkflowDraft(
  scope: WorkflowScope,
  id: string,
  intent:
    | { kind: "start"; targetKind: WorkflowTarget["kind"]; replaceUncertain?: boolean }
    | { kind: "recover"; replayOnly: boolean },
  start: (payload: typeof RunRepositoryWorkflow.Type) => Promise<RepositoryWorkflowJob>,
) {
  const key = workflowSessionKey(scope, id);
  const draft = appAtomRegistry.get(workflowDraftAtom).runs[key];
  if (!draft || draft.operation?.state === "pending") return null;
  const previous = draft.operation;
  const previousVm = previous?.targetKind === "vm" ? previous : null;
  let operation: NonNullable<typeof draft.operation>;
  if (intent.kind === "recover") {
    if (!previousVm) return null;
    operation = { ...previousVm, state: "pending" };
  } else {
    if ((previousVm && !intent.replaceUncertain) || !draft.instruction.trim()) return null;
    operation = {
      requestId: randomUUID(),
      state: "pending",
      instruction: draft.instruction,
      ...(intent.targetKind === "vm" ? { targetKind: "vm" } : {}),
    };
  }
  if (
    !updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      runs: { ...state.runs, [key]: { ...draft, operation, error: null, startedJobId: null } },
    }))
  )
    return null;
  try {
    const job = await start({
      workflowId: id,
      instruction: operation.instruction,
      expectedTargetKind: operation.targetKind ?? "machine",
      ...(operation.targetKind === "vm" ? { requestId: operation.requestId } : {}),
      ...(intent.kind === "recover" && intent.replayOnly ? { replayOnly: true } : {}),
    });
    let applied = false;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.runs[key];
      if (current?.operation !== operation) return state;
      applied = true;
      return {
        ...state,
        runs: {
          ...state.runs,
          [key]: {
            ...current,
            instruction: current.instruction === operation.instruction ? "" : current.instruction,
            operation: null,
            startedJobId: job.jobId,
            error: null,
          },
        },
      };
    });
    return applied ? job : null;
  } catch (cause) {
    const rejected =
      intent.kind === "start" &&
      (cause instanceof WorkflowRequestNotSentError || definitiveRejection(cause));
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.runs[key];
      if (current?.operation !== operation) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [key]: {
            ...current,
            operation: rejected ? previous : { ...operation, state: "uncertain" },
            startedJobId: rejected ? draft.startedJobId : current.startedJobId,
            error: workflowError(cause),
          },
        },
      };
    });
    return null;
  }
}
