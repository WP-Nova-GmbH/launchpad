import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadExecution } from "../../relay/ThreadExecution.ts";
import {
  makeThreadExecutionRelay,
  ThreadExecutionRelayError,
} from "../../relay/ThreadExecutionRelay.ts";

/** Ordinary-provider fixtures have no placement; accidental portable execution fails closed. */
export const threadExecutionTestLayerForDatabase = Layer.effect(
  ThreadExecution,
  Effect.gen(function* () {
    return makeThreadExecutionRelay(yield* SqlClient.SqlClient, {
      admit: (work) =>
        Effect.fail(
          new ThreadExecutionRelayError({
            threadId: work.threadId,
            operation: "admit",
            detail: "No test relay configured",
          }),
        ),
      complete: (work) =>
        Effect.fail(
          new ThreadExecutionRelayError({
            threadId: work.threadId,
            operation: "complete",
            detail: "No test relay configured",
          }),
        ),
    });
  }),
);
export const threadExecutionTestLayer = threadExecutionTestLayerForDatabase.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
