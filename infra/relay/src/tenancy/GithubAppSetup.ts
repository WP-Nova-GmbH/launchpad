import { normalizeRelayIssuer, signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as RelaySecretBox from "../auth/SecretBox.ts";
import * as RelayConfiguration from "../Config.ts";
import * as GithubAppRecords from "./GithubAppRecords.ts";

/**
 * Creating and installing the relay's GitHub App from Organization settings,
 * with no terminal in the loop — and no requirement that the client be a web
 * page GitHub can redirect to. The desktop app can only reach GitHub through
 * the system browser, so the whole journey runs there, on relay-hosted pages:
 *
 *   start   → posts the App manifest to GitHub; the admin presses Create
 *   created → GitHub's callback; converts the code, seals and stores the key,
 *             then sends the admin straight on to install the App
 *   installed → GitHub's setup callback; claims the installation for the
 *             organization and tells the admin to go back to Launchpad
 *
 * Each hop carries a `state` JWT signed with the relay's cloud mint key naming
 * the admin, the organization, and where to send them at the end, so the
 * callbacks trust nothing but the relay's own signature. The client only ever
 * opens a URL and refreshes when it regains focus.
 */

export const GITHUB_APP_SETUP_STATE_TYP = "t3-github-app-setup+jwt";
export const GITHUB_INSTALL_STATE_TYP = "t3-github-install+jwt";
// Two GitHub screens with a human between them; generous on purpose.
const STATE_LIFETIME_MINUTES = 30;
export const GITHUB_APP_START_PATH = "/v1/organization/github-app/start";
export const GITHUB_APP_CREATED_PATH = "/v1/organization/github-app/created";
export const GITHUB_APP_INSTALLED_PATH = "/v1/organization/github-app/installed";

/** The desktop app's own origins; GitHub cannot redirect to them, the relay's pages can link to them. */
const DESKTOP_RETURN_SCHEMES = new Set(["t3code:", "t3code-dev:"]);

/**
 * What the App may do. Contents (write, so executors push) and metadata are
 * what listing, cloning, and pushing need; pull requests are what the job
 * runner needs, and asking now avoids a second trip through GitHub's approval
 * later.
 */
export function githubAppManifest(input: {
  readonly name: string;
  readonly redirectUrl: string;
  readonly setupUrl: string;
  readonly homepageUrl?: string | undefined;
  readonly isPublic?: boolean;
}) {
  return {
    name: input.name,
    url: input.homepageUrl ?? input.setupUrl,
    redirect_url: input.redirectUrl,
    setup_url: input.setupUrl,
    setup_on_update: true,
    // A vendor App other organizations install has to be public; keep it
    // private while only your own organization installs it.
    public: input.isPublic ?? false,
    default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
    default_events: [] as ReadonlyArray<string>,
  };
}

export function githubAppCreateUrl(organization: string | undefined): string {
  return organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

export class GithubAppSetupReturnUrlInvalid extends Schema.TaggedErrorClass<GithubAppSetupReturnUrlInvalid>()(
  "GithubAppSetupReturnUrlInvalid",
  {},
) {
  override get message(): string {
    return "The GitHub return URL must be an http(s) URL or a Launchpad desktop URL, without credentials.";
  }
}

export class GithubAppSetupStateInvalid extends Schema.TaggedErrorClass<GithubAppSetupStateInvalid>()(
  "GithubAppSetupStateInvalid",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The GitHub setup state is invalid or has expired.";
  }
}

export class GithubAppSetupConversionFailed extends Schema.TaggedErrorClass<GithubAppSetupConversionFailed>()(
  "GithubAppSetupConversionFailed",
  { status: Schema.optionalKey(Schema.Number), cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub did not convert the App manifest";
  }
}

export class GithubAppNotAvailable extends Schema.TaggedErrorClass<GithubAppNotAvailable>()(
  "GithubAppNotAvailable",
  {},
) {
  override get message(): string {
    return "This relay has no GitHub App to install.";
  }
}

export interface GithubSetupClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly returnUrl: string;
}

/** Whether a return URL is the desktop app rather than a web page GitHub could redirect to. */
export function isDesktopReturnUrl(returnUrl: string): boolean {
  try {
    return DESKTOP_RETURN_SCHEMES.has(new URL(returnUrl).protocol);
  } catch {
    return false;
  }
}

const StateClaims = Schema.Struct({
  sub: Schema.String,
  organizationId: Schema.String,
  returnUrl: Schema.String,
  githubOrganization: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
});
const decodeStateClaims = Schema.decodeUnknownEffect(StateClaims);

