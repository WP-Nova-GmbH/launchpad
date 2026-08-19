/**
 * Runs the relay locally, on Node, against a plain Postgres.
 *
 * This is not a mock. The HTTP surface, the schemas, the authorization, the
 * services and the SQL are the deployed ones — only the three Cloudflare
 * bindings are replaced, because Tunnel, DNS, and Queues have no local
 * equivalent and nothing in the organization surface touches them:
 *
 *   - managed endpoints  → refuse to provision (a local relay hands out no tunnels)
 *   - APNs delivery queue → drop, so publishing activity does not need a queue
 *
 * Clerk verification is real, using CLERK_SECRET_KEY from infra/relay/.env, so
 * tokens minted by the browser are checked exactly as production checks them.
 *
 * Usage, from the repository root:
 *
 *   node infra/relay/scripts/dev-server.ts
 *
 * Reads DEV_RELAY_PORT (default 8610), DEV_RELAY_DATABASE_URL, and
 * DEV_RELAY_ISSUER (the public origin clients reach it on).
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as Etag from "effect/unstable/http/Etag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as PgClient from "@effect/sql-pg/PgClient";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  jobsApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayDpopClientAuthLayer,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  tokenApi,
} from "../src/http/Api.ts";
import { organizationApi, repositoriesApi } from "../src/http/TenancyApi.ts";
import * as AgentActivityPublisher from "../src/agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "../src/agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "../src/agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "../src/agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "../src/agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "../src/agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "../src/agentActivity/DeliveryAttempts.ts";
import * as Devices from "../src/agentActivity/Devices.ts";
import * as DpopProofs from "../src/auth/DpopProofs.ts";
import * as EnvironmentConnector from "../src/environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "../src/environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../src/environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../src/environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../src/environments/EnvironmentPublishSignatures.ts";
import * as Invitations from "../src/tenancy/Invitations.ts";
import * as Jobs from "../src/jobs/Jobs.ts";
import * as LiveActivities from "../src/agentActivity/LiveActivities.ts";
import * as ManagedEndpointAllocations from "../src/environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "../src/environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "../src/environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "../src/agentActivity/MobileRegistrations.ts";
import * as Organizations from "../src/tenancy/Organizations.ts";
import * as RelayConfiguration from "../src/Config.ts";
import * as RelayDb from "../src/db.ts";
import * as RelayTokens from "../src/auth/RelayTokens.ts";
import * as Repositories from "../src/tenancy/Repositories.ts";
import * as UserDirectory from "../src/tenancy/UserDirectory.ts";

const DEFAULT_PORT = 8610;
const DEFAULT_DATABASE_URL = "postgres://postgres:t3relay@127.0.0.1:5433/t3relay";

const nodeCryptoLayer = Layer.succeed(
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

/**
 * A local relay provisions no tunnels. Refusing is the honest answer — the
 * hostname it would hand out could not resolve to anything. Reads report
 * "nothing there" and deletes succeed, so teardown paths stay usable.
 */
const unsupported = (operation: string) =>
  Effect.die(`The development relay does not ${operation}.`);

const tunnelClientStub: ManagedEndpointProvider.ManagedEndpointTunnelClient["Service"] = {
  list: () => Effect.succeed({ result: [] }),
  create: () => unsupported("provision Cloudflare tunnels"),
  putConfiguration: () => unsupported("configure Cloudflare tunnels"),
  getToken: () => unsupported("issue Cloudflare tunnel tokens"),
  delete: () => Effect.succeed(undefined),
};

