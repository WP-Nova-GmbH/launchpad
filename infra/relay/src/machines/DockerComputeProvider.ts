import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  MachineComputeProvider,
  MachineComputeRequestFailed,
  type MachineComputeCreateInput,
} from "./MachineComputeProvider.ts";

/**
 * Dev-mode machines are Docker containers on the developer's own host, run by
 * the local dev relay. Node-only — never import this from the Worker; the
 * production relay binds the Hetzner driver instead.
 */
export interface DockerComputeSettings {
  /** The executor image, built from `infra/executor-image/Dockerfile`. */
  readonly image: string;
  /** The port the server binds inside the container. */
  readonly containerServerPort: number;
}

export const DEFAULT_DEV_MACHINE_DOCKER_IMAGE = "t3code-executor-dev";
export const DEFAULT_DEV_MACHINE_SERVER_PORT = 4483;

export class DockerCommandFailed extends Schema.TaggedErrorClass<DockerCommandFailed>()(
  "DockerCommandFailed",
  {
    subcommand: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `docker ${this.subcommand} failed`;
  }
}

/**
 * The relay on the host is loopback, which inside a container is the
 * container itself. `host.docker.internal` resolves to the host on macOS and
 * Windows out of the box and via `--add-host=host-gateway` on Linux.
 */
export function containerRelayUrl(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    if (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    ) {
      url.hostname = "host.docker.internal";
      return url.origin;
    }
    return relayUrl;
  } catch {
    return relayUrl;
  }
}

export const makeDocker = (settings: DockerComputeSettings) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const docker = (subcommand: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make("docker", [subcommand, ...args]))
        .pipe(Effect.mapError((cause) => new DockerCommandFailed({ subcommand, cause })));

    return MachineComputeProvider.of({
      kind: "docker",
      create: Effect.fn("relay.machine_compute.docker.create")(function* (
        input: MachineComputeCreateInput,
      ) {
        yield* Effect.annotateCurrentSpan({
          "relay.machine_id": input.machineId,
          "relay.machine_compute.kind": "docker",
        });
        const containerName = `t3-machine-${input.machineId.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "")}`;
        const relayUrl = containerRelayUrl(input.relayUrl);
        // The host port is what other host-local parties (the dev relay, the
        // browser) reach the machine on; the container learns it so its
        // enrollment can advertise a reachable endpoint. Ports are picked
        // blindly, so a collision retries with a fresh one — and a failed run
        // can leave a created container squatting on the name, so every
        // attempt clears it first.
        const attemptRun = Effect.gen(function* () {
          const hostPort = yield* Random.nextIntBetween(20_000, 30_000);
          yield* docker("rm", ["--force", containerName]).pipe(Effect.ignore);
          return yield* docker("run", [
            "--detach",
            "--name",
            containerName,
            "--add-host",
            "host.docker.internal:host-gateway",
            "--publish",
            `127.0.0.1:${hostPort}:${settings.containerServerPort}`,
            "--env",
            `T3CODE_MACHINE_ENROLLMENT_SEED=${input.seed}`,
            "--env",
            `T3CODE_MACHINE_ENROLLMENT_RELAY_URL=${relayUrl}`,
            "--env",
            `T3CODE_MACHINE_ADVERTISED_ORIGIN=http://127.0.0.1:${hostPort}`,
            "--env",
            `T3CODE_MACHINE_ID=${input.machineId}`,
            "--env",
            `T3CODE_MACHINE_ROLE=${input.role}`,
            settings.image,
          ]);
        });
        const stdout = yield* attemptRun.pipe(
          Effect.retry({ times: 2 }),
          Effect.mapError(
            (cause) =>
              new MachineComputeRequestFailed({
                operation: "create",
                computeKind: "docker",
                machineId: input.machineId,
                cause,
              }),
          ),
        );
        const containerId = stdout.trim().split("\n").at(-1)?.trim() ?? "";
        if (containerId.length === 0) {
          return yield* new MachineComputeRequestFailed({
            operation: "create",
            computeKind: "docker",
            machineId: input.machineId,
            cause: "docker run returned no container id",
          });
        }
        return { computeKind: "docker" as const, computeRef: containerId };
      }),

      destroy: Effect.fn("relay.machine_compute.docker.destroy")(function* (input) {
        if (input.computeKind !== "docker") {
          yield* Effect.logWarning("Skipping compute destroy for a foreign compute kind", {
            computeKind: input.computeKind,
            computeRef: input.computeRef,
          });
          return;
        }
        yield* docker("rm", ["--force", input.computeRef]).pipe(
          // `rm --force` fails on a container that no longer exists, which is
          // the outcome destroy wanted; inspect distinguishes that from a
          // daemon that actually refused.
          Effect.catchTag("DockerCommandFailed", (error) =>
            docker("inspect", [input.computeRef]).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.fail(error),
                onFailure: () => Effect.void,
              }),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new MachineComputeRequestFailed({
                operation: "destroy",
                computeKind: "docker",
                computeRef: input.computeRef,
                cause,
              }),
          ),
        );
      }),
    });
  });

export const layerDocker = (settings: DockerComputeSettings) =>
  Layer.effect(MachineComputeProvider, makeDocker(settings));
