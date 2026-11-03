import type { WorkflowVmCapabilities, WorkflowVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import { parseWorkflowVmLimit, WORKFLOW_VM_LIMIT_INPUT_ERROR } from "./threadVmPolicyForm.ts";

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
    loading: false,
    saving: false,
    readError: null,
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
    error instanceof Error ? error.message : fallback;
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
      if (!state.canEdit || state.loading || state.saving) return;
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
          saveError: null,
        });
      } catch (error) {
        if (request === epoch)
          update({ readError: message(error, "Could not read the workflow VM limit.") });
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
