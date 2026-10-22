import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import type * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { ProcessRunner } from "../processRunner.ts";
import { workspaceGit } from "./ThreadWorkspaceGit.ts";
import { physicalFs, workspaceFileSystem } from "./ThreadWorkspaceFileSystem.ts";
import {
  workspaceFailure,
  type ThreadWorkspaceTransferError,
} from "./ThreadWorkspaceTransferError.ts";

import { WorkspaceFile } from "@t3tools/contracts/threadTransfer";
export { WorkspaceFile } from "@t3tools/contracts/threadTransfer";
export { ThreadWorkspaceTransferError, workspaceFailure } from "./ThreadWorkspaceTransferError.ts";
const foldPath = (value: string) => value.normalize("NFD").toLowerCase();

/** Keep the format portable between the supported Mac and Linux filesystems. */
export function safeWorkspacePath(value: string) {
  return (
    value.length > 0 &&
    !value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part.toLowerCase() === ".t3" ||
          /[\\:]/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/.test(part),
      )
  );
}

export const workspaceFileHash = Effect.fnUntraced(function* (file: string) {
  const fs = yield* workspaceFileSystem;
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  yield* fs.stream(file).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        size += chunk.length;
        hash.update(chunk);
      }),
    ),
  );
  return { sha256: hash.digest("hex"), size };
});

// lstat is essential here: directory symlinks are data, never traversal instructions.
const lstat = (file: string) =>
  Effect.tryPromise({
    try: () => physicalFs.promises.lstat(file, { bigint: true }),
    catch: () => workspaceFailure("Workspace changed or became unreadable during transfer."),
  });
