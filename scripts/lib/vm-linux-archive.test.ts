// @effect-diagnostics nodeBuiltinImport:off - Isolated build fixtures without infrastructure.
/* oxlint-disable t3code/no-global-process-runtime -- Assert both standalone host command paths. */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  buildLinuxVmArchive,
  linuxVmArchiveBuildScript,
  vmArchiveSourcePaths,
} from "./vm-linux-archive.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vm-archive-test-")),
  );
  directories.push(path);
  return path;
}
async function write(root: string, path: string, text = "current checkout content") {
  await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, path), text);
}

describe("VM Linux server archive", () => {
  it("selects current source and rejects credentials, generated files, VM state and symlinks", async () => {
    const root = await directory();
    const outside = await directory();
    const allowed = [
      "package.json",
      "apps/server/src/current.ts",
      "apps/web/src/new.ts",
      "patches/effect.patch",
    ];
    const excluded = [
      ".env",
      "apps/server/.env.local",
      "infra/relay/.env",
      ".git/config",
      ".repos/source.ts",
      "apps/server/node_modules/dependency.ts",
      "native/resource-monitor/target/release/binary",
      ".t3/state.sqlite",
      "scripts/credential.key",
      "apps/server/secrets/auth.json",
      "apps/web/dist/index.html",
      "vm/disk.qcow2",
      ".npmrc",
    ];
    await Promise.all([...allowed, ...excluded].map((path) => write(root, path)));
    await write(outside, "private.ts");
    await NodeFSP.symlink(NodePath.join(outside, "private.ts"), NodePath.join(root, "linked.ts"));
    await NodeFSP.symlink(outside, NodePath.join(root, "linked-directory"));
    const paths = await vmArchiveSourcePaths(root, [
      ...allowed,
      ...excluded,
      "linked.ts",
      "linked-directory/private.ts",
      "deleted.ts",
      "../escape",
      "/etc/passwd",
      "",
    ]);
    expect(paths).toEqual(allowed.map((path) => `./${path}`));
  });

  it("rejects command injection in build versions", () => {
    expect(() => linuxVmArchiveBuildScript("0.3.3; unexpected", "0.1.7")).toThrow("exact");
    expect(() => linuxVmArchiveBuildScript("0.3.3", "$(unexpected)")).toThrow("exact");
  });

  for (const outcome of ["success", "failure", "cancelled", "cleanup failed"] as const) {
    it(`cleans only its owned Linux container and scratch after ${outcome}`, async () => {
      const root = await directory();
      const output = await directory();
      const bytes = Buffer.from("packaged linux server");
      await write(
        root,
        "package.json",
        JSON.stringify({ devDependencies: { "vite-plus": "catalog:" } }),
      );
      await write(root, "apps/server/package.json", JSON.stringify({ version: "0.1.7" }));
      await write(root, "pnpm-workspace.yaml", "catalog:\n  vite-plus: 0.3.3\n");
      await write(root, "apps/server/src/new.ts");
      await write(root, ".env", "SECRET_DO_NOT_TRANSFER=private");
      const controller = new AbortController();
      const calls: Parameters<NonNullable<Parameters<typeof buildLinuxVmArchive>[1]>>[0][] = [];
      let source: string | undefined;
      let hostDirectory: string | undefined;
      const run: NonNullable<Parameters<typeof buildLinuxVmArchive>[1]> = async (input) => {
        calls.push(input);
        if (input.command === "git")
          return "package.json\0apps/server/package.json\0pnpm-workspace.yaml\0apps/server/src/new.ts\0.env\0";
        if (input.command === "tar") {
          source = input.args[1]!;
          const files = await NodeFSP.readFile(input.args.at(-1)!, "utf8");
          expect(files).toContain("./apps/server/src/new.ts\0");
          expect(files).not.toContain(".env");
          await NodeFSP.writeFile(source, "source snapshot");
          return "";
        }
        if (
          input.args.includes("mkdir") ||
          input.args.some((arg) => arg.startsWith("umask 077; mkdir"))
        ) {
          hostDirectory = /\/tmp\/launchpad-vm-build-[a-f0-9-]+/u.exec(input.args.join(" "))?.[0];
          if (process.platform === "linux") {
            await NodeFSP.mkdir(hostDirectory!);
            directories.push(hostDirectory!);
          }
        }
        if (input.args.includes("run")) {
          expect(input.args).toContain("--rm");
          expect(input.args).toContain("node:26.8.2-bookworm");
          expect(input.args).toContain("VP_NODE_VERSION=26.8.2");
          expect(input.args.join(" ")).not.toContain("SECRET_DO_NOT_TRANSFER");
          expect(input.args.join(" ")).not.toContain(root);
          if (outcome === "failure") throw new Error("compiler failed");
          if (outcome === "cancelled") {
            controller.abort(new Error("interrupted"));
            controller.signal.throwIfAborted();
          }
          if (process.platform === "linux")
            await NodeFSP.writeFile(`${hostDirectory}/server.tar.gz`, bytes);
        }
        if (
          input.command === "limactl" &&
          input.args[0] === "copy" &&
          input.args[1]?.endsWith("/server.tar.gz")
        )
          await NodeFSP.writeFile(input.args[2]!, bytes);
        if (
          outcome === "cleanup failed" &&
          input.args.some((arg) => arg.includes("docker rm --force"))
        )
          throw new Error("Docker unavailable during cleanup");
        if (process.platform === "linux" && input.args.includes("-rf"))
          await NodeFSP.rm(hostDirectory!, { recursive: true, force: true });
        return "";
      };
      const build = buildLinuxVmArchive(
        { repoRoot: root, outputDirectory: output, env: {}, signal: controller.signal },
        run,
      );
      if (outcome === "success") {
        const result = await build;
        expect(await NodeFSP.readFile(result.archive)).toEqual(bytes);
        expect(result.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
      } else {
        await expect(build).rejects.toThrow(
          outcome === "failure"
            ? "compiler failed"
            : outcome === "cancelled"
              ? "interrupted"
              : "cleanup failed",
        );
        expect(await NodeFSP.readdir(output)).toEqual([]);
      }
      expect(source).toBeDefined();
      await expect(NodeFSP.access(NodePath.dirname(source!))).rejects.toThrow();
      const stop = calls.find((call) => call.args.some((arg) => arg.includes("docker rm --force")));
      const remove = calls.find((call) => call.args.includes("-rf"));
      expect(stop?.args.at(-1)).toContain("name=^/launchpad-vm-build-");
      if (outcome === "cleanup failed") expect(remove).toBeUndefined();
      else expect(remove?.args.at(-1)).toBe(hostDirectory);
      expect(stop?.signal).toBeUndefined();
      expect(remove?.signal).toBeUndefined();
      expect(await NodeFSP.readdir(root)).toContain(".env");
    });
  }
});
