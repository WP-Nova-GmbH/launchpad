import {
  RelayApi,
  RelayClientPrincipal,
  type ThreadVmPolicyRecord,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import { makeThreadVmPolicyStore } from "../threads/ThreadVmPolicy.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
import { resolveMembership } from "./TenancyApi.ts";
import { tenancyConflict, tenancyForbidden } from "./tenancyErrors.ts";

export const getThreadVmPolicy = Effect.fn("relay.api.thread_vm_policy.get")(function* () {
  const { userId } = yield* RelayClientPrincipal;
  const membership = yield* resolveMembership({ userId });
  const db = yield* RelayDb;
  return yield* makeThreadVmPolicyStore(db.$client)
    .get(membership.organization.organizationId)
    .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
}, mapRelayCommonApiErrors("not_authorized"));

export const updateThreadVmPolicy = Effect.fn("relay.api.thread_vm_policy.update")(function* (
  input: ThreadVmPolicyRecord,
) {
  const { userId } = yield* RelayClientPrincipal;
  const membership = yield* resolveMembership({ userId });
  if (input.organizationId !== membership.organization.organizationId)
    return yield* tenancyConflict("vm_policy_changed");
  const sql = (yield* RelayDb).$client;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // Hold membership through the write: a concurrent demotion/removal must serialize here.
        const admins = yield* sql`SELECT user_id FROM relay_organization_members
      WHERE user_id = ${userId} AND organization_id = ${membership.organization.organizationId} AND role = 'admin' FOR SHARE`;
        if (!admins.length) return yield* tenancyForbidden("not_an_admin");
        return yield* makeThreadVmPolicyStore(sql)
          .update({
            organizationId: membership.organization.organizationId,
            expectedRevision: input.revision,
            policy: input.policy,
          })
          .pipe(
            Effect.catchTags({
              ThreadPlacementConflict: () => tenancyConflict("vm_policy_changed"),
              SchemaError: () => relayInternalErrorResponse("internal_error"),
            }),
          );
      }),
    )
    .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("internal_error")));
}, mapRelayCommonApiErrors("not_authorized"));

export const threadVmPolicyApi = HttpApiBuilder.group(RelayApi, "threadVmPolicy", (handlers) =>
  handlers
    .handle("getThreadVmPolicy", () => getThreadVmPolicy())
    .handle("updateThreadVmPolicy", ({ payload }) => updateThreadVmPolicy(payload)),
);
