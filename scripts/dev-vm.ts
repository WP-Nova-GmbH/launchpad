// @effect-diagnostics nodeBuiltinImport:off - Standalone development launcher.
// @effect-diagnostics globalTimers:off - Node child lifecycle and readiness deadlines.
// @effect-diagnostics globalConsole:off - Standalone CLI status and errors.
/* oxlint-disable t3code/no-global-process-runtime -- This CLI owns its environment and child processes. */
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makeCloudflaredRelayClient } from "@t3tools/shared/relayClient";
import { relayPublicDomainForStage } from "../infra/relay/src/deploymentConfig.ts";
import { ensureDevRelayTunnel } from "../infra/relay/scripts/dev-relay-tunnel.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { loadVmRelayEnv, prepareVmRunnerImage } from "./build-vm-image.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

/** Fill the local Lima host blocklist at startup; other hosts retain explicit configuration. */
export async function resolveVmHostAddresses(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  readLimaAddresses = async () =>
    (
      await NodeUtil.promisify(NodeChildProcess.execFile)(
        "limactl",
        ["shell", "--workdir=/", "launchpad-e2b", "hostname", "-I"],
        { timeout: 15_000, maxBuffer: 65_536, encoding: "utf8" },
      )
    ).stdout,
) {
  const explicit = env.E2B_HOST_ADDRESSES?.trim();
  if (explicit && !/[<>]/u.test(explicit)) return env;
  const loopback = (value: string | undefined) => {
    try {
      const url = new URL(value ?? "");
      return (
        ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      );
    } catch {
      return false;
    }
  };
  if (platform !== "darwin" || !loopback(env.E2B_API_URL) || !loopback(env.E2B_SANDBOX_URL))
    return env;

  let output: string;
  try {
    output = await readLimaAddresses();
  } catch {
    throw new Error(
      "Could not detect Lima host IP addresses. Make sure the existing launchpad-e2b Lima host is running, or set E2B_HOST_ADDRESSES explicitly for another compute host.",
    );
  }
  const addresses = [...new Set(output.trim().split(/\s+/u).filter(Boolean))];
  if (!addresses.length || addresses.some((address) => !NodeNet.isIP(address)))
    throw new Error("Lima did not return a valid host IP address list. VM startup was stopped.");
  return { ...env, E2B_HOST_ADDRESSES: addresses.join(",") };
}

/** Derive the public URLs once, rather than asking developers to copy them between env files. */
export function vmDevConfiguration(relayEnv: NodeJS.ProcessEnv, desktopBase: NodeJS.ProcessEnv) {
  const required = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "RELAY_TUNNEL_ZONE_NAME",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "E2B_API_URL",
    "E2B_SANDBOX_URL",
    "E2B_API_KEY",
    "E2B_HOST_ID",
    "E2B_MAX_RUNNING_VMS",
    "E2B_HOST_ADDRESSES",
  ];
  const missing = required.filter((key) => !relayEnv[key]?.trim() || /[<>]/u.test(relayEnv[key]!));
  if (missing.length)
    throw new Error(
      `Complete infra/relay/.env before running dev:vm: ${missing.join(", ")}. See docs/operations/e2b-host-setup.md.`,
    );
  if (!relayEnv.E2B_HOST_ADDRESSES!.split(",").every((address) => NodeNet.isIP(address.trim())))
    throw new Error(
      "E2B_HOST_ADDRESSES must contain the Linux compute host's IP addresses, separated by commas.",
    );

  const namespace = relayEnv.MANAGED_ENDPOINT_NAMESPACE?.trim() || "dev";
  if (namespace === "prod" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(namespace))
    throw new Error(
      "MANAGED_ENDPOINT_NAMESPACE must be a development name such as dev-stefan (lowercase letters, digits and hyphens; not prod).",
    );
  const zoneName = (relayEnv.RELAY_API_ZONE_NAME || relayEnv.RELAY_TUNNEL_ZONE_NAME)!
    .trim()
    .toLowerCase();
  const hostname =
    relayEnv.DEV_RELAY_HOSTNAME?.trim().toLowerCase() ||
    relayPublicDomainForStage(namespace, zoneName);
  const port = Number(relayEnv.DEV_RELAY_PORT || 8610);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("DEV_RELAY_PORT must be a port between 1 and 65535.");
  const relayUrl = `https://${hostname}`;
  const relay: NodeJS.ProcessEnv = {
    ...relayEnv,
    DEV_RELAY_PORT: String(port),
    DEV_RELAY_ISSUER: relayUrl,
    E2B_PUBLIC_RELAY_URL: relayUrl,
    MANAGED_ENDPOINT_NAMESPACE: namespace,
    RELAY_THREAD_VM_PROVISIONING_ENABLED: "true",
    RELAY_TUNNEL_CLEANUP_MODE: "off",
  };
  delete relay.DEV_RELAY_LOCAL_VM_CONNECTIONS;
  delete relay.T3CODE_DISABLE_MANAGED_TUNNELS;

  // Empty values also mask root .env files when the dev runner/Vite reloads
  // them. Deleting keys here would let those files reintroduce credentials.
  const desktop = Object.fromEntries(
    Object.entries(desktopBase).map(([key, value]) => [
      key,
      /^(CLOUDFLARE_|E2B_|DEV_RELAY_|RELAY_THREAD_VM_|RELAY_TUNNEL_|MANAGED_ENDPOINT_NAMESPACE$|CLERK_SECRET_KEY$|TUNNEL_TOKEN$)/u.test(
        key,
      )
        ? ""
        : value,
    ]),
  );
  desktop.T3CODE_DISABLE_MANAGED_TUNNELS = "false";
  desktop.T3CODE_RELAY_URL = relayUrl;
  desktop.VITE_T3CODE_RELAY_URL = relayUrl;
  desktop.T3CODE_CLERK_PUBLISHABLE_KEY = relay.CLERK_PUBLISHABLE_KEY;
  desktop.VITE_CLERK_PUBLISHABLE_KEY = relay.CLERK_PUBLISHABLE_KEY;
  return {
    relay,
    desktop,
    relayUrl,
    tunnel: {
      apiToken: relay.CLOUDFLARE_API_TOKEN!,
      accountId: relay.CLOUDFLARE_ACCOUNT_ID!,
      zoneName,
      hostname,
      port,
      namespace,
    },
  };
}

