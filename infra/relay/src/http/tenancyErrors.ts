import * as Effect from "effect/Effect";

import {
  RelayTenancyConflictError,
  type RelayTenancyConflictReason,
  RelayTenancyForbiddenError,
  type RelayTenancyForbiddenReason,
  RelayTenancyNotFoundError,
  type RelayTenancyNotFoundReason,
} from "@t3tools/contracts/relay";

import { currentTraceId } from "../observability.ts";

export const tenancyForbidden = Effect.fnUntraced(function* (reason: RelayTenancyForbiddenReason) {
  const traceId = yield* currentTraceId;
  yield* Effect.annotateCurrentSpan({
    "relay.error.outbound_tag": "RelayTenancyForbiddenError",
    "relay.error.outbound_reason": reason,
  });
  return yield* new RelayTenancyForbiddenError({ code: "tenancy_forbidden", reason, traceId });
});

export const tenancyNotFound = Effect.fnUntraced(function* (reason: RelayTenancyNotFoundReason) {
  const traceId = yield* currentTraceId;
  return yield* new RelayTenancyNotFoundError({ code: "tenancy_not_found", reason, traceId });
});

export const tenancyConflict = Effect.fnUntraced(function* (reason: RelayTenancyConflictReason) {
  const traceId = yield* currentTraceId;
  return yield* new RelayTenancyConflictError({ code: "tenancy_conflict", reason, traceId });
});
