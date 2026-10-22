// @effect-diagnostics nodeBuiltinImport:off - Mocked host memory commands only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withVmBuildMemory } from "./vm-build-memory.ts";

const env = {
  E2B_API_URL: "http://127.0.0.1:3000",
  E2B_SANDBOX_URL: "http://localhost:3002",
};
const input = { env, platform: "darwin" as const };
type Command = Parameters<NonNullable<Parameters<typeof withVmBuildMemory>[2]>>[0];

function host(
  options: {
    total?: number;
    used?: number;
    reserved?: number;
    available?: number;
    partial?: boolean;
    growFails?: boolean;
    restoreFails?: boolean;
    retainedAfterRestore?: boolean;
    locked?: boolean;
  } = {},
) {
  const original = options.total ?? 3072;
  let total = original;
  const calls: Command[] = [];
  const run = async (command: Command) => {
    calls.push(command);
    if (command.args[3] === "mkdir" && options.locked) throw new Error("already exists");
    const setting = command.args.at(-1)?.match(/^vm\.nr_hugepages=(\d+)$/u);
    if (setting) {
      const target = Number(setting[1]);
      if (target === original && options.restoreFails) throw new Error("restore failed");
      if (target === original && options.retainedAfterRestore) return "";
      total = options.partial && target > original ? original + 1 : target;
      if (target > original && options.growFails) throw new Error("allocation command failed");
    }
    if (command.args[3] === "sh")
      return [
        `MemAvailable: ${options.available ?? 24 * 1024 * 1024 - total * 2048} kB`,
        `HugePages_Total: ${total}`,
        `HugePages_Free: ${total - (options.used ?? 0)}`,
        `HugePages_Rsvd: ${options.reserved ?? 0}`,
        "Hugepagesize: 2048 kB",
        `RequestedHugePages: ${total}`,
      ].join("\n");
    return "";
  };
  return {
    run,
    calls,
    settings: () =>
      calls
        .map((call) => call.args.at(-1))
        .filter((value) => value?.startsWith("vm.nr_hugepages=")),
  };
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("Lima image-build hugepage memory", () => {
  it("temporarily reserves 12 GiB in addition to occupied/reserved pages, then restores the original pool", async () => {
    const f = host({ used: 10, reserved: 20 });
    const value = await withVmBuildMemory(
      input,
      async () => {
        expect(f.settings()).toEqual(["vm.nr_hugepages=6174"]);
        return "image";
      },
      f.run,
    );
    expect(value).toBe("image");
    expect(f.settings()).toEqual(["vm.nr_hugepages=6174", "vm.nr_hugepages=3072"]);
    expect(f.calls.at(-1)?.args).toEqual([
      "shell",
      "--workdir=/",
      "launchpad-e2b",
      "rmdir",
      "--",
      "/tmp/launchpad-vm-build-memory.lock",
    ]);
  });

  it("preserves a larger existing pool without writing memory settings", async () => {
    const f = host({ total: 7168 });
    await withVmBuildMemory(input, async () => "image", f.run);
    expect(f.settings()).toEqual([]);
  });

  for (const failure of ["failed", "cancelled"] as const) {
    it(`restores the original pool after a ${failure} build without the cancelled signal`, async () => {
      const f = host();
      const controller = new AbortController();
      await expect(
        withVmBuildMemory(
          { ...input, signal: controller.signal },
          async () => {
            if (failure === "cancelled") controller.abort();
            throw new Error(failure);
          },
          f.run,
        ),
      ).rejects.toThrow(failure);
      expect(f.settings()).toEqual(["vm.nr_hugepages=6144", "vm.nr_hugepages=3072"]);
      const cleanup = f.calls.slice(
        f.calls.findIndex((call) => call.args.at(-1) === "vm.nr_hugepages=3072"),
      );
      expect(cleanup.every((call) => call.signal === undefined)).toBe(true);
    });
  }

  it("refuses insufficient normal RAM before changing the pool or starting the build", async () => {
    const f = host({ available: 8 * 1024 * 1024 });
    const build = vi.fn();
    await expect(withVmBuildMemory(input, build, f.run)).rejects.toThrow("3 GiB of normal RAM");
    expect(f.settings()).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(f.calls.at(-1)?.args[3]).toBe("rmdir");
  });

  it("detects a partially allocated pool and restores it before allowing another build", async () => {
    const f = host({ partial: true });
    const build = vi.fn();
    await expect(withVmBuildMemory(input, build, f.run)).rejects.toThrow(
      "could not reserve enough",
    );
    expect(build).not.toHaveBeenCalled();
    expect(f.settings()).toEqual(["vm.nr_hugepages=6144", "vm.nr_hugepages=3072"]);
  });

  it("reports restoration failure even after a successful build", async () => {
    const f = host({ restoreFails: true });
    await expect(withVmBuildMemory(input, async () => "image", f.run)).rejects.toThrow(
      "Could not restore the Lima hugepage pool to 3072 pages",
    );
    expect(f.calls.some((call) => call.args[3] === "rmdir")).toBe(false);
  });

  it("restores memory when the allocation command fails after changing the pool", async () => {
    const f = host({ growFails: true });
    const build = vi.fn();
    await expect(withVmBuildMemory(input, build, f.run)).rejects.toThrow(
      "allocation command failed",
    );
    expect(build).not.toHaveBeenCalled();
    expect(f.settings()).toEqual(["vm.nr_hugepages=6144", "vm.nr_hugepages=3072"]);
  });

  it("reports a pool that remains allocated after a successful restore command", async () => {
    const f = host({ retainedAfterRestore: true });
    await expect(withVmBuildMemory(input, async () => "image", f.run)).rejects.toThrow(
      "Could not restore the Lima hugepage pool",
    );
    expect(f.calls.some((call) => call.args[3] === "rmdir")).toBe(false);
  });

  it("does not touch memory or remove another build's lock", async () => {
    const f = host({ locked: true });
    const build = vi.fn();
    await expect(withVmBuildMemory(input, build, f.run)).rejects.toThrow("another image build");
    expect(f.calls).toHaveLength(1);
    expect(build).not.toHaveBeenCalled();
  });

  for (const remote of [
    { platform: "linux" as const, env },
    { platform: "darwin" as const, env: { ...env, E2B_API_URL: "https://remote.example.test" } },
    {
      platform: "darwin" as const,
      env: { ...env, E2B_SANDBOX_URL: "https://remote.example.test" },
    },
    { platform: "darwin" as const, env: { ...env, E2B_API_URL: "invalid" } },
  ]) {
    it(`leaves memory unchanged for ${JSON.stringify(remote)}`, async () => {
      const f = host();
      expect(await withVmBuildMemory(remote, async () => "remote", f.run)).toBe("remote");
      expect(f.calls).toEqual([]);
    });
  }
});
