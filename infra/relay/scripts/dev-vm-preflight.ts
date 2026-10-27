// @effect-diagnostics globalConsole:off - Standalone preflight reports configuration errors only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { loadDevThreadVmRuntimeSettings } from "./dev-thread-vm-template.ts";

// Check the same host/image configuration as the relay without opening its database or starting workers.
await Effect.runPromise(
  loadDevThreadVmRuntimeSettings.pipe(
    Effect.provide(NodeServices.layer),
    Effect.match({
      onSuccess: () => {},
      onFailure: (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
    }),
  ),
);
