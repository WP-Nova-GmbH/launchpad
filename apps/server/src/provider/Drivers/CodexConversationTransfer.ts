import { CodexConversationManifest, NativeThreadId, RolloutName } from "@t3tools/contracts/relay";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  parseCodexNativeRollout,
  selectCodexNativeHistory,
  repairCodexNativeHistoryOffsets,
  type CodexNativeRollout,
} from "./CodexNativeHistory.ts";

const SessionMetadata = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({
    id: NativeThreadId,
    session_id: Schema.optionalKey(NativeThreadId),
    cli_version: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    history_mode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    parent_thread_id: Schema.optionalKey(Schema.NullOr(NativeThreadId)),
    history_base: Schema.optionalKey(Schema.Unknown),
  }),
});

export {
  CodexConversationManifest,
  CODEX_CONVERSATION_TRANSFER_VERSION,
} from "@t3tools/contracts/relay";
const decodeManifest = Schema.decodeUnknownEffect(CodexConversationManifest);
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionMetadata));
const decodeRolloutName = Schema.decodeUnknownEffect(RolloutName);
const isRolloutName = Schema.is(RolloutName);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(CodexConversationManifest));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RolloutRecord = Schema.Struct({
  type: Schema.NonEmptyString,
  payload: Schema.Unknown,
});
const decodeRolloutRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(RolloutRecord));
const decodeObject = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
const decodeOriginalRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const hasChildEvent = Schema.is(Schema.Struct({ type: Schema.Literal("collab_agent_spawn_end") }));
const isFunctionCall = Schema.is(
  Schema.Struct({
    type: Schema.Literals(["function_call", "custom_tool_call"]),
    name: Schema.String,
  }),
);
const hasChildItem = Schema.is(
  Schema.Struct({
    type: Schema.Literal("item_completed"),
    item: Schema.Struct({
      type: Schema.Literals([
        "collab_agent_tool_call",
        "collabAgentToolCall",
        "CollabAgentToolCall",
      ]),
    }),
  }),
);
const UserFiles = Schema.Struct({
  type: Schema.Literal("user_message"),
  local_images: Schema.optionalKey(Schema.Array(Schema.String)),
  local_audio: Schema.optionalKey(Schema.Array(Schema.String)),
  file_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isUserFiles = Schema.is(UserFiles);
const decodeUserFiles = Schema.decodeEffect(UserFiles);
const ViewImageFile = Schema.Struct({
  type: Schema.Literal("view_image_tool_call"),
  path: Schema.String,
});
const isViewImageFile = Schema.is(ViewImageFile);
const decodeViewImageFile = Schema.decodeUnknownEffect(ViewImageFile);
const fileFailure = () =>
  new CodexConversationTransferError({
    message:
      "A native Codex file is missing, changed, unsupported, or outside this thread's permitted storage.",
  });
const hasUserFilesType = Schema.is(Schema.Struct({ type: Schema.Literal("user_message") }));
const hasViewImageType = Schema.is(Schema.Struct({ type: Schema.Literal("view_image_tool_call") }));
const NativeMessage = Schema.Struct({
  type: Schema.Literal("message"),
  content: Schema.Array(Schema.Unknown),
});
const isNativeMessage = Schema.is(NativeMessage);
const NativeText = Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String });
const isNativeText = Schema.is(NativeText);
// Paginated rollouts embed local-image provenance beside inline image
// bytes. Match a complete native marker, never arbitrary path mentions in prose.
const imageMarker = /^<image name=\[[^<>\r\n]{1,512}\] path="([^"<>\r\n]+)">$/u;
const markerPath = (text: string) => imageMarker.exec(text)?.[1];
const referencedPaths = Effect.fnUntraced(function* (record: typeof RolloutRecord.Type) {
  if (record.type === "response_item" && isNativeMessage(record.payload)) {
    const references: string[] = [];
    for (const item of record.payload.content) {
      if (!isNativeText(item)) continue;
      const file = markerPath(item.text);
      if (item.text.startsWith("<image ") && item.text.includes(' path="') && !file)
        return yield* fileFailure();
      if (file) references.push(file);
    }
    return references;
  }
  if (record.type !== "event_msg") return [];
  if (hasUserFilesType(record.payload)) {
    const payload = yield* decodeUserFiles(record.payload);
    if (payload.file_ids?.length) return yield* fileFailure();
    return [...(payload.local_images ?? []), ...(payload.local_audio ?? [])];
  }
  if (hasViewImageType(record.payload)) {
    const payload = yield* decodeViewImageFile(record.payload);
    return [payload.path];
  }
  return [];
});

