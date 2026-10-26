import {
  type ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import { RelayApi, RelayIssueTrackerTurnClaims } from "@t3tools/contracts/relay";
import { issueTrackerCommandDigest } from "@t3tools/shared/issueTrackerTurn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerConfig } from "../config.ts";

export class CurrentIssueTrackerAuthorization extends Context.Reference<string | undefined>(
  "server.currentIssueTrackerAuthorization",
  { defaultValue: (): string | undefined => undefined },
) {}

const StoredAuthorization = Schema.Struct({
  authorization: Schema.String,
  relayUrl: Schema.String,
  claims: RelayIssueTrackerTurnClaims,
});
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredAuthorization));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAuthorization));
const key = (id: string) => `issue-tracker-turn-${Buffer.from(id).toString("base64url")}`;
const failure = () =>
  new OrchestrationDispatchCommandError({
    message:
      "Personal connection authorization is invalid or expired. Sign in and send the message again.",
  });

const nextPruneByStore = new WeakMap<ServerSecretStore["Service"], number>();
/** Expired, removed and abandoned prompts must not accumulate credentials indefinitely. */
const pruneExpired = Effect.fnUntraced(
  function* (secrets: ServerSecretStore["Service"]) {
    const now = yield* Clock.currentTimeMillis;
    if ((nextPruneByStore.get(secrets) ?? -Infinity) > now) return;
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const config = yield* Effect.serviceOption(ServerConfig);
    if (Option.isNone(fs) || Option.isNone(config)) return;
    const names = yield* fs.value.readDirectory(config.value.secretsDir);
    yield* Effect.forEach(
      names.filter((name) => /^issue-tracker-turn-[A-Za-z0-9_-]+\.bin$/.test(name)),
      (name) =>
        Effect.gen(function* () {
          const secretName = name.slice(0, -4);
          const bytes = yield* secrets.get(secretName);
          if (Option.isNone(bytes)) return;
          const grant = yield* decode(new TextDecoder().decode(bytes.value));
          if (grant.claims.expiresAt <= now) yield* secrets.remove(secretName);
        }).pipe(Effect.ignore),
      { concurrency: 4, discard: true },
    );
    nextPruneByStore.set(secrets, now + 60 * 60_000);
  },
  (effect) => effect.pipe(Effect.ignore),
);

/** Verify before normalization; only an opaque lookup ID may be persisted in queue events. */
export const saveCommandAuthorization = Effect.fn("issueTrackers.saveCommandAuthorization")(
  function* (command: ClientOrchestrationCommand, authenticatedUserId?: string) {
    if (!("issueTrackerAuthorization" in command) || !command.issueTrackerAuthorization)
      return undefined;
    const authorization = command.issueTrackerAuthorization;
    const httpOption = yield* Effect.serviceOption(HttpClient.HttpClient);
    const environmentOption = yield* Effect.serviceOption(ServerEnvironment);
    const secretsOption = yield* Effect.serviceOption(ServerSecretStore);
    const cryptoOption = yield* Effect.serviceOption(Crypto.Crypto);
    if (
      Option.isNone(httpOption) ||
      Option.isNone(environmentOption) ||
      Option.isNone(secretsOption) ||
      Option.isNone(cryptoOption)
    )
      return yield* failure();
    const relayUrl = yield* relayUrlConfig;
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: relayUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(authorization)),
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpOption.value));
    const claims = yield* client.issueTrackersServer.verifyTurn();
    const environment = environmentOption.value;
    if (
      (authenticatedUserId !== undefined && claims.ownerUserId !== authenticatedUserId) ||
      claims.environmentId !== (yield* environment.getEnvironmentId) ||
      claims.threadId !== command.threadId ||
      claims.commandId !== command.commandId ||
      (claims.runtimeMode !== undefined &&
        claims.runtimeMode !==
          ("runtimeMode" in command
            ? command.runtimeMode
            : command.type === "thread.prompt.edit"
              ? command.expectedRuntimeMode
              : undefined)) ||
      claims.commandDigest !==
        (yield* issueTrackerCommandDigest(command).pipe(
          Effect.provideService(Crypto.Crypto, cryptoOption.value),
        ))
    )
      return yield* failure();
    const secrets = secretsOption.value;
    yield* pruneExpired(secrets);
    const saved = yield* encode({ authorization, relayUrl, claims });
    // Command IDs are idempotency keys. A rejected duplicate must not replace
    // the authorization of an already queued prompt.
    yield* secrets.create(key(command.commandId), new TextEncoder().encode(saved)).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          const existing = yield* secrets.get(key(command.commandId));
          if (Option.isNone(existing)) return yield* failure();
          const previous = yield* decode(new TextDecoder().decode(existing.value));
          if (
            previous.claims.ownerUserId !== claims.ownerUserId ||
            previous.claims.commandDigest !== claims.commandDigest ||
            previous.claims.runtimeMode !== claims.runtimeMode ||
            previous.claims.threadId !== claims.threadId ||
            previous.claims.environmentId !== claims.environmentId
          )
            return yield* failure();
        }),
      ),
    );
    return command.commandId;
  },
  Effect.mapError(failure),
);

export const readTurnAuthorization = Effect.fn("issueTrackers.readTurnAuthorization")(
  function* (id: string | undefined, threadId: string) {
    if (!id) return null;
    const secretsOption = yield* Effect.serviceOption(ServerSecretStore);
    if (Option.isNone(secretsOption)) return null;
    const secrets = secretsOption.value;
    const value = yield* secrets.get(key(id));
    if (Option.isNone(value)) return null;
    const stored = yield* decode(new TextDecoder().decode(value.value));
    if (stored.claims.threadId !== threadId) return null;
    if (stored.claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
      yield* secrets.remove(key(id));
      return null;
    }
    return stored;
  },
  Effect.orElseSucceed(() => null),
);
