import * as NodeCrypto from "node:crypto";
import {
  RelayMachineEnrollResponse,
  type RelayMachineEnrollProofPayload,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_MACHINE_ENROLL_PROOF_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MACHINE_IDENTITY,
  CLOUD_MINT_PUBLIC_KEY,
  decodeCloudMachineIdentity,
  encodeCloudMachineIdentityJson,
  encodeEndpointRuntimeConfigJson,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
  type CloudMachineIdentity,
} from "./config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";

/**
 * How a provisioned machine finds its way home (ADR-0002). The compute driver
 * injects these into the instance; the seed is single-use and dead the moment
 * enrollment succeeds, so a restart re-reading it is harmless.
 */
const machineEnrollmentSeedConfig = Config.nonEmptyString("T3CODE_MACHINE_ENROLLMENT_SEED").pipe(
  Config.option,
);
const machineEnrollmentRelayUrlConfig = Config.nonEmptyString(
  "T3CODE_MACHINE_ENROLLMENT_RELAY_URL",
).pipe(Config.option);
const machineEnrollmentRelayIssuerConfig = Config.nonEmptyString(
  "T3CODE_MACHINE_ENROLLMENT_RELAY_ISSUER",
).pipe(Config.option);
/**
 * The origin other parties can reach this machine on, when it differs from the
 * loopback origin the server binds — a Docker driver maps the container port
 * onto the host and passes the host-side origin here.
 */
const machineAdvertisedOriginConfig = Config.nonEmptyString(
  "T3CODE_MACHINE_ADVERTISED_ORIGIN",
).pipe(Config.option);
/**
 * Where the injected enrollment file lives, when the bootstrap wants it
 * scrubbed after use. The seed is single-use server-side either way; wiping
 * the file just stops a dead secret from lingering on disk.
 */
const machineEnrollmentEnvFileConfig = Config.nonEmptyString(
  "T3CODE_MACHINE_ENROLLMENT_ENV_FILE",
).pipe(Config.option);

export class MachineEnrollmentRejected extends Schema.TaggedErrorClass<MachineEnrollmentRejected>()(
  "MachineEnrollmentRejected",
  {
    status: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The relay rejected machine enrollment (${this.status}): ${this.detail}`;
  }
}

export class MachineEnrollmentFailed extends Schema.TaggedErrorClass<MachineEnrollmentFailed>()(
  "MachineEnrollmentFailed",
  {
    stage: Schema.Literals([
      "read-configuration",
      "validate-relay-url",
      "sign-proof",
      "enroll-request",
      "decode-response",
      "persist-configuration",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Machine enrollment failed during '${this.stage}'`;
  }
}

export type MachineEnrollmentOutcome =
  | { readonly outcome: "not-a-machine" }
  | { readonly outcome: "already-enrolled"; readonly identity: CloudMachineIdentity }
  | { readonly outcome: "linked-environment" }
  | { readonly outcome: "enrolled"; readonly identity: CloudMachineIdentity };

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function readInstalledMachineIdentity(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  return secrets
    .get(CLOUD_MACHINE_IDENTITY)
    .pipe(
      Effect.map((bytes) =>
        Option.isSome(bytes)
          ? Option.getOrNull(decodeCloudMachineIdentity(bytesToString(bytes.value)))
          : null,
      ),
    );
}

export interface ManagedExecutorRelayConfig {
  readonly url: string;
  readonly issuer: string;
  readonly environmentCredential: string;
}

/**
 * The relay this environment answers to as an enrolled agent executor, with
 * the credential enrollment left behind. Null on a personal machine, on a
 * review host, and until enrollment has completed — the one check every
 * executor-only relay call makes before it does anything.
 */
