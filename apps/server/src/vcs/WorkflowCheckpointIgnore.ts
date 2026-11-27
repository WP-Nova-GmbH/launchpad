// @effect-diagnostics nodeBuiltinImport:off - No-follow/nonblocking open flags.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const MAX_IGNORE_RULES_BYTES = 64 * 1024;
const flags =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

/** Read only checkout-local ignore rules, using directory handles in Linux guests. */
export const readWorkflowIgnoreRules = Effect.fnUntraced(function* (cwd: string) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.tryPromise(async () => {
    const opened: NodeFSP.FileHandle[] = [];
    const open = async (path: string, directory: boolean, optional = false) => {
      try {
        // On development hosts without Linux's descriptor-relative paths, bind
        // the opened handle to the same canonical inode observed at the path.
        const before = platform !== "linux" ? await NodeFSP.lstat(path, { bigint: true }) : null;
        if (before && (before.isSymbolicLink() || (await NodeFSP.realpath(path)) !== path))
          throw new Error("Unsafe Git ignore path.");
        const handle = await NodeFSP.open(
          path,
          flags | (directory ? (NodeFS.constants.O_DIRECTORY ?? 0) : 0),
        );
        opened.push(handle);
        const actual = await handle.stat({ bigint: true });
        if (
          (directory ? !actual.isDirectory() : !actual.isFile() || actual.nlink !== 1n) ||
          (before && (before.ino !== actual.ino || before.dev !== actual.dev))
        )
          throw new Error("Unsafe Git ignore path.");
        return { handle, path, actual };
      } catch (cause) {
        if (optional && (cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    };
    const childPath = (parent: { handle: NodeFSP.FileHandle; path: string }, name: string) =>
      NodePath.join(platform === "linux" ? `/proc/self/fd/${parent.handle.fd}` : parent.path, name);

    try {
      const checkout = (await open(cwd, true))!;
      const git = (await open(childPath(checkout, ".git"), true))!;
      const info = await open(childPath(git, "info"), true, true);
      const file = info && (await open(childPath(info, "exclude"), false, true));
      if (!file) return new Uint8Array();
      if (file.actual.size > BigInt(MAX_IGNORE_RULES_BYTES))
        throw new Error("The Git ignore file is too large.");
      const buffer = new Uint8Array(MAX_IGNORE_RULES_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await file.handle.stat({ bigint: true });
      if (
        offset > MAX_IGNORE_RULES_BYTES ||
        BigInt(offset) !== file.actual.size ||
        after.ctimeNs !== file.actual.ctimeNs
      )
        throw new Error("The Git ignore file changed or is too large.");
      return buffer.slice(0, offset);
    } finally {
      await Promise.all(opened.map((handle) => handle.close()));
    }
  });
});
