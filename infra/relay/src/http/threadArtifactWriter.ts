import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { isWorkflowVmThread, withWorkflowVmGuest } from "../jobs/WorkflowVmBinding.ts";
import { withEnvironmentThread } from "./ThreadEnvironmentApi.ts";

/** Only database work belongs inside these authorization locks. */
export const withThreadArtifactWriter = <A, E, R>(
  input: { threadId: string; environmentId: string; generation: number },
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    return yield* (yield* isWorkflowVmThread(sql, input.threadId))
      ? withWorkflowVmGuest(input, "enrolled", () => action)
      : withEnvironmentThread(input, true, action);
  });
