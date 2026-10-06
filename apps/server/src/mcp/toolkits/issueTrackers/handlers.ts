import { CommandId, EventId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayAuthInvalidError,
  RelayIssueTrackerError,
  type RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { issueTrackerToolTitle } from "@t3tools/shared/issueTrackerActivity";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { readTurnAuthorization } from "../../IssueTrackerTurnAuthorization.ts";
import { registerIssueWrite, releaseIssueWrite } from "../../IssueTrackerApprovalBroker.ts";
import { readMcpProviderSession } from "../../McpProviderSession.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkit, LinearImageToolkit } from "./tools.ts";

const isTrackerFailure = Schema.is(RelayIssueTrackerError);
const isRelayAuthorizationFailure = Schema.is(RelayAuthInvalidError);
const unavailableOnThisEnvironment = () =>
  new RelayIssueTrackerError({
    code: "not_configured",
    message: "Connect your account in Account → Connections, then send a new message.",
  });
const approvalUnavailable = () =>
  new RelayIssueTrackerError({
    code: "unavailable",
    message: "Could not show or resolve the issue comment approval. Try again.",
  });
const failureMessages = {
  auth_required:
    "Your personal issue tracker connection needs to be reconnected in Account → Connections.",
  forbidden: "Your connected account does not have permission to read this issue.",
  not_found: "The issue was not found or is not visible to your connected account.",
  invalid_input: "Use an issue identifier or a URL from your connected issue tracker.",
  unavailable: "The issue tracker could not be reached. Try again later.",
  image_too_large:
    "This image exceeds the 5 MiB limit. Open its source link from the image reference. Continue with the available issue context; retrying will not resize it.",
  unsupported_image:
    "This upload is not a supported image (PNG, JPEG, WebP or GIF). Open its source link from the image reference and continue with the available issue context.",
  conflict:
    "The issue tracker connection or source content changed. Read the issue again to get fresh references.",
  write_in_progress: "An identical issue change is already in progress. Wait for it to finish.",
  not_configured: "Connect this issue tracker in Account → Connections, then send a new message.",
  rate_limited: "The issue tracker is rate limiting requests. Try again later.",
} satisfies Record<RelayIssueTrackerError["code"], string>;
const expiredTurn = () =>
  new RelayIssueTrackerError({
    code: "auth_required",
    message:
      "Your issue tracker authorization for this message is no longer valid. Check Account → Connections and send a new message.",
  });

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const clientForInvocation = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issue-trackers").pipe(
      Effect.mapError(unavailableOnThisEnvironment),
    );
    const active = readMcpProviderSession(scope.threadId);
    if (
      !active ||
      !scope.issueTrackerAuthorizationId ||
      !active.issueTrackerTurnId ||
      active.issueTrackerTurnComplete ||
      active.providerSessionId !== scope.providerSessionId ||
      active.issueTrackerAuthorizationId !== scope.issueTrackerAuthorizationId
    )
      return yield* unavailableOnThisEnvironment();
    const grant = yield* readTurnAuthorization(
      scope.issueTrackerAuthorizationId,
      scope.threadId,
    ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets));
    if (!grant || grant.claims.environmentId !== scope.environmentId)
      return yield* unavailableOnThisEnvironment();
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: grant.relayUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(grant.authorization)),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    return {
      client,
      scope,
      environmentId: scope.environmentId,
      providerSessionId: scope.providerSessionId,
      ownerUserId: grant.claims.ownerUserId,
    };
  });
  const safe = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    mode: "read" | "image" | "search" | "write" = "read",
  ) =>
    effect.pipe(
      Effect.mapError((error) => {
        // Do not serialize transport errors: they retain the environment's Authorization header.
        if (isRelayAuthorizationFailure(error)) return expiredTurn();
        const code = isTrackerFailure(error) ? error.code : "unavailable";
        const message =
          mode === "write" && code === "forbidden"
            ? "Your connected account cannot change issues. Check write access in Account → Connections."
            : mode === "write" && code === "invalid_input"
              ? "This issue change is invalid. Read the issue and choose a supported value."
              : mode === "write" && code === "conflict"
                ? "The issue or connection changed. Read the issue and prepare the change again."
                : mode === "search" && code === "forbidden"
                  ? "Your connected account cannot search issues. Check search access in Account → Connections."
                  : mode === "search" && code === "invalid_input"
                    ? "Use search text or a supported filter, or continue with an unchanged search reference."
                    : mode === "search" && code === "conflict"
                      ? "The connection changed. Start the issue search again."
                      : mode === "image" && code === "not_found"
                        ? "The issue or image is no longer accessible. Read the issue again to check its current images."
                        : mode === "image" && code === "invalid_input"
                          ? "Use an image reference returned by a Linear read."
                          : failureMessages[code];
        return new RelayIssueTrackerError({
          code,
          message,
          ...(isTrackerFailure(error) && error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        });
      }),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new RelayIssueTrackerError({
              code: "unavailable",
              message: failureMessages.unavailable,
            }),
          ),
      }),
    );
  const read = (service: RelayIssueTrackerService, issue: string) =>
    Effect.gen(function* () {
      const { client, environmentId } = yield* clientForInvocation;
      return yield* safe(
        client.issueTrackersServer.readIssue({
          params: { environmentId, service },
          payload: { issue },
        }),
      );
    });
  const submitWrite = (
    service: RelayIssueTrackerService,
    input:
      | { kind: "comment"; issue: string; body: string; retryAfterUnknown?: boolean }
      | {
          kind: "edit";
          issue: string;
          field: "title" | "description" | "status" | "assignee";
          value: string | null;
          retryAfterUnknown?: boolean;
        },
  ) =>
    Effect.gen(function* () {
      const { client, scope, environmentId, providerSessionId, ownerUserId } =
        yield* clientForInvocation;
      const invocationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const prepared =
        input.kind === "comment"
          ? yield* safe(
              client.issueTrackersServer.prepareComment({
                params: { environmentId, service },
                payload: {
                  issue: input.issue,
                  body: input.body,
                  ...(input.retryAfterUnknown !== undefined
                    ? { retryAfterUnknown: input.retryAfterUnknown }
                    : {}),
                  providerSessionId,
                  invocationId,
                },
              }),
              "write",
            )
          : yield* safe(
              client.issueTrackersServer.prepareEdit({
                params: { environmentId, service },
                payload: {
                  issue: input.issue,
                  field: input.field,
                  value: input.value,
                  ...(input.retryAfterUnknown !== undefined
                    ? { retryAfterUnknown: input.retryAfterUnknown }
                    : {}),
                  providerSessionId,
                  invocationId,
                },
              }),
              "write",
            );
      let terminal = false;
      const run = Effect.gen(function* () {
        if (prepared.state === "awaiting_approval") {
          const registration = yield* registerIssueWrite(
            prepared.operationId,
            scope.threadId,
            providerSessionId,
            ownerUserId,
            environmentId,
            scope.issueTrackerAuthorizationId!,
          );
          if (!registration) {
            terminal = true;
            return yield* new RelayIssueTrackerError({
              code: "write_in_progress",
              message: failureMessages.write_in_progress,
            });
          }
          const { requestId, deferred } = registration;
          const now = DateTime.formatIso(yield* DateTime.now);
          const resolvedActivity = Effect.gen(function* () {
            const resolvedAt = DateTime.formatIso(yield* DateTime.now);
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`issue-write-resolved:${prepared.operationId}`),
              threadId: scope.threadId,
              activity: {
                id: EventId.make(`issue-write-resolved:${prepared.operationId}`),
                tone: "approval",
                kind: "approval.resolved",
                summary: "Issue change approval resolved",
                payload: { requestId },
                turnId: null,
                createdAt: resolvedAt,
              },
              createdAt: resolvedAt,
            });
          }).pipe(Effect.ignoreCause);
          const approval = Effect.gen(function* () {
            yield* engine
              .dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`issue-write-request:${prepared.operationId}`),
                threadId: scope.threadId,
                activity: {
                  id: EventId.make(`issue-write-request:${prepared.operationId}`),
                  tone: "approval",
                  kind: "approval.requested",
                  summary: `${service === "jira" ? "Jira" : "Linear"} ${input.kind === "comment" ? "comment" : "issue edit"} approval requested`,
                  payload: {
                    requestId,
                    requestKind: "mcp-elicitation",
                    requestType: "mcp_elicitation_approval",
                    appName:
                      input.kind === "comment"
                        ? issueTrackerToolTitle(
                            service === "jira" ? "add_jira_comment" : "add_linear_comment",
                          )
                        : issueTrackerToolTitle(
                            service === "jira" ? "edit_jira_issue" : "edit_linear_issue",
                          ),
                    detail: `Issue: ${prepared.identifier}\nConnection: ${prepared.executionAccount}\nOnly the connection owner can approve.\n${prepared.retryWarning ? "A previous identical change may already have completed. Approving may create a duplicate.\n" : ""}\n${prepared.body}`,
                    options: [
                      {
                        decision: "accept",
                        label: input.kind === "comment" ? "Post comment" : "Apply change",
                      },
                      { decision: "decline", label: "Cancel" },
                    ],
                  },
                  turnId: null,
                  createdAt: now,
                },
                createdAt: now,
              })
              .pipe(Effect.mapError(approvalUnavailable));
            const decision = yield* Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: "10 minutes",
                orElse: () => Effect.succeed({ decision: "cancel" as const, actorUserId: null }),
              }),
            );
            const current = yield* clientForInvocation;
            if (current.providerSessionId !== providerSessionId) return yield* expiredTurn();
            if (decision.actorUserId !== ownerUserId)
              return { ...prepared, state: "cancelled" as const };
            if (decision.decision === "decline") return { ...prepared, state: "rejected" as const };
            return decision.decision === "accept"
              ? null
              : { ...prepared, state: "cancelled" as const };
          }).pipe(
            Effect.ensuring(
              releaseIssueWrite(requestId, deferred).pipe(Effect.andThen(resolvedActivity)),
            ),
          );
          const decided = yield* approval;
          if (decided) {
            terminal = decided.state === "rejected";
            return decided;
          }
        } else if (prepared.state !== "ready") {
          terminal = true;
          return prepared;
        }
        const result =
          input.kind === "comment"
            ? yield* safe(
                client.issueTrackersServer.executeComment({
                  params: { environmentId },
                  payload: { operationId: prepared.operationId, providerSessionId },
                }),
                "write",
              )
            : yield* safe(
                client.issueTrackersServer.executeEdit({
                  params: { environmentId },
                  payload: { operationId: prepared.operationId, providerSessionId },
                }),
                "write",
              );
        terminal = true;
        return {
          ...prepared,
          state: result.state,
          resultResourceId: result.resourceId,
          resultUrl: result.url,
        };
      });
      return yield* run.pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            terminal
              ? Effect.void
              : client.issueTrackersServer
                  .cancelTurnWrite({
                    params: { environmentId },
                    payload: { operationId: prepared.operationId },
                  })
                  .pipe(Effect.ignore),
          ),
        ),
      );
    });
  return {
    read_linear_issue: ({ issue }: { issue: string }) => read("linear", issue),
    read_jira_issue: ({ issue }: { issue: string }) => read("jira", issue),
    add_linear_comment: (input: { issue: string; body: string; retryAfterUnknown?: boolean }) =>
      submitWrite("linear", { kind: "comment", ...input }),
    add_jira_comment: (input: { issue: string; body: string; retryAfterUnknown?: boolean }) =>
      submitWrite("jira", { kind: "comment", ...input }),
    edit_linear_issue: (input: {
      issue: string;
      field: "title" | "description" | "status" | "assignee";
      value: string | null;
      retryAfterUnknown?: boolean;
    }) => submitWrite("linear", { kind: "edit", ...input }),
    edit_jira_issue: (input: {
      issue: string;
      field: "title" | "description" | "status" | "assignee";
      value: string | null;
      retryAfterUnknown?: boolean;
    }) => submitWrite("jira", { kind: "edit", ...input }),
    search_linear_issues: (request: {
      query?: string;
      project?: string;
      team?: string;
      status?: string;
      assignee?: string;
      continuation?: string;
    }) =>
      Effect.gen(function* () {
        const { client, environmentId } = yield* clientForInvocation;
        return yield* safe(
          client.issueTrackersServer.searchIssues({
            params: { environmentId, service: "linear" },
            payload: request,
          }),
          "search",
        );
      }),
    search_jira_issues: (request: {
      query?: string;
      project?: string;
      team?: string;
      status?: string;
      assignee?: string;
      continuation?: string;
    }) =>
      Effect.gen(function* () {
        const { client, environmentId } = yield* clientForInvocation;
        return yield* safe(
          client.issueTrackersServer.searchIssues({
            params: { environmentId, service: "jira" },
            payload: request,
          }),
          "search",
        );
      }),
    read_linear_comments: ({ reference }: { reference: string }) =>
      Effect.gen(function* () {
        const { client, environmentId } = yield* clientForInvocation;
        return yield* safe(
          client.issueTrackersServer.readComments({
            params: { environmentId },
            payload: { reference },
          }),
        );
      }),
    read_linear_images: ({ reference }: { reference: string }) =>
      Effect.gen(function* () {
        const { client, environmentId } = yield* clientForInvocation;
        return yield* safe(
          client.issueTrackersServer.readImages({
            params: { environmentId },
            payload: { reference },
          }),
        );
      }),
    view_linear_image: ({ reference }: { reference: string }) =>
      Effect.gen(function* () {
        const { client, environmentId } = yield* clientForInvocation;
        return yield* safe(
          client.issueTrackersServer.viewImage({
            params: { environmentId },
            payload: { reference },
          }),
          "image",
        );
      }),
  };
});

export const IssueTrackersToolkitHandlersLive = IssueTrackersToolkit.toLayer(
  make.pipe(Effect.map((handlers) => IssueTrackersToolkit.of(handlers))),
);
export const LinearImageToolkitHandlersLive = LinearImageToolkit.toLayer(
  make.pipe(Effect.map((handlers) => LinearImageToolkit.of(handlers))),
);
