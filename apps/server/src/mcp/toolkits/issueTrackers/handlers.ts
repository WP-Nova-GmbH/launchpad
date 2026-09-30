import { RelayIssueTrackerError, type RelayIssueTrackerService } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../../../cloud/machineEnrollment.ts";
import { makeExecutorRelayApiClient } from "../../../relay/executorRelayClient.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkit, LinearImageToolkit } from "./tools.ts";

const isTrackerFailure = Schema.is(RelayIssueTrackerError);
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
  image_too_large:
    "This image exceeds the 5 MiB limit. Open its source link from the image reference. Continue with the available issue context; retrying will not resize it.",
  unsupported_image:
    "This upload is not a supported image (PNG, JPEG, WebP or GIF). Open its source link from the image reference and continue with the available issue context.",
  conflict:
    "The issue tracker connection or source content changed. Read the issue again to get fresh references.",
  not_configured: "An administrator must connect this issue tracker in Organization settings.",
} satisfies Record<RelayIssueTrackerError["code"], string>;

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const clientForInvocation = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issue-trackers").pipe(
      Effect.mapError(unavailableOnThisEnvironment),
    );
    const config = yield* readManagedExecutorRelayConfig(secrets);
    if (config === null) return yield* unavailableOnThisEnvironment();
    const client = yield* makeExecutorRelayApiClient(config).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return { client, environmentId: scope.environmentId };
  });
  const safe = <A, E, R>(effect: Effect.Effect<A, E, R>, image = false) =>
    effect.pipe(
      Effect.mapError((error) => {
        // Do not serialize transport errors: they retain the environment's Authorization header.
        const code = isTrackerFailure(error) ? error.code : "unavailable";
        const message =
          image && code === "not_found"
            ? "The issue or image is no longer accessible. Read the issue again to check its current images."
            : image && code === "invalid_input"
              ? "Use an image reference returned by a Linear read."
              : failureMessages[code];
        return new RelayIssueTrackerError({ code, message });
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
  return {
    read_linear_issue: ({ issue }: { issue: string }) => read("linear", issue),
    read_jira_issue: ({ issue }: { issue: string }) => read("jira", issue),
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
          true,
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
