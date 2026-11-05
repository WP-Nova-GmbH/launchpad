import {
  RelayApi,
  RelayClientPrincipal,
  WorkflowSourceError,
  type RelayInternalError,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WORKFLOW_LINEAR_CALLBACK_PATH } from "@t3tools/contracts/relay";
import { wakeWorkflows } from "../jobs/WorkflowWake.ts";
import { RelayDb } from "../db.ts";
import * as Sources from "../workflowSources/Sources.ts";
import * as Store from "../workflowSources/Store.ts";
import * as Linear from "../workflowSources/Linear.ts";
import { relayInternalErrorResponse } from "./Api.ts";

const isSourceError = Schema.is(WorkflowSourceError);

const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error): Effect.Effect<never, WorkflowSourceError | RelayInternalError> =>
      isSourceError(error) ? Effect.fail(error) : relayInternalErrorResponse("persistence_failed"),
    ),
  );
export const workflowSourcesApi = HttpApiBuilder.group(RelayApi, "workflowSources", (handlers) =>
  Effect.succeed(
    handlers
      .handle("owner", () =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.owner((yield* RelayClientPrincipal).userId);
          }),
        ),
      )
      .handle("begin", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.begin((yield* RelayClientPrincipal).userId, args.payload);
          }),
        ),
      )
      .handle("cancel", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.cancel(
              (yield* RelayClientPrincipal).userId,
              args.payload.attemptId,
            );
          }),
        ),
      )
      .handle("disconnect", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.disconnect(
              (yield* RelayClientPrincipal).userId,
              args.payload.connectionId,
              args.payload.expectedEpoch,
            );
          }),
        ),
      )
      .handle("refreshOwner", (args) =>
        safe(
          Effect.gen(function* () {
            const result = yield* Sources.refreshOwner(
              (yield* RelayClientPrincipal).userId,
              args.payload.connectionId,
            );
            yield* wakeWorkflows({ connectionId: args.payload.connectionId });
            return result;
          }),
        ),
      )
      .handle("repository", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.repository(
              args.params.repositoryId,
              (yield* RelayClientPrincipal).userId,
            );
          }),
        ),
      )
      .handle("health", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Store.repositoryHealth(
              args.params.repositoryId,
              (yield* RelayClientPrincipal).userId,
            );
          }),
        ),
      )
      .handle("allow", (args) =>
        safe(
          Effect.gen(function* () {
            const user = (yield* RelayClientPrincipal).userId;
            const config = yield* Linear.configuration;
            yield* Store.allow(args.params.repositoryId, user, args.payload, config.clientId);
            return yield* Sources.repository(args.params.repositoryId, user);
          }),
        ),
      )
      .handle("withdraw", (args) =>
        safe(
          Effect.gen(function* () {
            const user = (yield* RelayClientPrincipal).userId;
            yield* Store.withdraw(user, args.payload.grantId, args.params.repositoryId);
            return yield* Sources.repository(args.params.repositoryId, user);
          }),
        ),
      )
      .handle("withdrawOwner", (args) =>
        safe(
          Effect.gen(function* () {
            const user = (yield* RelayClientPrincipal).userId;
            yield* Store.withdraw(user, args.payload.grantId);
            return yield* Sources.owner(user);
          }),
        ),
      )
      .handle("refreshRepository", (args) =>
        safe(
          Effect.gen(function* () {
            const user = (yield* RelayClientPrincipal).userId;
            const sql = (yield* RelayDb).$client;
            const bound = yield* sql.withTransaction(
              Store.authority(args.params.repositoryId, args.payload.grantId, user),
            );
            yield* Sources.refresh(bound.connection);
            yield* wakeWorkflows({ connectionId: bound.connection.connection_id });
            yield* sql.withTransaction(
              Store.authority(args.params.repositoryId, args.payload.grantId, user),
            );
            return yield* Sources.repository(args.params.repositoryId, user);
          }),
        ),
      )
      .handle("selection", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.selection(
              args.params.repositoryId,
              (yield* RelayClientPrincipal).userId,
              args.payload,
            );
          }),
        ),
      )
      .handle("metadata", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.metadata(
              args.params.repositoryId,
              (yield* RelayClientPrincipal).userId,
              args.payload,
            );
          }),
        ),
      ),
  ),
);
export const workflowSourceCallbackRoute = HttpRouter.add(
  "GET",
  WORKFLOW_LINEAR_CALLBACK_PATH,
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(req.url, "https://relay.invalid").searchParams;
    const outcome = yield* Sources.callback(
      params.get("state") ?? "",
      params.get("code"),
      params.has("error"),
    ).pipe(
      Effect.match({
        onSuccess: () => true,
        onFailure: () => false,
      }),
    );
    if (outcome) yield* wakeWorkflows();
    return HttpServerResponse.text(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workflow source · Launchpad</title><body><h1>${outcome ? "Linear connected" : "Linear was not connected"}</h1><p>Return to Workflow sources in Launchpad and refresh the connection status. You can close this tab.</p></body></html>`,
      {
        status: outcome ? 200 : 400,
        contentType: "text/html; charset=utf-8",
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        },
      },
    );
  }),
);
