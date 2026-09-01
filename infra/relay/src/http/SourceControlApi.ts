import { RelayApi, RelayInternalError } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as GithubApp from "../tenancy/GithubApp.ts";
import * as GithubInstallations from "../tenancy/GithubInstallations.ts";
import { mapErrorTags, mapRelayCommonApiErrors } from "./Api.ts";
import { requireEnrolledExecutor } from "./enrolledExecutor.ts";
import { tenancyNotFound } from "./tenancyErrors.ts";

/**
 * Source-control credentials for managed executors (ADR-0015). An enrolled
 * agent executor borrows its organization's GitHub App installation: the
 * relay mints a short-lived installation token on request and forgets it.
 */
export const sourceControlServerApi = HttpApiBuilder.group(
  RelayApi,
  "sourceControlServer",
  Effect.fnUntraced(function* (handlers) {
    const installations = yield* GithubInstallations.GithubInstallations;
    const githubApp = yield* GithubApp.GithubApp;

    return handlers.handle(
      "mintGithubInstallationToken",
      Effect.fn("relay.api.source_control.mint_github_installation_token")(
        function* (args) {
          const machine = yield* requireEnrolledExecutor({
            environmentId: args.params.environmentId,
          });
          const connection = yield* installations.getForOrganization({
            organizationId: machine.organizationId,
          });
          if (connection === null) {
            return yield* tenancyNotFound("github_not_connected");
          }
          const minted = yield* githubApp.mintInstallationToken({
            installationId: connection.installationId,
          });
          yield* Effect.logInfo("github installation token minted for executor", {
            organizationId: machine.organizationId,
            machineId: machine.machineId,
            installationId: connection.installationId,
          });
          return {
            token: minted.token,
            expiresAt: minted.expiresAt,
            accountLogin: connection.accountLogin,
          };
        },
        mapErrorTags({
          GithubAppNotConfigured: (_error, traceId) =>
            new RelayInternalError({ code: "internal_error", reason: "internal_error", traceId }),
          GithubRequestFailed: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    );
  }),
);
