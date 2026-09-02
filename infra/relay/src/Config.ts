import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

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

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    /** Absent until a deployment configures a GitHub App; the surface hides itself. */
    readonly github: GithubAppCredentials | undefined;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    /**
     * Development-only escape hatch for relay-provisioned Docker machines.
     * When enabled, the connector may call a machine's loopback-only manual
     * endpoint. Personal links and non-loopback endpoints remain rejected.
     */
    readonly allowLocalMachineEndpoints?: boolean;
    /**
     * The source enrolled executors keep themselves current with. Absent on a
     * relay that does not want machines updating themselves; executors then
     * stay on whatever they were started with.
     */
    readonly executorSource?: ExecutorSourceRelease | undefined;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export interface ExecutorSourceRelease {
  readonly gitUrl: string;
  readonly ref: string;
}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
