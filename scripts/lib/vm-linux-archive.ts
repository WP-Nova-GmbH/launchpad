// @effect-diagnostics nodeBuiltinImport:off - Standalone build bootstrap and owned child processes.
/* oxlint-disable t3code/no-global-process-runtime -- This build helper owns its child environment. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

interface ArchiveCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  signal?: AbortSignal | undefined;
}

async function runArchiveCommand(input: ArchiveCommand): Promise<string> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
      stdio: ["ignore", input.capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    let failure: Error | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve(output);
      else reject(new Error(`VM server build command ${input.command} failed (exit ${code}).`));
    });
  });
}

/** Only current checkout source is transferred; never credentials, caches or VM state. */
export async function vmArchiveSourcePaths(repoRoot: string, paths: string[]) {
  const root = await NodeFSP.realpath(repoRoot);
  const files: string[] = [];
  for (const path of new Set(paths)) {
    const parts = path.split("/");
    if (
      parts.some(
        (part) =>
          part === ".." ||
          part.startsWith(".env") ||
          [
            ".git",
            ".repos",
            ".agents",
            ".codex",
            ".t3",
            ".lima",
            ".generated",
            "node_modules",
            "dist",
            "dist-exe",
            "dist-electron",
            "target",
            "release",
            "release-cli",
            "secrets",
            ".npmrc",
            ".yarnrc",
            ".pypirc",
          ].includes(part),
      ) ||
      !path ||
      NodePath.isAbsolute(path) ||
      /\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?|qcow2|img|raw|tar(?:\.gz)?|tsbuildinfo)$/u.test(
        path,
      )
    )
      continue;
    const absolute = NodePath.join(root, path);
    // Deleted tracked files and gitlinks are absent from the source snapshot.
    const stat = await NodeFSP.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat?.isFile() || (await NodeFSP.realpath(absolute)) !== absolute) continue;
    files.push(`./${path}`);
  }
  return files;
}

