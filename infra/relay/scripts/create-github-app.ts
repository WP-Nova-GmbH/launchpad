/**
 * Creates the relay's GitHub App from a manifest, so nobody fills in GitHub's
 * form or downloads a private key by hand.
 *
 * GitHub's manifest flow: we hand it an app definition, the person presses
 * Create once, and GitHub redirects back with a short-lived code that converts
 * into the app id, slug, and private key. Those land in `infra/relay/.env`,
 * where the relay already reads its secrets from and which is gitignored.
 *
 * Usage, from the repository root:
 *
 *   node infra/relay/scripts/create-github-app.ts --setup-url https://your.app/settings/organization
 *
 * Add `--org <login>` to create it inside a GitHub organization rather than a
 * personal account. Creating the app is not installing it — installing is the
 * button on the organization page, and is what ties it to a Launchpad org.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const PORT = Number(process.env.GITHUB_APP_SETUP_PORT ?? 8620);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const setupUrl = flag("setup-url");
const organization = flag("org");
const appName = flag("name") ?? "Launchpad";
/**
 * A vendor app that other organizations will install has to be public. Keep it
 * private while only your own organization installs it.
 */
const isPublic = process.argv.includes("--public");

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const createUrl = organization
  ? `https://github.com/organizations/${organization}/settings/apps/new`
  : "https://github.com/settings/apps/new";

/**
 * What the app may do. Contents and metadata are what listing and cloning
 * need; pull requests are what the job runner will need in M5, and asking now
 * avoids a second trip through GitHub's approval later.
 */
const manifest = (redirectUrl: string, landing: string) => ({
  name: appName,
  url: landing,
  redirect_url: redirectUrl,
  setup_url: landing,
  setup_on_update: true,
  public: isPublic,
  default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
  default_events: [] as ReadonlyArray<string>,
});

class GithubAppSetupFailed extends Schema.TaggedErrorClass<GithubAppSetupFailed>()(
  "GithubAppSetupFailed",
  { status: Schema.optionalKey(Schema.Number), detail: Schema.String },
) {
  override get message(): string {
    return `Could not create the GitHub App: ${this.detail}`;
  }
}

interface ConvertedApp {
  readonly id: number;
  readonly slug: string;
  readonly pem: string;
  readonly html_url: string;
}

const convert = Effect.fn("relay.github_app_setup.convert")(function* (code: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(`https://api.github.com/app-manifests/${code}/conversions`).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "user-agent": "t3code-relay-setup",
        "x-github-api-version": "2022-11-28",
      }),
    ),
  );
  if (response.status >= 400) {
    return yield* new GithubAppSetupFailed({
      status: response.status,
      detail: "GitHub refused the manifest conversion",
    });
  }
  return (yield* response.json) as unknown as ConvertedApp;
});

/** Replaces rather than appends, so re-running leaves one of each key. */
const writeEnv = Effect.fn("relay.github_app_setup.write_env")(function* (app: ConvertedApp) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const envPath = path.join(import.meta.dirname, "..", ".env");
  const existing = yield* fs.readFileString(envPath).pipe(Effect.orElseSucceed(() => ""));
  const kept = existing
    .split("\n")
    .filter((line: string) => !/^GITHUB_APP_(ID|SLUG|PRIVATE_KEY)=/.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  const block = [
    "",
    "# Written by infra/relay/scripts/create-github-app.ts. Secret — never commit.",
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    // Quoted with escaped newlines so the PEM survives a dotenv read.
    `GITHUB_APP_PRIVATE_KEY="${app.pem.replace(/\n/g, "\\n")}"`,
    "",
  ].join("\n");
  yield* fs.writeFileString(envPath, `${kept}\n${block}`);
  yield* fs.chmod(envPath, 0o600).pipe(Effect.ignore);
  return envPath;
});

const nodeHttp = await import("node:http");

const main = Effect.gen(function* () {
  if (!setupUrl) {
    yield* Effect.logError(
      "--setup-url is required: where GitHub sends someone after they install the app, " +
        "for example --setup-url https://t3-dev.example.com/settings/organization",
    );
    return;
  }
  const redirectUrl = `http://localhost:${PORT}/created`;
  const definition = yield* encodeManifest(manifest(redirectUrl, setupUrl));
  const finished = yield* Deferred.make<void>();

  // GitHub takes the manifest as a form POST, so the landing page submits itself.
  const start = HttpRouter.add(
    "GET",
    "/",
    HttpServerResponse.html(
      `<!doctype html><meta charset="utf-8"><title>Creating the GitHub App…</title>
<body style="font-family: system-ui; padding: 3rem; max-width: 34rem">
<h1>Creating the GitHub App</h1>
<p>GitHub will ask you to confirm. Nothing exists until you press the button there.</p>
<form id="f" method="post" action="${createUrl}">
  <input type="hidden" name="manifest" value='${definition.replace(/'/g, "&apos;")}'>
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit()</script>`,
    ),
  );

  const created = HttpRouter.add(
    "GET",
    "/created",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const code = new URL(request.url, `http://localhost:${PORT}`).searchParams.get("code");
      if (!code) {
        return HttpServerResponse.text("GitHub did not send a code.", { status: 400 });
      }
      const app = yield* convert(code);
      const envPath = yield* writeEnv(app);
      yield* Effect.logInfo("GitHub App created", { slug: app.slug, id: app.id, envPath });
      yield* Deferred.succeed(finished, undefined);
      return HttpServerResponse.html(
        `<!doctype html><meta charset="utf-8"><title>Done</title>
<body style="font-family: system-ui; padding: 3rem; max-width: 34rem">
<h1>App created</h1>
<p><strong>${app.slug}</strong> — credentials written to <code>infra/relay/.env</code>.</p>
<p>Restart the relay, then press <em>Connect GitHub</em> on the organization page to install it.</p>
<p><a href="${app.html_url}">App settings on GitHub</a></p>`,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Could not create the GitHub App", cause).pipe(
          Effect.andThen(Deferred.succeed(finished, undefined)),
          Effect.as(
            HttpServerResponse.text("Could not create the app; see the console.", {
              status: 500,
            }),
          ),
        ),
      ),
    ),
  );

  yield* Effect.logInfo("Open this to create the app", {
    url: `http://localhost:${PORT}/`,
    target: organization ? `@${organization}` : "your personal account",
  });

  yield* Layer.launch(
    HttpRouter.serve(Layer.mergeAll(start, created)).pipe(
      Layer.provide(NodeHttpServer.layer(nodeHttp.createServer, { host: "127.0.0.1", port: PORT })),
    ),
  ).pipe(Effect.raceFirst(Deferred.await(finished)));
});

NodeRuntime.runMain(
  main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
