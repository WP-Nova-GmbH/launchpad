import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class LinuxNodePtyError extends Schema.TaggedError<LinuxNodePtyError>()("LinuxNodePtyError", {
  message: Schema.String,
}) {}
const decodePackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

/** Linux node-pty is source-built; its npm package only ships Mac/Windows prebuilds. */
export const stageLinuxNodePty = Effect.fn("stageLinuxNodePty")(function* (input: {
  packageDirectory: string;
  arch: "arm64" | "x64";
  nativePackageDirectory?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = input.nativePackageDirectory ?? input.packageDirectory;
  if (input.nativePackageDirectory) {
    const [expected, supplied] = yield* Effect.forEach(
      [input.packageDirectory, source],
      (directory) =>
        fs.readFileString(path.join(directory, "package.json")).pipe(Effect.flatMap(decodePackage)),
    );
    if (supplied!.name !== "node-pty" || supplied!.version !== expected!.version)
      return yield* new LinuxNodePtyError({
        message: "The supplied Linux node-pty package must match the staged package version.",
      });
  }
  const candidates = [
    path.join(source, "prebuilds", `linux-${input.arch}`, "pty.node"),
    path.join(source, "build", "Release", "pty.node"),
  ];
  for (const candidate of candidates) {
    if (!(yield* fs.exists(candidate))) continue;
    const bytes = yield* fs.readFile(candidate);
    // Reject a host build accidentally left by a cross-platform staged install.
    const machine = input.arch === "arm64" ? 183 : 62;
    if (bytes.length < 20) continue;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      header.getUint32(0) !== 0x7f454c46 ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      header.getUint16(18, true) !== machine
    )
      continue;
    const destination = path.join(input.packageDirectory, "prebuilds", `linux-${input.arch}`);
    yield* fs.makeDirectory(destination, { recursive: true });
    const target = path.join(destination, "pty.node");
    yield* fs.writeFile(target, bytes);
    yield* fs.chmod(target, 0o755);
    return;
  }
  return yield* new LinuxNodePtyError({
    message: `Missing a Linux ${input.arch} node-pty binary. Build the archive on the target architecture or pass --node-pty-dir with the same node-pty version compiled there.`,
  });
});
