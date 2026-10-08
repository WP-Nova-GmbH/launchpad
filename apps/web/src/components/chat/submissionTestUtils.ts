import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
  EnvironmentRegistry,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type {
  EnqueueThreadPromptInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/operations";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { createThreadEnvironmentAtoms } from "@t3tools/client-runtime/state/threads";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

/** Real prompt authorization and dispatch, with only the environment and relay transport replaced. */
export function makeSubmissionRuntime(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  sharedPromptQueue = false,
) {
  const dispatched: ClientOrchestrationCommand[] = [];
  const requests: Request[] = [];
  const supervisorLayer = Layer.effect(
    EnvironmentSupervisor,
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed({
          environment: { capabilities: { sharedPromptQueue } },
        } as ServerConfig),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      return {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Local",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      };
    }),
  );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.unwrap(
        Effect.gen(function* () {
          return Layer.mock(EnvironmentRegistry, {
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map()),
            networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
            run: (_environmentId, effect) => Effect.provide(effect, supervisorLayer),
          });
        }),
      ),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
          digest: (algorithm, bytes) =>
            Effect.promise(
              async () =>
                new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes))),
            ),
        }),
      ),
      Layer.mock(ManagedRelay.ManagedRelayClient, { relayUrl: "https://relay.test" }),
      Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ authorization: "personal-grant" });
      }),
    ),
  );
  const commands = createThreadEnvironmentAtoms(runtime, () => Atom.make(null));
  return {
    dispatched,
    requests,
    start: (input: StartThreadTurnInput) =>
      commands.startTurn.run(registry, { environmentId, input }),
    enqueue: (input: EnqueueThreadPromptInput) =>
      commands.enqueuePrompt.run(registry, { environmentId, input }),
  };
}

export function preparationBarrier() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      enter();
      return waiting;
    },
  };
}
