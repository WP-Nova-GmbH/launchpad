import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmPause } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";

export class ThreadPauseError extends Schema.TaggedError<ThreadPauseError>()("ThreadPauseError", {
  threadId: Schema.String,
  detail: Schema.String,
}) {}
export interface ThreadPauseTransport {
  readonly cancel: (
    owner: ThreadHistoryOwner,
    input: { operationId: string },
  ) => Effect.Effect<RelayThreadVmPause, ThreadPauseError>;
  readonly activate: (
    owner: ThreadHistoryOwner,
    input: { operationId: string },
  ) => Effect.Effect<RelayThreadVmPause, ThreadPauseError>;
  readonly get: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<RelayThreadVmPause | null, ThreadPauseError>;
  readonly freeze: (
    owner: ThreadHistoryOwner,
    input: { operationId: string; nativeCheckpointOperationId: string; bootId: string },
  ) => Effect.Effect<RelayThreadVmPause, ThreadPauseError>;
}
export function makeThreadPauseTransport<E, R>(
  clientFor: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>, E, R>,
) {
  const fail = (owner: ThreadHistoryOwner) =>
    new ThreadPauseError({
      threadId: owner.threadId,
      detail: "VM pause is waiting for retained recovery and relay confirmation.",
    });
  const get = Effect.fn("ThreadPauseTransport.get")(
    function* (owner: ThreadHistoryOwner) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.getPause({
        params: {
          environmentId: EnvironmentId.make(owner.environmentId),
          threadId: ThreadId.make(owner.threadId),
        },
        payload: { generation: owner.generation },
      });
    },
    (effect, owner) =>
      effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => fail(owner)),
      ),
  );
  const freeze = Effect.fn("ThreadPauseTransport.freeze")(
    function* (
      owner: ThreadHistoryOwner,
      input: { operationId: string; nativeCheckpointOperationId: string; bootId: string },
    ) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.freezePause({
        params: {
          environmentId: EnvironmentId.make(owner.environmentId),
          threadId: ThreadId.make(owner.threadId),
        },
        payload: { generation: owner.generation, ...input },
      });
    },
    (effect, owner) =>
      effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => fail(owner)),
      ),
  );
  const activate = Effect.fn("ThreadPauseTransport.activate")(
    function* (owner: ThreadHistoryOwner, input: { operationId: string }) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.confirmPauseActivation({
        params: {
          environmentId: EnvironmentId.make(owner.environmentId),
          threadId: ThreadId.make(owner.threadId),
        },
        payload: { generation: owner.generation, ...input },
      });
    },
    (effect, owner) =>
      effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => fail(owner)),
      ),
  );
  const cancel = Effect.fn("ThreadPauseTransport.cancel")(
    function* (owner: ThreadHistoryOwner, input: { operationId: string }) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.cancelPause({
        params: {
          environmentId: EnvironmentId.make(owner.environmentId),
          threadId: ThreadId.make(owner.threadId),
        },
        payload: { generation: owner.generation, ...input },
      });
    },
    (effect, owner) =>
      effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => fail(owner)),
      ),
  );
  return { get, freeze, activate, cancel };
}
