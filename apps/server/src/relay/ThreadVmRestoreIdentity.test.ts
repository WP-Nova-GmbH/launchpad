// @effect-diagnostics nodeBuiltinImport:off - Tests real atomic rename, inode ownership and symlinks at the cold restore boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  cleanupThreadVmRestoreIdentity,
  prepareThreadVmRestoreIdentity,
} from "./ThreadVmRestoreIdentity.ts";

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
    prepare: () => prepareThreadVmRestoreIdentity(boot, baseDir, bootstrapPath),
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
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
        await expect(
          prepareThreadVmRestoreIdentity(changed, f.baseDir, f.bootstrapPath),
        ).rejects.toThrow();
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
      await expect(prepareThreadVmRestoreIdentity(f.boot, f.baseDir, linked)).rejects.toThrow();
      await NodeFSP.chmod(f.bootstrapPath, 0o666);
      await expect(f.prepare()).rejects.toThrow();
      await NodeFSP.chmod(f.bootstrapPath, 0o600);
      const old = NodePath.join(f.root, "source");
      await NodeFSP.rename(f.baseDir, old);
      await NodeFSP.symlink(old, f.baseDir);
      await expect(f.prepare()).rejects.toThrow();
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
      await expect(f.prepare()).rejects.toThrow();
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
        await expect(
          cleanupThreadVmRestoreIdentity(changed, f.baseDir, f.bootstrapPath),
        ).rejects.toThrow();
      expect(
        await NodeFSP.readFile(NodePath.join(saved.sourceDirectory, "old-identity"), "utf8"),
      ).toBe("old-narrow-credential");
      await cleanupThreadVmRestoreIdentity(f.boot, f.baseDir, f.bootstrapPath);
      await cleanupThreadVmRestoreIdentity(f.boot, f.baseDir, f.bootstrapPath);
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
      await expect(
        cleanupThreadVmRestoreIdentity(f.boot, f.baseDir, f.bootstrapPath),
      ).rejects.toThrow();
      await NodeFSP.chmod(reservation, 0o755);
      const original = saved.sourceDirectory + "-keep";
      await NodeFSP.rename(saved.sourceDirectory, original);
      await NodeFSP.symlink(original, saved.sourceDirectory);
      await expect(
        cleanupThreadVmRestoreIdentity(f.boot, f.baseDir, f.bootstrapPath),
      ).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(original, "old-identity"), "utf8")).toBe(
        "old-narrow-credential",
      );
    } finally {
      await f.cleanup();
    }
  });
});