export function readManagedExecutorRelayConfig(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<ManagedExecutorRelayConfig | null> {
  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(Effect.map((bytes) => (Option.isSome(bytes) ? bytesToString(bytes.value) : null)));
  return Effect.all([
    readSecretString(RELAY_URL_SECRET),
    readSecretString(RELAY_ISSUER_SECRET),
    readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    readInstalledMachineIdentity(secrets),
  ]).pipe(
    Effect.map(([url, issuer, environmentCredential, machineIdentity]) =>
      url && environmentCredential && machineIdentity?.role === "agent_executor"
        ? { url, issuer: issuer ?? url, environmentCredential }
        : null,
    ),
    Effect.orElseSucceed(() => null),
  );
}

/**
 * Unlike a personal environment's relay URL, a machine's may be plain HTTP:
 * the dev relay lives on the developer's own host and the Docker driver hands
 * containers an `http://host.docker.internal` origin. The seed traveled the
 * same channel, so refusing it here would protect nothing.
 */
function normalizeMachineRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/*$/u.test(url.pathname.replace(/^\//u, ""))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function validateEd25519PublicKey(publicKey: string): boolean {
  try {
    const key = NodeCrypto.createPublicKey(publicKey.replace(/\\n/gu, "\n"));
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

const scrubEnrollmentEnvFile = Effect.fn("environment.machine.scrubEnrollmentEnvFile")(
  function* () {
    const envFile = yield* machineEnrollmentEnvFileConfig.pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(envFile)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(envFile.value, "# Consumed by machine enrollment.\n").pipe(
      Effect.tap(() => Effect.logInfo("Scrubbed the machine enrollment seed file")),
      Effect.catch((cause) =>
        Effect.logWarning("Could not scrub the machine enrollment seed file", { cause }),
      ),
    );
  },
);

/**
 * Present the seeded credential once and become an executor: exchange the
 * seed for the durable environment credential, persist the relay
 * configuration and machine identity, and start the managed endpoint
 * connector when the relay handed one out.
 *
 * Idempotent across restarts — an installed machine identity wins over any
 * seed still visible in the environment, so a rebooted machine never replays
 * an enrollment.
 */
export const reconcileMachineEnrollment = Effect.fn("environment.machine.reconcileEnrollment")(
  function* (localOrigin: string) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const endpointRuntime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
    const httpClient = yield* HttpClient.HttpClient;

    const installed = yield* readInstalledMachineIdentity(secrets);
    if (installed !== null) {
      return {
        outcome: "already-enrolled",
        identity: installed,
      } satisfies MachineEnrollmentOutcome;
    }
    const [seed, relayUrlRaw, relayIssuerRaw] = yield* Effect.all([
      machineEnrollmentSeedConfig,
      machineEnrollmentRelayUrlConfig,
      machineEnrollmentRelayIssuerConfig,
    ]).pipe(
      Effect.mapError(
        (cause) => new MachineEnrollmentFailed({ stage: "read-configuration", cause }),
      ),
    );
    if (Option.isNone(seed) || Option.isNone(relayUrlRaw)) {
      return { outcome: "not-a-machine" } satisfies MachineEnrollmentOutcome;
    }
    // An environment someone already linked can never become a machine; the
    // relay refuses this too, but failing fast keeps the seed unconsumed.
    const linkedUser = yield* secrets.get(CLOUD_LINKED_USER_ID);
    if (Option.isSome(linkedUser)) {
      yield* Effect.logWarning(
        "Ignoring the machine enrollment seed: this environment is already linked to a cloud account",
      );
      return { outcome: "linked-environment" } satisfies MachineEnrollmentOutcome;
    }
    const relayUrl = normalizeMachineRelayUrl(relayUrlRaw.value);
    const relayIssuer = normalizeMachineRelayUrl(
      Option.isSome(relayIssuerRaw) ? relayIssuerRaw.value : relayUrlRaw.value,
    );
    if (relayUrl === null || relayIssuer === null) {
      return yield* new MachineEnrollmentFailed({ stage: "validate-relay-url" });
    }
    if (relayUrl.startsWith("http:")) {
      yield* Effect.logWarning("Enrolling against a plain-HTTP relay; expected only in dev", {
        relayUrl,
      });
    }

    const localUrl = yield* Effect.try({
      try: () => new URL(localOrigin),
      catch: (cause) => new MachineEnrollmentFailed({ stage: "read-configuration", cause }),
    });
    const advertisedOrigin = yield* machineAdvertisedOriginConfig.pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const endpointOrigin = Option.isSome(advertisedOrigin) ? advertisedOrigin.value : localOrigin;

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
      Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "sign-proof", cause })),
    );
    const descriptor = yield* environment.getDescriptor.pipe(
      Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "sign-proof", cause })),
    );
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const payload = {
      iss: `t3-env:${descriptor.environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: descriptor.environmentId,
      jti: yield* Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "sign-proof", cause })),
      ),
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      seed: seed.value,
      descriptor,
      environmentId: descriptor.environmentId,
      environmentPublicKey: keyPair.publicKey.trim(),
      endpoint: {
        httpBaseUrl: endpointOrigin,
        wsBaseUrl: endpointOrigin.replace(/^http/u, "ws"),
        providerKind: "manual" as const,
      },
      origin: {
        localHttpHost: localUrl.hostname,
        localHttpPort: Number(localUrl.port || (localUrl.protocol === "https:" ? 443 : 80)),
      },
    } satisfies RelayMachineEnrollProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MACHINE_ENROLL_PROOF_TYP,
      payload,
    }).pipe(
      Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "sign-proof", cause })),
    );

    const response = yield* HttpClientRequest.post(`${relayUrl}/v1/machines/enroll`).pipe(
      HttpClientRequest.bodyJson({ proof }),
      Effect.flatMap(httpClient.execute),
      Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "enroll-request", cause })),
      withRelayClientTracing,
    );
    if (response.status >= 400 && response.status < 500) {
      // A definite refusal — a bad or consumed seed — is not retryable; the
      // machine needs to be deprovisioned and recreated with a fresh seed.
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new MachineEnrollmentRejected({ status: response.status, detail });
    }
    const enrollment = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayMachineEnrollResponse)),
      Effect.mapError((cause) => new MachineEnrollmentFailed({ stage: "decode-response", cause })),
    );
    if (!validateEd25519PublicKey(enrollment.cloudMintPublicKey)) {
      return yield* new MachineEnrollmentFailed({ stage: "decode-response" });
    }

    const identity = {
      machineId: enrollment.machineId,
      organizationId: enrollment.organizationId,
      role: enrollment.role,
    } satisfies CloudMachineIdentity;
    yield* Effect.gen(function* () {
      yield* secrets.set(RELAY_URL_SECRET, stringToBytes(relayUrl));
      yield* secrets.set(RELAY_ISSUER_SECRET, stringToBytes(enrollment.relayIssuer));
      yield* secrets.set(
        CLOUD_MACHINE_IDENTITY,
        stringToBytes(yield* encodeCloudMachineIdentityJson(identity)),
      );
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        stringToBytes(enrollment.environmentCredential),
      );
      yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(enrollment.cloudMintPublicKey));
      // Executors publish agent awareness by default: coarse job state is fed
      // by exactly this stream once the relay starts consuming it.
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
      if (enrollment.endpointRuntime) {
        yield* secrets.set(
          CLOUD_ENDPOINT_RUNTIME_CONFIG,
          stringToBytes(yield* encodeEndpointRuntimeConfigJson(enrollment.endpointRuntime)),
        );
      } else {
        yield* secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
      }
    }).pipe(
      Effect.mapError(
        (cause) => new MachineEnrollmentFailed({ stage: "persist-configuration", cause }),
      ),
    );
    // The credential is durable the moment it persists; the connector is
    // reconciled from the stored config on every boot, so a failure here only
    // delays reachability, never the enrollment.
    yield* endpointRuntime.applyConfig(enrollment.endpointRuntime).pipe(
      Effect.tap((status) =>
        status.status === "failed"
          ? Effect.logWarning("Managed endpoint connector did not start after enrollment", {
              reason: status.reason,
            })
          : Effect.void,
      ),
    );
    yield* scrubEnrollmentEnvFile();
    yield* Effect.logInfo("Machine enrolled with the relay", {
      machineId: identity.machineId,
      organizationId: identity.organizationId,
      role: identity.role,
    });
    return { outcome: "enrolled", identity } satisfies MachineEnrollmentOutcome;
  },
);
