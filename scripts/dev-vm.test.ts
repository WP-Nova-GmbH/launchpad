// @effect-diagnostics nodeBuiltinImport:off - Development launcher tests.
import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveVmHostAddresses, runVmDevProcesses, vmDevConfiguration } from "./dev-vm.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

const configured = {
  CLOUDFLARE_API_TOKEN: "cloudflare-secret",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  RELAY_TUNNEL_ZONE_NAME: "example.com",
  MANAGED_ENDPOINT_NAMESPACE: "dev-stefan",
  CLERK_PUBLISHABLE_KEY: "pk_test_public",
  CLERK_SECRET_KEY: "clerk-secret",
  E2B_API_URL: "http://127.0.0.1:3000",
  E2B_SANDBOX_URL: "http://127.0.0.1:3002",
  E2B_API_KEY: "e2b-secret",
  E2B_HOST_ID: "local-lima",
  E2B_MAX_RUNNING_VMS: "1",
  E2B_HOST_ADDRESSES: "192.0.2.10,::1",
};

describe("Lima host address discovery", () => {
  it.each([undefined, "", " \t ", "<host-ipv4>,<host-ipv6>"])(
    "detects addresses for a local Mac setup with %j configured",
    async (addresses) => {
      const env = { ...configured, E2B_HOST_ADDRESSES: addresses };
      const read = vi.fn(async () => " 192.168.5.15  172.18.0.1\nfd00::1 192.168.5.15 \n");
      const resolved = await resolveVmHostAddresses(env, "darwin", read);
      expect(resolved.E2B_HOST_ADDRESSES).toBe("192.168.5.15,172.18.0.1,fd00::1");
      expect(vmDevConfiguration(resolved, {}).relay.E2B_HOST_ADDRESSES).toBe(
        "192.168.5.15,172.18.0.1,fd00::1",
      );
      expect(env.E2B_HOST_ADDRESSES).toBe(addresses);
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("preserves an explicitly configured host list without contacting Lima", async () => {
    const read = vi.fn<() => Promise<string>>();
    expect(await resolveVmHostAddresses(configured, "darwin", read)).toBe(configured);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "linux" as const },
    { platform: "win32" as const },
    { platform: "darwin" as const, E2B_API_URL: "https://compute.example.test" },
    { platform: "darwin" as const, E2B_SANDBOX_URL: "https://proxy.example.test" },
    { platform: "darwin" as const, E2B_API_URL: "invalid-url" },
  ])("keeps explicit configuration required for other hosts: %j", async ({ platform, ...urls }) => {
    const env = { ...configured, ...urls, E2B_HOST_ADDRESSES: "" };
    const read = vi.fn<() => Promise<string>>();
    const resolved = await resolveVmHostAddresses(env, platform, read);
    expect(() => vmDevConfiguration(resolved, {})).toThrow("E2B_HOST_ADDRESSES");
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts localhost and IPv6 loopback E2B URLs", async () => {
    const env = {
      ...configured,
      E2B_HOST_ADDRESSES: "",
      E2B_API_URL: "http://localhost:3000",
      E2B_SANDBOX_URL: "http://[::1]:3002",
    };
    expect(
      (await resolveVmHostAddresses(env, "darwin", async () => "192.168.5.15")).E2B_HOST_ADDRESSES,
    ).toBe("192.168.5.15");
  });

  it.each(["", "  \n", "192.168.5.15 not-an-ip"])(
    "stops startup rather than using invalid detection output: %j",
    async (output) => {
      await expect(
        resolveVmHostAddresses(
          { ...configured, E2B_HOST_ADDRESSES: "" },
          "darwin",
          async () => output,
        ),
      ).rejects.toThrow("valid host IP address list");
    },
  );

  it("explains a failed lookup without leaking command output", async () => {
    await expect(
      resolveVmHostAddresses({ ...configured, E2B_HOST_ADDRESSES: "" }, "darwin", async () => {
        throw new Error("private command output");
      }),
    ).rejects.toThrow("Make sure the existing launchpad-e2b Lima host is running");
  });
});

describe("VM development configuration", () => {
  it("derives matching URLs without exposing relay secrets to desktop", () => {
    const result = vmDevConfiguration(
      {
        ...configured,
        DEV_RELAY_ISSUER: "<old placeholder>",
        E2B_PUBLIC_RELAY_URL: "<old placeholder>",
        DEV_RELAY_LOCAL_VM_CONNECTIONS: "1",
        T3CODE_DISABLE_MANAGED_TUNNELS: "1",
      },
      {
        ...configured,
        HOME: "/home/developer",
        T3CODE_RELAY_URL: "http://127.0.0.1:8610",
        T3CODE_DISABLE_MANAGED_TUNNELS: "1",
      },
    );
    expect(result.relayUrl).toBe("https://relay-dev-stefan.example.com");
    expect(result.relay.DEV_RELAY_ISSUER).toBe(result.relayUrl);
    expect(result.relay.E2B_PUBLIC_RELAY_URL).toBe(result.relayUrl);
    expect(result.desktop.T3CODE_RELAY_URL).toBe(result.relayUrl);
    expect(result.desktop.VITE_T3CODE_RELAY_URL).toBe(result.relayUrl);
    expect(result.desktop.T3CODE_CLERK_PUBLISHABLE_KEY).toBe(configured.CLERK_PUBLISHABLE_KEY);
    expect(result.desktop.HOME).toBe("/home/developer");
    expect(Object.values(result.desktop)).not.toContain("cloudflare-secret");
    expect(Object.values(result.desktop)).not.toContain("clerk-secret");
    expect(Object.values(result.desktop)).not.toContain("e2b-secret");
    expect(result.relay).not.toHaveProperty("DEV_RELAY_LOCAL_VM_CONNECTIONS");
    expect(result.relay).not.toHaveProperty("T3CODE_DISABLE_MANAGED_TUNNELS");
    expect(result.desktop.T3CODE_DISABLE_MANAGED_TUNNELS).toBe("false");
  });

  it("accepts a separate API zone and an explicit relay hostname", () => {
    const result = vmDevConfiguration(
      {
        ...configured,
        RELAY_API_ZONE_NAME: "other.example",
        DEV_RELAY_HOSTNAME: "relay-dev.other.example",
        DEV_RELAY_PORT: "18610",
      },
      {},
    );
    expect(result.tunnel).toMatchObject({
      hostname: "relay-dev.other.example",
      zoneName: "other.example",
      port: 18610,
    });
    expect(result.relay.DEV_RELAY_PORT).toBe("18610");
    expect(result.relay.RELAY_TUNNEL_ZONE_NAME).toBe("example.com");
  });

  it("reports missing settings by name without echoing credentials", () => {
    expect(() => vmDevConfiguration({ CLOUDFLARE_API_TOKEN: "secret" }, {})).toThrow(
      "CLOUDFLARE_ACCOUNT_ID",
    );
    expect(() =>
      vmDevConfiguration({ ...configured, E2B_HOST_ADDRESSES: "<host addresses>" }, {}),
    ).toThrow("E2B_HOST_ADDRESSES");
    expect(() =>
      vmDevConfiguration({ ...configured, E2B_HOST_ADDRESSES: "not-an-address" }, {}),
    ).toThrow("Linux compute host");
  });

  it.each(["prod", "", "Dev Stefan"])(
    "does not use a production or invalid namespace: %s",
    (namespace) => {
      if (!namespace)
        expect(
          vmDevConfiguration({ ...configured, MANAGED_ENDPOINT_NAMESPACE: namespace }, {}).tunnel
            .namespace,
        ).toBe("dev");
      else
        expect(() =>
          vmDevConfiguration({ ...configured, MANAGED_ENDPOINT_NAMESPACE: namespace }, {}),
        ).toThrow("development name");
    },
  );
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("keeps root dotenv reloads from restoring relay credentials or the tunnel-disable flag", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launchpad-vm-env-"));
  temporaryDirectories.push(directory);
  NodeFS.writeFileSync(
    NodePath.join(directory, ".env"),
    "CLOUDFLARE_API_TOKEN=root-secret\nE2B_API_KEY=host-secret\nT3CODE_DISABLE_MANAGED_TUNNELS=1\n",
  );
  const original = loadRepoEnv({ baseEnv: {}, repoRoot: directory });
  const result = vmDevConfiguration(configured, original);
  const reloaded = loadRepoEnv({ baseEnv: result.desktop, repoRoot: directory });
  expect(reloaded.CLOUDFLARE_API_TOKEN).toBe("");
  expect(reloaded.E2B_API_KEY).toBe("");
  expect(reloaded.T3CODE_DISABLE_MANAGED_TUNNELS).toBe("false");
  expect(reloaded.T3CODE_RELAY_URL).toBe(result.relayUrl);
});

describe("VM development child shutdown", () => {
  it("stops the child it started when a later child fails", async () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "launchpad-dev-processes-"),
    );
    temporaryDirectories.push(directory);
    const stopped = NodePath.join(directory, "stopped");
    const childCode = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.argv[1],'stopped');process.exit(0)});process.stdout.write('fixture-ready');setInterval(()=>{},1000);`;
    await expect(
      runVmDevProcesses([
        {
          name: "Owned fixture",
          command: process.execPath,
          args: ["-e", childCode, stopped],
          cwd: directory,
          env: {},
          readyText: "fixture-ready",
        },
        {
          name: "Failing fixture",
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
          cwd: directory,
          env: {},
        },
      ]),
    ).rejects.toThrow("Failing fixture exited (7)");
    expect(NodeFS.readFileSync(stopped, "utf8")).toBe("stopped");
  });

  it("force-stops owned descendants after their direct parent has already exited", async () => {
    if (HostProcessPlatform.defaultValue() === "win32") return;
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "launchpad-dev-descendants-"),
    );
    temporaryDirectories.push(directory);
    const pidFile = NodePath.join(directory, "descendant-pid");
    const socketPath = NodePath.join(directory, "exit.sock");
    let descendant: NodeNet.Socket | undefined;
    const server = NodeNet.createServer((socket) => {
      descendant = socket;
    });
    server.listen(socketPath);
    await NodeEvents.EventEmitter.once(server, "listening");
    const descendantCode = `process.on('SIGTERM',()=>{});const socket=require('node:net').connect(process.argv[1],()=>process.send('ready'));`;
    const parentCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)},process.argv[2]],{stdio:['ignore','ignore','ignore','ipc']});require('node:fs').writeFileSync(process.argv[1],String(child.pid));child.once('message',()=>process.stdout.write('fixture-ready'));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    try {
      await expect(
        runVmDevProcesses([
          {
            name: "Owned parent fixture",
            command: process.execPath,
            args: ["-e", parentCode, pidFile, socketPath],
            cwd: directory,
            env: {},
            readyText: "fixture-ready",
          },
          {
            name: "Failing fixture",
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
            cwd: directory,
            env: {},
          },
        ]),
      ).rejects.toThrow("Failing fixture exited (7)");
      expect(descendant).toBeDefined();
      if (!descendant!.destroyed)
        await NodeEvents.EventEmitter.once(descendant!, "close", {
          signal: AbortSignal.timeout(1000),
        });
    } finally {
      if (NodeFS.existsSync(pidFile)) {
        const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* The owned descendant may already have exited. */
        }
      }
      descendant?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
