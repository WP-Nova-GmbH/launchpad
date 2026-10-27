// @effect-diagnostics nodeBuiltinImport:off - Disposable headless runtime regression fixture.
/* oxlint-disable t3code/no-global-process-runtime -- This isolated subprocess owns only its fixture directory. */
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../../persistence/ThreadExecutionFence.ts";
import { layer as ProcessRunnerLayer } from "../../processRunner.ts";
import { makeThreadCheckoutInstaller } from "../ThreadCheckoutInstall.ts";
import { scanWorkspaceFiles } from "../ThreadWorkspaceFiles.ts";
import { physicalFs } from "../ThreadWorkspaceFileSystem.ts";
import { exportThreadWorkspace, importThreadWorkspace } from "../ThreadWorkspaceTransfer.ts";

const require = NodeModule.createRequire(import.meta.url);
// Physical I/O is the independent oracle, never the patched filesystem under test.
const disk: typeof NodeFS = process.versions.electron ? require("original-fs") : NodeFS;
const runtime = process as NodeJS.Process & { noAsar?: boolean };
const initialNoAsar = runtime.noAsar;
const root = disk.realpathSync(process.argv[2]!);
const expectedHash = process.argv[3]!;
const source = NodePath.join(root, "source");
const archive = NodePath.join(source, "payload.asar");
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const expectedBytes = disk.readFileSync(archive);
NodeAssert.equal(hash(expectedBytes), expectedHash);
const physicalStat = physicalFs.lstatSync(archive, { bigint: true });
NodeAssert.equal(physicalStat.isFile(), true);
NodeAssert.equal(typeof physicalStat.mode, "bigint");
NodeAssert.equal(physicalStat.size, BigInt(expectedBytes.byteLength));
if (process.versions.electron) {
  NodeAssert.equal(NodeFS.statSync(archive).isDirectory(), true);
  NodeAssert.deepEqual(NodeFS.readdirSync(archive), ["inside.txt"]);
}
const git = (cwd: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@localhost",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git(source, ["init", "-b", "fixture"]);
git(source, ["add", "."]);
git(source, ["commit", "-m", "fixture"]);
const head = git(source, ["rev-parse", "HEAD"]);

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const files = (yield* scanWorkspaceFiles(source)).files;
    const opaque = files.find((entry) => entry.path === "payload.asar");
    NodeAssert.equal(opaque?.kind, "file");
    if (opaque?.kind !== "file") throw new Error("ASAR archive was not an opaque file");
    NodeAssert.equal(opaque.sha256, expectedHash);
    NodeAssert.equal(opaque.size, expectedBytes.byteLength);
    NodeAssert.equal(
      files.some((entry) => entry.path.startsWith("payload.asar/")),
      false,
    );
    const exported = yield* exportThreadWorkspace({
      threadId: "thread",
      workspaceRoot: source,
      artifactRoot: NodePath.join(root, "artifacts"),
    });
    disk.rmSync(source, { recursive: true });
    const staged = yield* importThreadWorkspace({
      threadId: "thread",
      manifest: exported.manifest,
      artifactDirectory: exported.directory,
      destinationRoot: NodePath.join(root, "staging"),
    });
    const target = NodePath.join(root, "target");
    disk.mkdirSync(target);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('project','Fixture',${target},'[]','2026-10-22T00:00:00Z','2026-10-22T00:00:00Z')`;
    const owner = {
      threadId: "thread",
      projectId: "project",
      environmentId: "destination",
      relayUrl: "https://relay.example",
      generation: 2,
      operationId: "move",
    };
    yield* makeThreadExecutionFence(sql).prepare(owner);
    const installed = yield* makeThreadCheckoutInstaller(sql).install({
      ...owner,
      manifestSha256: "a".repeat(64),
      workspace: exported.manifest,
      stagedWorkspaceRoot: staged.workspaceRoot,
      artifactDirectory: exported.directory,
      recoveryRoot: NodePath.join(root, "recovery"),
      worktreesRoot: NodePath.join(root, "worktrees"),
      freshCheckoutRoot: target,
    });
    NodeAssert.equal(installed.phase, "installed");
    NodeAssert.equal(git(target, ["rev-parse", "HEAD"]), head);
    NodeAssert.deepEqual(disk.readFileSync(NodePath.join(target, "payload.asar")), expectedBytes);
    NodeAssert.equal(
      disk.readFileSync(NodePath.join(target, "payload.asar.unpacked", "fixture.txt"), "utf8"),
      "unpacked sibling\n",
    );
    if (process.platform !== "win32") {
      NodeAssert.notEqual(disk.statSync(NodePath.join(target, "run.sh")).mode & 0o111, 0);
      NodeAssert.equal(disk.readlinkSync(NodePath.join(target, "archive-link")), "payload.asar");
      const framework = NodePath.join(target, "Framework.framework");
      NodeAssert.equal(disk.readlinkSync(NodePath.join(framework, "Versions", "Current")), "A");
      NodeAssert.equal(
        disk.readlinkSync(NodePath.join(framework, "Framework")),
        "Versions/Current/Framework",
      );
      NodeAssert.equal(
        disk.readlinkSync(NodePath.join(framework, "Resources")),
        "Versions/Current/Resources",
      );
      NodeAssert.equal(
        disk.readFileSync(NodePath.join(framework, "Framework"), "utf8"),
        "framework executable\n",
      );
      NodeAssert.equal(
        disk.readFileSync(NodePath.join(framework, "Resources", "Info.plist"), "utf8"),
        "fixture plist\n",
      );
    }
    NodeAssert.deepEqual((yield* scanWorkspaceFiles(target)).files, exported.manifest.files);
    NodeAssert.equal(runtime.noAsar, initialNoAsar);
    if (process.versions.electron)
      NodeAssert.equal(NodeFS.statSync(NodePath.join(target, "payload.asar")).isDirectory(), true);
    return { phase: installed.phase, archiveHash: expectedHash };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqlitePersistenceMemory, ProcessRunnerLayer).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
