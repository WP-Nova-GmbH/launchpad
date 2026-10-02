import {
  RelayApi,
  RelayClientPrincipal,
  RelayInternalError,
  RelayIssueTrackerError,
  RelayIssueTrackerTurnPrincipal,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as Connections from "../issueTrackers/Connections.ts";
import {
  startJira,
  selectJiraSite,
  cancelJiraSelection,
} from "../issueTrackers/JiraAuthorization.ts";
import type { ConnectionPersistenceError } from "../issueTrackers/ConnectionStore.ts";
import { mapErrorTags, mapRelayCommonApiErrors } from "./Api.ts";
import { authorizeRead, authorizeTurn } from "../issueTrackers/TurnAuthorization.ts";

const persistenceFailure = (_error: ConnectionPersistenceError, traceId: string) =>
  new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId });
const trackerFailure = (error: RelayIssueTrackerError, traceId: string) =>
  new RelayIssueTrackerError({ code: error.code, message: error.message, traceId });

export const issueTrackersApi = HttpApiBuilder.group(RelayApi, "issueTrackers", (handlers) =>
  handlers
    .handle(
      "authorizeTurn",
      Effect.fn("issueTrackers.api.authorizeTurn")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* authorizeTurn(userId, payload);
        },
        mapErrorTags({ IssueTrackerConnectionPersistenceError: persistenceFailure }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "listConnections",
      Effect.fn("issueTrackers.api.list")(
        function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* Connections.listConnections(userId);
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
          return yield* Connections.startLinear({
            ownerUserId: userId,
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
      "confirmLinearReplacement",
      Effect.fn("issueTrackers.api.confirmLinearReplacement")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* Connections.confirmLinearReplacement({
            ownerUserId: userId,
            userId,
            proposalId: payload.proposalId,
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
      "cancelLinearReplacement",
      Effect.fn("issueTrackers.api.cancelLinearReplacement")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* Connections.cancelLinearReplacement({
            ownerUserId: userId,
            userId,
            proposalId: payload.proposalId,
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
      "startJira",
      Effect.fn("issueTrackers.api.startJira")(
        function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* startJira({
            ownerUserId: userId,
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
      "selectJiraSite",
      Effect.fn("issueTrackers.api.selectJiraSite")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          yield* selectJiraSite({ ...payload, ownerUserId: userId, userId });
          return yield* Connections.listConnections(userId);
        },
        mapErrorTags({
          IssueTrackerConnectionPersistenceError: persistenceFailure,
          RelayIssueTrackerError: trackerFailure,
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "cancelJiraSelection",
      Effect.fn("issueTrackers.api.cancelJiraSelection")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          yield* cancelJiraSelection({ ...payload, ownerUserId: userId, userId });
          return yield* Connections.listConnections(userId);
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
          return yield* Connections.disconnect({
            ownerUserId: userId,
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
      .handle("verifyTurn", () => RelayIssueTrackerTurnPrincipal)
      .handle(
        "readComments",
        Effect.fn("issueTrackers.api.comments")(
          function* ({ params, payload }) {
            const access = yield* authorizeRead(params.environmentId, "linear");
            return yield* Connections.readComments({
              ...payload,
              ...access,
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
            const access = yield* authorizeRead(params.environmentId, "linear");
            return yield* Connections.readImages({
              ...payload,
              ...access,
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
            const access = yield* authorizeRead(params.environmentId, "linear");
            return yield* Connections.viewImage({
              ...payload,
              ...access,
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
            const access = yield* authorizeRead(params.environmentId, params.service);
            return yield* Connections.readIssue({
              ...access,
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
