import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  MachineComputeProvider,
  MachineComputeRequestFailed,
  type MachineComputeCreateInput,
} from "./MachineComputeProvider.ts";

const HETZNER_API_BASE_URL = "https://api.hetzner.cloud/v1";

export interface HetznerComputeSettings {
  readonly apiToken: Redacted.Redacted<string>;
  /** Hetzner server type slug, e.g. `cx22`. */
  readonly serverType: string;
  /** OS image slug the bootstrap script targets, e.g. `ubuntu-24.04`. */
  readonly image: string;
  /** Datacenter location slug, e.g. `fsn1`. */
  readonly location: string;
  /** Names or ids of SSH keys to install, for operator access to the VM. */
  readonly sshKeys: ReadonlyArray<string>;
  /** Where the cloud-init `runcmd` fetches the bootstrap script from. */
  readonly bootstrapUrl: string;
  /** The repository the bootstrap clones and runs the server from. */
  readonly sourceGitUrl: string;
}

const HetznerCreateServerResponse = Schema.Struct({
  server: Schema.Struct({
    id: Schema.Number,
  }),
});
const decodeCreateServerResponse = HttpClientResponse.schemaBodyJson(HetznerCreateServerResponse);

const MACHINE_ENROLLMENT_ENV_FILE = "/etc/t3code/machine-enrollment.env";

/**
 * Values land on their own lines inside a cloud-init block scalar and an env
 * file, so anything that could break out of a line is refused outright rather
 * than escaped — every legitimate value here is a token, a URL, or a slug.
 */
function assertSingleLine(name: string, value: string): void {
  if (/[\r\n]/u.test(value) || value.includes("'")) {
    throw new Error(`machine compute input '${name}' contains characters that cannot be embedded`);
  }
}

export function renderHetznerCloudInit(input: {
  readonly seed: string;
  readonly relayUrl: string;
  readonly bootstrapUrl: string;
  readonly sourceGitUrl: string;
}): string {
  assertSingleLine("seed", input.seed);
  assertSingleLine("relayUrl", input.relayUrl);
  assertSingleLine("bootstrapUrl", input.bootstrapUrl);
  assertSingleLine("sourceGitUrl", input.sourceGitUrl);
  return [
    "#cloud-config",
    "write_files:",
    `  - path: ${MACHINE_ENROLLMENT_ENV_FILE}`,
    '    permissions: "0600"',
    "    content: |",
    `      T3CODE_MACHINE_ENROLLMENT_SEED=${input.seed}`,
    `      T3CODE_MACHINE_ENROLLMENT_RELAY_URL=${input.relayUrl}`,
    `      T3CODE_MACHINE_ENROLLMENT_ENV_FILE=${MACHINE_ENROLLMENT_ENV_FILE}`,
    `      T3CODE_MACHINE_SOURCE_GIT_URL=${input.sourceGitUrl}`,
    "runcmd:",
    `  - [bash, -c, "curl -fsSL '${input.bootstrapUrl}' | bash 2>&1 | tee /var/log/t3code-bootstrap.log"]`,
    "",
  ].join("\n");
}

export function hetznerServerName(machineId: string): string {
  // RFC 1123 hostname: lowercase the UUID and drop anything else.
  return `t3-machine-${machineId.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "")}`.slice(0, 63);
}

export const makeHetzner = (settings: HetznerComputeSettings) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const authorized = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClientRequest.bearerToken(request, Redacted.value(settings.apiToken));

    return MachineComputeProvider.of({
      kind: "hetzner",
      create: Effect.fn("relay.machine_compute.hetzner.create")(function* (
        input: MachineComputeCreateInput,
      ) {
        yield* Effect.annotateCurrentSpan({
          "relay.machine_id": input.machineId,
          "relay.machine_compute.kind": "hetzner",
        });
        const userData = yield* Effect.try({
          try: () =>
            renderHetznerCloudInit({
              seed: input.seed,
              relayUrl: input.relayUrl,
              bootstrapUrl: settings.bootstrapUrl,
              sourceGitUrl: settings.sourceGitUrl,
            }),
          catch: (cause) =>
            new MachineComputeRequestFailed({
              operation: "create",
              computeKind: "hetzner",
              machineId: input.machineId,
              cause,
            }),
        });
        const response = yield* HttpClientRequest.post(`${HETZNER_API_BASE_URL}/servers`).pipe(
          authorized,
          HttpClientRequest.bodyJson({
            name: hetznerServerName(input.machineId),
            server_type: settings.serverType,
            image: settings.image,
            location: settings.location,
            start_after_create: true,
            ...(settings.sshKeys.length > 0 ? { ssh_keys: settings.sshKeys } : {}),
            labels: {
              "t3-machine-id": input.machineId,
              "t3-organization-id": input.organizationId,
              "t3-role": input.role,
            },
            user_data: userData,
          }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeCreateServerResponse),
          Effect.mapError(
            (cause) =>
              new MachineComputeRequestFailed({
                operation: "create",
                computeKind: "hetzner",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
        return { computeKind: "hetzner" as const, computeRef: String(response.server.id) };
      }),

      destroy: Effect.fn("relay.machine_compute.hetzner.destroy")(function* (input) {
        if (input.computeKind !== "hetzner") {
          // A record another driver created: destroying an unrelated resource
          // that happens to share an id would be far worse than leaving an
          // orphan for the operator.
          yield* Effect.logWarning("Skipping compute destroy for a foreign compute kind", {
            computeKind: input.computeKind,
            computeRef: input.computeRef,
          });
          return;
        }
        const response = yield* HttpClientRequest.delete(
          `${HETZNER_API_BASE_URL}/servers/${encodeURIComponent(input.computeRef)}`,
        ).pipe(
          authorized,
          httpClient.execute,
          Effect.mapError(
            (cause) =>
              new MachineComputeRequestFailed({
                operation: "destroy",
                computeKind: "hetzner",
                computeRef: input.computeRef,
                cause,
              }),
          ),
        );
        // Already gone is the outcome destroy wanted.
        if (response.status >= 400 && response.status !== 404) {
          return yield* new MachineComputeRequestFailed({
            operation: "destroy",
            computeKind: "hetzner",
            computeRef: input.computeRef,
            cause: `Hetzner answered ${response.status}`,
          });
        }
      }),
    });
  });

export const layerHetzner = (settings: HetznerComputeSettings) =>
  Layer.effect(MachineComputeProvider, makeHetzner(settings));
