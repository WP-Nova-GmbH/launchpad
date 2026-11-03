import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES,
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
import { requireMaintainableRepository, resolveMembership } from "./TenancyApi.ts";
import {
  tenancyConflict,
  tenancyForbidden,
  tenancyInvalid,
  tenancyNotFound,
} from "./tenancyErrors.ts";

// A 4 KiB value can take six JSON bytes per byte when escaped.
const maxRequestBytes = RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES * 6 + 1024;
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

/** Hold current authority through the settings operation in the caller's transaction. */
const lockAuthority = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly userId: string;
  },
  operation: "read" | "write",
) {
  const { organizationId, repositoryId, userId } = scope;
  // Match repository removal's lock order.
  const [current] = yield* sql<{ role: "admin" | "member" }>`
    SELECT role FROM relay_organization_members
    WHERE organization_id=${organizationId} AND user_id=${userId} FOR SHARE
  `;
  if (!current) return yield* tenancyNotFound("repository_not_found");
  if (current.role !== "admin") {
    const [grant] = yield* sql<{ role: "maintainer" | "developer" }>`
      SELECT role FROM relay_repository_access
      WHERE organization_id=${organizationId} AND repository_id=${repositoryId}
        AND user_id=${userId} FOR SHARE
    `;
    if (grant?.role !== "maintainer")
      return yield* tenancyForbidden(grant ? "not_a_maintainer" : "no_repository_access");
  }
  const [repository] = yield* sql`
    SELECT repository_id FROM relay_repositories
    WHERE repository_id=${repositoryId} AND organization_id=${organizationId}
    ${sql.literal(operation === "read" ? "FOR SHARE" : "FOR NO KEY UPDATE")}
  `;
  if (!repository) return yield* tenancyNotFound("repository_not_found");
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
        yield* lockAuthority(sql, { ...scope, userId }, "read");
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
        yield* lockAuthority(sql, { organizationId, repositoryId, userId }, "write");
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
