// @effect-diagnostics nodeBuiltinImport:off - Owned local build fixtures; no Linux host or E2B is started.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareVmRunnerImage } from "./build-vm-image.ts";
import { buildLinuxVmArchive } from "./lib/vm-linux-archive.ts";
import { withVmBuildMemory } from "./lib/vm-build-memory.ts";

vi.mock("./lib/vm-linux-archive.ts", () => ({ buildLinuxVmArchive: vi.fn() }));
vi.mock("./lib/vm-build-memory.ts", () => ({
  withVmBuildMemory: vi.fn(async (_input, build: () => Promise<void>) => build()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(buildLinuxVmArchive).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const repoRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-image-cli-"));
  roots.push(repoRoot);
  const script = NodePath.join(repoRoot, "infra/relay/scripts/e2b-build-template.mjs");
  const selected = NodePath.join(repoRoot, "selected.json");
  const argsFile = NodePath.join(repoRoot, "build-arguments.json");
  await NodeFSP.mkdir(NodePath.dirname(script), { recursive: true });
  // This subprocess stands in for E2B: it verifies the packaged input and publishes a selection.
  await NodeFSP.writeFile(
    script,
    `
    import fs from 'node:fs';
    const args=process.argv.slice(2);
    fs.writeFileSync(process.env.TEST_ARGUMENTS_FILE,JSON.stringify(args));
    if(process.env.TEST_FAIL==='1') process.exit(1);
    if(fs.readFileSync(args[1],'utf8')!=='Linux fixture') process.exit(2);
    fs.writeFileSync(process.env.E2B_TEMPLATE_FILE,JSON.stringify({
      schemaVersion:1,state:'built',apiUrl:process.env.E2B_API_URL,
      templateRef:'fixture:build-current',buildId:'current-build'
    }));
  `,
  );
  let archive: string | undefined;
  vi.mocked(buildLinuxVmArchive).mockImplementation(async (input) => {
    archive = NodePath.join(input.outputDirectory, "server.tar.gz");
    await NodeFSP.writeFile(archive, "Linux fixture");
    return { archive, sha256: "a".repeat(64) };
  });
  return {
    repoRoot,
    selected,
    argsFile,
    archive: () => archive,
    env: {
      E2B_API_URL: "http://127.0.0.1:3000",
      E2B_API_KEY: "test-team-key",
      E2B_TEMPLATE_FILE: selected,
      TEST_ARGUMENTS_FILE: argsFile,
    },
  };
}

describe("VM runner build command integration", () => {
  it("rejects missing E2B credentials before spending time packaging Linux", async () => {
    const f = await fixture();
    await expect(
      prepareVmRunnerImage({ ...f, env: { ...f.env, E2B_API_KEY: "" } }),
    ).rejects.toThrow("Set E2B_API_KEY");
    expect(buildLinuxVmArchive).not.toHaveBeenCalled();
    expect(withVmBuildMemory).not.toHaveBeenCalled();
    await expect(NodeFSP.stat(f.argsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds a missing image using the archive and checksum, then reuses the selection", async () => {
    const f = await fixture();
    const listeners = process.listenerCount("SIGINT");
    expect((await prepareVmRunnerImage(f)).built).toBe(true);
    expect(JSON.parse(await NodeFSP.readFile(f.argsFile, "utf8"))).toEqual([
      "--server-archive",
      f.archive(),
      "--server-sha256",
      "a".repeat(64),
    ]);
    await expect(NodeFSP.stat(NodePath.dirname(f.archive()!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await prepareVmRunnerImage(f)).built).toBe(false);
    expect(buildLinuxVmArchive).toHaveBeenCalledOnce();
    expect(withVmBuildMemory).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });

  it("keeps the old selection and removes the temporary archive if the image build fails", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(f.selected, "previous image selection");
    const listeners = process.listenerCount("SIGTERM");
    await expect(
      prepareVmRunnerImage({ ...f, env: { ...f.env, TEST_FAIL: "1" }, rebuild: true }),
    ).rejects.toThrow("previous image selection was preserved");
    expect(await NodeFSP.readFile(f.selected, "utf8")).toBe("previous image selection");
    await expect(NodeFSP.stat(NodePath.dirname(f.archive()!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it("stops before invoking the E2B builder if Linux packaging fails", async () => {
    const f = await fixture();
    vi.mocked(buildLinuxVmArchive).mockRejectedValueOnce(new Error("Linux build failed"));
    await expect(prepareVmRunnerImage(f)).rejects.toThrow("Linux build failed");
    await expect(NodeFSP.stat(f.argsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.stat(f.selected)).rejects.toMatchObject({ code: "ENOENT" });
    expect(withVmBuildMemory).not.toHaveBeenCalled();
  });

  it("keeps the previous image selected if restoring build memory fails after compilation", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(f.selected, "previous selection");
    vi.mocked(withVmBuildMemory).mockImplementationOnce(async (_input, build) => {
      await build();
      throw new Error("Could not restore original host memory");
    });
    await expect(prepareVmRunnerImage({ ...f, rebuild: true })).rejects.toThrow(
      "restore original host memory",
    );
    expect(await NodeFSP.readFile(f.selected, "utf8")).toBe("previous selection");
    expect(
      (await NodeFSP.readdir(f.repoRoot)).some((name) => name.startsWith(".e2b-template-")),
    ).toBe(false);
  });
});
