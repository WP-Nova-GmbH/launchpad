import type { WorkflowVmCapabilities, WorkflowVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";
import { relayProtectedErrorMessage } from "./errorPresentation.ts";
import { ManagedRelayRequestFailedError } from "./managedRelay.ts";
import type { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import {
  parseWorkflowVmLimit,
  workflowVmLimitDraftStatus,
  WORKFLOW_VM_LIMIT_INPUT_ERROR,
} from "./threadVmPolicyForm.ts";

type Client = Pick<
  ManagedRelayTenancyClient["Service"],
  "getOrganization" | "getHealth" | "getWorkflowVmPolicy" | "updateWorkflowVmPolicy"
>;
type Scope = { readonly userId: string; readonly organizationId?: string };

export class WorkflowVmPolicyScopeError extends Schema.TaggedError<WorkflowVmPolicyScopeError>()(
  "WorkflowVmPolicyScopeError",
  { message: Schema.String },
) {}

const requireScope = Effect.fnUntraced(function* (
  client: Client,
  clerkToken: string,
  scope: Scope,
) {
  const membership = yield* client.getOrganization({ clerkToken });
  if (
    membership.userId !== scope.userId ||
    (scope.organizationId !== undefined &&
      membership.organization.organizationId !== scope.organizationId)
  )
    return yield* new WorkflowVmPolicyScopeError({
      message: "Your account or organization changed. Reload the workflow VM limit.",
    });
  return membership;
});

export const readWorkflowVmPolicy = Effect.fnUntraced(function* (
  client: Client,
  clerkToken: string,
  scope: Scope,
) {
  const membership = yield* requireScope(client, clerkToken, scope);
  const capabilities = (yield* client.getHealth()).workflowVmCapabilities ?? null;
  const record = capabilities?.configuration
    ? yield* client.getWorkflowVmPolicy({ clerkToken })
    : null;
  const organizationId = membership.organization.organizationId;
  if (record && record.organizationId !== organizationId)
    return yield* new WorkflowVmPolicyScopeError({
      message: "Your organization changed. Reload the workflow VM limit.",
    });
  const current = yield* requireScope(client, clerkToken, { ...scope, organizationId });
  return { record, capabilities, canEdit: current.role === "admin" };
});

export const saveWorkflowVmPolicy = Effect.fnUntraced(function* (
  client: Client,
  clerkToken: string,
  scope: Scope,
  record: WorkflowVmPolicyRecord,
) {
  const current = yield* requireScope(client, clerkToken, {
    ...scope,
    organizationId: record.organizationId,
  });
  if (current.role !== "admin")
    return yield* new WorkflowVmPolicyScopeError({
      message: "An organization admin can change this limit.",
    });
  const saved = yield* client.updateWorkflowVmPolicy({ clerkToken, payload: record });
  yield* requireScope(client, clerkToken, { ...scope, organizationId: record.organizationId });
  return saved;
});

export interface WorkflowVmPolicyState {
  readonly record: WorkflowVmPolicyRecord | null;
  readonly capabilities: WorkflowVmCapabilities | null;
  readonly canEdit: boolean;
  readonly draft: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly readError: string | null;
  readonly recoveryDraft: string | null;
  readonly saveError: string | null;
  readonly saved: boolean;
}

/** Shared async settings state; disposing a scope invalidates every outstanding reply. */
export function makeWorkflowVmPolicyController(dependencies: {
  readonly read: () => Promise<Pick<WorkflowVmPolicyState, "record" | "capabilities" | "canEdit">>;
  readonly save: (record: WorkflowVmPolicyRecord) => Promise<WorkflowVmPolicyRecord>;
}) {
  let state: WorkflowVmPolicyState = {
    record: null,
    capabilities: null,
    canEdit: false,
    draft: "",
    loading: true,
    saving: false,
    readError: null,
    recoveryDraft: null,
    saveError: null,
    saved: false,
  };
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: Partial<WorkflowVmPolicyState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const message = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback;
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      epoch++;
    },
    edit: (draft: string) => {
      if (!state.canEdit || state.loading || state.saving || state.readError) return;
      epoch++;
      update({ draft, saveError: null, saved: false });
    },
    load: async () => {
      if (state.saving) return;
      const request = ++epoch;
      update({ loading: true, readError: null, saved: false });
      try {
        const next = await dependencies.read();
        if (request !== epoch) return;
        update({
          ...next,
          draft: next.record ? String(next.record.maxRunningVms) : "",
          recoveryDraft: null,
          saveError: null,
        });
      } catch (error) {
        if (request !== epoch) return;
        const relayFailure = error instanceof ManagedRelayRequestFailedError;
        const relayError = relayFailure ? error.relayError : undefined;
        const httpAccessDenied =
          relayFailure &&
          HttpClientError.isHttpClientError(error.cause) &&
          [401, 403, 404].includes(error.cause.response?.status ?? 0);
        const retryHint = "Check your connection and try again.";
        const readError = relayError
          ? relayProtectedErrorMessage(relayError)
          : httpAccessDenied
            ? "Check that you’re signed in and have access, then try again."
            : relayFailure
              ? retryHint
              : message(error, retryHint);
        const lostAccess =
          httpAccessDenied ||
          error instanceof WorkflowVmPolicyScopeError ||
          relayError?._tag === "RelayAuthInvalidError" ||
          relayError?._tag === "RelayTenancyForbiddenError" ||
          relayError?._tag === "RelayTenancyNotFoundError";
        if (lostAccess) {
          update({
            readError,
            record: null,
            capabilities: null,
            canEdit: false,
            draft: "",
            recoveryDraft: null,
            saveError: null,
          });
        } else {
          const { record, draft, canEdit } = state;
          update({
            readError,
            recoveryDraft:
              canEdit &&
              record &&
              workflowVmLimitDraftStatus(draft, record.maxRunningVms) === "changed"
                ? draft
                : null,
          });
        }
      } finally {
        if (request === epoch) update({ loading: false });
      }
    },
    save: async () => {
      if (
        !state.record ||
        !state.canEdit ||
        state.saving ||
        state.loading ||
        state.readError ||
        !state.capabilities?.configuration
      )
        return;
      let maxRunningVms;
      try {
        maxRunningVms = parseWorkflowVmLimit(state.draft);
      } catch {
        update({ saveError: WORKFLOW_VM_LIMIT_INPUT_ERROR, saved: false });
        return;
      }
      const original = state.record;
      const request = ++epoch;
      update({ saving: true, saveError: null, saved: false });
      try {
        const record = await dependencies.save({ ...original, maxRunningVms });
        if (request !== epoch) return;
        if (
          record.organizationId !== original.organizationId ||
          record.revision !== original.revision + 1 ||
          record.maxRunningVms !== maxRunningVms
        )
          throw new Error("Could not confirm the saved limit. Reload before saving again.");
        update({ record, draft: String(record.maxRunningVms), saved: true, readError: null });
      } catch (error) {
        if (request === epoch)
          update({
            saveError: message(
              error,
              "Could not save the workflow VM limit. Reload before trying again.",
            ),
          });
      } finally {
        if (request === epoch) update({ saving: false });
      }
    },
  };
}
