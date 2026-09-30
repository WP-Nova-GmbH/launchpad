import { RelayIssueTrackerError, type RelayIssueTrackerService } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../../../cloud/machineEnrollment.ts";
import { makeExecutorRelayApiClient } from "../../../relay/executorRelayClient.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkit } from "./tools.ts";

const unavailableOnThisEnvironment = () =>
  new RelayIssueTrackerError({
    code: "not_configured",
    message: "Issue tracker tools are available only on organization-managed executors.",
  });
const failureMessages = {
  auth_required:
    "The organization's issue tracker connection needs to be reconnected by an administrator.",
  forbidden: "The organization's connected account does not have permission to read this issue.",
  not_found: "The issue was not found or is not visible to the organization's connected account.",
  invalid_input:
    "Use an issue identifier or a URL from the organization's connected issue tracker.",
  unavailable: "The issue tracker could not be reached. Try again later.",
  conflict: "The issue tracker connection changed. Retry with its current connection.",
  not_configured: "An administrator must connect this issue tracker in Organization settings.",
} satisfies Record<RelayIssueTrackerError["code"], string>;

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const read = Effect.fn("IssueTrackersToolkit.read")(function* (
    service: RelayIssueTrackerService,
    issue: string,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issue-trackers").pipe(
      Effect.mapError(unavailableOnThisEnvironment),
    );
    const config = yield* readManagedExecutorRelayConfig(secrets);
    if (config === null) return yield* unavailableOnThisEnvironment();
    const client = yield* makeExecutorRelayApiClient(config).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return yield* client.issueTrackersServer
      .readIssue({
        params: { environmentId: scope.environmentId, service },
        payload: { issue },
      })
      .pipe(
        Effect.mapError((error) => {
          // Do not serialize transport errors: they retain the environment's Authorization header.
          const code = error._tag === "RelayIssueTrackerError" ? error.code : "unavailable";
          return new RelayIssueTrackerError({ code, message: failureMessages[code] });
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
  });
  return IssueTrackersToolkit.of({
    read_linear_issue: ({ issue }) => read("linear", issue),
    read_jira_issue: ({ issue }) => read("jira", issue),
  });
});

export const IssueTrackersToolkitHandlersLive = IssueTrackersToolkit.toLayer(make);