const dnsClientStub: ManagedEndpointProvider.ManagedEndpointDnsClient["Service"] = {
  listRecords: () => Effect.succeed([]),
  createRecord: () => unsupported("manage DNS records"),
  updateRecord: () => unsupported("manage DNS records"),
  deleteRecord: () => Effect.succeed(undefined),
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Run this with infra/relay/.env loaded, for example:\n  node --env-file infra/relay/.env infra/relay/scripts/dev-server.ts`,
    );
  }
  return value;
}

const port = Number(process.env.DEV_RELAY_PORT ?? DEFAULT_PORT);
const databaseUrl = process.env.DEV_RELAY_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
const relayIssuer = process.env.DEV_RELAY_ISSUER?.trim() || `http://127.0.0.1:${port}`;

const relayConfigurationLayer = Layer.succeed(
  RelayConfiguration.RelayConfiguration,
  RelayConfiguration.RelayConfiguration.of({
    relayIssuer,
    // Never exercised: nothing in the organization surface sends a push.
    apns: {
      environment: "sandbox",
      teamId: process.env.APNS_TEAM_ID ?? "dev-team",
      keyId: process.env.APNS_KEY_ID ?? "dev-key",
      bundleId: process.env.APNS_BUNDLE_ID ?? "dev.bundle",
      privateKey: Redacted.make("dev-apns-private-key"),
    },
    apnsDeliveryJobSigningSecret: Redacted.make("dev-apns-delivery-secret"),
    // The real key, so tokens are verified exactly as production verifies them.
    clerkSecretKey: Redacted.make(required("CLERK_SECRET_KEY")),
    clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
    clerkJwtAudience: process.env.CLERK_JWT_AUDIENCE?.trim() || "t3-code-relay",
    cloudMintPrivateKey: Redacted.make("dev-cloud-mint-private-key"),
    cloudMintPublicKey: "dev-cloud-mint-public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
  }),
);

const relayDbLayer = Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
);

const runtimeLayer = Layer.empty
  .pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(EnvironmentPublishSignatures.layer),
    Layer.provideMerge(
      ManagedEndpointProvider.layer.pipe(
        Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClientStub)),
        Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClientStub)),
      ),
    ),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(ApnsDeliveries.layer),
    Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
    Layer.provideMerge(
      ApnsDeliveryQueue.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ApnsDeliveryQueue.ApnsDeliveryQueueSender,
            ApnsDeliveryQueue.ApnsDeliveryQueueSender.of({
              // Dropped rather than queued: there is no queue locally, and a
              // push nobody receives is not worth a dependency.
              send: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        AgentActivityRows.layer,
        Jobs.layer,
        Organizations.layer,
        Invitations.layer,
        Repositories.layer,
        UserDirectory.layer,
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
    Layer.provideMerge(RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(relayDbLayer))),
    Layer.provideMerge(relayConfigurationLayer),
    Layer.provideMerge(nodeCryptoLayer),
    Layer.provideMerge(FetchHttpClient.layer),
  );

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  organizationApi,
  repositoriesApi,
  tokenApi,
  dpopClientApi,
  jobsApi,
  serverApi,
);

const appLayer = relayApiLayer.pipe(
  Layer.provideMerge(relayClientAuthLayer),
  Layer.provideMerge(relayDpopClientAuthLayer),
  Layer.provideMerge(relayEnvironmentAuthLayer),
  Layer.provide(runtimeLayer),
);

const routerLayer = Layer.merge(
  Layer.mergeAll(
    HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(appLayer)),
    HttpApiScalar.layer(RelayApi, { path: "/docs" }),
    relayDocsRedirectRoute,
  ).pipe(Layer.provide([Etag.layerWeak, relayCors])),
  relayNotFoundRoute,
);

const main = Effect.gen(function* () {
  const nodeHttp = yield* Effect.promise(() => import("node:http"));
  yield* Effect.logInfo("Development relay listening", { port, issuer: relayIssuer, databaseUrl });
  // Handler requirements are deferred to the serve step rather than discharged
  // by the group layers, so this is where the runtime has to be supplied.
  return yield* Layer.launch(
    HttpRouter.serve(routerLayer).pipe(
      Layer.provide(NodeHttpServer.layer(nodeHttp.createServer, { host: "127.0.0.1", port })),
      Layer.provide(runtimeLayer),
      Layer.provide(NodeServices.layer),
    ),
  );
});

NodeRuntime.runMain(main);
