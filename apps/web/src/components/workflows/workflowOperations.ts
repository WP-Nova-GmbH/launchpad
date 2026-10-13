import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  updateWorkflowDrafts,
  workflowSessionKey,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import {
  WorkflowConflictError,
  WorkflowInvalidError,
  SaveRepositoryWorkflow,
  type RepositoryWorkflow,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
const workflowError = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The request could not be completed.";
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

/** Pending write ownership survives the editor; follow-up reads are separate from write receipts. */
export async function saveWorkflowDraft(
  scope: WorkflowScope,
  id: string,
  save: (payload: typeof SaveRepositoryWorkflow.Type) => Promise<RepositoryWorkflow>,
  archived?: boolean,
) {
  const key = workflowSessionKey(scope, id);
  const draft = appAtomRegistry.get(workflowDraftAtom).editors[key];
  if (!draft || draft.operation?.state === "pending") return null;
  const operation = {
    requestId: randomUUID(),
    state: "pending" as const,
    definition: draft.definition,
    archived: archived ?? draft.baseline?.archived ?? false,
    expectedRevision: draft.baseline?.revision ?? 0,
  };
  const accepted = updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
    ...state,
    editors: { ...state.editors, [key]: { ...draft, operation, error: null } },
  }));
  if (!accepted) return null;
  try {
    const saved = await save({
      workflowId: draft.workflowId,
      expectedRevision: operation.expectedRevision,
      definition: operation.definition,
      archived: operation.archived,
    });
    if (saved.workflowId !== draft.workflowId)
      throw new Error("The saved workflow ID did not match this draft.");
    let applied = false;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.editors[key];
      if (current?.operation?.requestId !== operation.requestId) return state;
      applied = true;
      return {
        ...state,
        editors: {
          ...state.editors,
          [key]: {
            ...current,
            definition: saved.definition,
            baseline: saved,
            targetConfirmed: true,
            operation: null,
            error: null,
          },
        },
      };
    });
    return applied ? saved : null;
  } catch (cause) {
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.editors[key];
      if (current?.operation?.requestId !== operation.requestId) return state;
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
  start: (instruction: string) => Promise<RepositoryWorkflowJob>,
) {
  const key = workflowSessionKey(scope, id);
  const draft = appAtomRegistry.get(workflowDraftAtom).runs[key];
  if (!draft?.instruction.trim() || draft.operation?.state === "pending") return null;
  const operation = {
    requestId: randomUUID(),
    state: "pending" as const,
    instruction: draft.instruction,
  };
  if (
    !updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      runs: { ...state.runs, [key]: { ...draft, operation, error: null, startedJobId: null } },
    }))
  )
    return null;
  try {
    const job = await start(operation.instruction);
    let applied = false;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.runs[key];
      if (current?.operation?.requestId !== operation.requestId) return state;
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
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const current = state.runs[key];
      if (current?.operation?.requestId !== operation.requestId) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
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
