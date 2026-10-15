import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  workflowDraftAtom,
  workflowJobReadAtom,
  updateWorkflowDrafts,
  workflowSessionKey,
  replaceNewWorkflowDraft,
  sameWorkflowDefinition,
  type WorkflowScope,
  type WorkflowEditorDraft,
  type WorkflowRunDraft,
} from "@t3tools/client-runtime/relay/workflow-session";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { randomUUID } from "../../lib/utils";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { runtime } from "../../lib/runtime";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { requestConfirmDialog } from "../../confirmDialog";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
export const workflowError = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The request could not be completed.";
export const confirmWorkflow = (message: string) =>
  requestConfirmDialog(message) ?? Promise.resolve(window.confirm(message));

export function useWorkflowClient(scope: WorkflowScope) {
  const { getToken } = useAuth();
  return useCallback(
    async <A>(
      operation: (
        client: Client,
        token: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ) => {
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token || appAtomRegistry.get(workflowDraftAtom).accountId !== scope.accountId)
        throw new Error("Sign in to Launchpad Connect to continue.");
      const result = await runtime.runPromiseExit(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => operation(client, token)),
        ),
      );
      if (Exit.isFailure(result)) throw Cause.squash(result.cause);
      return result.value;
    },
    [getToken, scope.accountId],
  );
}

export function useWorkflowDrafts() {
  return useAtomValue(workflowDraftAtom);
}
export function useWorkflowJobReads() {
  return useAtomValue(workflowJobReadAtom);
}
export const editWorkflowDraft = (
  scope: WorkflowScope,
  id: string,
  update: (draft: WorkflowEditorDraft) => WorkflowEditorDraft,
) =>
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const key = workflowSessionKey(scope, id);
    const draft = state.editors[key];
    if (!draft || draft.operation?.state === "pending") return state;
    const next = update(draft);
    const edited =
      next.error === draft.error && !sameWorkflowDefinition(next.definition, draft.definition)
        ? { ...next, error: null }
        : next;
    return { ...state, editors: { ...state.editors, [key]: edited } };
  });

/** Inspection can change during Save; this never mutates the definition or write receipt. */
export const selectWorkflowStep = (scope: WorkflowScope, id: string, selectedStepId: string) =>
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const key = workflowSessionKey(scope, id);
    const draft = state.editors[key];
    if (
      !draft ||
      draft.selectedStepId === selectedStepId ||
      (selectedStepId && !draft.definition.steps.some((step) => step.id === selectedStepId))
    )
      return state;
    return { ...state, editors: { ...state.editors, [key]: { ...draft, selectedStepId } } };
  });

export const editWorkflowRun = (
  scope: WorkflowScope,
  id: string,
  update: (draft: WorkflowRunDraft) => WorkflowRunDraft,
) =>
  updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
    const key = workflowSessionKey(scope, id);
    const draft = state.runs[key];
    return draft?.operation?.state === "pending"
      ? state
      : {
          ...state,
          runs: {
            ...state.runs,
            [key]: update(
              draft ?? { instruction: "", operation: null, startedJobId: null, error: null },
            ),
          },
        };
  });
export const savedWorkflowDraft = (workflow: RepositoryWorkflow): WorkflowEditorDraft => ({
  workflowId: workflow.workflowId,
  definition: workflow.definition,
  baseline: workflow,
  selectedStepId: "",
  targetConfirmed: true,
  operation: null,
  error: null,
});

export function newWorkflowDraft(
  projects: ReadonlyArray<RelayOrganizationProject>,
  template: "review" | "publish" = "review",
): WorkflowEditorDraft | null {
  const target = projects[0];
  if (!target) return null;
  return {
    workflowId: randomUUID(),
    baseline: null,
    targetConfirmed: projects.length === 1,
    selectedStepId: "",
    operation: null,
    error: null,
    definition: {
      name: template === "publish" ? "Reviewed implementation" : "New workflow",
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
        ...(template === "publish"
          ? [
              {
                id: "push",
                kind: "action" as const,
                title: "Push branch",
                action: "push" as const,
              },
              {
                id: "pr",
                kind: "action" as const,
                title: "Open PR",
                action: "open_pull_request" as const,
              },
            ]
          : []),
      ],
    },
  };
}

export function copiedWorkflowDraft(
  source: RepositoryWorkflow,
  projects: ReadonlyArray<RelayOrganizationProject>,
  sameRepository: boolean,
) {
  const draft = newWorkflowDraft(projects);
  if (!draft) return null;
  const target = sameRepository
    ? projects.find(
        (project) =>
          project.environmentId === source.definition.environmentId &&
          project.projectId === source.definition.projectId,
      )
    : undefined;
  return {
    ...draft,
    targetConfirmed: !!target || projects.length === 1,
    definition: {
      ...draft.definition,
      name: `Copy of ${source.definition.name}`.slice(0, 120),
      ...(target ? { environmentId: target.environmentId, projectId: target.projectId } : {}),
      steps: structuredClone(source.definition.steps),
    },
  };
}

/** Draft replacement is explicit and cannot displace a pending or uncertain Create. */
export async function openNewWorkflowDraft(
  scope: WorkflowScope,
  create: () => WorkflowEditorDraft | null,
) {
  const state = appAtomRegistry.get(workflowDraftAtom);
  if (state.accountId !== scope.accountId) return null;
  const id = state.newWorkflowIds[workflowSessionKey(scope, "new")];
  const previous = id ? state.editors[workflowSessionKey(scope, id)] : undefined;
  if (previous?.operation)
    throw new Error(
      "Finish or reconcile the retained new workflow's save before starting another draft.",
    );
  if (
    previous &&
    !previous.baseline &&
    !(await confirmWorkflow("Discard the retained new workflow draft and start this one?"))
  )
    return null;
  const draft = create();
  if (!draft)
    throw new Error(
      "Enroll an organization machine with a checkout in the destination repository first.",
    );
  return replaceNewWorkflowDraft(appAtomRegistry, scope, previous, draft) ? draft.workflowId : null;
}

export function useActiveWorkflowView() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}

export { saveWorkflowDraft, runWorkflowDraft } from "./workflowOperations";
