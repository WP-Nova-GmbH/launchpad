// @effect-diagnostics nodeBuiltinImport:off - Local Lima build memory preparation.
// @effect-diagnostics globalConsole:off - CLI host memory preparation progress.
/* oxlint-disable t3code/no-global-process-runtime -- Standalone build commands own their environment. */
import * as NodeChildProcess from "node:child_process";

interface MemoryCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}

async function runMemoryCommand(input: MemoryCommand): Promise<string> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, input.args, {
      env: input.env,
      signal: input.signal,
      // Do not abandon a kernel allocation midway, then race it with restoration.
      timeout: input.args.includes("sysctl") ? undefined : 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    // Never include child output in failures: the inherited environment can contain credentials.
    child.stderr.resume();
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve(output);
      else reject(new Error(`Lima VM build memory command failed (exit ${code}).`));
    });
  });
}

const buildMemoryKiB = 12 * 1024 * 1024;
const hostHeadroomKiB = 3 * 1024 * 1024;
const lock = "/tmp/launchpad-vm-build-memory.lock";

function memoryState(output: string) {
  const field = (name: string) => {
    const value = Number(new RegExp(`^${name}:\\s+(\\d+)(?:\\s+kB)?$`, "mu").exec(output)?.[1]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Cannot read ${name} from the Lima host memory information.`);
    return value;
  };
  const state = {
    available: field("MemAvailable"),
    total: field("HugePages_Total"),
    free: field("HugePages_Free"),
    reserved: field("HugePages_Rsvd"),
    size: field("Hugepagesize"),
    requested: field("RequestedHugePages"),
  };
  if (!state.size || state.free > state.total || state.reserved > state.free)
    throw new Error("The Lima host returned inconsistent hugepage memory information.");
  return state;
}

function localLima(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "darwin") return false;
  try {
    return [env.E2B_API_URL, env.E2B_SANDBOX_URL].every((value) => {
      const url = new URL(value ?? "");
      return (
        ["http:", "https:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      );
    });
  } catch {
    return false;
  }
}

/** E2B image builds overlap guest restores and snapshot exports; restore the host pool afterward. */
export async function withVmBuildMemory<T>(
  input: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; signal?: AbortSignal },
  build: () => Promise<T>,
  run = runMemoryCommand,
): Promise<T> {
  if (!localLima(input.env, input.platform ?? process.platform)) return build();
  input.signal?.throwIfAborted();
  const host = (command: string, args: string[], cleanup = false) =>
    run({
      command: "limactl",
      args: ["shell", "--workdir=/", "launchpad-e2b", command, ...args],
      env: input.env,
      ...(cleanup ? {} : { signal: input.signal }),
    });
  const read = (cleanup = false) =>
    host(
      "sh",
      ["-euc", 'cat /proc/meminfo; printf "RequestedHugePages: "; cat /proc/sys/vm/nr_hugepages'],
      cleanup,
    ).then(memoryState);

  try {
    // Complete this short command even on cancellation so lock ownership is unambiguous.
    await host("mkdir", ["--", lock], true);
  } catch (cause) {
    throw new Error(
      `Cannot acquire the Lima VM image-build lock (${lock}). Check that launchpad-e2b is running and another image build is not active; remove a stale lock only after that build has stopped.`,
      { cause },
    );
  }

  let original: ReturnType<typeof memoryState> | undefined;
  let changed = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    input.signal?.throwIfAborted();
    original = await read();
    input.signal?.throwIfAborted();
    const needed = Math.ceil(buildMemoryKiB / original.size);
    const additional = Math.max(0, needed - (original.free - original.reserved));
    if (original.available < additional * original.size + hostHeadroomKiB)
      throw new Error(
        "The Lima host needs 12 GiB of available hugepages for an image build, plus 3 GiB of normal RAM. Increase launchpad-e2b memory or stop unused guest workloads before retrying.",
      );
    if (additional) {
      const requested = Math.max(original.requested, original.total + additional);
      console.log(`[dev:vm] Temporarily reserving ${requested} hugepages for the VM image build.`);
      changed = true;
      await host("sudo", ["-n", "sysctl", "-w", `vm.nr_hugepages=${requested}`], true);
      const allocated = await read();
      if (allocated.free - allocated.reserved < needed || allocated.available < hostHeadroomKiB)
        throw new Error(
          "The Lima host could not reserve enough hugepage memory for the image build. No build was started; increase host memory or stop unused guest workloads before retrying.",
        );
    }
    input.signal?.throwIfAborted();
    outcome = { ok: true, value: await build() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const cleanupErrors: unknown[] = [];
  if (changed && original) {
    try {
      await host("sudo", ["-n", "sysctl", "-w", `vm.nr_hugepages=${original.requested}`], true);
      const restored = await read(true);
      if (restored.requested !== original.requested || restored.total > original.total)
        throw new Error("The host still holds more hugepage memory than before this build.");
      console.log(`[dev:vm] Restored the Lima hugepage pool to ${original.requested} pages.`);
    } catch (cause) {
      cleanupErrors.push(
        new Error(
          `Could not restore the Lima hugepage pool to ${original.requested} pages. The build lock remains at ${lock}; verify the E2B build has stopped, restore that pool size and remove this lock before retrying.`,
          { cause },
        ),
      );
    }
  }
  if (!cleanupErrors.length) {
    try {
      await host("rmdir", ["--", lock], true);
    } catch (cause) {
      cleanupErrors.push(
        new Error(`Could not release the Lima VM image-build lock (${lock}).`, { cause }),
      );
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(outcome.ok ? [] : [outcome.error]), ...cleanupErrors],
      cleanupErrors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join(" "),
    );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