const readReferences = Effect.fnUntraced(function* (rolloutPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const references = new Set<string>();
  yield* fs.stream(rolloutPath).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const record = yield* decodeRolloutRecord(line);
        const paths = yield* referencedPaths(record).pipe(
          Effect.catchTag("SchemaError", fileFailure),
        );
        for (const value of paths) {
          if (!value || value.length > 4096 || value.includes("\0")) return yield* fileFailure();
          references.add(value);
          if (references.size > 256) return yield* fileFailure();
        }
      }),
    ),
  );
  return references;
});

/** Only known native file fields are rewritten. Text, tool arguments, IDs and
 * conversation records keep their original values. */
const relocateReferences = Effect.fnUntraced(function* (
  rolloutPath: string,
  locations: ReadonlyMap<string, string>,
) {
  if (!locations.size) return;
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${rolloutPath}.relocating`;
  yield* fs.stream(rolloutPath).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.gen(function* () {
        const record = yield* decodeRolloutRecord(line);
        if (record.type !== "event_msg" && record.type !== "response_item") return `${line}\n`;
        const original = yield* decodeOriginalRecord(line);
        if (record.type === "response_item" && isNativeMessage(record.payload)) {
          let changed = false;
          const content = yield* Effect.forEach(record.payload.content, (item) =>
            Effect.gen(function* () {
              if (!isNativeText(item)) return item;
              const file = markerPath(item.text);
              if (!file) return item;
              const target = locations.get(file);
              if (!target || /["<>\r\n\0]/u.test(target)) return yield* fileFailure();
              const originalItem = yield* decodeObject(item);
              changed = true;
              return {
                ...originalItem,
                text: item.text.replace(`path="${file}"`, `path="${target}"`),
              };
            }),
          );
          if (!changed) return `${line}\n`;
          const payload = yield* decodeObject(record.payload);
          return encodeRecord({ ...original, payload: { ...payload, content } }) + "\n";
        }
        if (isUserFiles(record.payload)) {
          const payload = yield* decodeObject(record.payload);
          return (
            encodeRecord({
              ...original,
              payload: {
                ...payload,
                ...(record.payload.local_images
                  ? {
                      local_images: record.payload.local_images.map((name) => locations.get(name)!),
                    }
                  : {}),
                ...(record.payload.local_audio
                  ? { local_audio: record.payload.local_audio.map((name) => locations.get(name)!) }
                  : {}),
              },
            }) + "\n"
          );
        }
        if (isViewImageFile(record.payload)) {
          const payload = yield* decodeObject(record.payload);
          return (
            encodeRecord({
              ...original,
              payload: { ...payload, path: locations.get(record.payload.path)! },
            }) + "\n"
          );
        }
        return `${line}\n`;
      }),
    ),
    Stream.encodeText,
    Stream.run(fs.sink(temporary, { flag: "wx", mode: 0o600 })),
  );
  yield* fs.rename(temporary, rolloutPath);
});
const unsupportedDependencies = () =>
  new CodexConversationTransferError({
    message:
      "This Codex conversation depends on other native sessions. Moving it is blocked until their complete history can be transferred.",
  });
const requireStandaloneHistory = (metadata: typeof SessionMetadata.Type) =>
  metadata.payload.parent_thread_id != null || metadata.payload.history_base != null
    ? unsupportedDependencies()
    : Effect.void;

/** A checksum can faithfully preserve an already truncated source. Validate every native record too. */
const validateRollout = Effect.fnUntraced(function* (file: string, allowDependencies = false) {
  const fs = yield* FileSystem.FileSystem;
  let lastByte: number | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (chunk?: Uint8Array) =>
    Effect.try({
      try: () => decoder.decode(chunk, { stream: chunk !== undefined }),
      catch: () =>
        new CodexConversationTransferError({
          message: "The Codex conversation contains invalid UTF-8 data.",
        }),
    });
  yield* fs.stream(file).pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        if (chunk.length) lastByte = chunk[chunk.length - 1];
      }),
    ),
    Stream.mapEffect((chunk) => decode(chunk)),
    Stream.concat(Stream.fromEffect(decode())),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const record = yield* decodeRolloutRecord(line);
        if (
          !allowDependencies &&
          record.type === "event_msg" &&
          (hasChildEvent(record.payload) || hasChildItem(record.payload))
        )
          return yield* unsupportedDependencies();
        if (
          !allowDependencies &&
          record.type === "response_item" &&
          isFunctionCall(record.payload) &&
          /^(?:functions\.)?(?:spawn_agent|spawn_agents_on_csv)$/u.test(record.payload.name)
        )
          return yield* unsupportedDependencies();
      }),
    ),
    Effect.catchTag(
      "SchemaError",
      () =>
        new CodexConversationTransferError({
          message: "The Codex conversation contains an incomplete or corrupt native record.",
        }),
    ),
  );
  if (lastByte !== 10)
    return yield* new CodexConversationTransferError({
      message: "The Codex conversation ends with an incomplete native record.",
    });
});

export class CodexConversationTransferError extends Schema.TaggedError<CodexConversationTransferError>()(
  "CodexConversationTransferError",
  { message: Schema.String },
) {}

const readMetadata = Effect.fnUntraced(function* (rolloutPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const firstLine = yield* fs
    .stream(rolloutPath)
    .pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  if (Option.isNone(firstLine)) {
    return yield* new CodexConversationTransferError({ message: "The Codex rollout is empty." });
  }
  return yield* decodeMetadata(firstLine.value);
});

const digest = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash("sha256");
  yield* fs.stream(file).pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  return hash.digest("hex");
});

const exportReferencedFiles = Effect.fnUntraced(function* (input: {
  readonly rolloutPath: string;
  readonly rolloutPaths?: ReadonlyArray<string>;
  readonly directory: string;
  readonly roots: ReadonlyArray<string>;
  readonly allowedFiles: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const references = new Set<string>();
  for (const rollout of input.rolloutPaths ?? [input.rolloutPath])
    for (const file of yield* readReferences(rollout)) references.add(file);
  if (references.size > 256) return yield* fileFailure();
  if (!references.size) return [];
  const candidates = yield* Effect.forEach(input.roots, (root) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(root))) return null;
      const resolved = yield* fs.realPath(root);
      return (yield* fs.stat(resolved)).type === "Directory" ? resolved : null;
    }),
  );
  const roots = candidates.filter((root) => root !== null);
  const allowedFiles = new Set(input.allowedFiles);
  const files: NonNullable<CodexConversationManifest["files"]>[number][] = [];
  let total = 0;
  for (const sourcePath of references) {
    if (!path.isAbsolute(sourcePath)) return yield* fileFailure();
    const source = path.resolve(sourcePath);
    if (
      !(yield* fs.exists(source)) ||
      (yield* fs.realPath(source)) !== source ||
      (!allowedFiles.has(source) && !roots.some((root) => source.startsWith(`${root}${path.sep}`)))
    )
      return yield* fileFailure();
    const stat = yield* fs.stat(source);
    total += Number(stat.size);
    if (stat.type !== "File" || total > 64 * 1024 * 1024) return yield* fileFailure();
    const extension = path.extname(source).toLowerCase();
    const name =
      NodeCrypto.createHash("sha256").update(sourcePath).digest("hex") +
      (/^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "");
    const sha256 = yield* digest(source);
    const directory = path.join(input.directory, "files");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, name);
    yield* fs.copyFile(source, target);
    yield* fs.chmod(target, 0o600);
    if (
      (yield* digest(target)) !== sha256 ||
      (yield* digest(source)) !== sha256 ||
      (yield* fs.stat(target)).size !== stat.size ||
      (yield* fs.realPath(source)) !== source
    )
      return yield* fileFailure();
    files.push({ sourcePath, name, sha256, sizeBytes: Number(stat.size) });
  }
  for (const file of files)
    if (
      (yield* digest(file.sourcePath)) !== file.sha256 ||
      (yield* fs.realPath(file.sourcePath)) !== file.sourcePath
    )
      return yield* fileFailure();
  return files;
});

const importReferencedFiles = Effect.fnUntraced(function* (input: {
  readonly manifest: CodexConversationManifest;
  readonly artifactRolloutPath: string;
  readonly rolloutPath: string;
  readonly rolloutPaths?: ReadonlyArray<string>;
  readonly home: string;
  readonly finalHomePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const references = new Set<string>();
  for (const rollout of input.rolloutPaths ?? [input.rolloutPath])
    for (const file of yield* readReferences(rollout)) references.add(file);
  const files = input.manifest.files ?? [];
  if (
    (input.manifest.format === "codex-rollout-v1" && files.length > 0) ||
    (input.manifest.format !== "codex-rollout-v1" && input.manifest.files === undefined) ||
    references.size !== files.length ||
    new Set(files.map((file) => file.sourcePath)).size !== files.length ||
    new Set(files.map((file) => file.name)).size !== files.length ||
    files.reduce((size, file) => size + file.sizeBytes, 0) > 64 * 1024 * 1024
  )
    return yield* fileFailure();
  const locations = new Map<string, string>();
  const artifacts = yield* fs.realPath(path.dirname(input.artifactRolloutPath));
  if (files.length) yield* fs.makeDirectory(path.join(input.home, "native-files"), { mode: 0o700 });
  for (const file of files) {
    if (!references.has(file.sourcePath)) return yield* fileFailure();
    const source = path.join(artifacts, "files", file.name);
    if (!(yield* fs.exists(source)) || (yield* fs.realPath(source)) !== path.resolve(source))
      return yield* fileFailure();
    const stat = yield* fs.stat(source);
    if (stat.type !== "File" || stat.size !== BigInt(file.sizeBytes)) return yield* fileFailure();
    const target = path.join(input.home, "native-files", file.name);
    yield* fs.copyFile(source, target);
    yield* fs.chmod(target, 0o600);
    if ((yield* digest(target)) !== file.sha256) return yield* fileFailure();
    locations.set(file.sourcePath, path.join(input.finalHomePath, "native-files", file.name));
  }
  for (const rollout of input.rolloutPaths ?? [input.rolloutPath])
    yield* relocateReferences(rollout, locations);
});

/** Call after the native session has drained and closed; never export a live writer. */
export const exportCodexConversation = Effect.fn("exportCodexConversation")(function* (input: {
  readonly codexHome: string;
  readonly rolloutPath: string;
  readonly threadId: string;
  readonly artifactRoot: string;
  readonly referencedFileRoots?: ReadonlyArray<string>;
  readonly referencedFiles?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(input.codexHome);
  const source = yield* fs.realPath(input.rolloutPath);
  const relative = path.relative(home, source);
  const parts = relative.split(path.sep);
  if (parts[0] !== "sessions" && parts[0] !== "archived_sessions") {
    return yield* new CodexConversationTransferError({
      message: "The Codex rollout must belong to this provider home's session storage.",
    });
  }
  const metadata = yield* readMetadata(source);
  if (metadata.payload.session_id === input.threadId)
    return yield* exportCodexHistoryGraph({ ...input, codexHome: home, rolloutPath: source });
  yield* requireStandaloneHistory(metadata);
  if (metadata.payload.history_mode !== "paginated") {
    return yield* new CodexConversationTransferError({
      message: "This native Codex history format has not been verified for transfer.",
    });
  }
  if (metadata.payload.id !== input.threadId) {
    return yield* new CodexConversationTransferError({
      message: "The selected Codex rollout belongs to a different conversation.",
    });
  }
  const rolloutName = yield* decodeRolloutName(path.basename(source));
  if (!rolloutName.endsWith(`-${metadata.payload.id}.jsonl`)) {
    return yield* new CodexConversationTransferError({
      message: "Codex rollout identity mismatch.",
    });
  }
  const before = yield* digest(source);
  yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({
    directory: input.artifactRoot,
    prefix: "codex-",
  });
  return yield* Effect.gen(function* () {
    const rolloutPath = path.join(directory, "rollout.jsonl");
    yield* fs.copyFile(source, rolloutPath);
    yield* fs.chmod(rolloutPath, 0o600);
    const sha256 = yield* digest(rolloutPath);
    if (sha256 !== before || (yield* digest(source)) !== before) {
      return yield* new CodexConversationTransferError({
        message: "The Codex conversation changed during export. Close its session and retry.",
      });
    }
    yield* validateRollout(rolloutPath);
    const ownedFiles = path.join(home, "native-files");
    const files = yield* exportReferencedFiles({
      rolloutPath,
      directory,
      roots: [
        ...(input.referencedFileRoots ?? []),
        ...((yield* fs.exists(ownedFiles)) ? [ownedFiles] : []),
      ],
      allowedFiles: input.referencedFiles ?? [],
    });
    if ((yield* digest(source)) !== before) return yield* fileFailure();
    const manifest: CodexConversationManifest = {
      format: files.length ? "codex-rollout-v2" : "codex-rollout-v1",
      threadId: metadata.payload.id,
      codexVersion: metadata.payload.cli_version,
      historyMode: "paginated",
      rolloutName,
      sha256,
      ...(files.length ? { files } : {}),
    };
    const manifestJson = yield* encodeManifest(manifest);
    yield* fs.writeFileString(path.join(directory, "manifest.json"), manifestJson, {
      mode: 0o600,
      flag: "wx",
    });
    return { directory, manifest, sourceRollouts: [{ rolloutPath: source, sha256: before }] };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

/** Materializes a fresh native home before starting Codex; no shared home or login is copied. */
export const importCodexConversation = Effect.fn("importCodexConversation")(function* (input: {
  readonly manifest: unknown;
  readonly rolloutPath: string;
  readonly destinationRoot: string;
  readonly codexVersion: string;
  /** Internal installer may publish this temporary home atomically under this final path. */
  readonly finalHomePath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* decodeManifest(input.manifest);
  if (manifest.format === "codex-rollout-v3")
    return yield* importCodexHistoryGraph({ ...input, manifest });
  if (manifest.heads !== undefined || manifest.rollouts !== undefined) return yield* fileFailure();
  if (!manifest.rolloutName.endsWith(`-${manifest.threadId}.jsonl`)) {
    return yield* new CodexConversationTransferError({
      message: "Codex rollout identity mismatch.",
    });
  }
  yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectory({ directory: input.destinationRoot, prefix: "codex-" }),
  );
  return yield* Effect.gen(function* () {
    const date = manifest.rolloutName.slice(8, 18).split("-");
    const directory = path.join(home, "sessions", ...date);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const rolloutPath = path.join(directory, manifest.rolloutName);
    yield* fs.copyFile(input.rolloutPath, rolloutPath);
    yield* fs.chmod(rolloutPath, 0o600);
    if ((yield* digest(rolloutPath)) !== manifest.sha256) {
      return yield* new CodexConversationTransferError({
        message: "The transferred Codex conversation failed its integrity check.",
      });
    }
    yield* validateRollout(rolloutPath);
    const metadata = yield* readMetadata(rolloutPath);
    yield* requireStandaloneHistory(metadata);
    if (
      metadata.payload.id !== manifest.threadId ||
      metadata.payload.cli_version !== manifest.codexVersion ||
      (metadata.payload.history_mode ?? "legacy") !== manifest.historyMode
    ) {
      return yield* new CodexConversationTransferError({
        message: "Codex manifest identity mismatch.",
      });
    }
    yield* importReferencedFiles({
      manifest,
      artifactRolloutPath: input.rolloutPath,
      rolloutPath,
      home,
      finalHomePath: input.finalHomePath ?? home,
    });
    return {
      homePath: home,
      rolloutPath,
      rolloutPaths: [rolloutPath],
      resumeCursor: { threadId: manifest.threadId, resumePolicy: "require-existing" as const },
    };
  }).pipe(Effect.onError(() => fs.remove(home, { recursive: true }).pipe(Effect.ignore)));
});

const nativeGraphFailure = () =>
  new CodexConversationTransferError({
    message:
      "The complete native Codex history is missing, corrupt, unsupported, or outside this conversation.",
  });
const nativeGraph = <A>(evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: nativeGraphFailure });

/** Read only metadata while discovering candidates in a shared provider home.
 * Complete bodies are read only after their native session ID matches this root. */
const readOwnedNativeRollouts = Effect.fnUntraced(function* (home: string, threadId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths: string[] = [];
  let bytes = 0n;
  const visit = Effect.fnUntraced(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<
    void,
    import("effect/PlatformError").PlatformError | CodexConversationTransferError,
    FileSystem.FileSystem | Path.Path
  > {
    if (depth > 4) return;
    if ((yield* fs.realPath(directory)) !== directory) return;
    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name);
      if ((yield* fs.realPath(file)) !== file) continue;
      const stat = yield* fs.stat(file);
      if (stat.type === "Directory") {
        if (/^\d{2,4}$/u.test(name)) yield* visit(file, depth + 1);
      } else if (stat.type === "File" && isRolloutName(name)) {
        const metadata = yield* readMetadata(file).pipe(Effect.orElseSucceed(() => null));
        if (metadata?.payload.session_id !== threadId) continue;
        bytes += stat.size;
        if (stat.size > 64n * 1024n * 1024n || bytes > 256n * 1024n * 1024n || paths.length >= 256)
          return yield* nativeGraphFailure();
        paths.push(file);
      }
    }
  });
  for (const name of ["sessions", "archived_sessions"]) {
    const directory = path.join(home, name);
    if (yield* fs.exists(directory)) yield* visit(directory, 0);
  }
  return paths;
});

const exportCodexHistoryGraph = Effect.fnUntraced(function* (input: {
  readonly codexHome: string;
  readonly rolloutPath: string;
  readonly threadId: string;
  readonly artifactRoot: string;
  readonly referencedFileRoots?: ReadonlyArray<string>;
  readonly referencedFiles?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* readOwnedNativeRollouts(input.codexHome, input.threadId);
  if (!paths.includes(input.rolloutPath)) return yield* nativeGraphFailure();
  const rollouts: CodexNativeRollout[] = [];
  const sourceDigests = new Map<string, string>();
  for (const file of paths) {
    yield* validateRollout(file, true);
    sourceDigests.set(file, yield* digest(file));
    const text = yield* fs.readFileString(file);
    if (NodeCrypto.createHash("sha256").update(text).digest("hex") !== sourceDigests.get(file))
      return yield* nativeGraphFailure();
    rollouts.push(yield* nativeGraph(() => parseCodexNativeRollout(path.basename(file), text)));
  }
  const selected = yield* nativeGraph(() =>
    selectCodexNativeHistory(path.basename(input.rolloutPath), rollouts),
  );
  yield* fs.makeDirectory(input.artifactRoot, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({
    directory: input.artifactRoot,
    prefix: "codex-",
  });
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(directory, "native-rollouts"), { mode: 0o700 });
    const outputPaths: string[] = [];
    const descriptors: NonNullable<CodexConversationManifest["rollouts"]>[number][] = [];
    const rootName = path.basename(input.rolloutPath);
    for (const rollout of selected.rollouts) {
      const file =
        rollout.name === rootName
          ? path.join(directory, "rollout.jsonl")
          : path.join(directory, "native-rollouts", rollout.name);
      yield* fs.writeFileString(file, rollout.text, { mode: 0o600, flag: "wx" });
      outputPaths.push(file);
      descriptors.push({
        rolloutName: rollout.name,
        sizeBytes: Buffer.byteLength(rollout.text),
        sha256: yield* digest(file),
      });
    }
    const ownedFiles = path.join(input.codexHome, "native-files");
    const files = yield* exportReferencedFiles({
      rolloutPath: path.join(directory, "rollout.jsonl"),
      rolloutPaths: outputPaths,
      directory,
      roots: [
        ...(input.referencedFileRoots ?? []),
        ...((yield* fs.exists(ownedFiles)) ? [ownedFiles] : []),
      ],
      allowedFiles: input.referencedFiles ?? [],
    });
    for (const [source, before] of sourceDigests)
      if ((yield* digest(source)) !== before) return yield* nativeGraphFailure();
    const root = descriptors.find((r) => r.rolloutName === rootName)!;
    const manifest: CodexConversationManifest = {
      format: "codex-rollout-v3",
      threadId: input.threadId,
      codexVersion: selected.rollouts.find((rollout) => rollout.name === rootName)!.metadata
        .cli_version,
      historyMode: "paginated",
      rolloutName: rootName,
      sha256: root.sha256,
      files,
      heads: Object.fromEntries(selected.heads),
      rollouts: descriptors,
    };
    yield* fs.writeFileString(
      path.join(directory, "manifest.json"),
      yield* encodeManifest(manifest),
      { mode: 0o600, flag: "wx" },
    );
    return {
      directory,
      manifest,
      sourceRollouts: [...sourceDigests].map(([rolloutPath, sha256]) => ({ rolloutPath, sha256 })),
    };
  }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
});

const importCodexHistoryGraph = Effect.fnUntraced(function* (input: {
  readonly manifest: CodexConversationManifest;
  readonly rolloutPath: string;
  readonly destinationRoot: string;
  readonly finalHomePath?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = input.manifest;
  const descriptors = manifest.rollouts;
  if (
    !descriptors?.length ||
    !manifest.heads ||
    !manifest.files ||
    manifest.heads[manifest.threadId] !== manifest.rolloutName ||
    Object.keys(manifest.heads).length > 256 ||
    descriptors.reduce((bytes, descriptor) => bytes + descriptor.sizeBytes, 0) >
      256 * 1024 * 1024 ||
    new Set(descriptors.map((d) => d.rolloutName)).size !== descriptors.length
  )
    return yield* nativeGraphFailure();
  const root = descriptors.find((r) => r.rolloutName === manifest.rolloutName);
  if (!root || root.sha256 !== manifest.sha256) return yield* nativeGraphFailure();
  const artifacts = yield* fs.realPath(path.dirname(input.rolloutPath));
  const canonicalRoot = path.join(artifacts, path.basename(input.rolloutPath));
  const rollouts: CodexNativeRollout[] = [];
  for (const descriptor of descriptors) {
    const source =
      descriptor.rolloutName === manifest.rolloutName
        ? canonicalRoot
        : path.join(artifacts, "native-rollouts", descriptor.rolloutName);
    if (!(yield* fs.exists(source)) || (yield* fs.realPath(source)) !== source)
      return yield* nativeGraphFailure();
    const stat = yield* fs.stat(source);
    if (
      stat.type !== "File" ||
      stat.size !== BigInt(descriptor.sizeBytes) ||
      (yield* digest(source)) !== descriptor.sha256
    )
      return yield* nativeGraphFailure();
    yield* validateRollout(source, true);
    const text = yield* fs.readFileString(source);
    rollouts.push(yield* nativeGraph(() => parseCodexNativeRollout(descriptor.rolloutName, text)));
  }
  const selected = yield* nativeGraph(() =>
    selectCodexNativeHistory(manifest.rolloutName, rollouts),
  );
  if (
    selected.rootId !== manifest.threadId ||
    rollouts.find((rollout) => rollout.name === manifest.rolloutName)?.metadata.cli_version !==
      manifest.codexVersion ||
    selected.rollouts.length !== rollouts.length ||
    selected.heads.size !== Object.keys(manifest.heads).length ||
    [...selected.heads].some(([id, name]) => manifest.heads![id] !== name)
  )
    return yield* nativeGraphFailure();
  // A manifest may include only required prefix bytes, never an unrelated tail.
  for (const rollout of selected.rollouts)
    if (rollout.text !== rollouts.find((r) => r.name === rollout.name)!.text)
      return yield* nativeGraphFailure();
  yield* fs.makeDirectory(input.destinationRoot, { recursive: true, mode: 0o700 });
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectory({ directory: input.destinationRoot, prefix: "codex-" }),
  );
  return yield* Effect.gen(function* () {
    const installed = new Map<string, string>();
    for (const rollout of selected.rollouts) {
      const directory = path.join(home, "sessions", ...rollout.name.slice(8, 18).split("-"));
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, rollout.name);
      yield* fs.writeFileString(file, rollout.text, { mode: 0o600, flag: "wx" });
      installed.set(rollout.name, file);
    }
    const rolloutPath = installed.get(manifest.rolloutName)!;
    const rolloutPaths = [...installed.values()];
    yield* importReferencedFiles({
      manifest,
      artifactRolloutPath: input.rolloutPath,
      rolloutPath,
      rolloutPaths,
      home,
      finalHomePath: input.finalHomePath ?? home,
    });
    const relocated: CodexNativeRollout[] = [];
    for (const [name, file] of installed) {
      const text = yield* fs.readFileString(file);
      relocated.push(yield* nativeGraph(() => parseCodexNativeRollout(name, text)));
    }
    const repaired = yield* nativeGraph(() => repairCodexNativeHistoryOffsets(relocated));
    yield* nativeGraph(() => selectCodexNativeHistory(manifest.rolloutName, repaired));
    for (const rollout of repaired)
      yield* fs.writeFileString(installed.get(rollout.name)!, rollout.text, { mode: 0o600 });
    return {
      homePath: home,
      rolloutPath,
      rolloutPaths,
      resumeCursor: { threadId: manifest.threadId, resumePolicy: "require-existing" as const },
    };
  }).pipe(Effect.onError(() => fs.remove(home, { recursive: true }).pipe(Effect.ignore)));
});
