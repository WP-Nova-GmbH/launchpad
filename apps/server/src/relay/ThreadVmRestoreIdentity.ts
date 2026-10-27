// @effect-diagnostics nodeBuiltinImport:off - Root-owned cold boot and identity records require lstat uid/gid/link count checks.
import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ThreadVmRestoreBoot } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(ThreadVmRestoreBoot);
const decodeRecord = Schema.decodeUnknownSync(
  Schema.Struct({
    boot: ThreadVmRestoreBoot,
    uid: Schema.Int,
    gid: Schema.Int,
  }),
);
const sameBoot = (a: ThreadVmRestoreBoot, b: ThreadVmRestoreBoot) =>
  a.operationId === b.operationId &&
  a.allocationId === b.allocationId &&
  a.threadId === b.threadId &&
  a.generation === b.generation;
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
async function stat(file: string) {
  try {
    return await NodeFSP.lstat(file);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function directory(file: string) {
  const value = await stat(file);
  if (value && (!value.isDirectory() || value.isSymbolicLink()))
    throw new Error("Invalid restore directory");
  return value;
}
async function sync(file: string) {
  const handle = await NodeFSP.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Called as root under the enrollment flock, before any identity/database layer
 * opens. The old home remains available for read-only import; none of its secrets
 * or global SQLite sequence numbers are installed into the fresh serving home.
 * The durable reservation makes a crash after rename retry the same source. */
export async function prepareThreadVmRestoreIdentity(
  input: ThreadVmRestoreBoot,
  baseDir = "/home/user/.launchpad",
  bootstrapPath = "/launchpad-restore.json",
  platform: NodeJS.Platform = HostProcessPlatform.defaultValue(),
) {
  const expected = decode(input);
  const bootstrap = await NodeFSP.lstat(bootstrapPath);
  if (
    !bootstrap.isFile() ||
    bootstrap.isSymbolicLink() ||
    bootstrap.nlink !== 1 ||
    bootstrap.size > 16384 ||
    (bootstrap.mode & 0o022) !== 0 ||
    (platform === "linux" && bootstrap.uid !== 0)
  )
    throw new Error("Invalid cold boot scope");
  const actual = decode(JSON.parse(await NodeFSP.readFile(bootstrapPath, "utf8")));
  if (!sameBoot(actual, expected) || expected.generation <= 1)
    throw new Error("Cold boot scope differs");
  if (
    !NodePath.isAbsolute(baseDir) ||
    NodePath.resolve(baseDir) !== baseDir ||
    (await NodeFSP.realpath(NodePath.dirname(baseDir))) !== NodePath.dirname(baseDir)
  )
    throw new Error("Invalid serving home");
  const recoveryRoot = `${baseDir}-restores`;
  const priorRoot = await directory(recoveryRoot);
  if (
    priorRoot &&
    ((priorRoot.mode & 0o022) !== 0 || (platform === "linux" && priorRoot.uid !== 0))
  )
    throw new Error("Invalid recovery root");
  if (!priorRoot) {
    await NodeFSP.mkdir(recoveryRoot, { mode: 0o755 });
    await sync(NodePath.dirname(baseDir));
  }
  const recovery = NodePath.join(recoveryRoot, expected.allocationId);
  const recoveryStat = await directory(recovery);
  if (
    recoveryStat &&
    ((recoveryStat.mode & 0o022) !== 0 || (platform === "linux" && recoveryStat.uid !== 0))
  )
    throw new Error("Invalid recovery reservation");
  if (!recoveryStat) {
    await NodeFSP.mkdir(recovery, { mode: 0o755 });
    await sync(recoveryRoot);
  }
  const recordFile = NodePath.join(recovery, "identity.json");
  const recordStat = await stat(recordFile);
  let record;
  if (recordStat) {
    if (
      !recordStat.isFile() ||
      recordStat.isSymbolicLink() ||
      recordStat.nlink !== 1 ||
      (recordStat.mode & 0o022) !== 0 ||
      (platform === "linux" && recordStat.uid !== 0)
    )
      throw new Error("Invalid identity reservation");
    record = decodeRecord(JSON.parse(await NodeFSP.readFile(recordFile, "utf8")));
    if (!sameBoot(record.boot, expected)) throw new Error("Identity reservation differs");
  } else {
    const source = await directory(baseDir);
    if (!source || (platform === "linux" && source.uid !== 1000))
      throw new Error("Saved source home is missing");
    record = { boot: expected, uid: source.uid, gid: source.gid };
    const stage = NodePath.join(recovery, `.identity-${NodeCrypto.randomUUID()}`);
    try {
      await NodeFSP.writeFile(stage, JSON.stringify(record), { flag: "wx", mode: 0o644 });
      await sync(stage);
      await NodeFSP.rename(stage, recordFile);
      await sync(recovery);
    } finally {
      await NodeFSP.rm(stage, { force: true });
    }
  }
  if (await stat(NodePath.join(recovery, "cleanup")))
    throw new Error("Restore source was already retired");
  const sourceDirectory = NodePath.join(recovery, "source");
  if (!(await directory(sourceDirectory))) {
    if (!(await directory(baseDir))) throw new Error("Saved source home is missing");
    await NodeFSP.rename(baseDir, sourceDirectory);
    await sync(recovery);
    await sync(NodePath.dirname(baseDir));
  }
  if (!(await directory(baseDir))) {
    await NodeFSP.mkdir(baseDir, { mode: 0o700 });
    if (platform === "linux") await NodeFSP.chown(baseDir, record.uid, record.gid);
    await sync(NodePath.dirname(baseDir));
  }
  // Worktrees contain workspace files and Git links, not server identity. Keep
  // their original absolute path while the userdata/credentials stay quarantined.
  const savedWorktrees = NodePath.join(sourceDirectory, "worktrees");
  if (await directory(savedWorktrees)) {
    const destination = NodePath.join(baseDir, "worktrees");
    if (await directory(destination)) {
      if ((await NodeFSP.readdir(destination)).length)
        throw new Error("Serving worktree path is occupied");
      await NodeFSP.rmdir(destination);
    }
    await NodeFSP.rename(savedWorktrees, destination);
    await sync(sourceDirectory);
    await sync(baseDir);
  }
  return { sourceDirectory };
}

/** Relay invokes this as root only after activation committed. The root-owned
 * reservation confines deletion to the old identity; the serving home, checkout
 * and independent retained artifacts are never targets. A tombstone prevents
 * an enrollment retry from mistaking the new home for the original source. */
export async function cleanupThreadVmRestoreIdentity(
  input: ThreadVmRestoreBoot,
  baseDir = "/home/user/.launchpad",
  bootstrapPath = "/launchpad-restore.json",
  platform: NodeJS.Platform = HostProcessPlatform.defaultValue(),
) {
  const expected = decode(input);
  const bootstrap = await NodeFSP.lstat(bootstrapPath);
  if (
    !bootstrap.isFile() ||
    bootstrap.isSymbolicLink() ||
    bootstrap.nlink !== 1 ||
    bootstrap.size > 16384 ||
    (bootstrap.mode & 0o022) !== 0 ||
    (platform === "linux" && bootstrap.uid !== 0) ||
    expected.generation <= 1 ||
    !sameBoot(decode(JSON.parse(await NodeFSP.readFile(bootstrapPath, "utf8"))), expected)
  )
    throw new Error("Invalid cold boot scope");
  if (
    !NodePath.isAbsolute(baseDir) ||
    NodePath.resolve(baseDir) !== baseDir ||
    (await NodeFSP.realpath(NodePath.dirname(baseDir))) !== NodePath.dirname(baseDir)
  )
    throw new Error("Invalid serving home");
  const root = `${baseDir}-restores`,
    recovery = NodePath.join(root, expected.allocationId);
  for (const target of [root, recovery]) {
    const value = await directory(target);
    if (!value || (value.mode & 0o022) !== 0 || (platform === "linux" && value.uid !== 0))
      throw new Error("Invalid recovery reservation");
  }
  const recordPath = NodePath.join(recovery, "identity.json"),
    recordStat = await NodeFSP.lstat(recordPath);
  if (
    !recordStat.isFile() ||
    recordStat.isSymbolicLink() ||
    recordStat.nlink !== 1 ||
    (recordStat.mode & 0o022) !== 0 ||
    (platform === "linux" && recordStat.uid !== 0)
  )
    throw new Error("Invalid identity reservation");
  const record = decodeRecord(JSON.parse(await NodeFSP.readFile(recordPath, "utf8")));
  if (!sameBoot(record.boot, expected)) throw new Error("Identity reservation differs");
  const serving = await directory(baseDir);
  if (!serving || (platform === "linux" && serving.uid !== record.uid))
    throw new Error("Serving identity is missing");
  const tombstone = NodePath.join(recovery, "cleanup"),
    existing = await stat(tombstone);
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (existing.mode & 0o022) !== 0 ||
      (platform === "linux" && existing.uid !== 0)
    )
      throw new Error("Invalid cleanup reservation");
  } else {
    await NodeFSP.writeFile(tombstone, "activated\n", { flag: "wx", mode: 0o600 });
    await sync(tombstone);
    await sync(recovery);
  }
  const source = NodePath.join(recovery, "source");
  if (await directory(source)) await NodeFSP.rm(source, { recursive: true });
  await sync(recovery);
}
