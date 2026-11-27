import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import { readWorkflowHead } from "./jobs/WorkflowActions.ts";
import { RepositoryIdentityResolver } from "./project/RepositoryIdentityResolver.ts";
import { makeServerLayer } from "./server.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { withVmWorkloads } from "./vmWorkloadCommand.ts";
import { GitVcsDriver } from "./vcs/GitVcsDriver.ts";

const native = vi.hoisted(() => ({
  spawn: undefined as ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] | undefined,
}));

// This guard survives the defective server replacing its caller's process service.
vi.mock("@effect/platform-node/NodeServices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/platform-node/NodeServices")>();
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Context = await import("effect/Context");
  const { ChildProcessSpawner } = await import("effect/unstable/process");
  const guarded = ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      if (!native.spawn) return Effect.die("Native spawn outside the test scope");
      return native.spawn(command);
    }),
  );
  return {
    ...actual,
    layer: Layer.effectContext(
      Effect.gen(function* () {
        const context = yield* Layer.build(actual.layer);
        return Context.add(context, ChildProcessSpawner.ChildProcessSpawner, guarded);
      }),
    ),
  };
});

// NodeHttpServer.layer also embeds its own NodeServices, behind an external import.
vi.mock("@effect/platform-node/NodeHttpServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/platform-node/NodeHttpServer")>();
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Context = await import("effect/Context");
  const { ChildProcessSpawner } = await import("effect/unstable/process");
  const guarded = ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      if (!native.spawn) return Effect.die("Native spawn outside the test scope");
      return native.spawn(command);
    }),
  );
  return {
    ...actual,
    layer: (...args: Parameters<typeof actual.layer>) =>
      Layer.effectContext(
        Effect.gen(function* () {
          const context = yield* Layer.build(actual.layer(...args));
          return Context.add(context, ChildProcessSpawner.ChildProcessSpawner, guarded);
        }),
      ),
  };
});

vi.mock("./os-jank.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./os-jank.ts")>()),
  fixPath: () => Effect.void,
}));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

for (const mode of ["ordinary", "personal", "workflow"] as const) {
  it.effect(`retains ${mode} command routing through production server assembly`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "server-platform-" });
      const repository = root + "/project";
      const branch = "t3-job/platform-assembly";
      const head = "a".repeat(40);
      yield* fs.makeDirectory(repository);
      const config = {
        ...(yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(repository, root + "/state")),
        )),
        host: "127.0.0.1",
        noBrowser: true,
      };
      yield* fs.writeFileString(
        config.settingsPath,
        encodeJson({
          ...DEFAULT_SERVER_SETTINGS,
          providers: Object.fromEntries(
            Object.entries(DEFAULT_SERVER_SETTINGS.providers).map(([key, value]) => [
              key,
              { ...value, enabled: false },
            ]),
          ),
        }),
      );
      const commands: ChildProcess.StandardCommand[] = [];
      native.spawn = (command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
          commands.push(command);
          const args = command.args;
          const stdout = args.includes("--show-toplevel")
            ? repository + "\n"
            : args.includes("-v") && args.includes("remote")
              ? "origin\thttps://github.com/acme/project.git (fetch)\n"
              : args.includes("symbolic-ref") && args.at(-1) === "HEAD"
                ? `refs/heads/${branch}\n`
                : args.includes("HEAD^{commit}")
                  ? head + "\n"
                  : "";
          const code =
            args.includes("symbolic-ref") && args.at(-1) === `refs/heads/${branch}`
              ? 1
              : stdout
                ? 0
                : 127;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        });
      const probe = Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(makeServerLayer, scope);
            yield* Context.get(context, ServerRuntimeStartup).awaitCommandReady;
            const identity = yield* Context.get(context, RepositoryIdentityResolver).resolve(
              repository,
            );
            expect(identity?.canonicalKey).toBe("github.com/acme/project");
            const probes = commands.filter((command) => command.args.includes(repository));
            expect(probes).toHaveLength(2);
            const headStart = commands.length;
            expect(
              yield* readWorkflowHead(Context.get(context, GitVcsDriver), repository, branch),
            ).toBe(head);
            const headProbes = commands
              .slice(headStart)
              .filter((command) => command.args.includes("--no-replace-objects"));
            expect(headProbes).toHaveLength(3);
            expect(
              headProbes.map((command) =>
                command.args.slice(command.args.indexOf("--no-replace-objects") + 1),
              ),
            ).toEqual([
              ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"],
              ["symbolic-ref", "--quiet", "--no-recurse", `refs/heads/${branch}`],
              ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
            ]);
            for (const command of [...probes, ...headProbes]) {
              expect(command.command).toBe(
                mode === "ordinary" ? "git" : "/opt/launchpad/bin/launchpad-workload",
              );
              if (mode !== "ordinary")
                expect(command.args[0]).toBe(mode === "workflow" ? "run-workflow" : "run");
              if (mode === "workflow") {
                expect(command.options.extendEnv).toBe(false);
                expect(command.options.env?.USER).toBe("launchpad-workflow");
              }
            }
          }),
        (scope) =>
          Scope.close(scope, Exit.void).pipe(
            // Full server shutdown interrupts its parked roots after the probe succeeds.
            Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void),
          ),
      );
      yield* (mode === "ordinary" ? probe : withVmWorkloads(probe, mode === "workflow")).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            native.spawn = undefined;
          }),
        ),
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessEnvironment, {}),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_DISABLE_MANAGED_TUNNELS: true,
            T3CODE_TELEMETRY_ENABLED: false,
          }),
        ),
      ),
    ),
  );
}
