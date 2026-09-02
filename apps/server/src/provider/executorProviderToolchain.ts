/**
 * Installing the provider CLIs an executor is missing.
 *
 * An organization's executors are meant to work without anyone touching the
 * machine, and a fresh self-hosted machine has Node and git and nothing
 * else. On startup an enrolled agent executor checks which provider CLIs
 * resolve, installs the npm-published ones the way the provider update
 * action would, and fetches Cursor's agent through Cursor's own installer.
 * Personal machines are never touched: what is installed there is the
 * person's business.
 *
 * @module provider/executorProviderToolchain
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readManagedExecutorRelayConfig } from "../cloud/machineEnrollment.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./Services/ProviderRegistry.ts";

/** Providers whose CLI ships on npm; the maintenance runner's update action installs them. */
export const NPM_INSTALLED_PROVIDERS: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("opencode"),
];

export const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";

export interface ExecutorToolchainReport {
  readonly installed: ReadonlyArray<ProviderDriverKind>;
  readonly failed: ReadonlyArray<ProviderDriverKind>;
}

const NOTHING: ExecutorToolchainReport = { installed: [], failed: [] };

/** The providers whose CLI is not on this machine, among those Launchpad can install. */
export function missingInstallableProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderDriverKind> {
  const installable = new Set<ProviderDriverKind>([...NPM_INSTALLED_PROVIDERS, CURSOR_PROVIDER]);
  const missing = new Set<ProviderDriverKind>();
  for (const provider of providers) {
    if (!provider.installed && installable.has(provider.driver)) {
      missing.add(provider.driver);
    }
  }
  return [...missing];
}

/**
 * A PATH that also covers the given directories, each prepended once. Installs
 * land where a service unit's PATH does not look — `~/.local/bin` for Cursor's
 * installer, npm's global prefix for the npm packages — so this process and
 * everything it spawns must be told.
 */
export function withBinDirectories(
  environment: NodeJS.ProcessEnv,
  directories: ReadonlyArray<string>,
): string {
  const current = environment.PATH ?? "";
  const present = new Set(current.split(NodePath.delimiter));
  const missing = directories.filter((directory) => !present.has(directory));
  return missing.length === 0
    ? current
    : [...missing, current].filter((entry) => entry.length > 0).join(NodePath.delimiter);
}

/** Where `npm install --global` puts executables: `<npm prefix -g>/bin`, or null when npm cannot say. */
const npmGlobalBinDirectory = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  path: Path.Path,
): Effect.Effect<string | null> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make("npm", ["prefix", "-g"]));
      const [stdout, exitCode] = yield* Effect.all([
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ]);
      const prefix = stdout.trim();
      return Number(exitCode) === 0 && prefix.length > 0 ? path.join(prefix, "bin") : null;
    }),
  ).pipe(Effect.orElseSucceed(() => null));

const installCursorAgent = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("bash", ["-c", `curl -fsS ${CURSOR_INSTALL_SCRIPT_URL} | bash`]),
      );
      const [stderr, exitCode] = yield* Effect.all([
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ]);
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(
          new Error(`Cursor's installer exited with code ${exitCode}: ${stderr.trim()}`),
        );
      }
    }),
  ).pipe(Effect.withSpan("installCursorAgent"));

/**
 * Bring the executor's provider CLIs up. Idempotent and never failing: a
 * provider that cannot be installed is logged and left for the provider
 * settings page to explain, exactly as on any other machine.
 */
export const ensureExecutorProviderToolchain = Effect.fn("ensureExecutorProviderToolchain")(
  function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    if ((yield* readManagedExecutorRelayConfig(secrets)) === null) {
      return NOTHING;
    }
    const path = yield* Path.Path;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const npmBin = yield* npmGlobalBinDirectory(spawner, path);
    process.env.PATH = withBinDirectories(process.env, [
      path.join(NodeOS.homedir(), ".local", "bin"),
      ...(npmBin === null ? [] : [npmBin]),
    ]);
    const missing = missingInstallableProviders(yield* registry.refresh());
    if (missing.length === 0) {
      return NOTHING;
    }
    yield* Effect.logInfo("executor provider toolchain incomplete; installing", {
      providers: missing,
    });

    const installed: Array<ProviderDriverKind> = [];
    const failed: Array<ProviderDriverKind> = [];
    for (const provider of missing) {
      const install: Effect.Effect<void, unknown> =
        provider === CURSOR_PROVIDER
          ? installCursorAgent(spawner).pipe(
              Effect.andThen(registry.refresh(provider)),
              Effect.asVoid,
            )
          : runner.updateProvider(provider).pipe(Effect.asVoid);
      const outcome = yield* install.pipe(
        Effect.as("installed" as const),
        Effect.catchCause((cause) =>
          Effect.logWarning("executor provider install failed", {
            provider,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as("failed" as const)),
        ),
      );
      if (outcome === "installed") {
        installed.push(provider);
        yield* Effect.logInfo("executor provider installed", { provider });
      } else {
        failed.push(provider);
      }
    }
    return { installed, failed } satisfies ExecutorToolchainReport;
  },
);
