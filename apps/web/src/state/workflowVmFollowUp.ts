import {
  EnvironmentRegistry,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentCommand,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  ManagedRelayTenancy,
  managedRelaySessionAtom,
  type ManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import { rememberVerifiedRelay } from "@t3tools/client-runtime/relay/portableThreadLibrary";
import type { WorkflowResultOrigin } from "@t3tools/client-runtime/relay/workflow-result";
import {
  OrchestrationDispatchCommandError,
  WS_METHODS,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayWorkflowVmFollowUp } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

type RunningWorkspace = Extract<RelayWorkflowVmFollowUp, { state: "running" }>;
type FollowUpConnection = RunningWorkspace & {
  readonly origin: WorkflowResultOrigin;
  readonly title: string;
};

export const rememberedWorkflowVmFollowUpOriginAtom = Atom.family((_scopeKey: string) =>
  Atom.make<{ session: ManagedRelaySession; origin: WorkflowResultOrigin } | null>(null).pipe(
    Atom.keepAlive,
  ),
);

export const sessionWorkflowVmFollowUpOriginAtom = Atom.family((scopeKey: string) =>
  Atom.make((get) => {
    const remembered = get(rememberedWorkflowVmFollowUpOriginAtom(scopeKey));
    return remembered?.session === get(managedRelaySessionAtom) ? remembered?.origin : undefined;
  }),
);

export function workflowVmFollowUpHistoryState(threadRef: ScopedThreadRef) {
  const workflowOrigin = appAtomRegistry.get(
    sessionWorkflowVmFollowUpOriginAtom(scopedThreadKey(threadRef)),
  );
  return workflowOrigin ? { workflowOrigin } : {};
}

export const connectWorkflowVmFollowUp = createRuntimeCommand(connectionAtomRuntime, {
  label: "continue in workflow VM",
  concurrency: {
    mode: "serial",
    key: (input: FollowUpConnection) => input.environmentId,
  },
  execute: Effect.fnUntraced(function* (
    { environmentId, threadId, generation, title, origin },
    atoms,
  ) {
    const registry = yield* EnvironmentRegistry;
    const relay = yield* ManagedRelayTenancy.ManagedRelayTenancyClient;
    const session = atoms.get(managedRelaySessionAtom);
    const sessionChanged = () =>
      new OrchestrationDispatchCommandError({
        message: "Sign in again before continuing in this workflow VM.",
      });
    if (!session || session.accountId !== origin.accountId) return yield* sessionChanged();
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (!entry) {
      yield* registry.register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({ environmentId, label: title }),
        }),
      );
    } else if (!entry.enabled) {
      yield* registry.setEnabled(environmentId, true);
    }

    yield* registry.setWorkflowFollowUp(environmentId, { threadId, generation });
    if (atoms.get(managedRelaySessionAtom) !== session) return yield* sessionChanged();
    rememberVerifiedRelay(atoms, environmentId, threadId, {
      session,
      relayUrl: relay.relayUrl,
      generation,
    });
    atoms.set(
      rememberedWorkflowVmFollowUpOriginAtom(
        scopedThreadKey(scopeThreadRef(environmentId, threadId)),
      ),
      {
        session,
        origin,
      },
    );
  }),
});

export const pushWorkflowVmFollowUp = createEnvironmentCommand(connectionAtomRuntime, {
  label: "push workflow follow-up",
  execute: (input: { readonly threadId: ThreadId; readonly operationId: string }) =>
    request(WS_METHODS.workflowVmFollowUpPush, input),
});
