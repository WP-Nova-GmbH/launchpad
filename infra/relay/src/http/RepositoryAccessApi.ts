import { RelayApi, RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as Machines from "../machines/Machines.ts";
import * as Policies from "../tenancy/RepositoryPolicies.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
const machineFor = Effect.fn(function* (environmentId: string) {
  const principal = yield* RelayEnvironmentPrincipal;
  const machines = yield* Machines.Machines;
  const machine = yield* machines.getActiveByEnvironmentId({ environmentId });
  if (
    !machine ||
    principal.environmentId !== environmentId ||
    machine.environmentPublicKey !== principal.environmentPublicKey
  )
    return yield* new HttpApiError.Unauthorized({});
  return machine;
});
export const repositoryAccessServerApi = HttpApiBuilder.group(
  RelayApi,
  "repositoryAccessServer",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle(
          "getPolicy",
          Effect.fn(function* ({ params }) {
            const machine = yield* machineFor(params.environmentId);
            return yield* Policies.proof(machine.organizationId, params.environmentId).pipe(
              Effect.catch(() => relayInternalErrorResponse("persistence_failed")),
            );
          }, mapRelayCommonApiErrors("not_authorized")),
        )
        .handle(
          "acknowledgePolicy",
          Effect.fn(function* ({ params, payload }) {
            const machine = yield* machineFor(params.environmentId);
            const ok = yield* Policies.acknowledge({
              organizationId: machine.organizationId,
              environmentId: params.environmentId,
              publicKey: machine.environmentPublicKey!,
              ack: payload,
            }).pipe(Effect.catch(() => relayInternalErrorResponse("persistence_failed")));
            if (!ok) return yield* new HttpApiError.Unauthorized({});
            return { ok: true };
          }, mapRelayCommonApiErrors("not_authorized")),
        ),
    ),
);
