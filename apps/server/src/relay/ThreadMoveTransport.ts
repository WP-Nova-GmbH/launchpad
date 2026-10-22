import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayThreadMove, RelayThreadArtifactReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  threadId: Schema.String,
  detail: Schema.String,
}) {}
export type ThreadMoveOwner = ThreadHistoryOwner & { readonly operationId: string };
type RelayClient = Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>;
type Parameters = { environmentId: EnvironmentId; threadId: ThreadId; operationId: string };
type Upload = Omit<RelayThreadArtifactReceipt, "threadId" | "state">;

// Four 64 MiB chunks share the connection. Allow the relay's bounded transfer
// window rather than cancelling valid uploads before their receipts arrive.
export const THREAD_MOVE_ARTIFACT_TIMEOUT = "10 minutes";

/** Every request obtains the current environment credential. A lost reply leaves
 * the same operation in the relay and never authorizes a second local owner. */
export function makeThreadMoveTransport<E, R>(
  clientFor: (owner: ThreadHistoryOwner) => Effect.Effect<RelayClient, E, R>,
  upload: (
    owner: ThreadHistoryOwner,
    file: Upload,
    body: Stream.Stream<Uint8Array, unknown>,
  ) => Effect.Effect<
    RelayThreadArtifactReceipt,
    E | import("./ThreadCheckpointPublisher.ts").ThreadCheckpointPublishError,
    R
  >,
) {
  const fail = (threadId: string) =>
    new ThreadMoveError({
      threadId,
      detail: "The move is waiting for relay confirmation. The source is retained.",
    });
  const request = <A, E1>(
    owner: ThreadMoveOwner,
    action: (client: RelayClient, params: Parameters) => Effect.Effect<A, E1>,
  ) =>
    Effect.gen(function* () {
      const client = yield* clientFor(owner);
      return yield* action(client, {
        environmentId: EnvironmentId.make(owner.environmentId),
        threadId: ThreadId.make(owner.threadId),
        operationId: owner.operationId,
      });
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() => fail(owner.threadId)),
    );
  return {
    pending: (owner: ThreadHistoryOwner, after: string | null) =>
      Effect.gen(function* () {
        const client = yield* clientFor(owner);
        return yield* client.threadMoves.pending({
          params: { environmentId: EnvironmentId.make(owner.environmentId) },
          payload: { after, limit: 50 },
        });
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => fail(owner.threadId)),
      ),
    begin: (
      owner: ThreadMoveOwner,
      input: {
        actorUserId: string;
        destinationEnvironmentId: EnvironmentId;
        destinationProjectId: import("@t3tools/contracts").ProjectId;
      },
    ) =>
      request(owner, (client, params) =>
        client.threadMoves.begin({ params, payload: { generation: owner.generation, ...input } }),
      ),
    beginVm: (owner: ThreadMoveOwner, input: { actorUserId: string; cancelBeforeStart: boolean }) =>
      request(owner, (client, params) =>
        client.threadMoves.beginVm({ params, payload: { generation: owner.generation, ...input } }),
      ),
    get: (owner: ThreadMoveOwner) =>
      request(owner, (client, params) =>
        client.threadMoves.get({ params, payload: { generation: owner.generation } }),
      ),
    failed: (owner: ThreadMoveOwner, detail: string) =>
      request(owner, (client, params) =>
        client.threadMoves.failed({ params, payload: { generation: owner.generation, detail } }),
      ),
    freeze: (owner: ThreadMoveOwner, input: { sourceCursor: number; manifestSha256: string }) =>
      request(owner, (client, params) =>
        client.threadMoves.freeze({ params, payload: { generation: owner.generation, ...input } }),
      ),
    ready: (owner: ThreadMoveOwner, input: { sourceCursor: number; manifestSha256: string }) =>
      request(owner, (client, params) =>
        client.threadMoves.ready({ params, payload: { generation: owner.generation, ...input } }),
      ),
    commit: (owner: ThreadMoveOwner) =>
      request(owner, (client, params) =>
        client.threadMoves.commit({ params, payload: { generation: owner.generation } }),
      ),
    activate: (owner: ThreadMoveOwner) =>
      request(owner, (client, params) =>
        client.threadMoves.activate({ params, payload: { generation: owner.generation } }),
      ),
    abort: (owner: ThreadMoveOwner) =>
      request(owner, (client, params) =>
        client.threadMoves.abort({ params, payload: { generation: owner.generation } }),
      ),
    removed: (owner: ThreadMoveOwner) =>
      request(owner, (client, params) =>
        client.threadMoves.removed({ params, payload: { generation: owner.generation } }),
      ),
    publish: (owner: ThreadMoveOwner, manifestArtifactId: string) =>
      Effect.gen(function* () {
        const client = yield* clientFor(owner);
        return yield* client.threadMoves.publish({
          params: {
            environmentId: EnvironmentId.make(owner.environmentId),
            threadId: ThreadId.make(owner.threadId),
            operationId: owner.operationId,
          },
          payload: { generation: owner.generation, manifestArtifactId },
        });
      }).pipe(
        Effect.timeout("55 minutes"),
        Effect.mapError(() => fail(owner.threadId)),
      ),
    artifact: (owner: ThreadMoveOwner, artifactId: string) =>
      request(owner, (client, params) =>
        client.threadMoves.artifact({
          params: { ...params, artifactId },
          query: { generation: owner.generation },
        }),
      ).pipe(Effect.map((body) => body.pipe(Stream.mapError(() => fail(owner.threadId))))),
    upload: (owner: ThreadMoveOwner, file: Upload, body: Stream.Stream<Uint8Array, unknown>) =>
      upload(owner, file, body).pipe(
        Effect.timeout(THREAD_MOVE_ARTIFACT_TIMEOUT),
        Effect.mapError(() => fail(owner.threadId)),
      ),
  };
}
export type ThreadMoveTransport = ReturnType<typeof makeThreadMoveTransport<never, never>>;
export const assertThreadMoveIdentity = (owner: ThreadMoveOwner, move: RelayThreadMove) =>
  move.threadId === owner.threadId &&
  move.operationId === owner.operationId &&
  ((owner.environmentId === move.sourceEnvironmentId &&
    owner.generation === move.expectedGeneration) ||
    (owner.environmentId === move.destinationEnvironmentId &&
      owner.generation === move.expectedGeneration + 1))
    ? Effect.void
    : Effect.fail(
        new ThreadMoveError({
          threadId: owner.threadId,
          detail: "The relay returned a different move or participant.",
        }),
      );
