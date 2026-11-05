import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadExecution } from "../relay/ThreadExecution.ts";
import { CheckoutCaptureError } from "../persistence/CheckoutCapture.ts";
import { ProviderExecutionError } from "./Errors.ts";

const isCheckoutCaptureError = Schema.is(CheckoutCaptureError);

/** Bound turns stay admitted until checkpointing; only acknowledged idle invocations complete here. */
export function makeProviderExecution(
  execution: Pick<
    ThreadExecution["Service"],
    "begin" | "wasStarted" | "completeInvocation" | "rejectInvocation" | "bindTurn"
  >,
) {
  return Effect.fn("ProviderExecution.admit")(function* (
    threadId: string,
    operation: string,
    invocationId?: string,
  ) {
    const work = {
      threadId,
      kind: "provider" as const,
      workId: `${operation}:${invocationId ?? NodeCrypto.randomUUID()}`,
    };
    const decision = yield* execution.begin(work).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // If even the durable local record is unreadable, lack of a reply is
          // uncertainty, not permission to release the prompt for another attempt.
          const uncertain = yield* execution
            .wasStarted(work)
            .pipe(Effect.orElseSucceed(() => true));
          return yield* new ProviderExecutionError({
            threadId,
            operation,
            uncertain,
            ...(isCheckoutCaptureError(cause) && cause.waitingForCheckout
              ? { waitingForCheckout: true }
              : {}),
            cause,
          });
        }),
      ),
    );
    if (decision !== "ordinary" && decision !== "start")
      return yield* new ProviderExecutionError({ threadId, operation, uncertain: true });
    const unresolved = (cause: unknown) =>
      new ProviderExecutionError({ threadId, operation, uncertain: true, cause });
    return {
      complete: execution.completeInvocation(work).pipe(Effect.mapError(unresolved)),
      reject: execution.rejectInvocation(work).pipe(Effect.mapError(unresolved)),
      bindTurn: (turnId: string) =>
        execution.bindTurn(work, turnId).pipe(Effect.mapError(unresolved)),
    };
  });
}