const signature = (stat: NodeFS.BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const validateWorkspaceFiles = Effect.fnUntraced(function* (
  files: ReadonlyArray<WorkspaceFile>,
) {
  const paths = new Map<string, WorkspaceFile>();
  const folded = new Map<string, WorkspaceFile>();
  for (const file of files) {
    if (!safeWorkspacePath(file.path) || paths.has(file.path) || folded.has(foldPath(file.path)))
      return yield* workspaceFailure(
        "Workspace paths are unsafe, duplicated, or collide on the destination filesystem.",
      );
    paths.set(file.path, file);
    folded.set(foldPath(file.path), file);
  }
  const targetParts = (target: string) =>
    !target || target.startsWith("/") || target.includes("\\") || target.includes("\0")
      ? null
      : target.split("/").toReversed();
  for (const file of files) {
    const parent = file.path.split("/").slice(0, -1);
    if (parent.length && paths.get(parent.join("/"))?.kind !== "directory")
      return yield* workspaceFailure("Workspace entries have a missing or non-directory parent.");
    if (file.kind === "symlink") {
      const remaining = targetParts(file.target);
      if (remaining === null)
        return yield* workspaceFailure(
          "A workspace symlink points outside the transferable repository.",
        );
      const resolved = [...parent];
      let followed = 1;
      // Expand links before processing later '..' components, as the filesystem does.
      while (remaining.length) {
        const part = remaining.pop()!;
        if (!part || part === ".") continue;
        if (part === "..") {
          if (!resolved.length)
            return yield* workspaceFailure(
              "A workspace symlink points outside the transferable repository.",
            );
          resolved.pop();
          continue;
        }
        if (!safeWorkspacePath(part))
          return yield* workspaceFailure(
            "A workspace symlink points outside the transferable repository.",
          );
        resolved.push(part);
        // Treat case/Unicode aliases conservatively for the supported Mac filesystem.
        const next = folded.get(foldPath(resolved.join("/")));
        if (next?.kind !== "symlink") continue;
        if (++followed > 40)
          return yield* workspaceFailure(
            "A workspace symlink contains a cycle or exceeds the supported link depth.",
          );
        const target = targetParts(next.target);
        if (target === null)
          return yield* workspaceFailure(
            "A workspace symlink points outside the transferable repository.",
          );
        resolved.pop();
        for (const component of target) remaining.push(component);
      }
    }
  }
});

/** Writers must already be stopped. Repeated signatures/hashes detect changes; they cannot freeze external writers. */
export const scanWorkspaceFiles = Effect.fn("scanWorkspaceFiles")(function* (root: string) {
  const fs = yield* workspaceFileSystem;
  const path = yield* Path.Path;
  const files: WorkspaceFile[] = [];
  const sqlite = new Set<string>();
  const excludedPaths: string[] = [];
  let dependencyPaths: Set<string> | undefined;
  const walk = Effect.fnUntraced(function* (
    relative: string,
    inDependencies = false,
  ): Effect.fn.Return<
    void,
    ThreadWorkspaceTransferError | import("effect/PlatformError").PlatformError,
    FileSystem.FileSystem | Path.Path | ProcessRunner
  > {
    const directory = path.join(root, relative);
    const before = yield* lstat(directory);
    if (!before.isDirectory() || (yield* fs.realPath(directory)) !== directory)
      return yield* workspaceFailure("A workspace directory changed into a link during transfer.");
    for (const name of (yield* fs.readDirectory(directory)).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      const dependency = inDependencies || name.toLowerCase() === "node_modules";
      if (name.toLowerCase() === ".t3") {
        excludedPaths.push(entry);
        continue;
      }
      if (dependency) {
        // Tracked node_modules fixtures are source. Only indexed paths and their parents travel.
        if (!dependencyPaths) {
          dependencyPaths = new Set();
          const tracked = (yield* workspaceGit(root, ["ls-files", "-z"])).stdout;
          for (const file of tracked.split("\0").filter(Boolean)) {
            const parts = file.split("/");
            if (!parts.some((part) => part.toLowerCase() === "node_modules")) continue;
            for (let i = 1; i <= parts.length; i++)
              dependencyPaths.add(parts.slice(0, i).join("/"));
          }
        }
        if (!dependencyPaths.has(entry)) {
          excludedPaths.push(entry);
          continue;
        }
      }
      if (name.toLowerCase() === ".git") {
        if (!relative) continue;
        return yield* workspaceFailure(
          "Nested repositories and submodules must be removed or handled before moving.",
        );
      }
      if (!safeWorkspacePath(entry))
        return yield* workspaceFailure("A workspace filename cannot be transferred safely.");
      const full = path.join(root, entry);
      const stat = yield* lstat(full);
      if (stat.isSymbolicLink())
        files.push({ kind: "symlink", path: entry, target: yield* fs.readLink(full) });
      else if (stat.isDirectory()) {
        files.push({ kind: "directory", path: entry });
        yield* walk(entry, dependency);
      } else if (stat.isFile()) {
        if (name === "PG_VERSION" || name === "WiredTiger")
          return yield* workspaceFailure(
            "This database requires an explicit stopped-workload export before moving.",
          );
        const header = yield* fs.stream(full, { bytesToRead: 16 }).pipe(Stream.runCollect);
        if (Buffer.concat(header).toString("utf8") === "SQLite format 3\0") sqlite.add(entry);
        files.push({
          kind: "file",
          path: entry,
          ...(yield* workspaceFileHash(full)),
          executable: (stat.mode & 0o111n) !== 0n,
        });
      } else
        return yield* workspaceFailure(
          "Sockets, devices, and other live workspace files cannot be transferred.",
        );
      if (signature(yield* lstat(full)) !== signature(stat))
        return yield* workspaceFailure(
          "A workspace file changed during transfer; stop its writer and retry.",
        );
    }
    if (signature(yield* lstat(directory)) !== signature(before))
      return yield* workspaceFailure("Workspace entries changed during transfer.");
  });
  yield* walk("");
  yield* validateWorkspaceFiles(files);
  return { files, sqlite, excludedPaths: excludedPaths.sort() };
});

export const copyWorkspaceFiles = Effect.fn("copyWorkspaceFiles")(function* (
  root: string,
  artifact: string,
  scan: Effect.Success<ReturnType<typeof scanWorkspaceFiles>>,
) {
  const fs = yield* workspaceFileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(artifact, "objects"), { mode: 0o700 });
  const output: WorkspaceFile[] = [];
  for (const file of scan.files) {
    if (
      ["-wal", "-shm", "-journal"].some(
        (suffix) =>
          file.path.endsWith(suffix) && scan.sqlite.has(file.path.slice(0, -suffix.length)),
      )
    )
      continue;
    if (file.kind !== "file") {
      output.push(file);
      continue;
    }
    const source = path.join(root, file.path);
    if ((yield* fs.realPath(source)) !== source)
      return yield* workspaceFailure("Workspace file changed into a link.");
    if (scan.sqlite.has(file.path)) {
      const candidate = path.join(artifact, "sqlite-candidate");
      // SQLite's backup API includes committed WAL data and excludes unfinished transactions.
      // Let an admitted backup finish before closing its connection on interruption.
      yield* Effect.tryPromise({
        try: async () => {
          const db = new NodeSqlite.DatabaseSync(source, { readOnly: true, allowExtension: false });
          try {
            await NodeSqlite.backup(db, candidate);
          } finally {
            db.close();
          }
          const copy = new NodeSqlite.DatabaseSync(candidate, {
            readOnly: true,
            allowExtension: false,
          });
          try {
            const rows = copy.prepare("PRAGMA quick_check").all();
            if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
              throw new Error("invalid SQLite backup");
          } finally {
            copy.close();
          }
        },
        catch: () => workspaceFailure("SQLite backup could not be verified."),
      }).pipe(Effect.uninterruptible);
      const digest = yield* workspaceFileHash(candidate);
      yield* fs.rename(candidate, path.join(artifact, "objects", digest.sha256));
      output.push({ ...file, ...digest });
    } else {
      const target = path.join(artifact, "objects", file.sha256);
      if (!(yield* fs.exists(target))) yield* fs.copyFile(source, target);
      const digest = yield* workspaceFileHash(target);
      if (digest.sha256 !== file.sha256 || digest.size !== file.size)
        return yield* workspaceFailure("Workspace bytes changed during transfer.");
      output.push(file);
    }
    const copied = output[output.length - 1]!;
    if (copied.kind === "file")
      yield* fs.chmod(path.join(artifact, "objects", copied.sha256), 0o600);
  }
  const after = yield* scanWorkspaceFiles(root);
  // SQLite's shared-memory lock bookkeeping may change when opening a read connection.
  const stable = (value: typeof scan) =>
    value.files.filter(
      (file) => !(file.path.endsWith("-shm") && value.sqlite.has(file.path.slice(0, -4))),
    );
  if (!NodeUtil.isDeepStrictEqual(stable(after), stable(scan)))
    return yield* workspaceFailure("Workspace changed during export; stop its writers and retry.");
  return output;
});

