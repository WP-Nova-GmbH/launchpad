import {
  RelayApi,
  RelayIssueTrackerError,
  type RelayIssueTrackerService,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { readTurnAuthorization } from "../../IssueTrackerTurnAuthorization.ts";
import { readMcpProviderSession } from "../../McpProviderSession.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssueTrackersToolkit, LinearImageToolkit } from "./tools.ts";

const isTrackerFailure = Schema.is(RelayIssueTrackerError);
const unavailableOnThisEnvironment = () =>
  new RelayIssueTrackerError({
    code: "not_configured",
    message: "Connect your account in Account → Connections, then send a new message.",
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
  not_configured: "Connect this issue tracker in Account → Connections, then send a new message.",
} satisfies Record<RelayIssueTrackerError["code"], string>;

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const clientForInvocation = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issue-trackers").pipe(
      Effect.mapError(unavailableOnThisEnvironment),
    );
    const active = readMcpProviderSession(scope.threadId);
    if (
      !active ||
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
