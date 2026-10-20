import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadVmFinalSave } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";

export class ThreadFinalSaveError extends Schema.TaggedError<ThreadFinalSaveError>()(
  "ThreadFinalSaveError",
  {
    threadId: Schema.String,
    detail: Schema.String,
  },
) {}
export interface ThreadFinalSaveTransport {
  readonly cancel: (
    owner: ThreadHistoryOwner,
    input: { operationId: string },
  ) => Effect.Effect<RelayThreadVmFinalSave, ThreadFinalSaveError>;
  readonly get: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<RelayThreadVmFinalSave | null, ThreadFinalSaveError>;
  readonly freeze: (
    owner: ThreadHistoryOwner,
    input: { operationId: string; nativeCheckpointOperationId: string },
  ) => Effect.Effect<RelayThreadVmFinalSave, ThreadFinalSaveError>;
}
export function makeThreadFinalSaveTransport<E, R>(
  clientFor: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>, E, R>,
) {
  const fail = (owner: ThreadHistoryOwner) =>
    new ThreadFinalSaveError({
      threadId: owner.threadId,
      detail: "Final saving is waiting for relay confirmation. The VM is retained.",
    });
  const get = Effect.fn("ThreadFinalSaveTransport.get")(
    function* (owner: ThreadHistoryOwner) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.getFinalSave({
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
  const freeze = Effect.fn("ThreadFinalSaveTransport.freeze")(
    function* (
      owner: ThreadHistoryOwner,
      input: { operationId: string; nativeCheckpointOperationId: string },
    ) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.freezeFinalSave({
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
  const cancel = Effect.fn("ThreadFinalSaveTransport.cancel")(
    function* (owner: ThreadHistoryOwner, input: { operationId: string }) {
      const client = yield* clientFor(owner);
      return yield* client.threadEnvironment.cancelFinalSave({
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
  return { get, freeze, cancel };
}
