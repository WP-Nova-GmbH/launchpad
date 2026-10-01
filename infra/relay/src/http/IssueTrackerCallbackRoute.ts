import * as Effect from "effect/Effect";
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
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Launchpad</title><body style="margin:0;background:#111;color:#eee;font:16px system-ui"><main style="max-width:34rem;margin:4rem auto;padding:1.5rem;line-height:1.6"><p>Launchpad</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>Return to Organization settings in Launchpad. You can close this tab.</p></main></body></html>`,
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

export const issueTrackerCallbackRoute = HttpRouter.add(
  "GET",
  LINEAR_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.url, "https://relay.invalid").searchParams;
    const state = params.get("state");
    if (!state || state.length > 256)
      return page(
        "Connection link is invalid",
        "Start connecting Linear from Organization settings.",
        400,
      );
    return yield* completeLinear({ state, code: params.get("code") }).pipe(
      Effect.map((result) =>
        result.status === "awaiting_confirmation"
          ? page(
              "Confirm workspace change",
              `Review the change to ${result.accountLabel} in Launchpad. Your current workspace remains selected until you choose Replace.`,
              200,
            )
          : page(
              "Linear connected",
              `Organization chats can now read issues from ${result.accountLabel}.`,
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
            "Could not finish the connection. Try again from Organization settings.",
            500,
          ),
        ),
      ),
    );
  }),
);
