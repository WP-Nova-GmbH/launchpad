import {
  EnvironmentId,
  ThreadId,
  OrchestrationDispatchCommandError,
  type ThreadRelayRouting,
} from "@t3tools/contracts";
import {
  CodexVmConnectionError,
  RelayAuthInvalidError,
  RelayTenancyConflictError,
  RelayTenancyForbiddenError,
  RelayTenancyInvalidError,
  RelayTenancyNotFoundError,
  RelayThreadVmCodexAuthSelection,
  type RelayThreadVmCodexPreference,
  type RelayCodexVmConnection,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createRuntimeCommand } from "../state/runtime.ts";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import {
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  type ManagedRelaySession,
} from "./managedRelayState.ts";

const keySchema = Schema.fromJsonString(Schema.Tuple([EnvironmentId, ThreadId]));
const encodeKey = Schema.encodeSync(keySchema);
const decodeKey = Schema.decodeSync(keySchema);
const sameSelection = Schema.toEquivalence(Schema.NullOr(RelayThreadVmCodexAuthSelection));
const rejectedWrite = Schema.is(
  Schema.Union([
    CodexVmConnectionError,
    RelayAuthInvalidError,
    RelayTenancyConflictError,
    RelayTenancyForbiddenError,
    RelayTenancyInvalidError,
    RelayTenancyNotFoundError,
  ]),
);
type Scope = {
  readonly session: ManagedRelaySession;
  readonly relayUrl: string;
  readonly generation: number;
};
const sameScope = (a: Scope | null | undefined, b: Scope | null | undefined) =>
  a === b ||
  (a != null &&
    b != null &&
    a.session === b.session &&
    a.relayUrl === b.relayUrl &&
    a.generation === b.generation);
type State = {
  readonly scope: Scope;
  readonly epoch: number;
  readonly read: number;
  readonly data: RelayThreadVmCodexPreference | null;
  readonly connection: RelayCodexVmConnection | null;
  readonly readError: string | null;
  readonly error: string | null;
  readonly phase: "idle" | "saving" | "unknown" | "rejected";
  readonly requested: RelayThreadVmCodexAuthSelection | null;
  readonly hasRequested: boolean;
  readonly expectedRevision: number | null;
};
const initial = (scope: Scope): State => ({
  scope,
  epoch: 0,
  read: 0,
  data: null,
  connection: null,
  readError: null,
  error: null,
  phase: "idle",
  requested: null,
  hasRequested: false,
  expectedRevision: null,
});

