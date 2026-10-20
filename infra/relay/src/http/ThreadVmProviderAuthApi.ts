import { RelayThreadVmProviderAuthRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeE2BThreadVmProviderAuth } from "../machines/E2BThreadVmProviderAuth.ts";
import { readPendingThreadVmProviderAuth } from "../threads/ThreadVmPendingProviderAuth.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { withPrivateThreadAccess } from "./privateThreadAccess.ts";
import { tenancyConflict } from "./tenancyErrors.ts";

/** Authorization, operation and allocation locks remain held across the narrow guest call. */
export const threadVmProviderAuth = Effect.fn("relay.api.thread_vm.provider_auth")(
  function* (
    threadId: string,
    action: "status" | "start" | "cancel",
    input?: RelayThreadVmProviderAuthRequest & { flowId?: string },
  ) {
    const sql = (yield* RelayDb).$client;
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    return yield* withPrivateThreadAccess(threadId, action === "status" ? "read" : "write", () =>
      Effect.gen(function* () {
        const pending = yield* readPendingThreadVmProviderAuth(sql, threadId);
        if (!pending && action === "status") return null;
        if (
          !pending ||
          !settings ||
          (action !== "status" &&
            (!input ||
              input.operationId !== pending.binding.operationId ||
              input.allocationId !== pending.binding.allocationId ||
              input.generation !== pending.binding.generation))
        )
          return yield* tenancyConflict("thread_placement_changed");
        const result = yield* makeE2BThreadVmProviderAuth(settings.compute)({
          ...pending,
          threadId,
          control: {
            binding: pending.binding,
            action,
            ...(input?.flowId ? { flowId: input.flowId } : {}),
          },
        }).pipe(Effect.timeout("45 seconds"));
        const current = yield* readPendingThreadVmProviderAuth(sql, threadId);
        if (
          !current ||
          current.binding.operationId !== pending.binding.operationId ||
          current.binding.allocationId !== pending.binding.allocationId ||
          current.computeRef !== pending.computeRef ||
          current.binding.generation !== pending.binding.generation ||
          current.binding.environmentId !== pending.binding.environmentId
        )
          return yield* tenancyConflict("thread_placement_changed");
        return result;
      }),
    );
  },
  Effect.catchTags({
    ThreadVmComputeError: () => relayInternalErrorResponse("upstream_unavailable"),
    TimeoutError: () => relayInternalErrorResponse("upstream_unavailable"),
  }),
);
