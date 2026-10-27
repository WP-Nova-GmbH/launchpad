// @effect-diagnostics nodeBuiltinImport:off - Isolated host-launcher tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { startVmHost } from "./vm-host.ts";

type RunHost = NonNullable<Parameters<typeof startVmHost>[1]>;

describe("VM host startup", () => {
  it("uses the default directory inside existing Lima without forwarding relay or Compose configuration", () => {
    const run = vi.fn<RunHost>();
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/developer",
      LIMA_HOME: "/some/lima",
      CLERK_SECRET_KEY: "relay-secret",
      E2B_API_KEY: "team-secret",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret",
      COMPOSE_PROJECT_NAME: "another-project",
      COMPOSE_FILE: "other.yaml",
      DOCKER_HOST: "tcp://other-host:2375",
      DOCKER_CONTEXT: "other-context",
    };
    expect(startVmHost({ env, platform: "darwin" }, run)).toBe("/var/lib/launchpad-e2b");
    expect(run).toHaveBeenCalledTimes(2);
    for (const [command] of run.mock.calls) {
      expect(command.command).toBe("limactl");
      expect(command.args.slice(0, 6)).toEqual([
        "shell",
        "--tty=false",
        "--workdir=/var/lib/launchpad-e2b",
        "launchpad-e2b",
        "sudo",
        "-n",
      ]);
      expect(command.env).toEqual({
        PATH: env.PATH,
        HOME: env.HOME,
        LIMA_HOME: env.LIMA_HOME,
      });
    }
    expect(env.COMPOSE_PROJECT_NAME).toBe("another-project");
    expect(run.mock.calls[0]?.[0].input).toContain("def verify_configuration(");
  });

  it("verifies and starts the same Linux deployment, keeping spaces and shell characters literal", () => {
    const run = vi.fn<RunHost>();
    const directory = "/var/lib/E2B developer's runtime $(echo literal)";
    startVmHost({ env: { E2B_RUNTIME_DIR: directory }, platform: "linux" }, run);
    const verify = run.mock.calls[0]![0];
    const start = run.mock.calls[1]![0];
    const configuration = [
      "--project-directory",
      directory,
      "--file",
      `${directory}/compose.yaml`,
      "--file",
      `${directory}/runtime.override.json`,
      "--file",
      `${directory}/compose.override.yaml`,
    ];
    expect(verify.command).toBe("sudo");
    expect(verify.cwd).toBe(directory);
    expect(verify.args).toEqual([
      "-n",
      "python3",
      "-",
      "--build-directory",
      directory,
      ...configuration,
      "--require-exclusive-host",
    ]);
    expect(start.command).toBe("sudo");
    expect(start.cwd).toBe(directory);
    expect(start.env).toEqual(verify.env);
    expect(start.args).toEqual([
      "-n",
      "docker",
      "compose",
      ...configuration,
      "up",
      "--no-build",
      "-d",
      "--wait",
      "api",
      "client-proxy",
      "launchpad-keepalive",
    ]);
    expect(start.input).toBeUndefined();
  });

  it("never starts services after failed runtime verification", () => {
    const run = vi.fn<RunHost>(() => {
      throw new Error("Runtime verification failed");
    });
    expect(() => startVmHost({ env: {}, platform: "linux" }, run)).toThrow(
      "Runtime verification failed",
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", "  "])("uses the default for an unset or blank override: %j", (value) => {
    const run = vi.fn<RunHost>();
    expect(startVmHost({ env: { E2B_RUNTIME_DIR: value }, platform: "linux" }, run)).toBe(
      "/var/lib/launchpad-e2b",
    );
  });

  it.each(["relative/path", "~/e2b", "/var/lib/<installation>", "/var/lib/e2b\nother"])(
    "refuses invalid directories before contacting the host: %j",
    (directory) => {
      const run = vi.fn<RunHost>();
      expect(() =>
        startVmHost({ env: { E2B_RUNTIME_DIR: directory }, platform: "darwin" }, run),
      ).toThrow("absolute directory on the Linux host");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported hosts without spawning anything", () => {
    const run = vi.fn<RunHost>();
    expect(() => startVmHost({ env: {}, platform: "win32" }, run)).toThrow(
      "macOS with Lima, or a native Linux host",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("explains a missing Linux installation without creating it", () => {
    const directory = NodePath.join(
      NodeOS.tmpdir(),
      `launchpad-missing-${NodeCrypto.randomUUID()}`,
    );
    expect(() => startVmHost({ env: { E2B_RUNTIME_DIR: directory }, platform: "linux" })).toThrow(
      "Follow docs/operations/e2b-host-setup.md, or set E2B_RUNTIME_DIR",
    );
    expect(NodeFS.existsSync(directory)).toBe(false);
  });

  it("launches the registered package command and reports invalid configuration before any host command", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "..");
    const manifest: { scripts: Record<string, string> } = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, "package.json"), "utf8"),
    );
    const command = manifest.scripts["start:vm-host"];
    expect(command).toBeDefined();
    const [executable, ...args] = command!.split(/\s+/u);
    expect(executable).toBe("node");
    const result = NodeChildProcess.spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, E2B_RUNTIME_DIR: "relative", E2B_API_KEY: "never-print-this-key" },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("E2B_RUNTIME_DIR must be an absolute directory");
    expect(result.stderr).not.toContain("never-print-this-key");
    expect(result.stdout).toBe("");
  });
});
