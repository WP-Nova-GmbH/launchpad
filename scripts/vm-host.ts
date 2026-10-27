// @effect-diagnostics nodeBuiltinImport:off - Standalone compute-host launcher.
// @effect-diagnostics globalConsole:off - CLI startup progress and errors.
/* oxlint-disable t3code/no-global-process-runtime -- This CLI owns its child environment. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { loadVmRelayEnv } from "./build-vm-image.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const defaultRuntimeDirectory = "/var/lib/launchpad-e2b";

interface HostCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  stage: string;
}

function runHostCommand(command: HostCommand) {
  const result = NodeChildProcess.spawnSync(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    input: command.input,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error && !NodeFS.existsSync(command.cwd))
    throw new Error(
      `No E2B installation exists at ${command.cwd}. Follow docs/operations/e2b-host-setup.md, or set E2B_RUNTIME_DIR to an existing installation.`,
    );
  if (result.error)
    throw new Error(
      `${command.stage} could not run. Check that the selected runtime directory exists, Lima is running on macOS, and Docker, Python 3 and non-interactive sudo are available on the Linux host.`,
    );
  if (result.status !== 0)
    throw new Error(
      `${command.stage} failed (${result.status ?? result.signal}). Check the host output above; no other deployment was selected.`,
    );
}

/** Verify and start one existing Linux deployment, without forwarding relay credentials. */
export function startVmHost(
  input: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
  run = runHostCommand,
) {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux")
    throw new Error("VM host startup requires macOS with Lima, or a native Linux host.");
  const runtimeDirectory = input.env.E2B_RUNTIME_DIR?.trim() || defaultRuntimeDirectory;
  if (!NodePath.posix.isAbsolute(runtimeDirectory) || /[\0\r\n<>]/u.test(runtimeDirectory))
    throw new Error("E2B_RUNTIME_DIR must be an absolute directory on the Linux host.");

  // Compose must read the deployment's own .env, not relay secrets or caller overrides.
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TERM", "LIMA_HOME", "XDG_CONFIG_HOME"]
      .filter((name) => input.env[name] !== undefined)
      .map((name) => [name, input.env[name]]),
  );
  const host = (stage: string, command: string, args: string[], source?: string) =>
    run({
      stage,
      command: platform === "darwin" ? "limactl" : "sudo",
      args:
        platform === "darwin"
          ? [
              "shell",
              "--tty=false",
              `--workdir=${runtimeDirectory}`,
              "launchpad-e2b",
              "sudo",
              "-n",
              command,
              ...args,
            ]
          : ["-n", command, ...args],
      cwd: platform === "darwin" ? repoRoot : runtimeDirectory,
      env,
      ...(source === undefined ? {} : { input: source }),
    });
  const files = ["compose.yaml", "runtime.override.json", "compose.override.yaml"].map((name) =>
    NodePath.posix.join(runtimeDirectory, name),
  );
  const configuration = [
    "--project-directory",
    runtimeDirectory,
    ...files.flatMap((file) => ["--file", file]),
  ];
  host(
    "Runtime verification",
    "python3",
    ["-", "--build-directory", runtimeDirectory, ...configuration, "--require-exclusive-host"],
    NodeFS.readFileSync(NodePath.join(repoRoot, "infra/e2b/verify-runtime.py"), "utf8"),
  );
  host("VM host startup", "docker", [
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
  return runtimeDirectory;
}

if (import.meta.main) {
  try {
    NodeUtil.parseArgs({ options: {} });
    const directory = startVmHost({ env: loadVmRelayEnv() });
    console.log(`[vm-host] E2B services are ready (${directory}). Run vp run dev:vm next.`);
  } catch (error) {
    console.error(`[vm-host] ${error instanceof Error ? error.message : "Host startup failed."}`);
    process.exitCode = 1;
  }
}
