import {
  RelayApi,
  RelayClientPrincipal,
  RelayInternalError,
  RelayIssueTrackerError,
  RelayIssueTrackerTurnPrincipal,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
import { WriteOperationStore } from "../issueTrackers/WriteOperationStore.ts";
import {
  executeComment,
  prepareComment,
  presentWriteOperation,
} from "../issueTrackers/WriteOperations.ts";
import { executeEdit, prepareEdit } from "../issueTrackers/WriteIssueEdits.ts";

const persistenceFailure = (_error: ConnectionPersistenceError, traceId: string) =>
  new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId });
const trackerFailure = (error: RelayIssueTrackerError, traceId: string) =>
  new RelayIssueTrackerError({
    code: error.code,
    message: error.message,
    traceId,
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  });

// Reserve two seconds before the relay's nine-second deadline for claim cleanup and a response.
export const executeWithBudget = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operationId: string,
  environmentId: string,
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "7 seconds",
      orElse: () =>
        Effect.gen(function* () {
          const claims = yield* RelayIssueTrackerTurnPrincipal;
          const store = yield* WriteOperationStore;
          const operation = yield* store.get(operationId);
          const owned =
            operation?.ownerUserId === claims.ownerUserId &&
            operation.threadId === claims.threadId &&
            operation.environmentId === environmentId;
          if (
            owned &&
            operation.state === "succeeded" &&
            operation.resultResourceId &&
            operation.resultUrl
          )
            return {
              state: "succeeded" as const,
              resourceId: operation.resultResourceId,
              url: operation.resultUrl,
            };
          if (owned && (operation.state === "executing" || operation.state === "outcome_unknown"))
            return {
              state: "outcome_unknown" as const,
              resourceId: null,
              url: operation.resultUrl,
            };
          return yield* new RelayIssueTrackerError({
            code: "unavailable",
            message: "Could not start this issue change. Try again later.",
          });
        }),
    }),
  );

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
      "decideWrite",
      Effect.fn("issueTrackers.api.decideWrite")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          const store = yield* WriteOperationStore;
          const existing = yield* store.get(payload.operationId);
          if (!existing || existing.ownerUserId !== userId)
            return yield* new RelayIssueTrackerError({
              code: "not_found",
              message: "This issue change is not available.",
            });
          const operation =
            payload.decision === "approve"
              ? yield* store.approve(payload.operationId, userId)
              : yield* store.reject(payload.operationId);
          return yield* presentWriteOperation(operation);
        },
        mapErrorTags({
          IssueTrackerConnectionPersistenceError: persistenceFailure,
          RelayIssueTrackerError: trackerFailure,
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    )
    .handle(
      "startLinear",
      Effect.fn("issueTrackers.api.startLinear")(
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* Connections.startLinear({
            ownerUserId: userId,
            userId,
            writes: payload.writes,
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
        function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* startJira({
            ownerUserId: userId,
            userId,
            writes: payload.writes,
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
        "verifyWriteDecision",
        Effect.fn("issueTrackers.api.verifyWriteDecision")(
          function* ({ params, payload }) {
            const claims = yield* RelayIssueTrackerTurnPrincipal;
            const store = yield* WriteOperationStore;
            const operation = yield* store.get(payload.operationId);
            if (
              !operation ||
              operation.ownerUserId !== claims.ownerUserId ||
              operation.environmentId !== params.environmentId ||
              operation.threadId !== claims.threadId ||
              operation.commandId !== claims.commandId ||
              operation.providerSessionId !== payload.providerSessionId ||
              operation.connectionVersion !== claims.connections[operation.service] ||
              operation.writeGeneration !== claims.writeGenerations?.[operation.service] ||
              operation.runtimeMode === "full-access"
            )
              return yield* new RelayIssueTrackerError({
                code: "not_found",
                message: "This issue change is not available.",
              });
            if (operation.expiresAt <= DateTime.formatIso(yield* DateTime.now))
              return { decision: null };
            if (operation.state === "ready" && operation.approvedByUserId === claims.ownerUserId)
              return { decision: "accept" as const };
            if (operation.state === "rejected") return { decision: "decline" as const };
            return { decision: null };
          },
          mapErrorTags({ RelayIssueTrackerError: trackerFailure }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
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
      )
      .handle(
        "searchIssues",
        Effect.fn("issueTrackers.api.search")(
          function* ({ params, payload }) {
            const access = yield* authorizeRead(params.environmentId, params.service);
            return yield* Connections.searchIssues({
              ...access,
              service: params.service,
              request: payload,
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
        "prepareComment",
        Effect.fn("issueTrackers.api.prepareComment")(
          function* ({ params, payload }) {
            const prepared = yield* prepareComment({
              environmentId: params.environmentId,
              service: params.service,
              ...payload,
            });
            return yield* presentWriteOperation(prepared.operation);
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "executeComment",
        Effect.fn("issueTrackers.api.executeComment")(
          function* ({ params, payload }) {
            return yield* executeWithBudget(
              executeComment({ environmentId: params.environmentId, ...payload }),
              payload.operationId,
              params.environmentId,
            );
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "prepareEdit",
        Effect.fn("issueTrackers.api.prepareEdit")(
          function* ({ params, payload }) {
            const prepared = yield* prepareEdit({
              environmentId: params.environmentId,
              service: params.service,
              ...payload,
            });
            return yield* presentWriteOperation(prepared.operation);
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "executeEdit",
        Effect.fn("issueTrackers.api.executeEdit")(
          function* ({ params, payload }) {
            return yield* executeWithBudget(
              executeEdit({ environmentId: params.environmentId, ...payload }),
              payload.operationId,
              params.environmentId,
            );
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "cancelTurnWrite",
        Effect.fn("issueTrackers.api.cancelTurnWrite")(
          function* ({ params, payload }) {
            const claims = yield* RelayIssueTrackerTurnPrincipal;
            const store = yield* WriteOperationStore;
            const existing = yield* store.get(payload.operationId);
            if (
              !existing ||
              existing.ownerUserId !== claims.ownerUserId ||
              existing.environmentId !== params.environmentId ||
              existing.threadId !== claims.threadId ||
              existing.commandId !== claims.commandId
            )
              return yield* new RelayIssueTrackerError({
                code: "not_found",
                message: "This issue change is not available.",
              });
            return yield* presentWriteOperation(yield* store.cancel(payload.operationId));
          },
          mapErrorTags({
            IssueTrackerConnectionPersistenceError: persistenceFailure,
            RelayIssueTrackerError: trackerFailure,
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      ),
);
