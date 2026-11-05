// @effect-diagnostics nodeBuiltinImport:off - Owned image selection and archive fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ensureDevVmImage } from "./dev-vm-image.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

const selected = {
  schemaVersion: 1,
  state: "built",
  apiUrl: "http://127.0.0.1:3000",
  templateRef: "runner:build-selected",
  buildId: "selected-build-id",
};

async function fixture() {
  const repoRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-image-test-"));
  directories.push(repoRoot);
  const selectionPath = NodePath.join(repoRoot, "infra", "relay", ".t3", "e2b-template.json");
  const env: NodeJS.ProcessEnv = { E2B_API_URL: selected.apiUrl };
  let archiveDirectory: string | undefined;
  const writeSelection = async (content = JSON.stringify(selected)) => {
    const path = env.E2B_TEMPLATE_FILE || selectionPath;
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, content);
  };
  const buildArchive = vi.fn(async (outputDirectory: string) => {
    archiveDirectory = outputDirectory;
    const archive = NodePath.join(outputDirectory, "server.tar.gz");
    await NodeFSP.writeFile(archive, "packaged Linux server");
    return { archive, sha256: "a".repeat(64) };
  });
  const buildTemplate = vi.fn(async ({ archive, sha256 }: { archive: string; sha256: string }) => {
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("packaged Linux server");
    expect(sha256).toBe("a".repeat(64));
    await writeSelection();
  });
  const input = { repoRoot, env, buildArchive, buildTemplate };
  return { input, selectionPath, writeSelection, archiveDirectory: () => archiveDirectory };
}

describe("development VM image bootstrap", () => {
  it("builds a missing image once, validates its selection, and removes the server archive", async () => {
    const f = await fixture();
    expect(await ensureDevVmImage(f.input)).toEqual({
      built: true,
      selectionPath: f.selectionPath,
    });
    expect(f.input.buildArchive).toHaveBeenCalledOnce();
    expect(f.input.buildTemplate).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(f.archiveDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ensureDevVmImage(f.input)).toEqual({
      built: false,
      selectionPath: f.selectionPath,
    });
    expect(f.input.buildArchive).toHaveBeenCalledOnce();
  });

  it("reuses a valid image with a canonical-equivalent API URL without building", async () => {
    const f = await fixture();
    f.input.env.E2B_API_URL = "http://LOCALHOST:3000/";
    await f.writeSelection(JSON.stringify({ ...selected, apiUrl: "http://localhost:3000" }));
    expect((await ensureDevVmImage(f.input)).built).toBe(false);
    expect(f.input.buildArchive).not.toHaveBeenCalled();
  });

  it("preserves explicit legacy image settings when no default selection exists", async () => {
    const f = await fixture();
    Object.assign(f.input.env, {
      E2B_TEMPLATE_REF: "runner:build-legacy",
      E2B_TEMPLATE_BUILD_ID: "legacy",
    });
    expect((await ensureDevVmImage(f.input)).built).toBe(false);
    expect(f.input.buildArchive).not.toHaveBeenCalled();
  });

  it("builds to an explicit missing selection path even if legacy settings exist", async () => {
    const f = await fixture();
    Object.assign(f.input.env, {
      E2B_TEMPLATE_FILE: NodePath.join(f.input.repoRoot, "selected.json"),
      E2B_TEMPLATE_REF: "runner:build-legacy",
      E2B_TEMPLATE_BUILD_ID: "legacy",
    });
    expect(await ensureDevVmImage(f.input)).toEqual({
      built: true,
      selectionPath: f.input.env.E2B_TEMPLATE_FILE,
    });
    expect(f.input.buildTemplate).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsuccessful build", JSON.stringify({ ...selected, state: "building" })],
    ["invalid reference", JSON.stringify({ ...selected, templateRef: "runner:latest" })],
    ["other API", JSON.stringify({ ...selected, apiUrl: "http://other.example" })],
  ])("rejects %s without replacing the selected image", async (_label, content) => {
    const f = await fixture();
    await f.writeSelection(content);
    await expect(ensureDevVmImage(f.input)).rejects.toThrow("Run vp run build:vm-template");
    expect(f.input.buildArchive).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(f.selectionPath, "utf8")).toBe(content);
  });

  it("does not treat an unreadable selection as a missing image", async () => {
    const f = await fixture();
    await NodeFSP.mkdir(f.selectionPath, { recursive: true });
    await expect(ensureDevVmImage(f.input)).rejects.toThrow("Cannot read the selected VM image");
    expect(f.input.buildArchive).not.toHaveBeenCalled();
  });

  it("rebuilds deliberately and can repair an invalid existing selection", async () => {
    const f = await fixture();
    await f.writeSelection("invalid old selection");
    expect((await ensureDevVmImage({ ...f.input, rebuild: true })).built).toBe(true);
    expect(f.input.buildTemplate).toHaveBeenCalledOnce();
    expect(JSON.parse(await NodeFSP.readFile(f.selectionPath, "utf8"))).toEqual(selected);
    await expect(NodeFSP.stat(f.archiveDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["archive", "template"])(
    "cleans artifacts and preserves the old selection after a failed %s build",
    async (phase) => {
      const f = await fixture();
      await f.writeSelection();
      if (phase === "archive")
        f.input.buildArchive.mockImplementationOnce(async (directory) => {
          await NodeFSP.writeFile(NodePath.join(directory, "partial.tar.gz"), "partial");
          throw new Error("archive build failed");
        });
      else f.input.buildTemplate.mockRejectedValueOnce(new Error("template build failed"));
      await expect(ensureDevVmImage({ ...f.input, rebuild: true })).rejects.toThrow(
        `${phase} build failed`,
      );
      const temporary =
        phase === "archive" ? f.input.buildArchive.mock.calls[0]![0] : f.archiveDirectory()!;
      await expect(NodeFSP.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await NodeFSP.readFile(f.selectionPath, "utf8"))).toEqual(selected);
      if (phase === "archive") expect(f.input.buildTemplate).not.toHaveBeenCalled();
    },
  );

  it("rejects a build that finishes without selecting a valid image", async () => {
    const f = await fixture();
    f.input.buildTemplate.mockImplementationOnce(async () => f.writeSelection("{}"));
    await expect(ensureDevVmImage(f.input)).rejects.toThrow("not a successful build");
    await expect(NodeFSP.stat(f.archiveDirectory()!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a relative selection override before building", async () => {
    const f = await fixture();
    f.input.env.E2B_TEMPLATE_FILE = "relative.json";
    await expect(ensureDevVmImage(f.input)).rejects.toThrow("absolute path");
    expect(f.input.buildArchive).not.toHaveBeenCalled();
  });
});
