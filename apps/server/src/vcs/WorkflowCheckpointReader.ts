// @effect-diagnostics nodeBuiltinImport:off - Byte-framed file ingestion into a private scratch directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const reader = "/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py";
const maxManifestBytes = 32 * 1024 * 1024;
const maxPathBytes = 4096;
const maxExcludeBytes = 64 * 1024;
const headerBytes = 13;
// Matches the guest reader's big-endian kind, path length and data length header.
const complete = 0,
  file = 1,
  executable = 2,
  symlink = 3,
  missing = 4,
  directory = 5;
const invalid = () => new Error("The workflow checkpoint reader returned an invalid stream.");

const runReader = Effect.fnUntraced(function* <A, E, R>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  mode: "capture" | "exclude",
  manifest: Uint8Array | undefined,
  consume: (
    output: Stream.Stream<Uint8Array, import("effect/PlatformError").PlatformError>,
  ) => Effect.Effect<A, E, R>,
) {
  const child = yield* spawner.spawn(
    ChildProcess.make("/usr/bin/python3", ["-IS", reader, mode], {
      cwd,
      env: {},
      extendEnv: false,
      stdin: manifest === undefined ? "ignore" : { stream: Stream.make(manifest) },
      stderr: "ignore",
    }),
  );
  const [output, status] = yield* Effect.all([consume(child.stdout), child.exitCode], {
    concurrency: "unbounded",
  });
  if (status !== 0) return yield* Effect.fail(invalid());
  return output;
});

/** Reads only the fixed checkout-local exclude file. A failed read is never empty rules. */
export const readWorkflowCheckpointExclude = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
) =>
  runReader(spawner, cwd, "exclude", undefined, (output) =>
    output.pipe(
      Stream.runFoldEffect(
        () => ({ buffer: new Uint8Array(maxExcludeBytes), length: 0 }),
        (state, chunk) => {
          if (state.length + chunk.byteLength > maxExcludeBytes) return Effect.fail(invalid());
          state.buffer.set(chunk, state.length);
          return Effect.succeed({ buffer: state.buffer, length: state.length + chunk.byteLength });
        },
      ),
      Effect.map(({ buffer, length }) => buffer.subarray(0, length)),
    ),
  ).pipe(Effect.scoped, Effect.timeout("15 seconds"));

interface Entry {
  readonly children: Map<string, Entry>;
  kind?: number;
}

const getManifest = (candidates: ReadonlyArray<string>) => {
  const root: Entry = { children: new Map(), kind: directory };
  const unique = new Set<string>();
  let size = 0;
  for (const candidate of candidates) {
    if (unique.has(candidate)) continue;
    const bytes = Buffer.byteLength(candidate);
    size += bytes + 1;
    if (bytes > maxPathBytes || size > maxManifestBytes || candidate.includes("\0"))
      throw invalid();
    unique.add(candidate);
    let current = root;
    for (const name of candidate.split("/")) {
      if (!name || name === "." || name === ".." || name.toLowerCase() === ".git") throw invalid();
      let child = current.children.get(name);
      if (child === undefined) current.children.set(name, (child = { children: new Map() }));
      current = child;
    }
  }
  return { root, manifest: Buffer.from(unique.size ? [...unique].join("\0") + "\0" : "") };
};

function validateRecord(root: Entry, relative: string, kind: number) {
  let entry = root;
  for (const name of relative.split("/")) {
    const child = entry.children.get(name);
    if (entry.kind !== directory || child === undefined) throw invalid();
    entry = child;
  }
  if (entry.kind !== undefined || (kind === directory && entry.children.size === 0))
    throw invalid();
  entry.kind = kind;
}

function validateComplete(entry: Entry) {
  for (const child of entry.children.values()) {
    if (child.kind === undefined) throw invalid();
    if (child.kind === directory) validateComplete(child);
  }
}

async function stageFiles(
  stream: AsyncIterable<Uint8Array>,
  snapshot: string,
  root: Entry,
  signal: AbortSignal,
) {
  const stat = await NodeFSP.statfs(snapshot, { bigint: true });
  // Stage at most half the available disk so Git can write the corresponding objects.
  let remaining = (stat.bavail * stat.bsize) / 2n;
  const source = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  const consume = async (count: number, write: (bytes: Uint8Array) => void | Promise<void>) => {
    while (count > 0) {
      if (signal.aborted) throw invalid();
      if (offset >= chunk.byteLength) {
        const next = await source.next();
        if (next.done) throw invalid();
        chunk = next.value;
        offset = 0;
      }
      const length = Math.min(count, chunk.byteLength - offset);
      await write(chunk.subarray(offset, offset + length));
      offset += length;
      count -= length;
    }
  };
  const read = async (length: number) => {
    const result = Buffer.alloc(length);
    let written = 0;
    await consume(length, (bytes) => {
      result.set(bytes, written);
      written += bytes.byteLength;
    });
    return result;
  };
  try {
    while (true) {
      const header = await read(headerBytes);
      const kind = header.readUInt8(0);
      const pathBytes = header.readUInt32BE(1);
      const size = header.readBigUInt64BE(5);
      if (kind === complete) {
        if (
          pathBytes !== 0 ||
          size !== 0n ||
          offset !== chunk.byteLength ||
          !(await source.next()).done
        )
          throw invalid();
        break;
      }
      if (
        kind < file ||
        kind > directory ||
        pathBytes === 0 ||
        pathBytes > maxPathBytes ||
        size > remaining ||
        size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw invalid();
      const relative = decoder.decode(await read(pathBytes));
      validateRecord(root, relative, kind);
      const target = NodePath.join(snapshot, relative);
      if (kind === directory || kind === missing) {
        if (size !== 0n) throw invalid();
        if (kind === directory) await NodeFSP.mkdir(target, { mode: 0o700 });
        continue;
      }
      remaining -= size;
      if (kind === symlink) {
        if (size === 0n || size > BigInt(maxPathBytes)) throw invalid();
        const link = await read(Number(size));
        if (link.includes(0)) throw invalid();
        await NodeFSP.symlink(link, target);
      } else {
        const handle = await NodeFSP.open(target, "wx", kind === executable ? 0o700 : 0o600);
        try {
          await consume(Number(size), (bytes) => handle.writeFile(bytes));
        } finally {
          await handle.close();
        }
      }
    }
    // A missing ancestor, symlink or regular file replaces any tracked descendants.
    validateComplete(root);
  } finally {
    await source.return?.();
  }
}

/** The workload reads checkout bytes. Only the coordinator can materialize staging. */
export const stageWorkflowCheckpoint = Effect.fnUntraced(
  function* (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    cwd: string,
    snapshot: string,
    candidates: ReadonlyArray<string>,
  ) {
    const { root, manifest } = yield* Effect.try(() => getManifest(candidates));
    yield* runReader(spawner, cwd, "capture", manifest, (output) =>
      Effect.tryPromise((signal) =>
        stageFiles(Stream.toAsyncIterable(output), snapshot, root, signal),
      ),
    );
  },
  Effect.scoped,
  Effect.timeout("2 minutes"),
);
