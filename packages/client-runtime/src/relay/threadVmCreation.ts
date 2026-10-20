import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { RelayThreadVmCreateRequest, RelayThreadVmCreateResponse } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { createRuntimeCommand } from "../state/runtime.ts";
import { ManagedRelayTenancyClient } from "./managedRelayTenancy.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";

const Draft = Schema.Struct({
  request: RelayThreadVmCreateRequest,
  response: Schema.NullOr(RelayThreadVmCreateResponse),
});
const codec = Schema.fromJsonString(Draft);
const decode = Schema.decodeSync(codec),
  encode = Schema.encodeSync(codec);
export type ThreadVmCreationDraft = typeof Draft.Type;
export interface ThreadVmCreationScope {
  readonly accountId: string;
  readonly relayUrl: string;
}
const keyFor = (scope: ThreadVmCreationScope) => {
  const relayUrl = normalizeSecureRelayUrl(scope.relayUrl);
  if (!relayUrl) throw new Error("Configure Launchpad Connect before creating a VM thread.");
  return `launchpad.thread-vm-create.v1:${JSON.stringify([scope.accountId, relayUrl])}`;
};
function checkResponse(request: RelayThreadVmCreateRequest, response: RelayThreadVmCreateResponse) {
  if (response.status === "accepted") {
    if (
      response.setup.threadId !== request.threadId ||
      response.setup.allocationId !== request.allocationId
    )
      throw new Error("The relay acknowledged a different VM thread.");
  } else if (
    !response.replacement ||
    response.replacement.threadId !== request.threadId ||
    response.replacement.requestId !== request.allocationId
  )
    throw new Error("The relay did not retain this VM replacement request.");
}
/** One unresolved creation per account/relay. A retry never changes the thread, allocation or input. */
export function createThreadVmCreationJournal(storage: ThreadMoveSubmissionStorage) {
  const read = async (scope: ThreadVmCreationScope) => {
    const value = await storage.read(keyFor(scope));
    return value === null ? null : decode(value);
  };
  return {
    read,
    prepare: (scope: ThreadVmCreationScope, request: RelayThreadVmCreateRequest) =>
      storage.withLock(keyFor(scope), async () => {
        const prior = await read(scope);
        if (prior) return prior;
        const draft = { request, response: null };
        await storage.write(keyFor(scope), encode(draft));
        return draft;
      }),
    acknowledge: (
      scope: ThreadVmCreationScope,
      request: RelayThreadVmCreateRequest,
      response: RelayThreadVmCreateResponse,
    ) =>
      storage.withLock(keyFor(scope), async () => {
        checkResponse(request, response);
        const prior = await read(scope);
        if (
          !prior ||
          encode({ request: prior.request, response: null }) !== encode({ request, response: null })
        )
          throw new Error("The saved VM creation changed while checking its response.");
        const draft = { request, response };
        await storage.write(keyFor(scope), encode(draft));
        return draft;
      }),
    finish: (scope: ThreadVmCreationScope, allocationId: string, cancelledReplacement?: string) =>
      storage.withLock(keyFor(scope), async () => {
        const prior = await read(scope);
        if (!prior || prior.request.allocationId !== allocationId)
          throw new Error("The saved VM creation changed.");
        if (
          prior.response?.status !== "accepted" &&
          (!cancelledReplacement ||
            prior.response?.status !== "quota_reached" ||
            cancelledReplacement !== prior.response.replacement?.requestId)
        )
          throw new Error("Check this creation before discarding an uncertain request.");
        await storage.remove(keyFor(scope));
      }),
  };
}

/** Relay-owned creation works before any environment is connected. */
export function createThreadVmCreationAtoms<R, E>(
  runtime: Atom.AtomRuntime<ManagedRelayTenancyClient | R, E>,
) {
  const authorize = Effect.fnUntraced(function* (
    registry: AtomRegistry.AtomRegistry,
    accountId: string,
  ) {
    const session = registry.get(managedRelaySessionAtom),
      relay = yield* ManagedRelayTenancyClient;
    if (!session || session.accountId !== accountId || !normalizeSecureRelayUrl(relay.relayUrl))
      return yield* new OrchestrationDispatchCommandError({
        message: "Sign in to this Launchpad Connect account first.",
      });
    const clerkToken = yield* session.readClerkToken();
    if (!clerkToken || registry.get(managedRelaySessionAtom) !== session)
      return yield* new OrchestrationDispatchCommandError({
        message: "Your account changed. Sign in again.",
      });
    return { session, relay, clerkToken };
  });
  const choices = createRuntimeCommand(runtime, {
    label: "VM repository choices",
    execute: Effect.fnUntraced(function* (input: { accountId: string }, registry) {
      const { session, relay, clerkToken } = yield* authorize(registry, input.accountId);
      const repositories = yield* relay.listRepositories({ clerkToken });
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. Reload the repositories.",
        });
      return repositories.flatMap(({ repository }) =>
        repository.canonicalKeys
          .filter((key) => /^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(key))
          .map((canonicalKey) => ({ repository, canonicalKey })),
      );
    }),
  });
  const create = createRuntimeCommand(runtime, {
    label: "create VM thread",
    concurrency: {
      mode: "serial",
      key: (input: { accountId: string; request: RelayThreadVmCreateRequest }) => input.accountId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { session, relay, clerkToken } = yield* authorize(registry, input.accountId);
      const response = yield* relay.createThreadVm({ clerkToken, payload: input.request });
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. Retry this saved creation after signing in.",
        });
      yield* Effect.try({
        try: () => checkResponse(input.request, response),
        catch: (cause) =>
          new OrchestrationDispatchCommandError({
            message: "The VM creation response did not match this request.",
            cause,
          }),
      });
      return response;
    }),
  });
  const replacement = createRuntimeCommand(runtime, {
    label: "VM creation replacement",
    concurrency: {
      mode: "serial",
      key: (input: {
        accountId: string;
        requestId: string;
        action: "read" | "cancel" | "select";
        victimAllocationId?: string;
      }) => input.accountId,
    },
    execute: Effect.fnUntraced(function* (input, registry) {
      const { session, relay, clerkToken } = yield* authorize(registry, input.accountId);
      if (input.action === "select" && !input.victimAllocationId)
        return yield* new OrchestrationDispatchCommandError({
          message: "Choose the VM to replace.",
        });
      const request =
        input.action === "cancel"
          ? yield* relay.cancelThreadVmReplacement({ clerkToken, requestId: input.requestId })
          : input.action === "select" && input.victimAllocationId
            ? yield* relay.selectThreadVmReplacement({
                clerkToken,
                requestId: input.requestId,
                victimAllocationId: input.victimAllocationId,
              })
            : yield* relay.getThreadVmReplacement({ clerkToken, requestId: input.requestId });
      if (request.requestId !== input.requestId)
        return yield* new OrchestrationDispatchCommandError({
          message: "The relay acknowledged a different replacement.",
        });
      const candidates =
        request.phase === "awaiting_choice"
          ? yield* relay.getThreadVmReplacementCandidates({
              clerkToken,
              requestId: request.requestId,
            })
          : [];
      if (registry.get(managedRelaySessionAtom) !== session)
        return yield* new OrchestrationDispatchCommandError({
          message: "Your account changed. Check this replacement after signing in.",
        });
      return { request, candidates };
    }),
  });
  return { choices, create, replacement };
}
