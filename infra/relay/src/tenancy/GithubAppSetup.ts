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
 * Creating the relay's GitHub App from Organization settings, with no
 * terminal in the loop.
 *
 * GitHub's manifest flow: the admin's browser posts an App definition to
 * GitHub, the admin presses Create once, and GitHub redirects to the relay
 * with a short-lived code that converts into the App's id, slug, and private
 * key. The relay seals the key, stores the App, and sends the admin back to
 * the settings page — from which the ordinary Connect GitHub button installs
 * it. The `state` GitHub carries through the round trip is a JWT signed with
 * the relay's cloud mint key, so the callback trusts nothing but its own
 * signature.
 */

export const GITHUB_APP_SETUP_STATE_TYP = "t3-github-app-setup+jwt";
const STATE_LIFETIME_MINUTES = 15;
export const GITHUB_APP_CREATED_PATH = "/v1/organization/github-app/created";

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
  readonly isPublic?: boolean;
}) {
  return {
    name: input.name,
    url: input.setupUrl,
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
    return "The GitHub App setup return URL must be an http(s) URL without credentials.";
  }
}

export class GithubAppSetupStateInvalid extends Schema.TaggedErrorClass<GithubAppSetupStateInvalid>()(
  "GithubAppSetupStateInvalid",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The GitHub App setup state is invalid or has expired.";
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

export interface GithubAppSetupClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly returnUrl: string;
}

const SetupStateClaims = Schema.Struct({
  sub: Schema.String,
  organizationId: Schema.String,
  returnUrl: Schema.String,
});
const decodeSetupStateClaims = Schema.decodeUnknownEffect(SetupStateClaims);

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
    readonly begin: (input: {
      readonly userId: string;
      readonly organizationId: string;
      readonly returnUrl: string;
      readonly githubOrganization?: string | undefined;
      readonly name?: string | undefined;
    }) => Effect.Effect<
      { readonly action: string; readonly manifest: string },
      GithubAppSetupReturnUrlInvalid | GithubAppSetupStateInvalid
    >;
    readonly readState: (
      state: string,
    ) => Effect.Effect<GithubAppSetupClaims, GithubAppSetupStateInvalid>;
    readonly complete: (input: {
      readonly code: string;
      readonly claims: GithubAppSetupClaims;
    }) => Effect.Effect<
      { readonly appSlug: string },
      | GithubAppSetupConversionFailed
      | RelaySecretBox.SecretBoxError
      | GithubAppRecords.GithubAppPersistenceError
    >;
  }
>()("t3code-relay/tenancy/GithubAppSetup") {}

function parseReturnUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
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

  const begin: GithubAppSetup["Service"]["begin"] = Effect.fn("relay.github_app_setup.begin")(
    function* (input) {
      const returnUrl = parseReturnUrl(input.returnUrl);
      if (returnUrl === null) {
        return yield* new GithubAppSetupReturnUrlInvalid();
      }
      const now = yield* DateTime.now;
      const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
      const state = yield* signRelayJwt({
        privateKey: Redacted.value(config.cloudMintPrivateKey),
        typ: GITHUB_APP_SETUP_STATE_TYP,
        payload: {
          iss: issuer,
          aud: issuer,
          sub: input.userId,
          jti: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          iat: issuedAt,
          exp: issuedAt + STATE_LIFETIME_MINUTES * 60,
          organizationId: input.organizationId,
          returnUrl: returnUrl.toString(),
        },
      }).pipe(Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })));
      const manifest = yield* encodeManifest(
        githubAppManifest({
          name: input.name?.trim() || "Launchpad",
          redirectUrl: `${issuer}${GITHUB_APP_CREATED_PATH}`,
          setupUrl: returnUrl.toString(),
        }),
      ).pipe(Effect.orDie);
      return {
        action: `${githubAppCreateUrl(input.githubOrganization?.trim() || undefined)}?state=${encodeURIComponent(state)}`,
        manifest,
      };
    },
  );

  const readState: GithubAppSetup["Service"]["readState"] = Effect.fn(
    "relay.github_app_setup.read_state",
  )(function* (state) {
    const now = yield* DateTime.now;
    const payload = yield* verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: state,
      typ: GITHUB_APP_SETUP_STATE_TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      maxTokenAge: `${STATE_LIFETIME_MINUTES} minutes`,
    }).pipe(Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })));
    const claims = yield* decodeSetupStateClaims(payload).pipe(
      Effect.mapError((cause) => new GithubAppSetupStateInvalid({ cause })),
    );
    return {
      userId: claims.sub,
      organizationId: claims.organizationId,
      returnUrl: claims.returnUrl,
    };
  });

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
    return { appSlug: record.appSlug };
  });

  return GithubAppSetup.of({ begin, readState, complete });
});

export const layer = Layer.effect(GithubAppSetup, make);