export const materializeWorkspaceFiles = Effect.fn("materializeWorkspaceFiles")(function* (
  files: ReadonlyArray<WorkspaceFile>,
  artifact: string,
  destination: string,
) {
  const fs = yield* workspaceFileSystem;
  const path = yield* Path.Path;
  yield* validateWorkspaceFiles(files);
  for (const file of [...files].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length,
  )) {
    const target = path.join(destination, file.path);
    if (file.kind === "directory") yield* fs.makeDirectory(target, { mode: 0o700 });
    else if (file.kind === "symlink") yield* fs.symlink(file.target, target);
    else {
      const source = path.join(artifact, "objects", file.sha256);
      if ((yield* fs.realPath(source)) !== source || !(yield* lstat(source)).isFile())
        return yield* workspaceFailure("Workspace object is not a regular artifact file.");
      yield* Effect.tryPromise({
        try: () => physicalFs.promises.copyFile(source, target, physicalFs.constants.COPYFILE_EXCL),
        catch: () =>
          workspaceFailure(
            "A destination file appeared during installation; it was not overwritten.",
          ),
      });
      const digest = yield* workspaceFileHash(target);
      if (digest.sha256 !== file.sha256 || digest.size !== file.size)
        return yield* workspaceFailure("Workspace object failed its integrity check.");
      yield* fs.chmod(target, file.executable ? 0o700 : 0o600);
    }
  }
});
