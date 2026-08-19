import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as RelayConfiguration from "../Config.ts";

export interface GithubInstallationAccount {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  /** When GitHub says the installation was created; used to bound claiming. */
  readonly createdAt: string;
}

export interface GithubRepository {
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  /** `host/owner/repo`, ready to register as a canonical key (ADR-0006). */
  readonly canonicalKey: string;
}

export class GithubAppNotConfigured extends Schema.TaggedErrorClass<GithubAppNotConfigured>()(
  "GithubAppNotConfigured",
  {},
) {
  override get message(): string {
    return "This relay has no GitHub App configured.";
  }
}

export class GithubRequestFailed extends Schema.TaggedErrorClass<GithubRequestFailed>()(
  "GithubRequestFailed",
  {
    operation: Schema.Literals(["read-installation", "mint-token", "list-repositories"]),
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub '${this.operation}' failed`;
  }
}

export class GithubApp extends Context.Service<
  GithubApp,
  {
    /** The install link an admin follows; null when no App is configured. */
    readonly installUrl: Effect.Effect<string | null>;
    readonly getInstallation: (input: {
      readonly installationId: string;
    }) => Effect.Effect<
      GithubInstallationAccount | null,
      GithubAppNotConfigured | GithubRequestFailed
    >;
    readonly listRepositories: (input: {
      readonly installationId: string;
    }) => Effect.Effect<
      ReadonlyArray<GithubRepository>,
      GithubAppNotConfigured | GithubRequestFailed
    >;
  }
>()("t3code-relay/tenancy/GithubApp") {}

const GITHUB_API = "https://api.github.com";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * A GitHub App JWT: RS256 over the app id, valid ten minutes. Signed with
 * WebCrypto so this works unchanged on Workers and on Node.
 */
const appJwt = Effect.fn("relay.github.app_jwt")(function* (input: {
  readonly appId: string;
  readonly privateKeyPem: string;
}) {
  const now = yield* DateTime.now;
  const issuedAt = Math.floor(now.epochMilliseconds / 1000) - 60;
  // Written literally rather than via JSON.stringify: a JWT header and claim
  // set are fixed shapes, and the encoder must not reorder or reformat them.
  const header = base64Url(new TextEncoder().encode(`{"alg":"RS256","typ":"JWT"}`));
  const payload = base64Url(
    new TextEncoder().encode(`{"iat":${issuedAt},"exp":${issuedAt + 600},"iss":"${input.appId}"}`),
  );
  const signingInput = `${header}.${payload}`;
  const signature = yield* Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(input.privateKeyPem).buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await globalThis.crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput),
      ),
    );
  }).pipe(Effect.mapError((cause) => new GithubRequestFailed({ operation: "mint-token", cause })));
  return `${signingInput}.${base64Url(signature)}`;
});

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;

  const credentials = Effect.suspend(() =>
    config.github ? Effect.succeed(config.github) : Effect.fail(new GithubAppNotConfigured()),
  );

  const request = Effect.fn("relay.github.request")(function* (input: {
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly token: string;
    readonly operation: GithubRequestFailed["operation"];
  }) {
    const httpRequest = (input.method === "POST" ? HttpClientRequest.post : HttpClientRequest.get)(
      `${GITHUB_API}${input.path}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "t3code-relay",
        "x-github-api-version": "2022-11-28",
      }),
    );
    const response = yield* httpClient
      .execute(httpRequest)
      .pipe(
        Effect.mapError((cause) => new GithubRequestFailed({ operation: input.operation, cause })),
      );
    if (response.status >= 400) {
      return yield* new GithubRequestFailed({
        operation: input.operation,
        status: response.status,
        cause: `GitHub responded ${response.status}`,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new GithubRequestFailed({
            operation: input.operation,
            status: response.status,
            cause,
          }),
      ),
    );
  });

  const installationToken = Effect.fn("relay.github.installation_token")(function* (input: {
    readonly installationId: string;
  }) {
    const app = yield* credentials;
    const jwt = yield* appJwt({
      appId: app.appId,
      privateKeyPem: Redacted.value(app.privateKey),
    });
    const body = yield* request({
      path: `/app/installations/${input.installationId}/access_tokens`,
      method: "POST",
      token: jwt,
      operation: "mint-token",
    });
    const token = (body as { readonly token?: string }).token;
    if (!token) {
      return yield* new GithubRequestFailed({
        operation: "mint-token",
        cause: "GitHub returned no token",
      });
    }
    // Deliberately returned, never stored: it expires within the hour and the
    // relay can always mint another.
    return token;
  });

  return GithubApp.of({
    installUrl: Effect.sync(() =>
      config.github ? `https://github.com/apps/${config.github.appSlug}/installations/new` : null,
    ),

    getInstallation: Effect.fn("relay.github.get_installation")(function* (input) {
      const app = yield* credentials;
      const jwt = yield* appJwt({
        appId: app.appId,
        privateKeyPem: Redacted.value(app.privateKey),
      });
      const body = yield* request({
        path: `/app/installations/${input.installationId}`,
        token: jwt,
        operation: "read-installation",
      }).pipe(
        // A missing installation is an answer, not a fault.
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.succeed(null),
        ),
      );
      if (body === null) {
        return null;
      }
      const parsed = body as {
        readonly id?: number;
        readonly created_at?: string;
        readonly account?: { readonly login?: string; readonly type?: string };
      };
      if (!parsed.id || !parsed.account?.login) {
        return null;
      }
      return {
        installationId: String(parsed.id),
        accountLogin: parsed.account.login,
        accountType: parsed.account.type ?? "Organization",
        createdAt: parsed.created_at ?? "",
      };
    }),

    listRepositories: Effect.fn("relay.github.list_repositories")(function* (input) {
      const token = yield* installationToken({ installationId: input.installationId });
      const collected: Array<GithubRepository> = [];
      for (let page = 1; page <= 10; page += 1) {
        const body = yield* request({
          path: `/installation/repositories?per_page=100&page=${page}`,
          token,
          operation: "list-repositories",
        });
        const repositories = (
          body as {
            readonly repositories?: ReadonlyArray<{
              readonly full_name?: string;
              readonly name?: string;
              readonly default_branch?: string;
              readonly private?: boolean;
            }>;
          }
        ).repositories;
        if (!repositories || repositories.length === 0) {
          break;
        }
        for (const repository of repositories) {
          if (!repository.full_name || !repository.name) continue;
          collected.push({
            fullName: repository.full_name,
            name: repository.name,
            defaultBranch: repository.default_branch ?? "main",
            isPrivate: repository.private ?? false,
            // Matches what `normalizeGitRemoteUrl` derives from a checkout's
            // remote, so a registered key recognises the clone (ADR-0006).
            canonicalKey: `github.com/${repository.full_name}`.toLowerCase(),
          });
        }
        if (repositories.length < 100) break;
      }
      return collected;
    }),
  });
});

export const layer = Layer.effect(GithubApp, make);
