import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** Local dev transports can name this relay without changing its durable token issuer. */
export const RelayTokenResourceAliases = Context.Reference<ReadonlyArray<string>>(
  "launchpad-relay/Config/RelayTokenResourceAliases",
  { defaultValue: () => [] },
);

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

export const managedEndpointCleanupModeConfig = Config.String("RELAY_TUNNEL_CLEANUP_MODE").pipe(
  Config.withDefault("off"),
  Config.map((value) => value.trim() || "off"),
  Config.mapEffect((value) =>
    decodeManagedEndpointCleanupMode(value).pipe(
      Effect.mapError((error) => new Config.ConfigError(error)),
    ),
  ),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

/**
 * The relay's own GitHub App. One app serves every organization; what an
 * organization owns is an *installation* of it, recorded by id alone. The
 * private key stays here, in configuration, and never reaches the database.
 */
export interface GithubAppCredentials {
  readonly appId: string;
  /** The `github.com/apps/<slug>` handle, used to build the install link. */
  readonly appSlug: string;
  readonly privateKey: Redacted.Redacted<string>;
}

export interface LinearWorkflowConfiguration {
  readonly clientId: string;
  readonly organizationId: string;
  readonly clientSecret?: Redacted.Redacted<string>;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    /** Absent until a deployment configures a GitHub App; the surface hides itself. */
    readonly github?: GithubAppCredentials | undefined;
    readonly linearWorkflow?: LinearWorkflowConfiguration | undefined;
    /** Intake may observe delivery while admission stays disabled until release verification. */
    readonly linearWorkflowWebhook?:
      | {
          readonly applicationId: string;
          readonly organizationId: string;
          readonly signingSecret: Redacted.Redacted<string>;
          readonly generation: string;
          readonly admissionEnabled: boolean;
        }
      | undefined;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    /**
     * The source enrolled executors keep themselves current with. Absent on a
     * relay that does not want machines updating themselves; executors then
     * stay on whatever they were started with.
     */
    readonly executorSource?: ExecutorSourceRelease | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
  }
>()("launchpad-relay/Config/RelayConfiguration") {}

export interface ExecutorSourceRelease {
  readonly gitUrl: string;
  readonly ref: string;
}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));

export function workflowLinearConfiguration(
  clientId: string | undefined,
  organizationId: string | undefined,
  clientSecret?: Redacted.Redacted<string>,
): LinearWorkflowConfiguration | undefined {
  const app = clientId?.trim();
  const org = organizationId?.trim();
  if (!app || !org) return undefined;
  return {
    clientId: app,
    organizationId: org,
    ...(clientSecret && Redacted.value(clientSecret).trim() ? { clientSecret } : {}),
  };
}

export function workflowWebhookConfiguration(
  linear: LinearWorkflowConfiguration | undefined,
  signingSecret: Redacted.Redacted<string> | undefined,
  generation: string | undefined,
  admissionEnabled = false,
) {
  return linear && signingSecret && Redacted.value(signingSecret).trim() && generation?.trim()
    ? {
        applicationId: linear.clientId,
        organizationId: linear.organizationId,
        signingSecret,
        generation: generation.trim(),
        admissionEnabled,
      }
    : undefined;
}
