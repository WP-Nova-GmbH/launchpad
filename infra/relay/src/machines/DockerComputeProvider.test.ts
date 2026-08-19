import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { containerRelayUrl, layerDocker } from "./DockerComputeProvider.ts";
import { MachineComputeProvider } from "./MachineComputeProvider.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly env?: Record<string, string | undefined> | undefined };
}

const dockerFailure = (message: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "Command",
    method: "spawn",
    pathOrDescriptor: message,
  });

const unusedSpawnerMethod = () => {
  throw new Error("unused spawner method");
};

/**
 * A spawner whose `string` answers from a script keyed by docker subcommand.
 * Only `string` is real; the driver uses nothing else.
 */
function spawnerLayer(input: {
  readonly commands: Array<RecordedCommand>;
  readonly respond: (
    recorded: RecordedCommand,
  ) => Effect.Effect<string, PlatformError.PlatformError>;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.ChildProcessSpawner.of({
      spawn: unusedSpawnerMethod,
      exitCode: unusedSpawnerMethod,
      streamString: unusedSpawnerMethod,
      streamLines: unusedSpawnerMethod,
      lines: unusedSpawnerMethod,
      string: (command) => {
        const recorded = command as unknown as RecordedCommand;
        input.commands.push(recorded);
        return input.respond(recorded);
      },
    }),
  );
}

const settings = { image: "t3code-executor-dev", containerServerPort: 4483 };

const createInput = {
  machineId: "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9",
  organizationId: "organization-1",
  role: "agent_executor" as const,
  label: "Executor 1",
  relayUrl: "http://127.0.0.1:8610",
  seed: "t3mseed_abc123",
};

describe("containerRelayUrl", () => {
  it("rewrites loopback relay origins to the Docker host gateway", () => {
    expect(containerRelayUrl("http://127.0.0.1:8610")).toBe("http://host.docker.internal:8610");
    expect(containerRelayUrl("http://localhost:8610")).toBe("http://host.docker.internal:8610");
  });

  it("leaves reachable origins alone", () => {
    expect(containerRelayUrl("https://relay.example.test")).toBe("https://relay.example.test");
  });
});

describe("DockerComputeProvider", () => {
  it.effect("runs the container with seeded env and returns its id", () => {
    const commands: Array<RecordedCommand> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      const result = yield* provider.create(createInput);
      expect(result.computeKind).toBe("docker");
      expect(result.computeRef).toBe("abc123containerid");

      const run = commands.find((command) => command.args[0] === "run");
      expect(run).toBeDefined();
      // The seed travels through docker's own environment, never as a
      // ps-visible argument value.
      expect(run?.args).toContain("T3CODE_MACHINE_ENROLLMENT_SEED");
      expect(run?.args.join(" ")).not.toContain(createInput.seed);
      expect(run?.options.env?.T3CODE_MACHINE_ENROLLMENT_SEED).toBe(createInput.seed);
      expect(run?.args).toContain(
        "T3CODE_MACHINE_ENROLLMENT_RELAY_URL=http://host.docker.internal:8610",
      );
      expect(run?.args.at(-1)).toBe("t3code-executor-dev");
    }).pipe(
      Effect.provide(
        layerDocker(settings).pipe(
          Layer.provide(
            spawnerLayer({
              commands,
              respond: (recorded) =>
                recorded.args[0] === "run"
                  ? Effect.succeed("abc123containerid\n")
                  : Effect.fail(dockerFailure("No such container")),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("retries a failed run on a fresh port after clearing the name", () => {
    const commands: Array<RecordedCommand> = [];
    let runs = 0;
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      const result = yield* provider.create(createInput);
      expect(result.computeRef).toBe("second-attempt-id");
      const runCommands = commands.filter((command) => command.args[0] === "run");
      expect(runCommands).toHaveLength(2);
      // Every attempt is preceded by clearing the container name.
      expect(commands.filter((command) => command.args[0] === "rm")).toHaveLength(2);
    }).pipe(
      Effect.provide(
        layerDocker(settings).pipe(
          Layer.provide(
            spawnerLayer({
              commands,
              respond: (recorded) => {
                if (recorded.args[0] !== "run") return Effect.succeed("");
                runs += 1;
                return runs === 1
                  ? Effect.fail(dockerFailure("port is already allocated"))
                  : Effect.succeed("second-attempt-id\n");
              },
            }),
          ),
        ),
      ),
    );
  });

  it.effect("treats a vanished container as destroyed and a live one as a real failure", () => {
    const commands: Array<RecordedCommand> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      // rm fails but inspect also fails: the container is gone, destroy is done.
      yield* provider.destroy({ computeKind: "docker", computeRef: "gone-container" });
      expect(commands.map((command) => command.args[0])).toEqual(["rm", "inspect"]);
    }).pipe(
      Effect.provide(
        layerDocker(settings).pipe(
          Layer.provide(
            spawnerLayer({
              commands,
              respond: () => Effect.fail(dockerFailure("No such container")),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("fails destroy when the daemon refuses but the container still exists", () => {
    const commands: Array<RecordedCommand> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      const error = yield* Effect.flip(
        provider.destroy({ computeKind: "docker", computeRef: "stuck-container" }),
      );
      expect(error).toMatchObject({ _tag: "MachineComputeRequestFailed", operation: "destroy" });
    }).pipe(
      Effect.provide(
        layerDocker(settings).pipe(
          Layer.provide(
            spawnerLayer({
              commands,
              respond: (recorded) =>
                recorded.args[0] === "inspect"
                  ? Effect.succeed("[{}]")
                  : Effect.fail(dockerFailure("daemon refused")),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("never destroys compute a different driver created", () => {
    const commands: Array<RecordedCommand> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      yield* provider.destroy({ computeKind: "hetzner", computeRef: "424242" });
      expect(commands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layerDocker(settings).pipe(
          Layer.provide(spawnerLayer({ commands, respond: () => Effect.succeed("") })),
        ),
      ),
    );
  });
});
