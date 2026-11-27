// @effect-diagnostics nodeBuiltinImport:off - Linux descriptor-relative filesystem reads.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

interface Paths extends Map<string, Paths> {}

const fileFlags =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);
const directoryFlags = fileFlags | (NodeFS.constants.O_DIRECTORY ?? 0);

/** Materialize Git's candidate paths without letting a rename or symlink expose coordinator files. */
export const copyWorkflowCheckpointWorkspace = Effect.fnUntraced(function* (
  checkout: string,
  snapshot: string,
  candidates: ReadonlyArray<string>,
) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.tryPromise(async () => {
    const paths: Paths = new Map();
    for (const candidate of candidates) {
      let directory = paths;
      for (const name of candidate.split("/")) {
        if (!name || name === "." || name === ".." || name.toLowerCase() === ".git")
          throw new Error("Unsafe workflow checkpoint path.");
        let children = directory.get(name);
        if (!children) directory.set(name, (children = new Map()));
        directory = children;
      }
    }

    const root = await NodeFSP.open(checkout, directoryFlags);
    const fdPath = (file: NodeFSP.FileHandle, path: string) =>
      platform === "linux" ? `/proc/self/fd/${file.fd}` : path;
    const sameFile = (before: NodeFS.BigIntStats, after: NodeFS.BigIntStats) =>
      before.ino === after.ino && before.dev === after.dev && before.uid === after.uid;
    try {
      const owner = (await root.stat({ bigint: true })).uid;
      const copy = async (
        source: NodeFSP.FileHandle,
        sourcePath: string,
        destination: string,
        entries: Paths,
      ) => {
        for (const [name, children] of entries) {
          const input = NodePath.join(fdPath(source, sourcePath), name);
          const output = NodePath.join(destination, name);
          const before = await NodeFSP.lstat(input, { bigint: true }).catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          });
          // An absent seed path is a deletion. A symlink is Git data, never a directory to enter.
          if (!before) continue;
          if (before.uid !== owner) throw new Error("Unsafe workflow checkpoint file owner.");
          if (before.isSymbolicLink()) {
            await NodeFSP.symlink(await NodeFSP.readlink(input, { encoding: "buffer" }), output);
            continue;
          }
          if (before.isDirectory()) {
            if (!children.size) continue;
            const directory = await NodeFSP.open(input, directoryFlags);
            try {
              const after = await directory.stat({ bigint: true });
              if (!after.isDirectory() || !sameFile(before, after))
                throw new Error("Workflow checkpoint directory changed.");
              await NodeFSP.mkdir(output, { mode: 0o700 });
              await copy(directory, input, output, children);
            } finally {
              await directory.close();
            }
            continue;
          }
          if (!before.isFile()) throw new Error("Unsupported workflow checkpoint file.");
          const file = await NodeFSP.open(input, fileFlags);
          try {
            const opened = await file.stat({ bigint: true });
            if (!opened.isFile() || !sameFile(before, opened))
              throw new Error("Workflow checkpoint file changed.");
            if (platform === "linux") {
              await NodeFSP.copyFile(
                fdPath(file, input),
                output,
                NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
              );
            } else {
              await NodeStreamPromises.pipeline(
                file.createReadStream({ autoClose: false }),
                NodeFS.createWriteStream(output, { flags: "wx", mode: 0o600 }),
              );
            }
            const after = await file.stat({ bigint: true });
            if (after.ctimeNs !== opened.ctimeNs || after.size !== opened.size)
              throw new Error("Workflow checkpoint file changed while being copied.");
            await NodeFSP.chmod(output, (opened.mode & 0o100n) !== 0n ? 0o700 : 0o600);
          } finally {
            await file.close();
          }
        }
      };
      await copy(root, checkout, snapshot, paths);
    } finally {
      await root.close();
    }
  });
});
