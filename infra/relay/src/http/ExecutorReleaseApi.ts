import { RelayApi } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as RelayConfiguration from "../Config.ts";
import { mapRelayCommonApiErrors } from "./Api.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";

/**
 * Which source an enrolled executor should be running. Executors ask on a
 * timer and update themselves when the ref's head moves, so a push to the
 * branch that deploys the relay also deploys every machine.
 */
export const resolveExecutorRelease = Effect.fn("relay.executor_release.resolve")(
  function* (input: { readonly environmentId: string }) {
    const machine = yield* requireEnrolledExecutor({ environmentId: input.environmentId });
    const { executorSource } = yield* RelayConfiguration.RelayConfiguration;
    if (executorSource === undefined) {
      return yield* tenancyNotFound("executor_source_not_configured");
    }
    return { machine, release: executorSource };
  },
);

export const executorReleaseServerApi = HttpApiBuilder.group(
  RelayApi,
  "executorReleaseServer",
  (handlers) =>
    handlers.handle(
      "getExecutorRelease",
      Effect.fn("relay.api.executor_release.get")(function* (args) {
        const { release } = yield* resolveExecutorRelease({
          environmentId: args.params.environmentId,
        });
        return { gitUrl: release.gitUrl, ref: release.ref };
      }, mapRelayCommonApiErrors("not_authorized")),
    ),
);
