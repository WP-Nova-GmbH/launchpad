import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RELAY_JIRA_CALLBACK_PATH } from "@t3tools/contracts/relay";
import { completeJira } from "../issueTrackers/JiraAuthorization.ts";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { completeLinear, LINEAR_CALLBACK_PATH } from "../issueTrackers/Connections.ts";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const page = (title: string, detail: string, status: number) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Launchpad</title><body style="margin:0;background:#111;color:#eee;font:16px system-ui"><main style="max-width:34rem;margin:4rem auto;padding:1.5rem;line-height:1.6"><p>Launchpad</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>Return to Account connections in Launchpad. You can close this tab.</p></main></body></html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    },
  );

const linearCallbackRoute = HttpRouter.add(
  "GET",
  LINEAR_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.url, "https://relay.invalid").searchParams;
    const state = params.get("state");
    if (!state || state.length > 256)
      return page(
        "Connection link is invalid",
        "Start connecting Linear from Account connections.",
        400,
      );
    return yield* completeLinear({
      state,
      code: params.get("code"),
      ...(params.has("iss") ? { iss: params.get("iss")! } : {}),
      ...(params.has("error") ? { error: params.get("error")! } : {}),
    }).pipe(
      Effect.map((result) =>
        result.status === "awaiting_confirmation"
          ? page(
              "Confirm workspace change",
              `Review the change to ${result.accountLabel} in Launchpad. Your current workspace remains selected until you choose Replace.`,
              200,
            )
          : page(
              "Linear connected",
              `Your personal connection can now read issues from ${result.accountLabel}.`,
              200,
            ),
      ),
      Effect.catchTag("RelayIssueTrackerError", (error) =>
        Effect.succeed(page("Linear was not connected", error.message, 400)),
      ),
      Effect.catchCause(() =>
        Effect.succeed(
          page(
            "Linear was not connected",
            "Could not finish the connection. Try again from Account connections.",
            500,
          ),
        ),
      ),
    );
  }),
);

const jiraCallbackRoute = HttpRouter.add(
  "GET",
  RELAY_JIRA_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.url, "https://relay.invalid").searchParams;
    const state = params.get("state");
    if (!state || state.length > 16_384)
      return page(
        "Connection link is invalid",
        "Start connecting Jira from Account connections.",
        400,
      );
    return yield* completeJira({
      state,
      code: params.get("code"),
      ...(params.has("iss") ? { iss: params.get("iss")! } : {}),
      ...(params.has("error") ? { error: params.get("error")! } : {}),
    }).pipe(
      Effect.map((result) =>
        result.status === "awaiting_site_selection"
          ? page(
              "Choose your Jira site",
              "Return to Account connections in Launchpad to choose which Jira site to connect.",
              200,
            )
          : page(
              "Jira connected",
              `Your personal connection can now read issues from ${result.accountLabel}.`,
              200,
            ),
      ),
      Effect.catchTag("RelayIssueTrackerError", (error) =>
        Effect.succeed(page("Jira was not connected", error.message, 400)),
      ),
      Effect.catchCause(() =>
        Effect.succeed(
          page(
            "Jira was not connected",
            "Could not finish connecting. Try again from Account connections.",
            500,
          ),
        ),
      ),
    );
  }),
);

export const issueTrackerCallbackRoute = Layer.merge(linearCallbackRoute, jiraCallbackRoute);
