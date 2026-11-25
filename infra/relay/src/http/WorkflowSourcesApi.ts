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
      .handle("owner", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.owner(
              args.params.organizationId,
              (yield* RelayClientPrincipal).userId,
            );
          }),
        ),
      )
      .handle("begin", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.begin(
              args.params.organizationId,
              (yield* RelayClientPrincipal).userId,
              args.payload,
            );
          }),
        ),
      )
      .handle("cancel", (args) =>
        safe(
          Effect.gen(function* () {
            return yield* Sources.cancel(
              args.params.organizationId,
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
              args.params.organizationId,
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
              args.params.organizationId,
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
            yield* Store.withdraw(
              user,
              args.payload.grantId,
              undefined,
              args.params.organizationId,
            );
            return yield* Sources.owner(args.params.organizationId, user);
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

    const title = outcome ? "Linear connected" : "Linear connection not confirmed";
    const instruction = outcome
      ? "Switch back to Launchpad to manage repository access in"
      : "Switch back to Launchpad to check the connection status in";
    return HttpServerResponse.text(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${title} · Launchpad</title>
    <style>
      :root {
        color-scheme: light dark;
        background: #fcfcfc;
        color: #27272a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        --muted: #595962;
        --success: #167648;
        --success-background: #edf7f1;
        --warning: #a04c16;
        --warning-background: #fff3e8;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          background: #0a0a0a;
          color: #f5f5f5;
          --muted: #a3a3a3;
          --success: #79cba0;
          --success-background: #15251c;
          --warning: #e6a873;
          --warning-background: #2b2017;
        }
      }
      body {
        display: grid;
        min-height: 100vh;
        min-height: 100svh;
        margin: 0;
        place-items: center;
      }
      main {
        box-sizing: border-box;
        width: min(100%, 26rem);
        padding: 2rem 1.5rem;
        text-align: center;
      }
      .brand { margin: 0 0 1.5rem; color: var(--muted); font-size: .8125rem; font-weight: 500; }
      .status {
        display: grid;
        place-items: center;
        width: 2.75rem;
        height: 2.75rem;
        margin: 0 auto .875rem;
        border-radius: 50%;
        background: var(--success-background);
        color: var(--success);
      }
      .status::after {
        content: "";
        width: 1rem;
        height: .5rem;
        border-left: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: translateY(-2px) rotate(-45deg);
      }
      .status.warning { background: var(--warning-background); color: var(--warning); }
      .status.warning::after { content: "!"; width: auto; height: auto; border: 0; transform: none; font-size: 1.5rem; }
      h1 { margin: 0; font-size: clamp(1.5rem, 4.5vw, 1.75rem); line-height: 1.2; letter-spacing: -.025em; font-weight: 500; }
      .instruction { margin: .6875rem 0 0; color: var(--muted); font-size: .875rem; line-height: 1.6; text-wrap: pretty; }
      .instruction strong { color: CanvasText; font-weight: 500; }
      .hint { margin: 1.1875rem 0 0; color: var(--muted); font-size: .75rem; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main aria-labelledby="title">
      <p class="brand">Launchpad</p>
      <div class="status${outcome ? "" : " warning"}" aria-hidden="true"></div>
      <h1 id="title">${title}</h1>
      <p class="instruction">${instruction} <strong>Organization settings → Workflow sources</strong>.</p>
      <p class="hint">You can close this tab.</p>
    </main>
  </body>
</html>`,
      {
        status: outcome ? 200 : 400,
        contentType: "text/html; charset=utf-8",
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      },
    );
  }),
);
