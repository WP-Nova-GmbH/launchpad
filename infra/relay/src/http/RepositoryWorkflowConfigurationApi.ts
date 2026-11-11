import {
  RELAY_WORKFLOW_ENV_MAX_ENTRIES,
  RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH,
  RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES,
  RelayClientPrincipal,
  RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayDb } from "../db.ts";
import * as Configurations from "../jobs/RepositoryWorkflowConfiguration.ts";
import { mapRelayCommonApiErrors, relayInternalErrorResponse } from "./Api.ts";
import {
  lockMaintainableRepository,
  requireMaintainableRepository,
  resolveMembership,
} from "./TenancyApi.ts";
import { tenancyConflict, tenancyInvalid } from "./tenancyErrors.ts";

// Each byte of a value can take six JSON bytes when escaped. Allow room for entry metadata.
const maxRequestBytes =
  RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES * 6 +
  RELAY_WORKFLOW_ENV_MAX_ENTRIES * (RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH + 96) +
  1024;
const decodeUpdate = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayUpdateRepositoryWorkflowConfiguration),
);

/** Keep parser causes, including the rejected body, out of HTTP errors and telemetry. */
const readUpdate = Effect.fnUntraced(function* (request: HttpServerRequest) {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type && type !== "application/json")
    return yield* tenancyInvalid("workflow_configuration_invalid");
  const body = new Uint8Array(maxRequestBytes);
  const bytes = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => 0,
      (offset, chunk) =>
        offset + chunk.byteLength > maxRequestBytes
          ? tenancyInvalid("workflow_configuration_limit")
          : Effect.sync(() => {
              body.set(chunk, offset);
              return offset + chunk.byteLength;
            }),
    ),
    Effect.catchTag("HttpServerError", () => tenancyInvalid("workflow_configuration_invalid")),
  );
  const text = yield* Effect.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, bytes)),
  ).pipe(Effect.catch(() => tenancyInvalid("workflow_configuration_invalid")));
  return yield* decodeUpdate(text).pipe(
    Effect.catch(() => tenancyInvalid("workflow_configuration_invalid")),
  );
});

export const getRepositoryWorkflowConfiguration = Effect.fn(
  "relay.api.repository_workflow_configuration.get",
)(function* (repositoryId: string) {
  const { userId } = yield* RelayClientPrincipal;
  const membership = yield* resolveMembership({ userId });
  const repository = yield* requireMaintainableRepository({ membership, repositoryId });
  const scope = { organizationId: repository.organizationId, repositoryId };
  const sql = (yield* RelayDb).$client;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockMaintainableRepository(sql, { ...scope, userId }, "read");
        return yield* Configurations.getRepositoryWorkflowConfiguration(sql, scope).pipe(
          Effect.catch(() => relayInternalErrorResponse("persistence_failed")),
        );
      }),
    )
    .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
}, mapRelayCommonApiErrors("not_authorized"));

export const updateRepositoryWorkflowConfiguration = Effect.fn(
  "relay.api.repository_workflow_configuration.update",
)(function* (repositoryId: string, request: HttpServerRequest) {
  const { userId } = yield* RelayClientPrincipal;
  const membership = yield* resolveMembership({ userId });
  const organizationId = membership.organization.organizationId;
  yield* requireMaintainableRepository({ membership, repositoryId });
  const payload = yield* readUpdate(request);
  const sql = (yield* RelayDb).$client;
  const box = yield* RelaySecretBox;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockMaintainableRepository(sql, { organizationId, repositoryId, userId }, "write");
        return yield* Configurations.updateRepositoryWorkflowConfiguration(
          sql,
          box,
          { organizationId, repositoryId },
          payload,
        ).pipe(
          Effect.catchTag(
            "RepositoryWorkflowConfigurationError",
            Effect.fnUntraced(function* ({ reason }) {
              switch (reason) {
                case "conflict":
                  return yield* tenancyConflict("workflow_configuration_changed");
                case "invalid":
                  return yield* tenancyInvalid("workflow_configuration_invalid");
                case "limit":
                  return yield* tenancyInvalid("workflow_configuration_limit");
                case "storage":
                  return yield* relayInternalErrorResponse("persistence_failed");
              }
            }),
          ),
        );
      }),
    )
    .pipe(Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")));
}, mapRelayCommonApiErrors("not_authorized"));
