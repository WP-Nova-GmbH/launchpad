import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type { ThreadExecution } from "../relay/ThreadExecution.ts";
import { ProviderExecutionError } from "./Errors.ts";

/** A native reply is not evidence that its tools stopped; the workload supervisor owns completion. */
export function makeProviderExecution(
  execution: Pick<ThreadExecution["Service"], "begin" | "wasStarted">,
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
          return yield* new ProviderExecutionError({ threadId, operation, uncertain, cause });
        }),
      ),
    );
    if (decision !== "ordinary" && decision !== "start")
      return yield* new ProviderExecutionError({ threadId, operation, uncertain: true });
  });
}
