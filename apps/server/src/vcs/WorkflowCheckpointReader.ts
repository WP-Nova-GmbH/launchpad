// @effect-diagnostics nodeBuiltinImport:off - Byte-framed file ingestion into a private scratch directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const WORKFLOW_CHECKPOINT_READ_TIMEOUT_MS = 10 * 60_000;

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
export class WorkflowCheckpointReadError extends Schema.TaggedError<WorkflowCheckpointReadError>()(
  "WorkflowCheckpointReadError",
  {
    reason: Schema.Literals([
      "manifest",
      "spawn",
      "stream",
      "invalid-stream",
      "reader-exit",
      "filesystem",
      "timeout",
      "unexpected",
    ]),
    exitCode: Schema.optional(Schema.Number),
    systemCode: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return `Workflow checkpoint capture failed (${this.reason}${this.exitCode === undefined ? "" : `, exit ${this.exitCode}`}${this.systemCode === undefined ? "" : `, ${this.systemCode}`}).`;
  }
}

const invalid = () => new WorkflowCheckpointReadError({ reason: "invalid-stream" });
const captureError = (cause: unknown): WorkflowCheckpointReadError => {
  if (Schema.is(WorkflowCheckpointReadError)(cause)) return cause;
  if (Cause.isUnknownError(cause)) return captureError(cause.cause);
  if (Cause.isTimeoutError(cause)) return new WorkflowCheckpointReadError({ reason: "timeout" });
  if (Predicate.isTagged(cause, "PlatformError"))
    return new WorkflowCheckpointReadError({ reason: "stream" });
  if (
    Predicate.hasProperty(cause, "code") &&
    typeof cause.code === "string" &&
    /^E[A-Z0-9_]+$/.test(cause.code)
  )
    return new WorkflowCheckpointReadError({ reason: "filesystem", systemCode: cause.code });
  return new WorkflowCheckpointReadError({ reason: "unexpected" });
};

interface CaptureProgress {
  phase: "manifest" | "spawn" | "read" | "write" | "validate" | "reader-exit" | "complete";
  filesCopied: number;
  bytesCopied: number;
  bytesReceived: number;
  lastProgressAt: number;
  readerExitCode?: number;
}

const runReader = Effect.fnUntraced(function* <A, E, R>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  mode: "capture" | "exclude",
  manifest: Uint8Array | undefined,
  consume: (
    output: Stream.Stream<Uint8Array, import("effect/PlatformError").PlatformError>,
  ) => Effect.Effect<A, E, R>,
  progress?: CaptureProgress,
) {
  if (progress) progress.phase = "spawn";
  const child = yield* spawner
    .spawn(
      ChildProcess.make("/usr/bin/python3", ["-IS", reader, mode], {
        cwd,
        env: {},
        extendEnv: false,
        stdin: manifest === undefined ? "ignore" : { stream: Stream.make(manifest) },
        stderr: "ignore",
      }),
    )
    .pipe(Effect.mapError(() => new WorkflowCheckpointReadError({ reason: "spawn" })));
  const [output, status] = yield* Effect.all(
    [
      consume(child.stdout),
      child.exitCode.pipe(
        Effect.tap((code) =>
          Effect.sync(() => {
            if (progress) progress.readerExitCode = code;
          }),
        ),
        Effect.mapError(() => new WorkflowCheckpointReadError({ reason: "stream" })),
      ),
    ],
    {
      concurrency: "unbounded",
    },
  );
  if (status !== 0)
    return yield* Effect.fail(
      new WorkflowCheckpointReadError({ reason: "reader-exit", exitCode: status }),
    );
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
  progress: CaptureProgress,
  now: () => number,
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
        progress.phase = "read";
        const next = await source.next();
        if (next.done) throw invalid();
        chunk = next.value;
        progress.bytesReceived += chunk.byteLength;
        progress.lastProgressAt = now();
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
        progress.phase = "reader-exit";
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
      progress.phase = "write";
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
          await consume(Number(size), async (bytes) => {
            progress.phase = "write";
            await handle.writeFile(bytes);
            progress.bytesCopied += bytes.byteLength;
            progress.lastProgressAt = now();
          });
        } finally {
          await handle.close();
        }
      }
      progress.filesCopied += 1;
      progress.lastProgressAt = now();
    }
    // A missing ancestor, symlink or regular file replaces any tracked descendants.
    progress.phase = "validate";
    validateComplete(root);
    progress.phase = "reader-exit";
  } finally {
    await source.return?.();
  }
}

/** The workload reads checkout bytes. Only the coordinator can materialize staging. */
export const stageWorkflowCheckpoint = Effect.fn("WorkflowCheckpointReader.stage")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  snapshot: string,
  candidates: ReadonlyArray<string>,
) {
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  const startedAt = now();
  const progress: CaptureProgress = {
    phase: "manifest",
    filesCopied: 0,
    bytesCopied: 0,
    bytesReceived: 0,
    lastProgressAt: startedAt,
  };
  const metrics = () => {
    const { lastProgressAt, ...counts } = progress;
    const measuredAt = now();
    return {
      ...counts,
      elapsedMs: Math.round(measuredAt - startedAt),
      idleMs: Math.round(measuredAt - lastProgressAt),
    };
  };
  yield* Effect.logInfo("Workflow checkpoint capture started", metrics());
  yield* Effect.forkScoped(
    Effect.sleep("5 seconds").pipe(
      Effect.andThen(
        Effect.suspend(() => Effect.logInfo("Workflow checkpoint capture progress", metrics())),
      ),
      Effect.forever,
      Effect.withTracerEnabled(false),
    ),
  );
  const capture = Effect.gen(function* () {
    const { root, manifest } = yield* Effect.try({
      try: () => getManifest(candidates),
      catch: () => new WorkflowCheckpointReadError({ reason: "manifest" }),
    });
    yield* runReader(
      spawner,
      cwd,
      "capture",
      manifest,
      (output) =>
        Effect.tryPromise({
          try: (signal) =>
            stageFiles(Stream.toAsyncIterable(output), snapshot, root, signal, progress, now),
          catch: captureError,
        }),
      progress,
    );
    progress.phase = "complete";
  });
  // Large checkouts can transfer for minutes. Bound inactivity separately so
  // healthy readers continue, while stalled reads, writes and exits still stop.
  const stalled = Effect.gen(function* () {
    while (true) {
      const remaining = 120_000 - (now() - progress.lastProgressAt);
      if (remaining <= 0) return yield* new WorkflowCheckpointReadError({ reason: "timeout" });
      yield* Effect.sleep(remaining);
    }
  });
  yield* Effect.raceFirst(capture, stalled).pipe(
    Effect.timeout(WORKFLOW_CHECKPOINT_READ_TIMEOUT_MS),
    Effect.mapError(captureError),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const stats = metrics();
        yield* Effect.annotateCurrentSpan(stats);
        if (Exit.isSuccess(exit)) {
          yield* Effect.logInfo("Workflow checkpoint capture completed", stats);
        } else {
          const failure = Cause.hasInterruptsOnly(exit.cause)
            ? { reason: "interrupted" }
            : captureError(Cause.squash(exit.cause));
          yield* Effect.logWarning("Workflow checkpoint capture failed", { ...stats, ...failure });
        }
      }),
    ),
  );
}, Effect.scoped);
