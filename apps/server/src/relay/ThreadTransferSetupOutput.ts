import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { workspaceFileSystem } from "./ThreadWorkspaceFileSystem.ts";
import {
  WorkspaceFile,
  safeWorkspacePath,
  scanWorkspaceFiles,
  workspaceFailure,
} from "./ThreadWorkspaceFiles.ts";

const excludedPath = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const parts = value.split("/");
    const name = parts.pop()?.toLowerCase();
    return (
      (safeWorkspacePath(value) &&
        value.split("/").some((part) => part.toLowerCase() === "node_modules")) ||
      (name === ".t3" && (parts.length === 0 || safeWorkspacePath(parts.join("/"))))
    );
  }),
);
export const ThreadTransferSetupOutput = Schema.Struct({
  files: Schema.Array(WorkspaceFile),
  excludedPaths: Schema.Array(excludedPath),
});
export const decodeThreadTransferSetupOutput = Schema.decodeEffect(
  Schema.fromJsonString(ThreadTransferSetupOutput),
);
const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(ThreadTransferSetupOutput));

/** Record only after the setup process has exited. Uncertain startup has no
 * receipt, so cancellation retains its fence instead of assuming it stopped. */
export const captureThreadTransferSetupOutput = Effect.fnUntraced(function* (root: string) {
  const { files, excludedPaths } = yield* scanWorkspaceFiles(root);
  return yield* encodeOutput({ files, excludedPaths: [...excludedPaths].sort() });
});

/** Preserve generated dependency/runtime entries outside the checkout. Rename
 * stays on the same filesystem and retries never delete an unrecognized entry. */
export const retainThreadTransferSetupDirectories = Effect.fnUntraced(function* (input: {
  checkoutPath: string;
  operationId: string;
  excludedPaths: ReadonlyArray<string>;
}) {
  const fs = yield* workspaceFileSystem,
    path = yield* Path.Path;
  const token = NodeCrypto.createHash("sha256").update(input.operationId).digest("hex");
  const directory = path.join(
    path.dirname(input.checkoutPath),
    `.launchpad-move-recovery-${token}`,
  );
  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  if ((yield* fs.realPath(directory)) !== directory)
    return yield* workspaceFailure("The move recovery directory changed into a link.");
  for (const relative of input.excludedPaths) {
    yield* Schema.decodeEffect(excludedPath)(relative);
    const source = path.join(input.checkoutPath, relative),
      destination = path.join(directory, relative);
    // readDirectory observes dangling links too; exists alone follows a link.
    const sourcePresent =
      (yield* fs.exists(path.dirname(source))) &&
      (yield* fs.readDirectory(path.dirname(source))).includes(path.basename(source));
    const destinationPresent =
      (yield* fs.exists(path.dirname(destination))) &&
      (yield* fs.readDirectory(path.dirname(destination))).includes(path.basename(destination));
    if (sourcePresent && destinationPresent)
      return yield* workspaceFailure(
        "Generated setup data changed during cancellation; keep its recovery hold.",
      );
    if (!sourcePresent) continue;
    yield* fs.makeDirectory(path.dirname(destination), { mode: 0o700, recursive: true });
    if (
      (yield* fs.realPath(path.dirname(destination))) !== path.dirname(destination) ||
      (yield* fs.realPath(path.dirname(source))) !== path.dirname(source)
    )
      return yield* workspaceFailure("Setup recovery cannot follow linked directories.");
    yield* fs.rename(source, destination);
    for (const parent of [path.dirname(source), path.dirname(destination)])
      yield* Effect.scoped(
        fs.open(parent, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
      );
  }
});
