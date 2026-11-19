import {
  WS_METHODS,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportProgress,
} from "@t3tools/contracts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { request, runStream, EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { serverEnvironment } from "./server";
import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Scan of Claude Code / Codex home directories on an environment, surfacing
 * project candidates for the welcome wizard's import step. The scan walks the
 * filesystem server-side, so results are cached briefly and refreshed when the
 * import step remounts.
 */
export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  execute: (
    input: {
      readonly request: AgentSessionImportInput;
      readonly onProgress: (progress: AgentSessionImportProgress) => void;
    },
    registry,
    environmentId,
  ) =>
    Effect.gen(function* () {
      const config = registry.get(serverEnvironment.configValueAtom(environmentId));
      if (config?.environment.capabilities.agentSessionImportProgress !== true) {
        return yield* request(WS_METHODS.agentSessionsImport, input.request);
      }
      let result: AgentSessionImportResult | undefined;
      yield* runStream(WS_METHODS.agentSessionsImportWithProgress, input.request).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "complete") result = event.result;
            else input.onProgress(event.progress);
          }),
        ),
      );
      if (result === undefined) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId,
          message:
            "The import connection closed before completion. Retry to import the remaining history.",
        });
      }
      return result;
    }),
});
