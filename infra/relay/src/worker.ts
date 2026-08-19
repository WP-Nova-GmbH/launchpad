import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  jobsApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { machineEnrollmentApi, machinesApi } from "./http/MachinesApi.ts";
import { organizationApi, repositoriesApi } from "./http/TenancyApi.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as Jobs from "./jobs/Jobs.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as HetznerComputeProvider from "./machines/HetznerComputeProvider.ts";
import * as MachineComputeProvider from "./machines/MachineComputeProvider.ts";
import * as MachineEnroller from "./machines/MachineEnroller.ts";
import * as MachineLimits from "./machines/MachineLimits.ts";
import * as Machines from "./machines/Machines.ts";
import * as Invitations from "./tenancy/Invitations.ts";
import * as Organizations from "./tenancy/Organizations.ts";
import * as Repositories from "./tenancy/Repositories.ts";
import * as GithubApp from "./tenancy/GithubApp.ts";
import * as GithubInstallations from "./tenancy/GithubInstallations.ts";
import * as UserDirectory from "./tenancy/UserDirectory.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  organizationApi,
  repositoriesApi,
  machinesApi,
  machineEnrollmentApi,
  tokenApi,
  dpopClientApi,
  jobsApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    );
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY");
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    // Optional: a deployment without a GitHub App simply hides the surface.
    const githubAppId = yield* Config.string("GITHUB_APP_ID").pipe(Config.option);
    const githubAppSlug = yield* Config.string("GITHUB_APP_SLUG").pipe(Config.option);
    const githubAppPrivateKey = yield* Config.redacted("GITHUB_APP_PRIVATE_KEY").pipe(
      Config.option,
    );

    // Optional: a deployment without a Hetzner token cannot create machine
    // compute and says so instead of pretending.
    const hetznerApiToken = yield* Config.redacted("HETZNER_API_TOKEN").pipe(Config.option);
    const hetznerSettings: Omit<HetznerComputeProvider.HetznerComputeSettings, "apiToken"> = {
      serverType: yield* Config.string("HETZNER_SERVER_TYPE").pipe(Config.withDefault("cx22")),
      image: yield* Config.string("HETZNER_IMAGE").pipe(Config.withDefault("ubuntu-24.04")),
      location: yield* Config.string("HETZNER_LOCATION").pipe(Config.withDefault("fsn1")),
      sshKeys: (yield* Config.string("HETZNER_SSH_KEYS").pipe(Config.withDefault("")))
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key.length > 0),
      bootstrapUrl: yield* Config.string("MACHINE_BOOTSTRAP_URL").pipe(
        Config.withDefault(
          "https://raw.githubusercontent.com/WP-Nova-GmbH/launchpad/main/infra/relay/scripts/machine-bootstrap.sh",
        ),
      ),
      sourceGitUrl: yield* Config.string("MACHINE_SOURCE_GIT_URL").pipe(
        Config.withDefault("https://github.com/WP-Nova-GmbH/launchpad.git"),
      ),
    };

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        github:
          Option.isSome(githubAppId) &&
          Option.isSome(githubAppSlug) &&
          Option.isSome(githubAppPrivateKey)
            ? {
                appId: githubAppId.value,
                appSlug: githubAppSlug.value,
                privateKey: githubAppPrivateKey.value,
              }
            : undefined,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const runtimeLayer = Layer.empty
      .pipe(
        Layer.provideMerge(MobileRegistrations.layer),
        Layer.provideMerge(AgentActivityPublisher.layer),
        Layer.provideMerge(EnvironmentConnector.layer),
        Layer.provideMerge(EnvironmentLinker.layer),
        Layer.provideMerge(MachineEnroller.layer),
        Layer.provideMerge(
          Option.isSome(hetznerApiToken)
            ? HetznerComputeProvider.layerHetzner({
                apiToken: hetznerApiToken.value,
                ...hetznerSettings,
              })
            : MachineComputeProvider.layerUnavailable,
        ),
        Layer.provideMerge(MachineLimits.layer),
        Layer.provideMerge(EnvironmentPublishSignatures.layer),
        Layer.provideMerge(
          ManagedEndpointProvider.layerCloudflareBindings(
            managedEndpointTunnelBinding,
            managedEndpointDnsBinding,
            alchemyRuntimeContext,
          ),
        ),
        Layer.provideMerge(DpopProofs.layer),
        Layer.provideMerge(ApnsDeliveries.layer),
        Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
        Layer.provideMerge(
          ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
        ),
        // Row stores that need nothing but RelayDb.
        Layer.provideMerge(
          Layer.mergeAll(
            AgentActivityRows.layer,
            Jobs.layer,
            Organizations.layer,
            Invitations.layer,
            Repositories.layer,
            UserDirectory.layer,
            GithubApp.layer,
            GithubInstallations.layer,
            Machines.layer,
          ),
        ),
        Layer.provideMerge(Devices.layer),
        Layer.provideMerge(EnvironmentCredentials.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            EnvironmentLinks.layer,
            ManagedEndpointAllocations.layer,
            ManagedTunnelLimits.layer,
          ),
        ),
        Layer.provideMerge(LiveActivities.layer),
        Layer.provideMerge(DeliveryAttempts.layer),
      )
      .pipe(
        // Split only because `pipe` takes at most twenty arguments.
        Layer.provideMerge(RelayTokens.layer),
        Layer.provideMerge(
          RelayDb.RelayTransactions.layer.pipe(
            Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
          ),
        ),
        Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
        Layer.provideMerge(webcryptoLayer),
      );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
      ),
    ),
  ),
);

export default ApiLive;
