import {
  type RelayCodexVmConnection,
  type RelayThreadVmCodexAuthSource,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";

export class ThreadVmCodexAuthSourceError extends Schema.TaggedError<ThreadVmCodexAuthSourceError>()(
  "ThreadVmCodexAuthSourceError",
  { reason: Schema.Literals(["unavailable", "selection_changed", "reconnect_required"]) },
) {
  override get message() {
    switch (this.reason) {
      case "selection_changed":
        return "This VM's Codex account selection changed. Finish VM preparation before starting work.";
      case "reconnect_required":
        return "Reconnect the organization's Codex account in Organization settings before starting work.";
      case "unavailable":
        return "Could not verify this VM's Codex account with Launchpad Connect. Check the connection and retry.";
    }
  }
}
const unavailable = () => new ThreadVmCodexAuthSourceError({ reason: "unavailable" });

/** Read the current relay binding. A missing/unreachable VM source never means personal sign-in. */
export const readThreadVmCodexAuthSource = Effect.fn("ThreadVmCodexAuthSource.read")(
  function* () {
    const vm = yield* readInstalledThreadVm();
    if (!vm) return null;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const url = normalizeSecureRelayUrl(vm.relayUrl),
      issuer = normalizeSecureRelayUrl(vm.relayIssuer);
    if (vm.environmentId !== environmentId || !url || !issuer) return yield* unavailable();
    const client = yield* makeExecutorRelayApiClient({
      url,
      issuer,
      environmentCredential: vm.environmentCredential,
    });
    return yield* client.threadVmCodexAuth.codexAuthSource({
      params: { environmentId, threadId: vm.scope.threadId },
      payload: { generation: vm.scope.generation },
    });
  },
  Effect.timeout("5 seconds"),
  Effect.mapError(unavailable),
);

export interface ManagedThreadVmCodexAuthContext {
  readonly connectionId: string;
  readonly label: string;
  readonly status: Effect.Effect<RelayCodexVmConnection, ThreadVmCodexAuthSourceError>;
  readonly preflight: Effect.Effect<void, ThreadVmCodexAuthSourceError>;
}
interface ThreadVmCodexAuthContextShape {
  readonly current: Effect.Effect<
    ManagedThreadVmCodexAuthContext | null,
    ThreadVmCodexAuthSourceError
  >;
  /** True while the selected mode/connection still needs a provider rebuild receipt. */
  readonly refresh: Effect.Effect<boolean, ThreadVmCodexAuthSourceError>;
  readonly markApplied: Effect.Effect<void>;
  /** Keep source discovery and the provider rebuild receipt in one operation. */
  readonly withReloadLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** A captured personal VM provider must stop if preparation selects managed auth. */
  readonly personalPreflight: Effect.Effect<void, ThreadVmCodexAuthSourceError>;
}
export const ThreadVmCodexAuthContext = Context.Reference<ThreadVmCodexAuthContextShape>(
  "t3/relay/ThreadVmCodexAuthContext",
  {
    defaultValue: () => ({
      current: Effect.succeed(null),
      refresh: Effect.succeed(false),
      markApplied: Effect.void,
      withReloadLock: (effect) => effect,
      personalPreflight: Effect.void,
    }),
  },
);

const sourceKey = (source: RelayThreadVmCodexAuthSource | null) =>
  source?.mode === "organization" ? `organization:${source.connectionId}` : "personal";

export const makeThreadVmCodexAuthContext = Effect.gen(function* () {
  const dependencies = Context.make(ServerSecretStore, yield* ServerSecretStore).pipe(
    Context.add(ServerEnvironmentIdentity, yield* ServerEnvironmentIdentity),
    Context.add(HttpClient.HttpClient, yield* HttpClient.HttpClient),
  );
  const read = readThreadVmCodexAuthSource().pipe(Effect.provideContext(dependencies));
  let source: RelayThreadVmCodexAuthSource | null = null;
  let error: ThreadVmCodexAuthSourceError | null = unavailable();
  let appliedKey: string | null = null;
  const refreshLock = yield* Semaphore.make(1);
  const reloadLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const next = yield* read.pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          error = cause;
        }),
      ),
    );
    source = next;
    error = null;
    return sourceKey(next) !== appliedKey;
  }).pipe(refreshLock.withPermit);
  // Provider construction can show a useful unavailable snapshot while the guest
  // server remains reachable for preparation and retry.
  yield* refresh.pipe(Effect.ignore);
  if (error === null) appliedKey = sourceKey(source);
  const personalPreflight =
    source === null && error === null
      ? Effect.void
      : read.pipe(
          Effect.flatMap((latest) =>
            latest === null || latest.mode === "personal"
              ? Effect.void
              : Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "selection_changed" })),
          ),
        );
  const current = Effect.suspend(() => {
    if (error) return Effect.fail(error);
    if (source?.mode !== "organization") return Effect.succeed(null);
    const selected = source;
    if (selected.connection.connectionId !== selected.connectionId)
      return Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "selection_changed" }));
    const status = read.pipe(
      Effect.flatMap((latest) =>
        latest?.mode === "organization" &&
        latest.connectionId === selected.connectionId &&
        latest.connection.connectionId === selected.connectionId
          ? Effect.succeed(latest.connection)
          : Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "selection_changed" })),
      ),
    );
    return Effect.succeed({
      connectionId: selected.connectionId,
      label: selected.connection.label ?? "Organization Codex",
      status,
      preflight: status.pipe(
        Effect.flatMap((connection) =>
          connection.status === "connected"
            ? Effect.void
            : Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "reconnect_required" })),
        ),
      ),
    } satisfies ManagedThreadVmCodexAuthContext);
  });
  return {
    current,
    refresh,
    personalPreflight,
    withReloadLock: reloadLock.withPermit,
    markApplied: Effect.sync(() => {
      if (error === null) appliedKey = sourceKey(source);
    }),
  } satisfies ThreadVmCodexAuthContextShape;
});

export const threadVmCodexAuthContextLayer = Layer.effect(
  ThreadVmCodexAuthContext,
  makeThreadVmCodexAuthContext,
).pipe(Layer.provide(FetchHttpClient.layer));