/** Bookworm matches the runner image's glibc; host tools and Mac modules stay outside it. */
export function linuxVmArchiveBuildScript(vitePlusVersion: string, version: string) {
  if (
    !/^[\d]+\.[\d]+\.[\d]+(?:-[\w.-]+)?$/u.test(vitePlusVersion) ||
    !/^[\d]+\.[\d]+\.[\d]+(?:[-+][\w.-]+)?$/u.test(version)
  )
    throw new Error("Expected exact Vite+ and server versions for the VM build.");
  return [
    'test "$(uname -m)" = aarch64',
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates curl build-essential python3 pkg-config libsecret-1-dev",
    "curl --fail --silent --show-error --location https://sh.rustup.rs -o /tmp/rustup.sh",
    "sh /tmp/rustup.sh -y --profile minimal --no-modify-path",
    'export PATH="/root/.cargo/bin:$PATH"',
    `npm install --global --no-audit --no-fund vite-plus@${vitePlusVersion}`,
    "mkdir /work",
    "tar -xf /transfer/source.tar -C /work",
    "cd /work",
    "vp install --frozen-lockfile --filter=t3... --filter=@t3tools/scripts... --filter=@t3tools/monorepo",
    "vp run --filter t3 build",
    "node apps/server/scripts/cli.ts build-exe --verbose",
    "cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml",
    `node scripts/build-cli-archive.ts --platform linux --arch arm64 --version ${version} --resource-monitor-dir native/resource-monitor/target/release --output-dir /tmp/cli-release`,
    `node scripts/smoke-cli-archive.ts --archive /tmp/cli-release/t3-${version}-linux-arm64.tar.gz --expect-version ${version}`,
    `cp /tmp/cli-release/t3-${version}-linux-arm64.tar.gz /transfer/server.tar.gz`,
  ].join("\n");
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Build in one disposable container on the existing Linux host, then copy only the release back. */
export async function buildLinuxVmArchive(
  input: {
    repoRoot: string;
    outputDirectory: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
  run = runArchiveCommand,
) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Automatic VM image builds require macOS with launchpad-e2b Lima, or Linux.");
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-vm-source-"));
  const id = NodeCrypto.randomUUID();
  const hostDirectory = `/tmp/launchpad-vm-build-${id}`;
  const container = `launchpad-vm-build-${id}`;
  const archive = NodePath.join(input.outputDirectory, `server-linux-arm64-${id}.tar.gz`);
  const env = input.env ?? process.env;
  const host = (command: string, args: string[], cleanup = false) =>
    run({
      command: process.platform === "darwin" ? "limactl" : command,
      args:
        process.platform === "darwin"
          ? ["shell", "--workdir=/", "launchpad-e2b", command, ...args]
          : args,
      env,
      ...(cleanup ? {} : { signal: input.signal }),
    });
  let complete = false;
  let hostCreated = false;
  let containerStarted = false;
  try {
    await host("sh", [
      "-euc",
      'test "$(uname -m)" = aarch64 || { echo "VM image builds require an ARM64 Linux host." >&2; exit 1; }; sudo -n docker info >/dev/null',
    ]);
    const tracked = await run({
      command: "git",
      args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      cwd: input.repoRoot,
      env,
      capture: true,
      signal: input.signal,
    });
    const paths = await vmArchiveSourcePaths(input.repoRoot, tracked.split("\0"));
    const list = NodePath.join(scratch, "files");
    const source = NodePath.join(scratch, "source.tar");
    await NodeFSP.writeFile(list, `${paths.join("\0")}\0`, { mode: 0o600 });
    await run({
      command: "tar",
      args: ["-cf", source, "--no-recursion", "--null", "-T", list],
      cwd: input.repoRoot,
      env: { ...env, COPYFILE_DISABLE: "1" },
      signal: input.signal,
    });
    const packageJson = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.repoRoot, "package.json"), "utf8"),
    );
    const workspace = await NodeFSP.readFile(
      NodePath.join(input.repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const vitePlusVersion =
      packageJson.devDependencies?.["vite-plus"] === "catalog:"
        ? /^  vite-plus: ([\d.]+)$/mu.exec(workspace)?.[1]
        : packageJson.devDependencies?.["vite-plus"];
    const { version } = JSON.parse(
      await NodeFSP.readFile(NodePath.join(input.repoRoot, "apps/server/package.json"), "utf8"),
    );
    const script = linuxVmArchiveBuildScript(vitePlusVersion ?? "", version);
    hostCreated = true;
    await host("sh", ["-euc", `umask 077; mkdir ${quote(hostDirectory)}`]);
    if (process.platform === "darwin")
      await run({
        command: "limactl",
        args: ["copy", source, `launchpad-e2b:${hostDirectory}/source.tar`],
        env,
        signal: input.signal,
      });
    else await NodeFSP.copyFile(source, `${hostDirectory}/source.tar`);
    containerStarted = true;
    await host("sudo", [
      "-n",
      "docker",
      "run",
      "--rm",
      "--name",
      container,
      "--platform",
      "linux/arm64",
      "--cpus",
      "4",
      "--memory",
      "6g",
      "--mount",
      `type=bind,source=${hostDirectory},target=/transfer`,
      "--env",
      "VP_NODE_VERSION=26.8.2",
      "--env",
      "CI=1",
      "--env",
      "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
      "node:26.8.2-bookworm",
      "bash",
      "-euc",
      script,
    ]);
    await NodeFSP.mkdir(input.outputDirectory, { recursive: true });
    if (process.platform === "darwin")
      await run({
        command: "limactl",
        args: ["copy", `launchpad-e2b:${hostDirectory}/server.tar.gz`, archive],
        env,
        signal: input.signal,
      });
    else await NodeFSP.copyFile(`${hostDirectory}/server.tar.gz`, archive);
    input.signal?.throwIfAborted();
    const digest = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(archive)) digest.update(chunk);
    input.signal?.throwIfAborted();
    complete = true;
    return { archive, sha256: digest.digest("hex") };
  } finally {
    // Do not remove a container's bind directory until its exact container is gone.
    let cleanupFailure: Error | undefined;
    try {
      if (containerStarted)
        await host(
          "sh",
          [
            "-euc",
            `ids=$(sudo -n docker ps -aq --filter ${quote(`name=^/${container}$`)}); if [ -n "$ids" ]; then sudo -n docker rm --force ${quote(container)}; fi`,
          ],
          true,
        );
      if (hostCreated) await host("sudo", ["-n", "rm", "-rf", "--", hostDirectory], true);
    } catch (cause) {
      cleanupFailure = new Error(
        `VM build cleanup failed. Check owned container ${container} and scratch ${hostDirectory} on the Linux host before retrying.`,
        { cause },
      );
    }
    await NodeFSP.rm(scratch, { recursive: true, force: true });
    if (!complete || cleanupFailure) await NodeFSP.rm(archive, { force: true });
    // oxlint-disable-next-line eslint/no-unsafe-finally -- A retained build container must prevent publishing the archive.
    if (cleanupFailure) throw cleanupFailure;
  }
}
