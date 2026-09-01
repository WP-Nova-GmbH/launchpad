import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as GithubApp from "../tenancy/GithubApp.ts";
import * as GithubAppSetup from "../tenancy/GithubAppSetup.ts";
import * as GithubInstallations from "../tenancy/GithubInstallations.ts";

/**
 * The browser side of connecting GitHub (see GithubAppSetup): plain pages
 * rather than typed API endpoints, because the caller is GitHub — or a
 * browser tab GitHub just sent back — holding nothing but the signed state.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(title: string, body: string, status = 200): HttpServerResponse.HttpServerResponse {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="margin:0;background:#0b0b0d;color:#e6e6ea;font-family:system-ui,-apple-system,sans-serif">
<main style="max-width:34rem;margin:0 auto;padding:4rem 1.5rem;line-height:1.5">
<p style="color:#8b8b95;font-size:.85rem;margin:0 0 1.5rem">Launchpad</p>
${body}
</main>`;
  return HttpServerResponse.text(html, { status, contentType: "text/html; charset=utf-8" });
}

const button = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;margin-top:1.5rem;padding:.6rem 1.1rem;border-radius:.5rem;background:#2f6bff;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`;

const problem = (title: string, detail: string, status = 400) =>
  render(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`, status);

/**
 * Sending the admin home. A web client is a redirect; the desktop app is a
 * custom scheme no HTTP redirect can follow reliably, so it gets a page with a
 * link that activates the app and a note that the tab can be closed.
 */
function returnHome(input: {
  readonly returnUrl: string;
  readonly title: string;
  readonly detail: string;
  readonly query: Readonly<Record<string, string>>;
}): HttpServerResponse.HttpServerResponse {
  if (!GithubAppSetup.isDesktopReturnUrl(input.returnUrl)) {
    const url = new URL(input.returnUrl);
    for (const [name, value] of Object.entries(input.query)) url.searchParams.set(name, value);
    return HttpServerResponse.redirect(url.toString());
  }
  const home = new URL(input.returnUrl);
  home.search = "";
  return render(
    input.title,
    `<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.detail)}</p><p>Switch back to Launchpad — it picks the change up on its own. You can close this tab.</p>${button(home.toString(), "Back to Launchpad")}`,
  );
}

const searchParams = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URL(request.url, "http://relay.invalid").searchParams,
);

const invalidState = () =>
  problem(
    "This link has expired",
    "Start again from Organization settings in Launchpad; setup links are valid for thirty minutes.",
  );

const missingState = () =>
  problem("Missing setup state", "Start from Organization settings in Launchpad.");

/** Posts the App manifest to GitHub from the admin's browser; GitHub shows a single Create button. */
const startRoute = HttpRouter.add(
  "GET",
  GithubAppSetup.GITHUB_APP_START_PATH,
  Effect.gen(function* () {
    const setup = yield* GithubAppSetup.GithubAppSetup;
    const state = (yield* searchParams).get("state");
    if (!state) return missingState();
    const start = yield* setup.renderStart(state).pipe(Effect.orElseSucceed(() => null));
    if (start === null) return invalidState();
    return render(
      "Creating the GitHub App",
      `<h1>Creating the GitHub App</h1><p>GitHub will show you the App and ask you to confirm. Nothing exists until you press <strong>Create GitHub App</strong> there; afterwards you are brought straight to installing it.</p>
<form id="f" method="post" action="${escapeHtml(start.action)}"><input type="hidden" name="manifest" value="${escapeHtml(start.manifest)}"><button type="submit" style="margin-top:1.5rem;padding:.6rem 1.1rem;border-radius:.5rem;border:0;background:#2f6bff;color:#fff;font-weight:600;font-size:1rem">Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script>`,
    );
  }),
);

/** GitHub's callback after Create: store the App, then send the admin on to install it. */
const createdRoute = HttpRouter.add(
  "GET",
  GithubAppSetup.GITHUB_APP_CREATED_PATH,
  Effect.gen(function* () {
    const setup = yield* GithubAppSetup.GithubAppSetup;
    const params = yield* searchParams;
    const state = params.get("state");
    const code = params.get("code");
    if (!state) return missingState();
    const claims = yield* setup.readState(state).pipe(Effect.orElseSucceed(() => null));
    if (claims === null) return invalidState();
    if (!code) {
      return problem(
        "GitHub did not finish",
        "GitHub sent no code back. Start again from Organization settings.",
      );
    }
    return yield* setup.complete({ code, claims }).pipe(
      Effect.map((created) =>
        render(
          "GitHub App created",
          `<h1>The App exists — now install it</h1><p><strong>${escapeHtml(created.appSlug)}</strong> was created. Installing it on your GitHub organization is what gives Launchpad access to repositories.</p>${button(created.installUrl, "Install on GitHub")}<script>setTimeout(function(){location.href=${JSON.stringify(created.installUrl)}},1500)</script>`,
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("github app setup failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(
            problem(
              "Creating the GitHub App failed",
              "GitHub accepted the App but the relay could not store it. Try again from Organization settings; if it keeps failing, check the relay's log.",
              500,
            ),
          ),
        ),
      ),
    );
  }),
);

/** GitHub's setup callback after Install: claim the installation for the organization. */
const installedRoute = HttpRouter.add(
  "GET",
  GithubAppSetup.GITHUB_APP_INSTALLED_PATH,
  Effect.gen(function* () {
    const setup = yield* GithubAppSetup.GithubAppSetup;
    const githubApp = yield* GithubApp.GithubApp;
    const installations = yield* GithubInstallations.GithubInstallations;
    const params = yield* searchParams;
    const state = params.get("state");
    const installationId = params.get("installation_id");
    if (!state) {
      return problem(
        "Missing setup state",
        "This App was installed from GitHub directly. Open Organization settings in Launchpad and press Connect GitHub to claim the installation.",
      );
    }
    const claims = yield* setup.readInstallState(state).pipe(Effect.orElseSucceed(() => null));
    if (claims === null) return invalidState();
    if (!installationId) {
      return problem(
        "GitHub did not finish",
        "GitHub sent no installation id back. Try Connect GitHub again.",
      );
    }
    const claim = Effect.gen(function* () {
      const installation = yield* githubApp.getInstallation({ installationId });
      if (installation === null) {
        return problem(
          "Installation not found",
          "GitHub does not know this installation. Try Connect GitHub again.",
        );
      }
      const claimed = yield* installations.claim({
        organizationId: claims.organizationId,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        connectedByUserId: claims.userId,
      });
      yield* Effect.logInfo("github installation connected from the browser", {
        organizationId: claimed.organizationId,
        installationId: claimed.installationId,
        accountLogin: claimed.accountLogin,
      });
      return returnHome({
        returnUrl: claims.returnUrl,
        title: "GitHub connected",
        detail: `Launchpad now reaches the repositories the App was installed on for ${claimed.accountLogin}. Every executor's access follows automatically.`,
        query: { github: "connected" },
      });
    });
    return yield* claim.pipe(
      Effect.catchTag("GithubInstallationAlreadyClaimed", () =>
        Effect.succeed(
          problem(
            "Already connected elsewhere",
            "Another organization on this Launchpad already claimed this GitHub installation.",
            409,
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("github installation claim failed", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(
            problem(
              "Connecting GitHub failed",
              "The App is installed on GitHub, but the relay could not record it. Press Connect GitHub in Launchpad again.",
              500,
            ),
          ),
        ),
      ),
    );
  }),
);

export const githubAppSetupRoutes = Layer.mergeAll(startRoute, createdRoute, installedRoute);