/** Mounted only by the editor. Saved defaults never carry guest auth state or wake compute. */
export function createThreadVmCodexPreferenceAtoms<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
  routeAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<ThreadRelayRouting | null>,
) {
  const configuredRelayAtom = runtime.atom(
    Effect.map(ManagedRelayTenancyClient, (relay) => normalizeSecureRelayUrl(relay.relayUrl)),
  );
  const keyFor = (environmentId: EnvironmentId, threadId: ThreadId) =>
    encodeKey([environmentId, threadId]);
  const scopeAtom = Atom.family((key: string) =>
    Atom.make((get): Scope | null => {
      const [environmentId, threadId] = decodeKey(key),
        route = get(routeAtom(environmentId, threadId)),
        configured = readManagedRelaySnapshotState(get(configuredRelayAtom)),
        session = get(managedRelaySessionAtom);
      if (
        !session ||
        !route ||
        route.phase !== "active" ||
        configured.isPending ||
        configured.error ||
        !configured.data ||
        normalizeSecureRelayUrl(route.relayUrl) !== configured.data
      )
        return null;
      return { session, relayUrl: configured.data, generation: route.generation };
    }).pipe(Atom.withEquality<Scope | null>(sameScope)),
  );
  const stateAtom = Atom.family((_key: string) =>
    Atom.make<State | null>(null).pipe(Atom.keepAlive),
  );
  const pendingAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const scope = get(scopeAtom(key)),
        state = get(stateAtom(key));
      return (
        !!state &&
        sameScope(state.scope, scope) &&
        (state.phase === "saving" || state.phase === "unknown")
      );
    }).pipe(Atom.setIdleTTL(0)),
  );
  const scopedState = (registry: AtomRegistry.AtomRegistry, key: string, scope: Scope) => {
    const state = registry.get(stateAtom(key));
    return state && sameScope(state.scope, scope) ? state : initial(scope);
  };
  const authorize = Effect.fnUntraced(function* (
    registry: AtomRegistry.AtomRegistry,
    key: string,
    scope: Scope,
  ) {
    const relay = yield* ManagedRelayTenancyClient;
    const clerkToken = yield* scope.session.readClerkToken();
    if (
      !clerkToken ||
      !sameScope(registry.get(scopeAtom(key)), scope) ||
      normalizeSecureRelayUrl(relay.relayUrl) !== scope.relayUrl
    )
      return yield* new OrchestrationDispatchCommandError({
        message: "The account or thread location changed. Reopen VM account settings.",
      });
    return { relay, clerkToken };
  });
  const queryAtom = Atom.family((key: string) =>
    runtime
      .atom((get) => {
        const scope = get(scopeAtom(key));
        return Effect.gen(function* () {
          if (!scope) return null;
          const registry = yield* AtomRegistry.AtomRegistry;
          const state = scopedState(registry, key, scope);
          if (state.phase === "saving") return null;
          const read = state.read + 1,
            epoch = state.epoch;
          registry.set(stateAtom(key), { ...state, read });
          const current = () => {
            const latest = registry.get(stateAtom(key));
            return latest &&
              sameScope(registry.get(scopeAtom(key)), scope) &&
              sameScope(latest.scope, scope) &&
              latest.epoch === epoch &&
              latest.read === read
              ? latest
              : null;
          };
          const auth = yield* authorize(registry, key, scope).pipe(Effect.result);
          if (auth._tag === "Failure") {
            const latest = current();
            if (latest)
              registry.set(stateAtom(key), {
                ...latest,
                readError: auth.failure.message,
                connection: null,
              });
            return null;
          }
          if (!current()) return null;
          const [, threadId] = decodeKey(key);
          const reply = yield* auth.success.relay
            .getThreadVmCodexPreference({ clerkToken: auth.success.clerkToken, threadId })
            .pipe(Effect.result);
          if (!current()) return null;
          const connection = yield* auth.success.relay
            .getCodexVmConnection({ clerkToken: auth.success.clerkToken })
            .pipe(Effect.result);
          const latest = current();
          if (!latest) return null;
          if (reply._tag === "Failure") {
            registry.set(stateAtom(key), {
              ...latest,
              connection: connection._tag === "Success" ? connection.success : null,
              readError: reply.failure.message,
            });
            return null;
          }
          if (reply.success.generation !== scope.generation) {
            registry.set(stateAtom(key), {
              ...latest,
              data: null,
              connection: null,
              readError:
                "This thread moved. Open its current location before changing the VM account.",
            });
            return null;
          }
          // Older reads cannot undo an acknowledged or independently observed revision.
          if (latest.data && reply.success.revision < latest.data.revision) return null;
          const settled =
            latest.phase === "unknown" &&
            latest.expectedRevision !== null &&
            reply.success.revision > latest.expectedRevision;
          const matches = sameSelection(reply.success.selection, latest.requested);
          registry.set(stateAtom(key), {
            ...latest,
            data: reply.success,
            connection: connection._tag === "Success" ? connection.success : null,
            readError: connection._tag === "Failure" ? connection.failure.message : null,
            ...(settled
              ? ({
                  phase: matches ? "idle" : "rejected",
                  hasRequested: false,
                  expectedRevision: null,
                  error: matches
                    ? null
                    : "The saved VM account changed. Review the current choice before saving again.",
                } as const)
              : {}),
          });
          return null;
        });
      })
      .pipe(Atom.setIdleTTL(0)),
  );
  const viewAtom = Atom.family((key: string) =>
    Atom.make((get) => {
      const query = readManagedRelaySnapshotState(get(queryAtom(key))),
        scope = get(scopeAtom(key)),
        raw = get(stateAtom(key)),
        state = raw && sameScope(raw.scope, scope) ? raw : null;
      return {
        data: state?.data ?? null,
        connection: state?.connection ?? null,
        isPending: query.isPending,
        error: state?.error ?? state?.readError ?? query.error,
        phase: state?.phase ?? "idle",
        requested: state?.requested ?? null,
        hasRequested: state?.hasRequested ?? false,
      };
    }).pipe(Atom.setIdleTTL(0)),
  );
  type Input = {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    accountId: string;
    selection: RelayThreadVmCodexAuthSelection | null;
    expectedRevision: number;
    expectedGeneration: number;
  };
  const scopeIds = new WeakMap<Scope, number>();
  let sequence = 0;
  const mutation = createRuntimeCommand(runtime, {
    label: "save VM account",
    concurrency: {
      mode: "singleFlight",
      key: (input: Input & { scope: Scope | null; scopeId: number; retry: boolean }) =>
        JSON.stringify([
          input.scopeId,
          input.environmentId,
          input.threadId,
          input.accountId,
          input.expectedRevision,
          input.expectedGeneration,
          input.selection,
        ]),
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const key = keyFor(input.environmentId, input.threadId),
        scope = input.scope;
      if (
        !scope ||
        !sameScope(registry.get(scopeAtom(key)), scope) ||
        scope.session.accountId !== input.accountId ||
        scope.generation !== input.expectedGeneration
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "The account or thread location changed. Reopen VM account settings.",
        });
      const previous = scopedState(registry, key, scope);
      // A new choice can supersede an uncertain one using the same CAS revision;
      // whichever request commits first prevents the other from overwriting it.
      if (
        previous.phase === "saving" ||
        (previous.phase === "unknown" && previous.expectedRevision !== input.expectedRevision) ||
        (input.retry &&
          (previous.phase !== "unknown" ||
            !previous.hasRequested ||
            previous.expectedRevision !== input.expectedRevision ||
            !sameSelection(previous.requested, input.selection)))
      )
        return yield* new OrchestrationDispatchCommandError({
          message: "Check the pending account choice before choosing another.",
        });
      const uncertain = previous.phase === "unknown";
      if (
        !previous.data?.editable ||
        previous.data.generation !== input.expectedGeneration ||
        (!input.retry && previous.data.revision !== input.expectedRevision)
      ) {
        const error = new OrchestrationDispatchCommandError({
          message: "The saved choice or thread location changed. Refresh before saving.",
        });
        registry.set(stateAtom(key), {
          ...previous,
          epoch: previous.epoch + 1,
          phase: uncertain ? "unknown" : "rejected",
          error: error.message,
          hasRequested: uncertain,
        });
        registry.refresh(queryAtom(key));
        return yield* error;
      }
      const epoch = previous.epoch + 1;
      registry.set(stateAtom(key), {
        ...previous,
        epoch,
        phase: "saving",
        requested: input.selection,
        hasRequested: true,
        expectedRevision: input.expectedRevision,
        error: null,
        readError: null,
      });
      const current = () => {
        const state = registry.get(stateAtom(key));
        return state &&
          sameScope(registry.get(scopeAtom(key)), scope) &&
          sameScope(state.scope, scope) &&
          state.epoch === epoch
          ? state
          : null;
      };
      const feedback = (phase: "unknown" | "rejected", error: string) => {
        const state = current();
        if (state)
          registry.set(stateAtom(key), {
            ...state,
            epoch: epoch + 1,
            phase,
            error,
            hasRequested: phase === "unknown",
          });
        registry.refresh(queryAtom(key));
      };
      const auth = yield* authorize(registry, key, scope).pipe(Effect.result);
      if (auth._tag === "Failure") {
        feedback(uncertain ? "unknown" : "rejected", auth.failure.message);
        return yield* auth.failure;
      }
      if (!current()) return null;
      const reply = yield* auth.success.relay
        .setThreadVmCodexPreference({
          clerkToken: auth.success.clerkToken,
          threadId: input.threadId,
          payload: {
            expectedGeneration: input.expectedGeneration,
            expectedRevision: input.expectedRevision,
            selection: input.selection,
          },
        })
        .pipe(Effect.result);
      const state = current();
      if (!state) return null;
      if (reply._tag === "Failure") {
        const rejected =
          !uncertain &&
          reply.failure._tag === "ManagedRelayRequestFailedError" &&
          rejectedWrite(reply.failure.cause);
        feedback(
          rejected ? "rejected" : "unknown",
          rejected
            ? reply.failure.message
            : "Could not confirm the saved account choice. Check it or choose an account again.",
        );
        return yield* reply.failure;
      }
      if (
        reply.success.generation !== input.expectedGeneration ||
        reply.success.revision !== input.expectedRevision + 1 ||
        !sameSelection(reply.success.selection, input.selection)
      ) {
        feedback(
          "unknown",
          "Could not confirm the saved account choice. Check the current choice.",
        );
        return null;
      }
      registry.set(stateAtom(key), {
        ...state,
        epoch: epoch + 1,
        data: reply.success,
        phase: "idle",
        error: null,
        readError: null,
        hasRequested: false,
        expectedRevision: null,
      });
      registry.refresh(queryAtom(key));
      return reply.success;
    }),
  });
  const captureScope = (
    registry: AtomRegistry.AtomRegistry,
    input: Pick<Input, "environmentId" | "threadId">,
  ) => {
    const key = keyFor(input.environmentId, input.threadId),
      currentScope = registry.get(scopeAtom(key)),
      saved = registry.get(stateAtom(key)),
      scope = saved && sameScope(saved.scope, currentScope) ? saved.scope : currentScope;
    if (scope && !scopeIds.has(scope)) scopeIds.set(scope, ++sequence);
    return {
      scope,
      scopeId: scope ? scopeIds.get(scope)! : 0,
    };
  };
  const run = (registry: AtomRegistry.AtomRegistry, input: Input, retry = false) =>
    mutation.run(registry, { ...input, ...captureScope(registry, input), retry });
  const refresh = createRuntimeCommand(runtime, {
    label: "check saved VM account",
    concurrency: {
      mode: "singleFlight",
      key: (input: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        scope: Scope | null;
        scopeId: number;
      }) => JSON.stringify([input.scopeId, keyFor(input.environmentId, input.threadId)]),
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const key = keyFor(input.environmentId, input.threadId);
      if (!input.scope || !sameScope(registry.get(scopeAtom(key)), input.scope)) return;
      const query = queryAtom(key);
      registry.refresh(query);
      yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
    }),
  });
  return {
    codexPreferencePendingAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      pendingAtom(keyFor(environmentId, threadId)),
    codexPreferenceQueryAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      queryAtom(keyFor(environmentId, threadId)),
    codexPreferenceViewAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      viewAtom(keyFor(environmentId, threadId)),
    refreshCodexPreference: {
      label: refresh.label,
      run: (
        registry: AtomRegistry.AtomRegistry,
        input: Pick<Input, "environmentId" | "threadId">,
      ) => refresh.run(registry, { ...input, ...captureScope(registry, input) }),
    },
    setCodexPreference: {
      label: mutation.label,
      run: (registry: AtomRegistry.AtomRegistry, input: Input) => run(registry, input),
    },
    retryCodexPreference: {
      label: "retry saved VM account",
      run(
        registry: AtomRegistry.AtomRegistry,
        input: { environmentId: EnvironmentId; threadId: ThreadId; accountId: string },
      ) {
        const key = keyFor(input.environmentId, input.threadId),
          scope = registry.get(scopeAtom(key));
        const state = scope ? scopedState(registry, key, scope) : null;
        return run(
          registry,
          {
            ...input,
            selection: state?.requested ?? null,
            expectedRevision: state?.expectedRevision ?? -1,
            expectedGeneration: scope?.generation ?? -1,
          },
          true,
        );
      },
    },
  };
}
