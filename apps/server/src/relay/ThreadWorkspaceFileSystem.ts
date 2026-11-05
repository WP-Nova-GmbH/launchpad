// @effect-diagnostics nodeBuiltinImport:off - Workspace transfers need physical files rather than Electron's virtual ASAR view.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

/** Loading application modules remains ASAR-aware; only workspace I/O uses this API. */
export const physicalFs: typeof NodeFS = process.versions.electron
  ? NodeModule.createRequire(import.meta.url)("original-fs")
  : NodeFS;

const errors: Record<string, PlatformError.SystemErrorTag> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ENOTDIR: "BadResource",
  ELOOP: "BadResource",
  EBUSY: "Busy",
};
const run = <A>(
  method: string,
  path: string | number,
  action: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      PlatformError.systemError({
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        _tag: errors[(cause as NodeJS.ErrnoException).code ?? ""] ?? "Unknown",
        cause,
      }),
  });
const number = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("File metadata exceeds safe integers.");
  return result;
};
const optionalNumber = (value: bigint | undefined) =>
  value === undefined || !Number.isSafeInteger(Number(value))
    ? Option.none<number>()
    : Option.some(Number(value));
const info = (stat: NodeFS.BigIntStats) =>
  Effect.try({
    try: (): FileSystem.File.Info => ({
      type: stat.isFile()
        ? "File"
        : stat.isDirectory()
          ? "Directory"
          : stat.isSymbolicLink()
            ? "SymbolicLink"
            : stat.isBlockDevice()
              ? "BlockDevice"
              : stat.isCharacterDevice()
                ? "CharacterDevice"
                : stat.isFIFO()
                  ? "FIFO"
                  : stat.isSocket()
                    ? "Socket"
                    : "Unknown",
      mtime: Option.fromNullishOr(stat.mtime),
      atime: Option.fromNullishOr(stat.atime),
      birthtime: Option.fromNullishOr(stat.birthtime),
      dev: number(stat.dev),
      mode: number(stat.mode),
      ino: optionalNumber(stat.ino),
      nlink: optionalNumber(stat.nlink),
      uid: optionalNumber(stat.uid),
      gid: optionalNumber(stat.gid),
      rdev: optionalNumber(stat.rdev),
      size: ByteSize.bytes(stat.size),
      blksize: Option.fromNullishOr(stat.blksize).pipe(Option.map(ByteSize.bytes)),
      blocks: optionalNumber(stat.blocks),
    }),
    catch: (cause) => PlatformError.badArgument({ module: "FileSystem", method: "stat", cause }),
  });

const open: FileSystem.FileSystem["open"] = Effect.fnUntraced(function* (path, options) {
  const handle = yield* Effect.acquireRelease(
    run("open", path, () => physicalFs.promises.open(path, options?.flag ?? "r", options?.mode)),
    (handle) => run("close", path, () => handle.close()).pipe(Effect.orDie),
  );
  let position = 0n;
  const append = options?.flag?.startsWith("a") ?? false;
  const read = Effect.fnUntraced(function* (buffer: Uint8Array) {
    const result = yield* run("read", path, () => handle.read({ buffer, position }));
    position += BigInt(result.bytesRead);
    return result.bytesRead;
  });
  const write = Effect.fnUntraced(function* (buffer: Uint8Array) {
    const result = yield* run("write", path, () =>
      handle.write(buffer, 0, buffer.length, append ? null : number(position)),
    );
    if (!append) position += BigInt(result.bytesWritten);
    return result.bytesWritten;
  });
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: run("stat", path, () => handle.stat({ bigint: true })).pipe(Effect.flatMap(info)),
    sync: run("sync", path, () => handle.sync()),
    seek: (offset, from) =>
      Effect.try({
        try: () => {
          const next = from === "start" ? offset : position + offset;
          if (next < 0n) throw new RangeError("Cannot seek before the start of a file.");
          position = next;
          return next;
        },
        catch: (cause) =>
          PlatformError.badArgument({ module: "FileSystem", method: "seek", cause }),
      }),
    read,
    readAlloc: Effect.fnUntraced(function* (size) {
      const buffer = yield* Effect.try({
        try: () => {
          if (!Number.isInteger(size) || size < 0)
            throw new RangeError("Read size must be a non-negative integer.");
          return Buffer.allocUnsafeSlow(size);
        },
        catch: (cause) =>
          PlatformError.badArgument({ module: "FileSystem", method: "readAlloc", cause }),
      });
      const bytes = yield* read(buffer);
      return bytes === 0 ? Option.none() : Option.some(buffer.subarray(0, bytes));
    }),
    truncate: (length = 0) =>
      run("truncate", path, () => handle.truncate(length)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!append && position > BigInt(length)) position = BigInt(length);
          }),
        ),
      ),
    write,
    writeAll: Effect.fnUntraced(function* (buffer) {
      let offset = 0;
      while (offset < buffer.length) {
        const written = yield* write(buffer.subarray(offset));
        if (written === 0)
          return yield* PlatformError.systemError({
            module: "FileSystem",
            method: "writeAll",
            pathOrDescriptor: path,
            _tag: "WriteZero",
          });
        offset += written;
      }
    }),
  } satisfies FileSystem.File;
});

