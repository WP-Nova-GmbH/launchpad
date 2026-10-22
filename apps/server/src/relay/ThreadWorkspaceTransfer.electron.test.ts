// @effect-diagnostics nodeBuiltinImport:off - Headless subprocess and tiny disposable archive fixtures.
/* oxlint-disable t3code/no-global-process-runtime -- Run only captured local Node/Electron fixture processes. */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const desktopRequire = NodeModule.createRequire(
  new URL("../../../desktop/package.json", import.meta.url),
);
const tooling = (() => {
  try {
    const electron = desktopRequire("electron") as string;
    const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar") as {
      createPackage: (source: string, destination: string) => Promise<void>;
    };
    return NodeFS.existsSync(electron) ? { electron, asar } : null;
  } catch {
    return null;
  }
})();
const fixtureRunner = NodeURL.fileURLToPath(
  new URL("./fixtures/thread-workspace-asar.ts", import.meta.url),
);

for (const runtime of ["Node", "Electron"] as const)
  it.skipIf(!tooling)(
    `${runtime} transfers real ASAR bytes through export, import and durable installation (requires installed Electron and ASAR tooling)`,
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workspace-asar-"));
      try {
        const packed = NodePath.join(root, "packed"),
          source = NodePath.join(root, "source");
        await NodeFSP.mkdir(packed);
        await NodeFSP.mkdir(source);
        await NodeFSP.writeFile(
          NodePath.join(packed, "inside.txt"),
          "virtual archive content\n".repeat(6000),
        );
        const archive = NodePath.join(source, "payload.asar");
        await tooling!.asar.createPackage(packed, archive);
        await NodeFSP.mkdir(`${archive}.unpacked`);
        await NodeFSP.writeFile(
          NodePath.join(`${archive}.unpacked`, "fixture.txt"),
          "unpacked sibling\n",
        );
        await NodeFSP.writeFile(NodePath.join(source, "run.sh"), "#!/bin/sh\necho fixture\n", {
          mode: 0o755,
        });
        if (process.platform !== "win32") {
          await NodeFSP.symlink("payload.asar", NodePath.join(source, "archive-link"));
          const framework = NodePath.join(source, "Framework.framework");
          const version = NodePath.join(framework, "Versions", "A");
          await NodeFSP.mkdir(NodePath.join(version, "Resources"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(version, "Framework"), "framework executable\n", {
            mode: 0o755,
          });
          await NodeFSP.writeFile(
            NodePath.join(version, "Resources", "Info.plist"),
            "fixture plist\n",
          );
          await NodeFSP.symlink("A", NodePath.join(framework, "Versions", "Current"));
          await NodeFSP.symlink(
            "Versions/Current/Framework",
            NodePath.join(framework, "Framework"),
          );
          await NodeFSP.symlink(
            "Versions/Current/Resources",
            NodePath.join(framework, "Resources"),
          );
        }
        const archiveHash = NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(archive))
          .digest("hex");
        const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
          runtime === "Electron" ? tooling!.electron : process.execPath,
          [fixtureRunner, root, archiveHash],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            timeout: 30_000,
            maxBuffer: 65_536,
            encoding: "utf8",
          },
        );
        expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
          phase: "installed",
          archiveHash,
        });
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
    35_000,
  );
