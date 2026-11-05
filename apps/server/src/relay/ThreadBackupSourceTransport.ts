import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmBackupSource } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";

export class ThreadBackupSourceError extends Schema.TaggedError<ThreadBackupSourceError>()(
  "ThreadBackupSourceError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {}
export interface ThreadBackupSourceTransport {
  readonly cancel: (
    owner: ThreadHistoryOwner,
    input: { operationId: string },
  ) => Effect.Effect<RelayThreadVmBackupSource, ThreadBackupSourceError>;
  readonly activate: (
    owner: ThreadHistoryOwner,
    input: { operationId: string },
  ) => Effect.Effect<RelayThreadVmBackupSource, ThreadBackupSourceError>;
  readonly get: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<RelayThreadVmBackupSource | null, ThreadBackupSourceError>;
  readonly freeze: (
    owner: ThreadHistoryOwner,
    input: {
      operationId: string;
      nativeCheckpointOperationId: string;
      bootId: string;
      sealEpoch: number;
    },
  ) => Effect.Effect<RelayThreadVmBackupSource, ThreadBackupSourceError>;
}
export function makeThreadBackupSourceTransport<E, R>(
  clientFor: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>, E, R>,
) {
  const fail = (owner: ThreadHistoryOwner) =>
    new ThreadBackupSourceError({
      threadId: owner.threadId,
      detail: "VM backup is waiting for retained recovery and relay confirmation.",
    });
  const get = Effect.fn("ThreadBackupSourceTransport.get")(
    function* (owner: ThreadHistoryOwner) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.getBackupSource({
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
  const freeze = Effect.fn("ThreadBackupSourceTransport.freeze")(
    function* (
      owner: ThreadHistoryOwner,
      input: {
        operationId: string;
        nativeCheckpointOperationId: string;
        bootId: string;
        sealEpoch: number;
      },
    ) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.freezeBackupSource({
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
  const activate = Effect.fn("ThreadBackupSourceTransport.activate")(
    function* (owner: ThreadHistoryOwner, input: { operationId: string }) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.confirmBackupSourceActivation({
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
  const cancel = Effect.fn("ThreadBackupSourceTransport.cancel")(
    function* (owner: ThreadHistoryOwner, input: { operationId: string }) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.cancelBackupSource({
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
