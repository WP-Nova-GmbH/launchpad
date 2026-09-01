import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as GithubAppSetup from "../tenancy/GithubAppSetup.ts";

function backTo(returnUrl: string, query: Readonly<Record<string, string>>) {
  const url = new URL(returnUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return HttpServerResponse.redirect(url.toString());
}

/**
 * Where GitHub sends the admin's browser after they press Create. Not part of
 * the typed API: the caller is GitHub with nothing but the signed state, and
 * the answer is a redirect back to the settings page that started the setup,
 * carrying `github_app=created` or `github_app_error=<reason>`.
 */
export const githubAppCreatedRoute = HttpRouter.add(
  "GET",
  GithubAppSetup.GITHUB_APP_CREATED_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const setup = yield* GithubAppSetup.GithubAppSetup;
    const params = new URL(request.url, "http://relay.invalid").searchParams;
    const state = params.get("state");
    const code = params.get("code");
    if (!state) {
      return HttpServerResponse.text("Missing setup state.", { status: 400 });
    }
    const claims = yield* setup.readState(state).pipe(Effect.orElseSucceed(() => null));
    if (claims === null) {
      return HttpServerResponse.text(
        "This setup link is invalid or has expired. Start again from Organization settings.",
        { status: 400 },
      );
    }
    if (!code) {
      return backTo(claims.returnUrl, { github_app_error: "missing_code" });
    }
    return yield* setup.complete({ code, claims }).pipe(
      Effect.map((created) =>
        backTo(claims.returnUrl, { github_app: "created", github_app_slug: created.appSlug }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("github app setup failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(backTo(claims.returnUrl, { github_app_error: "creation_failed" })),
        ),
      ),
    );
  }),
);
