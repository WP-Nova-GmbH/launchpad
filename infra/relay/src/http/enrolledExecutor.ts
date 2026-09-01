import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as Machines from "../machines/Machines.ts";

/**
 * The machine an environment-authenticated request may act for.
 *
 * The bearer credential proves an environment; this proves that environment
 * is an active, enrolled agent executor whose key matches, so an organization
 * capability granted to the caller lands only on organization compute. A
 * personal machine, a review host, a deprovisioned machine, and a mismatched
 * key all read as unauthorized rather than as distinct answers.
 */
export const requireEnrolledExecutor = Effect.fn("relay.api.require_enrolled_executor")(
  function* (input: { readonly environmentId: string }) {
    const principal = yield* RelayEnvironmentPrincipal;
    if (principal.environmentId !== input.environmentId) {
      return yield* new HttpApiError.Unauthorized({});
    }
    const machines = yield* Machines.Machines;
    const machine = yield* machines.getActiveByEnvironmentId({
      environmentId: input.environmentId,
    });
    if (
      machine === null ||
      machine.role !== "agent_executor" ||
      machine.environmentPublicKey !== principal.environmentPublicKey
    ) {
      return yield* new HttpApiError.Unauthorized({});
    }
    return machine;
  },
);
