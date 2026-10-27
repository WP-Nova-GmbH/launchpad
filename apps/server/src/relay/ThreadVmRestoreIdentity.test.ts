// @effect-diagnostics nodeBuiltinImport:off - Tests real atomic rename, inode ownership and symlinks at the cold restore boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  cleanupThreadVmRestoreIdentity,
  prepareThreadVmRestoreIdentity,
} from "./ThreadVmRestoreIdentity.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, lstat: vi.fn(actual.lstat), chown: vi.fn(actual.chown) };
});

async function fixture() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-restore-identity-")),
  );
  const baseDir = NodePath.join(root, ".launchpad"),
    bootstrapPath = NodePath.join(root, "boot.json");
  const boot = {
    version: 1 as const,
    operationId: NodeCrypto.randomUUID(),
    allocationId: NodeCrypto.randomUUID(),
    threadId: "thread",
    generation: 2,
  };
  await NodeFSP.mkdir(baseDir, { mode: 0o700 });
  await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"));
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "state.sqlite"),
    "saved-thread-history",
  );
  await NodeFSP.writeFile(NodePath.join(baseDir, "old-identity"), "old-narrow-credential", {
    mode: 0o600,
  });
  await NodeFSP.writeFile(bootstrapPath, JSON.stringify(boot), { mode: 0o600 });
  return {
    root,
    baseDir,
    bootstrapPath,
    boot,
    // Real filesystem behavior is independent of the guest's root/user ownership policy.
    prepare: (input = boot, bootstrap = bootstrapPath, platform: NodeJS.Platform = "darwin") =>
      prepareThreadVmRestoreIdentity(input, baseDir, bootstrap, platform),
    retire: (input = boot, platform: NodeJS.Platform = "darwin") =>
      cleanupThreadVmRestoreIdentity(input, baseDir, bootstrapPath, platform),
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

async function mockLinuxOwnership(f: Awaited<ReturnType<typeof fixture>>) {
  const native = await vi.importActual<typeof NodeFSP>("node:fs/promises");
  const source = await native.lstat(f.baseDir);
  const owners = new Map([[source.ino.toString(), { uid: 1000, gid: 1000 }]]);
  const overrides = new Map<string, number>();
  // Keep real inode/type/mode/link checks and filesystem operations. Only guest
  // ownership is simulated, so these cases do not require running tests as root.
  vi.mocked(NodeFSP.lstat).mockImplementation(async (file, options) => {
    const value = await native.lstat(file, options);
    if (!file.toString().startsWith(`${f.root}${NodePath.sep}`)) return value;
    return Object.assign(value, owners.get(value.ino.toString()) ?? { uid: 0, gid: 0 }, {
      uid: overrides.get(file.toString()) ?? owners.get(value.ino.toString())?.uid ?? 0,
    });
  });
  vi.mocked(NodeFSP.chown).mockImplementation(async (file, uid, gid) => {
    if (!file.toString().startsWith(`${f.root}${NodePath.sep}`))
      return native.chown(file, uid, gid);
    const value = await native.lstat(file);
    owners.set(value.ino.toString(), { uid, gid });
  });
  return {
    overrides,
    restore: () => {
      vi.mocked(NodeFSP.lstat).mockImplementation(native.lstat);
      vi.mocked(NodeFSP.chown).mockImplementation(native.chown);
    },
  };
}

describe("cold restore identity quarantine", () => {
  it("keeps thread worktree files at their original Git path while quarantining userdata and secrets", async () => {
    const f = await fixture();
    try {
      const worktree = NodePath.join(f.baseDir, "worktrees", "thread");
      await NodeFSP.mkdir(worktree, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(worktree, "uncommitted.txt"), "VM work");
      const result = await f.prepare();
      expect(await NodeFSP.readdir(f.baseDir)).toEqual(["worktrees"]);
      expect(await NodeFSP.readFile(NodePath.join(worktree, "uncommitted.txt"), "utf8")).toBe(
        "VM work",
      );
      expect(
        await NodeFSP.readFile(
          NodePath.join(result.sourceDirectory, "userdata", "state.sqlite"),
          "utf8",
        ),
      ).toBe("saved-thread-history");
      expect(await f.prepare()).toEqual(result);
      expect(await NodeFSP.readFile(NodePath.join(worktree, "uncommitted.txt"), "utf8")).toBe(
        "VM work",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("preserves the source history but starts enrollment with an empty home, and retries keep the new identity", async () => {
    const f = await fixture();
    try {
      const before = await NodeFSP.stat(f.baseDir),
        result = await f.prepare();
      expect((await NodeFSP.stat(result.sourceDirectory)).ino).toBe(before.ino);
      expect(await NodeFSP.readdir(f.baseDir)).toEqual([]);
      expect(
        await NodeFSP.readFile(
          NodePath.join(result.sourceDirectory, "userdata", "state.sqlite"),
          "utf8",
        ),
      ).toBe("saved-thread-history");
      await NodeFSP.writeFile(NodePath.join(f.baseDir, "fresh-identity"), "new-narrow-credential");
      expect(await f.prepare()).toEqual(result);
      expect(await NodeFSP.readdir(f.baseDir)).toEqual(["fresh-identity"]);
      expect(
        await NodeFSP.readFile(NodePath.join(result.sourceDirectory, "old-identity"), "utf8"),
      ).toBe("old-narrow-credential");
    } finally {
      await f.cleanup();
    }
  });
  it("recovers a crash after quarantining the old home without renaming that source again", async () => {
    const f = await fixture();
    try {
      const result = await f.prepare(),
        source = await NodeFSP.stat(result.sourceDirectory);
      await NodeFSP.rm(f.baseDir, { recursive: true });
      expect(await f.prepare()).toEqual(result);
      expect((await NodeFSP.stat(result.sourceDirectory)).ino).toBe(source.ino);
      expect(await NodeFSP.readdir(f.baseDir)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  it("refuses a foreign scope or generation before touching the old identity", async () => {
    const f = await fixture();
    try {
      for (const changed of [
        { ...f.boot, operationId: NodeCrypto.randomUUID() },
        { ...f.boot, allocationId: NodeCrypto.randomUUID() },
        { ...f.boot, threadId: "other" },
        { ...f.boot, generation: 3 },
      ])
        await expect(f.prepare(changed)).rejects.toThrow("Cold boot scope differs");
      expect(await NodeFSP.readFile(NodePath.join(f.baseDir, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );
      expect(await NodeFSP.readdir(f.root)).toEqual(
        expect.arrayContaining([".launchpad", "boot.json"]),
      );
      expect(await NodeFSP.readdir(f.root)).not.toContain(".launchpad-restores");
    } finally {
      await f.cleanup();
    }
  });
  it("rejects symlinked bootstrap or source homes, and writable control documents", async () => {
    const f = await fixture();
    try {
      const linked = NodePath.join(f.root, "linked-boot");
      await NodeFSP.symlink(f.bootstrapPath, linked);
      await expect(f.prepare(f.boot, linked)).rejects.toThrow("Invalid cold boot scope");
      await NodeFSP.chmod(f.bootstrapPath, 0o666);
      await expect(f.prepare()).rejects.toThrow("Invalid cold boot scope");
      await NodeFSP.chmod(f.bootstrapPath, 0o600);
      const old = NodePath.join(f.root, "source");
      await NodeFSP.rename(f.baseDir, old);
      await NodeFSP.symlink(old, f.baseDir);
      await expect(f.prepare()).rejects.toThrow("Invalid restore directory");
      expect(await NodeFSP.readFile(NodePath.join(old, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );
    } finally {
      await f.cleanup();
    }
  });
  it("never adopts a different durable reservation after a retry", async () => {
    const f = await fixture();
    try {
      const { sourceDirectory } = await f.prepare();
      const record = NodePath.join(NodePath.dirname(sourceDirectory), "identity.json");
      const saved = JSON.parse(await NodeFSP.readFile(record, "utf8"));
      saved.boot.threadId = "other";
      await NodeFSP.writeFile(record, JSON.stringify(saved));
      await expect(f.prepare()).rejects.toThrow("Identity reservation differs");
      expect(await NodeFSP.readdir(f.baseDir)).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(sourceDirectory, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );
    } finally {
      await f.cleanup();
    }
  });
  it("retired identity cleanup is idempotent and preserves fresh identity, checkout and unrelated allocations", async () => {
    const f = await fixture();
    try {
      const worktree = NodePath.join(f.baseDir, "worktrees", "thread");
      await NodeFSP.mkdir(worktree, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(worktree, "work"), "VM edits");
      const saved = await f.prepare();
      await NodeFSP.writeFile(NodePath.join(f.baseDir, "fresh-identity"), "keep");
      const unrelated = NodePath.join(f.baseDir + "-restores", NodeCrypto.randomUUID());
      await NodeFSP.mkdir(unrelated);
      await NodeFSP.writeFile(NodePath.join(unrelated, "keep"), "unrelated");
      for (const changed of [
        { ...f.boot, operationId: NodeCrypto.randomUUID() },
        { ...f.boot, allocationId: NodeCrypto.randomUUID() },
        { ...f.boot, generation: 3 },
      ])
        await expect(f.retire(changed)).rejects.toThrow("Invalid cold boot scope");
      expect(
        await NodeFSP.readFile(NodePath.join(saved.sourceDirectory, "old-identity"), "utf8"),
      ).toBe("old-narrow-credential");
      await f.retire();
      await f.retire();
      await expect(NodeFSP.stat(saved.sourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(NodePath.join(worktree, "work"), "utf8")).toBe("VM edits");
      expect(await NodeFSP.readFile(NodePath.join(f.baseDir, "fresh-identity"), "utf8")).toBe(
        "keep",
      );
      expect(await NodeFSP.readFile(NodePath.join(unrelated, "keep"), "utf8")).toBe("unrelated");
      await expect(f.prepare()).rejects.toThrow("retired");
    } finally {
      await f.cleanup();
    }
  });
  it("cleanup rechecks trusted reservation ownership and refuses linked paths", async () => {
    const f = await fixture();
    try {
      const saved = await f.prepare(),
        reservation = NodePath.dirname(saved.sourceDirectory);
      await NodeFSP.chmod(reservation, 0o777);
      await expect(f.retire()).rejects.toThrow("Invalid recovery reservation");
      await NodeFSP.chmod(reservation, 0o755);
      const original = saved.sourceDirectory + "-keep";
      await NodeFSP.rename(saved.sourceDirectory, original);
      await NodeFSP.symlink(original, saved.sourceDirectory);
      await expect(f.retire()).rejects.toThrow("Invalid restore directory");
      expect(await NodeFSP.readFile(NodePath.join(original, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );
    } finally {
      await f.cleanup();
    }
  });

  it("enforces Linux root-owned controls and preserves the UID 1000 serving identity", async () => {
    const f = await fixture();
    const ownership = await mockLinuxOwnership(f);
    const prepare = () => f.prepare(f.boot, f.bootstrapPath, "linux");
    const retire = () => f.retire(f.boot, "linux");
    try {
      ownership.overrides.set(f.bootstrapPath, 1000);
      await expect(prepare()).rejects.toThrow("Invalid cold boot scope");
      ownership.overrides.delete(f.bootstrapPath);
      ownership.overrides.set(f.baseDir, 0);
      await expect(prepare()).rejects.toThrow("Saved source home is missing");
      ownership.overrides.delete(f.baseDir);
      expect(await NodeFSP.readFile(NodePath.join(f.baseDir, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );

      const saved = await prepare();
      const recovery = NodePath.dirname(saved.sourceDirectory);
      const record = NodePath.join(recovery, "identity.json");
      expect(JSON.parse(await NodeFSP.readFile(record, "utf8"))).toMatchObject({
        uid: 1000,
        gid: 1000,
      });
      await NodeFSP.writeFile(NodePath.join(f.baseDir, "fresh-identity"), "keep");
      expect(await prepare()).toEqual(saved);

      for (const [target, prepareError, cleanupError] of [
        [f.bootstrapPath, "Invalid cold boot scope", "Invalid cold boot scope"],
        [f.baseDir + "-restores", "Invalid recovery root", "Invalid recovery reservation"],
        [recovery, "Invalid recovery reservation", "Invalid recovery reservation"],
        [record, "Invalid identity reservation", "Invalid identity reservation"],
      ] as const) {
        ownership.overrides.set(target, 1000);
        await expect(prepare()).rejects.toThrow(prepareError);
        await expect(retire()).rejects.toThrow(cleanupError);
        ownership.overrides.delete(target);
      }
      ownership.overrides.set(f.baseDir, 0);
      await expect(retire()).rejects.toThrow("Serving identity is missing");
      ownership.overrides.delete(f.baseDir);
      expect(
        await NodeFSP.readFile(NodePath.join(saved.sourceDirectory, "old-identity"), "utf8"),
      ).toBe("old-narrow-credential");

      await retire();
      await expect(NodeFSP.stat(saved.sourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      ownership.overrides.set(NodePath.join(recovery, "cleanup"), 1000);
      await expect(retire()).rejects.toThrow("Invalid cleanup reservation");
      ownership.overrides.clear();
      await retire();
      expect(await NodeFSP.readFile(NodePath.join(f.baseDir, "fresh-identity"), "utf8")).toBe(
        "keep",
      );
    } finally {
      ownership.restore();
      await f.cleanup();
    }
  });
});