export interface VmDevProcess {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  readyText?: string;
}

/** Own process groups so shutdown reaches only the children started by this command. */
export async function runVmDevProcesses(plans: VmDevProcess[]) {
  const children: NodeChildProcess.ChildProcess[] = [];
  const closed = new Set<NodeChildProcess.ChildProcess>();
  let stopping = false;
  let fail!: (error: Error) => void;
  const finished = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // An early child failure may arrive before startup reaches the final await.
  void finished.catch(() => {});
  const stop = (signal: NodeJS.Signals) => {
    for (const child of children) {
      if (child.pid === undefined) continue;
      try {
        if (process.platform === "win32")
          NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  const interrupt = () => fail(new Error("Development session stopped."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    for (const plan of plans) {
      await Promise.race([
        finished,
        new Promise<void>((resolve, reject) => {
          const child = NodeChildProcess.spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            env: plan.env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.push(child);
          child.once("close", () => closed.add(child));
          const timer = plan.readyText
            ? setTimeout(
                () => reject(new Error(`${plan.name} did not become ready within 60 seconds.`)),
                60_000,
              )
            : undefined;
          let tail = "";
          const output = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
            stream.write(chunk);
            tail = (tail + chunk.toString()).slice(-4096);
            if (plan.readyText && tail.includes(plan.readyText)) {
              clearTimeout(timer);
              resolve();
            }
          };
          child.stdout!.on("data", output(process.stdout));
          child.stderr!.on("data", output(process.stderr));
          child.once("error", () => {
            clearTimeout(timer);
            const error = new Error(
              `Could not start ${plan.name}. Check that its executable is installed.`,
            );
            reject(error);
            fail(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (!stopping) {
              const error = new Error(`${plan.name} exited (${code ?? "signal"}).`);
              reject(error);
              fail(error);
            }
          });
          if (!plan.readyText) child.once("spawn", resolve);
        }),
      ]);
    }
    await finished;
  } finally {
    stopping = true;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    stop("SIGTERM");
    let forceTimer: ReturnType<typeof setTimeout>;
    const forced = new Promise<void>((resolve, reject) => {
      forceTimer = setTimeout(() => {
        try {
          stop("SIGKILL");
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 5000);
    });
    void forced.catch(() => {});
    await Promise.all(
      children.map((child) =>
        closed.has(child) || !child.pid
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once("close", () => resolve())),
      ),
    );
    // A dev runner can exit before its Electron/Vite descendants. Closing the
    // direct child's stdio is not proof that its owned process group is gone.
    const groupStillRunning =
      process.platform !== "win32" &&
      children.some((child) => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    if (groupStillRunning) await forced;
    clearTimeout(forceTimer!);
  }
}

async function main() {
  const relayDirectory = NodePath.join(repoRoot, "infra/relay");
  const configuration = vmDevConfiguration(
    await resolveVmHostAddresses(loadVmRelayEnv()),
    loadRepoEnv(),
  );
  await prepareVmRunnerImage({ repoRoot, env: configuration.relay });
  // Fail on an incomplete host/image before creating anything in Cloudflare.
  try {
    NodeChildProcess.execFileSync(process.execPath, ["scripts/dev-vm-preflight.ts"], {
      cwd: relayDirectory,
      env: configuration.relay,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      detail ||
        "The VM host or runner image is not configured. See docs/operations/e2b-host-setup.md.",
      { cause: error },
    );
  }
  await new Promise<void>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${configuration.tunnel.port} is already in use. Stop the existing dev relay before running dev:vm.`,
        ),
      ),
    );
    probe.listen(configuration.tunnel.port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const executable = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeCloudflaredRelayClient({ baseDir: NodePath.join(repoRoot, ".t3") });
      const status = yield* client.resolve;
      if (status.status === "available") return status.executablePath;
      yield* Effect.logInfo("[dev:vm] Installing the pinned Cloudflare connector…");
      return (yield* client.install).executablePath;
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
  console.log(`[dev:vm] Preparing dedicated relay tunnel for ${configuration.relayUrl}…`);
  const tunnel = await ensureDevRelayTunnel(configuration.tunnel);
  console.log(
    `[dev:vm] Relay: ${configuration.relayUrl}. Tunnel and DNS are ready and will be reused on the next run.`,
  );
  await runVmDevProcesses([
    {
      name: "Relay",
      command: process.execPath,
      args: ["scripts/dev-server.ts"],
      cwd: relayDirectory,
      env: configuration.relay,
      readyText: `Listening on http://127.0.0.1:${configuration.tunnel.port}`,
    },
    {
      name: "Cloudflare connector",
      command: executable,
      args: ["tunnel", "--no-autoupdate", "run"],
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TUNNEL_TOKEN: tunnel.connectorToken },
      readyText: "Registered tunnel connection",
    },
    {
      name: "Desktop development",
      command: process.execPath,
      args: ["scripts/dev-runner.ts", "dev:desktop"],
      cwd: repoRoot,
      env: configuration.desktop,
    },
  ]);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(`[dev:vm] ${error instanceof Error ? error.message : "Startup failed."}`);
    process.exitCode = 1;
  });
