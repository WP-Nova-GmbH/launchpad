import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayThreadLocalEnrollmentAbortResponse,
  RelayThreadLocalEnrollmentRequest,
  RelayThreadLocalEnrollmentReceiptRequest,
  RelayThreadLocalEnrollmentResponse,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import type { ThreadHistoryOwner } from "./ThreadHistorySync.ts";
import type { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { ThreadMoveError } from "./ThreadMoveTransport.ts";
export interface ThreadLocalEnrollmentTransport {
  readonly abort: (
    owner: ThreadHistoryOwner,
    input: RelayThreadLocalEnrollmentRequest,
  ) => Effect.Effect<typeof RelayThreadLocalEnrollmentAbortResponse.Type, ThreadMoveError>;
  readonly prepare: (
    owner: ThreadHistoryOwner,
    input: RelayThreadLocalEnrollmentRequest,
  ) => Effect.Effect<typeof RelayThreadLocalEnrollmentResponse.Type, ThreadMoveError>;
  readonly receipts: (
    owner: ThreadHistoryOwner,
    input: RelayThreadLocalEnrollmentReceiptRequest,
  ) => Effect.Effect<{ readonly ok: true }, ThreadMoveError>;
  readonly confirm: (
    owner: ThreadHistoryOwner,
    input: { operationId: string; sourceSequence: number; receiptCount: number },
  ) => Effect.Effect<typeof RelayThreadLocalEnrollmentResponse.Type, ThreadMoveError>;
}
export function makeThreadLocalEnrollmentTransport<E, R>(
  clientFor: (
    owner: ThreadHistoryOwner,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>, E, R>,
) {
  const call = <A, E1>(
    owner: ThreadHistoryOwner,
    action: (
      client: Effect.Success<ReturnType<typeof makeExecutorRelayApiClient>>,
      params: { environmentId: EnvironmentId; threadId: ThreadId },
    ) => Effect.Effect<A, E1>,
  ) =>
    Effect.gen(function* () {
      return yield* action(yield* clientFor(owner), {
        environmentId: EnvironmentId.make(owner.environmentId),
        threadId: ThreadId.make(owner.threadId),
      });
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(
        () =>
          new ThreadMoveError({
            threadId: owner.threadId,
            detail: "Local enrollment is waiting for relay confirmation. Its source is retained.",
          }),
      ),
    );
  return {
    abort: (owner: ThreadHistoryOwner, payload: RelayThreadLocalEnrollmentRequest) =>
      call(owner, (c, params) => c.threadEnvironment.abortLocalEnrollment({ params, payload })),
    prepare: (owner: ThreadHistoryOwner, payload: RelayThreadLocalEnrollmentRequest) =>
      call(owner, (c, params) => c.threadEnvironment.prepareLocalEnrollment({ params, payload })),
    receipts: (owner: ThreadHistoryOwner, payload: RelayThreadLocalEnrollmentReceiptRequest) =>
      call(owner, (c, params) =>
        c.threadEnvironment.receiveLocalEnrollmentReceipts({ params, payload }),
      ),
    confirm: (
      owner: ThreadHistoryOwner,
      payload: { operationId: string; sourceSequence: number; receiptCount: number },
    ) =>
      call(owner, (c, params) => c.threadEnvironment.confirmLocalEnrollment({ params, payload })),
  };
}