const ConvertedApp = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  pem: Schema.String,
});
const decodeConvertedApp = Schema.decodeUnknownEffect(ConvertedApp);

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class GithubAppSetup extends Context.Service<
  GithubAppSetup,
  {
    /** The relay-hosted page that posts the manifest to GitHub; open it in a browser. */
    readonly begin: (input: {
      readonly userId: string;
      readonly organizationId: string;
      readonly returnUrl: string;
      readonly githubOrganization?: string | undefined;
      readonly name?: string | undefined;
    }) => Effect.Effect<
      { readonly startUrl: string },
      GithubAppSetupReturnUrlInvalid | GithubAppSetupStateInvalid
    >;
    /** What the start page renders: GitHub's form action and the manifest to post. */
    readonly renderStart: (
      state: string,
    ) => Effect.Effect<
      { readonly action: string; readonly manifest: string; readonly claims: GithubSetupClaims },
      GithubAppSetupStateInvalid
    >;
    readonly readState: (
      state: string,
    ) => Effect.Effect<GithubSetupClaims, GithubAppSetupStateInvalid>;
    /** Converts GitHub's code into a stored App and hands back where to install it. */
    readonly complete: (input: {
      readonly code: string;
      readonly claims: GithubSetupClaims;
    }) => Effect.Effect<
      { readonly appSlug: string; readonly installUrl: string },
      | GithubAppSetupConversionFailed
      | GithubAppSetupStateInvalid
      | RelaySecretBox.SecretBoxError
      | GithubAppRecords.GithubAppPersistenceError
    >;
    /** GitHub's install page for the relay's App, carrying who is installing and where to send them. */
    readonly beginInstall: (input: {
      readonly userId: string;
      readonly organizationId: string;
      readonly returnUrl: string;
    }) => Effect.Effect<
      { readonly installUrl: string },
      | GithubAppSetupReturnUrlInvalid
      | GithubAppSetupStateInvalid
      | GithubAppNotAvailable
      | GithubAppRecords.GithubAppPersistenceError
    >;
    readonly readInstallState: (
      state: string,
    ) => Effect.Effect<GithubSetupClaims, GithubAppSetupStateInvalid>;
  }
>()("t3code-relay/tenancy/GithubAppSetup") {}

function parseReturnUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" ||
      url.protocol === "http:" ||
      DESKTOP_RETURN_SCHEMES.has(url.protocol);
    if (!allowed || url.username || url.password) {
      return null;
    }
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const records = yield* GithubAppRecords.GithubAppRecords;
  const secretBox = yield* RelaySecretBox.RelaySecretBox;
  const crypto = yield* Crypto.Crypto;
  const issuer = normalizeRelayIssuer(config.relayIssuer);

  const signState = Effect.fn("relay.github_app_setup.sign_state")(function* (input: {
    readonly typ: string;
    readonly claims: GithubSetupClaims;
    readonly githubOrganization?: string | undefined;
    readonly appName?: string | undefined;
  }) {
    const now = yield* DateTime.now;
    const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
    return yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: input.typ,
      payload: {
        iss: issuer,
        aud: issuer,
        sub: input.claims.userId,
        jti: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
        iat: issuedAt,
        exp: issuedAt + STATE_LIFETIME_MINUTES * 60,
        organizationId: input.claims.organizationId,
        returnUrl: input.claims.returnUrl,
        ...(input.githubOrganization ? { githubOrganization: input.githubOrganization } : {}),
        ...(input.appName ? { appName: input.appName } : {}),
      },
    }).pipe(Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })));
  });

  const verifyState = Effect.fn("relay.github_app_setup.verify_state")(function* (input: {
    readonly typ: string;
    readonly state: string;
  }) {
    const now = yield* DateTime.now;
    const payload = yield* verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.state,
      typ: input.typ,
      issuer,
      audience: issuer,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      maxTokenAge: `${STATE_LIFETIME_MINUTES} minutes`,
    }).pipe(Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })));
    return yield* decodeStateClaims(payload).pipe(
      Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })),
    );
  });

  const toClaims = (decoded: typeof StateClaims.Type): GithubSetupClaims => ({
    userId: decoded.sub,
    organizationId: decoded.organizationId,
    returnUrl: decoded.returnUrl,
  });

  const appSlug = Effect.gen(function* () {
    if (config.github) {
      return config.github.appSlug;
    }
    const record = yield* records.get;
    return record?.appSlug ?? null;
  });

  const beginInstall: GithubAppSetup["Service"]["beginInstall"] = Effect.fn(
    "relay.github_app_setup.begin_install",
  )(function* (input) {
    const returnUrl = parseReturnUrl(input.returnUrl);
    if (returnUrl === null) {
      return yield* new GithubAppSetupReturnUrlInvalid();
    }
    const slug = yield* appSlug;
    if (slug === null) {
      return yield* new GithubAppNotAvailable();
    }
    const state = yield* signState({
      typ: GITHUB_INSTALL_STATE_TYP,
      claims: { ...input, returnUrl: returnUrl.toString() },
    });
    return {
      installUrl: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
    };
  });

  const begin: GithubAppSetup["Service"]["begin"] = Effect.fn("relay.github_app_setup.begin")(
    function* (input) {
      const returnUrl = parseReturnUrl(input.returnUrl);
      if (returnUrl === null) {
        return yield* new GithubAppSetupReturnUrlInvalid();
      }
      const state = yield* signState({
        typ: GITHUB_APP_SETUP_STATE_TYP,
        claims: {
          userId: input.userId,
          organizationId: input.organizationId,
          returnUrl: returnUrl.toString(),
        },
        githubOrganization: input.githubOrganization?.trim() || undefined,
        appName: input.name?.trim() || undefined,
      });
      return { startUrl: `${issuer}${GITHUB_APP_START_PATH}?state=${encodeURIComponent(state)}` };
    },
  );

  const renderStart: GithubAppSetup["Service"]["renderStart"] = Effect.fn(
    "relay.github_app_setup.render_start",
  )(function* (state) {
    const decoded = yield* verifyState({ typ: GITHUB_APP_SETUP_STATE_TYP, state });
    const manifest = yield* encodeManifest(
      githubAppManifest({
        name: decoded.appName ?? "Launchpad",
        redirectUrl: `${issuer}${GITHUB_APP_CREATED_PATH}`,
        setupUrl: `${issuer}${GITHUB_APP_INSTALLED_PATH}`,
        homepageUrl: issuer,
      }),
    ).pipe(Effect.orDie);
    return {
      action: `${githubAppCreateUrl(decoded.githubOrganization)}?state=${encodeURIComponent(state)}`,
      manifest,
      claims: toClaims(decoded),
    };
  });

  const readState: GithubAppSetup["Service"]["readState"] = (state) =>
    verifyState({ typ: GITHUB_APP_SETUP_STATE_TYP, state }).pipe(Effect.map(toClaims));

  const readInstallState: GithubAppSetup["Service"]["readInstallState"] = (state) =>
    verifyState({ typ: GITHUB_INSTALL_STATE_TYP, state }).pipe(Effect.map(toClaims));

  const complete: GithubAppSetup["Service"]["complete"] = Effect.fn(
    "relay.github_app_setup.complete",
  )(function* (input) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(
          `https://api.github.com/app-manifests/${encodeURIComponent(input.code)}/conversions`,
        ).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "user-agent": "t3code-relay",
            "x-github-api-version": "2022-11-28",
          }),
        ),
      )
      .pipe(Effect.mapError((cause) => new GithubAppSetupConversionFailed({ cause })));
    if (response.status >= 400) {
      return yield* new GithubAppSetupConversionFailed({
        status: response.status,
        cause: `GitHub responded ${response.status}`,
      });
    }
    const app = yield* response.json.pipe(
      Effect.flatMap(decodeConvertedApp),
      Effect.mapError((cause) => new GithubAppSetupConversionFailed({ cause })),
    );
    const privateKeySealed = yield* secretBox.seal(app.pem);
    const record = yield* records.save({
      appId: String(app.id),
      appSlug: app.slug,
      privateKeySealed,
      createdByUserId: input.claims.userId,
    });
    yield* Effect.logInfo("github app created from organization settings", {
      appSlug: record.appSlug,
      organizationId: input.claims.organizationId,
    });
    const state = yield* signState({ typ: GITHUB_INSTALL_STATE_TYP, claims: input.claims });
    return {
      appSlug: record.appSlug,
      installUrl: `https://github.com/apps/${encodeURIComponent(record.appSlug)}/installations/new?state=${encodeURIComponent(state)}`,
    };
  });

  return GithubAppSetup.of({
    begin,
    renderStart,
    readState,
    complete,
    beginInstall,
    readInstallState,
  });
});

export const layer = Layer.effect(GithubAppSetup, make);