/** Preserve injected Node/test services; Electron workspaces use physical primitives and derived streams. */
export const workspaceFileSystem = Effect.map(FileSystem.FileSystem, (base) => {
  if (!process.versions.electron) return base;
  const remove: FileSystem.FileSystem["remove"] = (path, options) =>
    run("remove", path, () => physicalFs.promises.rm(path, options));
  const makeTempDirectory: FileSystem.FileSystem["makeTempDirectory"] = (options) => {
    const directory = options?.directory ?? NodeOS.tmpdir();
    const prefix = options?.prefix ?? "";
    return run("makeTempDirectory", directory, () =>
      physicalFs.promises.mkdtemp(
        prefix ? NodePath.join(directory, prefix) : directory + NodePath.sep,
      ),
    );
  };
  const makeTempFile: FileSystem.FileSystem["makeTempFile"] = Effect.fnUntraced(
    function* (options) {
      const directory = yield* makeTempDirectory(options);
      const file = NodePath.join(directory, `${NodeCrypto.randomUUID()}${options?.suffix ?? ""}`);
      yield* run("makeTempFile", file, () => physicalFs.promises.writeFile(file, new Uint8Array()));
      return file;
    },
  );
  return FileSystem.make({
    ...base,
    open,
    access: (path, options) =>
      run("access", path, () =>
        physicalFs.promises.access(
          path,
          (options?.readable ? physicalFs.constants.R_OK : 0) |
            (options?.writable ? physicalFs.constants.W_OK : 0),
        ),
      ),
    chmod: (path, mode) => run("chmod", path, () => physicalFs.promises.chmod(path, mode)),
    chown: (path, uid, gid) => run("chown", path, () => physicalFs.promises.chown(path, uid, gid)),
    copy: (from, to, options) =>
      run("copy", from, () =>
        physicalFs.promises.cp(from, to, {
          recursive: true,
          force: options?.overwrite ?? false,
          preserveTimestamps: options?.preserveTimestamps ?? false,
        }),
      ),
    copyFile: (from, to) => run("copyFile", from, () => physicalFs.promises.copyFile(from, to)),
    link: (from, to) => run("link", from, () => physicalFs.promises.link(from, to)),
    makeDirectory: (path, options) =>
      run("makeDirectory", path, () => physicalFs.promises.mkdir(path, options)).pipe(
        Effect.asVoid,
      ),
    makeTempDirectory,
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(makeTempDirectory(options), (directory) =>
        remove(directory, { recursive: true }).pipe(Effect.orDie),
      ),
    makeTempFile,
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(makeTempFile(options), (file) =>
        remove(NodePath.dirname(file), { recursive: true }).pipe(Effect.orDie),
      ),
    readDirectory: (path, options) =>
      run("readDirectory", path, () => physicalFs.promises.readdir(path, options)),
    readFile: (path) =>
      run("readFile", path, (signal) => physicalFs.promises.readFile(path, { signal })),
    readLink: (path) => run("readLink", path, () => physicalFs.promises.readlink(path)),
    realPath: (path) => run("realPath", path, () => physicalFs.promises.realpath(path)),
    remove,
    rename: (from, to) => run("rename", from, () => physicalFs.promises.rename(from, to)),
    stat: (path) =>
      run("stat", path, () => physicalFs.promises.stat(path, { bigint: true })).pipe(
        Effect.flatMap(info),
      ),
    symlink: (target, path) =>
      run("symlink", path, () => physicalFs.promises.symlink(target, path)),
    truncate: (path, length) =>
      run("truncate", path, () => physicalFs.promises.truncate(path, length)),
    utimes: (path, atime, mtime) =>
      run("utimes", path, () => physicalFs.promises.utimes(path, atime, mtime)),
    writeFile: (path, data, options) =>
      run("writeFile", path, (signal) =>
        physicalFs.promises.writeFile(path, data, { ...options, signal }),
      ),
  });
});
