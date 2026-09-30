import {
  RelayApi,
  RelayClientPrincipal,
  RelayInternalError,
  RelayIssueTrackerError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as Connections from "../issueTrackers/Connections.ts";
import type { ConnectionPersistenceError } from "../issueTrackers/ConnectionStore.ts";
import { mapErrorTags, mapRelayCommonApiErrors } from "./Api.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";
import { requireAdmin, resolveMembership } from "./TenancyApi.ts";

const persistenceFailure = (_error: ConnectionPersistenceError, traceId: string) =>
  new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId });
const trackerFailure = (error: RelayIssueTrackerError, traceId: string) =>
  new RelayIssueTrackerError({ code: error.code, message: error.message, traceId });

export const issueTrackersApi = HttpApiBuilder.group(RelayApi, "issueTrackers", (handlers) =>
  handlers
    .handle(
      "listConnections",
      Effect.fn("issueTrackers.api.list")(
        function* () {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* resolveMembership({ userId });
          return yield* Connections.listConnections(membership.organization.organizationId);
        },
        mapErrorTags({ IssueTrackerConnectionPersistenceError: persistenceFailure }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "startLinear",
      Effect.fn("issueTrackers.api.startLinear")(
        function* () {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* Connections.startLinear({
            organizationId: membership.organization.organizationId,
            userId,
          });
        },
        mapErrorTags({
          IssueTrackerConnectionPersistenceError: persistenceFailure,
          RelayIssueTrackerError: trackerFailure,
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "connectJira",
      Effect.fn("issueTrackers.api.connectJira")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* Connections.saveJira({
            ...payload,
            organizationId: membership.organization.organizationId,
            userId,
          });
        },
        mapErrorTags({
          IssueTrackerConnectionPersistenceError: persistenceFailure,
          RelayIssueTrackerError: trackerFailure,
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "disconnect",
      Effect.fn("issueTrackers.api.disconnect")(
        function* ({ params }) {
          const { userId } = yield* RelayClientPrincipal;
          const membership = yield* requireAdmin({ userId });
          return yield* Connections.disconnect({
            organizationId: membership.organization.organizationId,
            service: params.service,
          });
        },
        mapErrorTags({ IssueTrackerConnectionPersistenceError: persistenceFailure }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    ),
);

export const issueTrackersServerApi = HttpApiBuilder.group(
  RelayApi,
  "issueTrackersServer",
  (handlers) =>
    handlers
      .handle(
        "readComments",
        Effect.fn("issueTrackers.api.comments")(
          function* ({ params, payload }) {
            const machine = yield* requireEnrolledExecutor({ environmentId: params.environmentId });
            return yield* Connections.readComments({
              ...payload,
              organizationId: machine.organizationId,
            });
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "readImages",
        Effect.fn("issueTrackers.api.images")(
          function* ({ params, payload }) {
            const machine = yield* requireEnrolledExecutor({ environmentId: params.environmentId });
            return yield* Connections.readImages({
              ...payload,
              organizationId: machine.organizationId,
            });
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "viewImage",
        Effect.fn("issueTrackers.api.image")(
          function* ({ params, payload }) {
            const machine = yield* requireEnrolledExecutor({ environmentId: params.environmentId });
            return yield* Connections.viewImage({
              ...payload,
              organizationId: machine.organizationId,
            });
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "readIssue",
        Effect.fn("issueTrackers.api.read")(
          function* ({ params, payload }) {
            const machine = yield* requireEnrolledExecutor({ environmentId: params.environmentId });
            return yield* Connections.readIssue({
              organizationId: machine.organizationId,
              service: params.service,
              issue: payload.issue,
            });
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      ),
);
