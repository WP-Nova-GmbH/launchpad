import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  materializeAuthStore,
  ORGANIZATION_ACCOUNT_MARKER_FILE,
} from "../organizationProviderAccount.ts";
import {
  CodexConversationManifest,
  CodexConversationTransferError,
  importCodexConversation,
  exportCodexConversation,
  validateCodexRollout,
} from "./CodexConversationTransfer.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const PortableCodexHome = Schema.Struct({
  format: Schema.Literal("launchpad-codex-home-v1"),
  threadId: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  providerInstanceId: Schema.NonEmptyString,
  transferSha256: Digest,
  native: CodexConversationManifest,
});
const NativeRolloutIntegrity = Schema.Struct({
  rolloutName: CodexConversationManifest.fields.rolloutName,
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
  ),
  sha256: Digest,
});
const NativeIntegrity = Schema.Struct({
  format: Schema.Literal("launchpad-native-integrity-v1"),
  portableStateId: Digest,
  rollouts: Schema.Array(NativeRolloutIntegrity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
});
const ProbeCheckpoint = Schema.Struct({
  ...NativeIntegrity.fields,
  format: Schema.Literal("launchpad-codex-probe-checkpoint-v1"),
  preflightFingerprint: Digest,
});
const decodeIntegrity = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeIntegrity));
const encodeIntegrity = Schema.encodeEffect(Schema.fromJsonString(NativeIntegrity));
const decodeProbeCheckpoint = Schema.decodeEffect(Schema.fromJsonString(ProbeCheckpoint));
const encodeProbeCheckpoint = Schema.encodeEffect(Schema.fromJsonString(ProbeCheckpoint));
const decodeHome = Schema.decodeUnknownEffect(Schema.fromJsonString(PortableCodexHome));
const encodeHome = Schema.encodeEffect(Schema.fromJsonString(PortableCodexHome));
const decodeDescriptor = Schema.decodeUnknownEffect(PortableCodexHome);
const decodeKey = Schema.decodeUnknownEffect(Digest);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (message: string) => new CodexConversationTransferError({ message });
export class PortableCodexProbeHistoryError extends Schema.TaggedError<PortableCodexProbeHistoryError>()(
  "PortableCodexProbeHistoryError",
  { message: Schema.String },
) {}
const probeHistoryChanged = () =>
  new PortableCodexProbeHistoryError({
    message:
      "The imported native conversation has changed; retain its settled destination checkpoint first.",
  });
const isMissingOrInvalidHistory = (error: PlatformError) =>
  error.reason._tag === "NotFound" ||
  error.reason._tag === "InvalidData" ||
  error.reason._tag === "UnexpectedEof";
type PortableHomeIdentity = {
  readonly stateDir: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly nativeThreadId: string;
  readonly portableStateId: string;
};
type RolloutIntegrity = typeof NativeRolloutIntegrity.Type;
const rolloutPath = (path: Path.Path, home: string, name: string) =>
  path.join(home, "sessions", ...name.slice(8, 18).split("-"), name);
const syncPath = (fs: FileSystem.FileSystem, file: string) =>
  Effect.scoped(fs.open(file, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)));
const homePath = Effect.fnUntraced(function* (stateDir: string, threadId: string, stateId: string) {
  const path = yield* Path.Path;
  const id = yield* decodeKey(stateId);
  return path.join(stateDir, "portable-codex", hash(threadId), id);
});

const digestPrefix = Effect.fnUntraced(function* (file: string, sizeBytes: number) {
  const fs = yield* FileSystem.FileSystem;
  const checksum = NodeCrypto.createHash("sha256");
  let count = 0;
  yield* fs.stream(file, { bytesToRead: sizeBytes }).pipe(
    Stream.runForEach((bytes) =>
      Effect.sync(() => {
        count += bytes.length;
        checksum.update(bytes);
      }),
    ),
  );
  if (count !== sizeBytes)
    return yield* fail("Required native Codex history is missing or changed.");
  return checksum.digest("hex");
});

/** Install only native conversation files. Authentication stays with the destination's
 * configured provider account and is never included in the transfer artifact.
 */
export const installPortableCodexHome = Effect.fn("installPortableCodexHome")(function* (input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly providerInstanceId: string;
  readonly transferSha256: string;
  readonly manifest: unknown;
  readonly rolloutPath: string;
  readonly codexVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptor = yield* decodeDescriptor({
    format: "launchpad-codex-home-v1",
    threadId: input.threadId,
    operationId: input.operationId,
    providerInstanceId: input.providerInstanceId,
    transferSha256: input.transferSha256,
    native: input.manifest,
  });
  const encoded = yield* encodeHome(descriptor);
  const portableStateId = hash(encoded);
  yield* fs.makeDirectory(input.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = yield* fs.realPath(input.stateDir);
  const target = yield* homePath(stateDir, input.threadId, portableStateId);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
  if ((yield* fs.realPath(path.dirname(target))) !== path.dirname(target))
    return yield* fail("Portable Codex storage cannot follow a linked directory.");
  if (yield* fs.exists(target)) {
    if (
      (yield* fs.realPath(target)) !== target ||
      !NodeUtil.isDeepStrictEqual(
        yield* decodeHome(yield* fs.readFileString(path.join(target, "launchpad-state.json"))),
        descriptor,
      )
    )
      return yield* fail("The installed Codex state belongs to another transfer.");
    yield* resolvePortableCodexHome({
      ...input,
      nativeThreadId: descriptor.native.threadId,
      portableStateId,
    });
  } else {
    const imported = yield* importCodexConversation({
      manifest: descriptor.native,
      rolloutPath: input.rolloutPath,
      destinationRoot: path.dirname(target),
      codexVersion: input.codexVersion,
      finalHomePath: target,
    });
    yield* Effect.gen(function* () {
      const receipt = path.join(imported.homePath, "launchpad-state.json");
      yield* fs.writeFileString(receipt, encoded, { mode: 0o600, flag: "wx" });
      const files = descriptor.native.files ?? [];
      const nativeRollouts = imported.rolloutPaths;
      // Codex may append after activation. Record only the relocated import prefix,
      // which must remain intact even when later turns extend these files.
      const rollouts = [];
      for (const file of nativeRollouts) {
        const sizeBytes = Number((yield* fs.stat(file)).size);
        rollouts.push({
          rolloutName: path.basename(file),
          sizeBytes,
          sha256: yield* digestPrefix(file, sizeBytes),
        });
      }
      const integrityReceipt = path.join(imported.homePath, "launchpad-native-integrity.json");
      yield* fs.writeFileString(
        integrityReceipt,
        yield* encodeIntegrity({
          format: "launchpad-native-integrity-v1",
          portableStateId,
          rollouts,
        }),
        { mode: 0o600, flag: "wx" },
      );
      const nativeDirectories = new Set<string>();
      for (const rollout of nativeRollouts) {
        let directory = path.dirname(rollout);
        while (directory !== imported.homePath) {
          nativeDirectories.add(directory);
          directory = path.dirname(directory);
        }
      }
      for (const filename of [
        ...nativeRollouts,
        ...nativeDirectories,
        receipt,
        integrityReceipt,
        ...files.map((file) => path.join(imported.homePath, "native-files", file.name)),
        ...(files.length ? [path.join(imported.homePath, "native-files")] : []),
        imported.homePath,
      ])
        yield* Effect.scoped(
          fs.open(filename, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
        );
      yield* fs.rename(imported.homePath, target);
      yield* Effect.scoped(
        fs.open(path.dirname(target), { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
      );
    }).pipe(
      Effect.onError(() => fs.remove(imported.homePath, { recursive: true }).pipe(Effect.ignore)),
    );
  }
  return {
    homePath: target,
    resumeCursor: {
      threadId: descriptor.native.threadId,
      resumePolicy: "require-existing" as const,
      portableStateId,
    },
  };
});

const readPortableCodexHome = Effect.fnUntraced(function* (input: PortableHomeIdentity) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(input.stateDir);
  const home = yield* homePath(root, input.threadId, input.portableStateId);
  if (!(yield* fs.exists(home)) || (yield* fs.realPath(home)) !== home)
    return yield* fail("Portable Codex state is missing or uses a linked provider home.");
  const receipt = path.join(home, "launchpad-state.json");
  if (!(yield* fs.exists(receipt)))
    return yield* fail("Portable Codex state has an invalid ownership record.");
  const receiptStat = yield* fs.stat(receipt);
  if (
    (yield* fs.realPath(receipt)) !== receipt ||
    receiptStat.type !== "File" ||
    receiptStat.size > 1_048_576n
  )
    return yield* fail("Portable Codex state has an invalid ownership record.");
  const descriptor = yield* decodeHome(yield* fs.readFileString(receipt));
  if (
    descriptor.threadId !== input.threadId ||
    descriptor.providerInstanceId !== input.providerInstanceId ||
    descriptor.native.threadId !== input.nativeThreadId ||
    hash(yield* encodeHome(descriptor)) !== input.portableStateId
  )
    return yield* fail("Portable Codex state does not belong to this thread and provider.");
  const integrityReceipt = path.join(home, "launchpad-native-integrity.json");
  const integrity = yield* Effect.gen(function* () {
    const receiptStat = yield* fs.stat(integrityReceipt);
    if (
      (yield* fs.realPath(integrityReceipt)) !== integrityReceipt ||
      receiptStat.type !== "File" ||
      receiptStat.size > 1_048_576n
    )
      return yield* fail("Required native Codex history is missing or changed.");
    const integrity = yield* decodeIntegrity(yield* fs.readFileString(integrityReceipt));
    const expected = new Set(
      (descriptor.native.rollouts ?? [{ rolloutName: descriptor.native.rolloutName }]).map(
        (entry) => entry.rolloutName,
      ),
    );
    if (
      integrity.portableStateId !== input.portableStateId ||
      integrity.rollouts.length !== expected.size ||
      integrity.rollouts.some((entry) => !expected.delete(entry.rolloutName)) ||
      expected.size !== 0
    )
      return yield* fail("Required native Codex history is missing or changed.");
    for (const entry of integrity.rollouts) {
      const file = rolloutPath(path, home, entry.rolloutName);
      const stat = yield* fs.stat(file);
      if (
        (yield* fs.realPath(file)) !== file ||
        stat.type !== "File" ||
        stat.size < BigInt(entry.sizeBytes) ||
        (yield* digestPrefix(file, entry.sizeBytes)) !== entry.sha256
      )
        return yield* fail("Required native Codex history is missing or changed.");
    }
    return integrity;
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "SchemaError" ||
      (error._tag === "PlatformError" && isMissingOrInvalidHistory(error))
        ? fail("Required native Codex history is missing or changed.")
        : error,
    ),
  );
  for (const file of descriptor.native.files ?? []) {
    const referenced = path.join(home, "native-files", file.name);
    if (!(yield* fs.exists(referenced)) || (yield* fs.realPath(referenced)) !== referenced)
      return yield* fail("A required native Codex file is missing or changed.");
    const stat = yield* fs.stat(referenced);
    if (stat.type !== "File" || stat.size !== BigInt(file.sizeBytes))
      return yield* fail("A required native Codex file is missing or changed.");
    const checksum = NodeCrypto.createHash("sha256");
    yield* fs
      .stream(referenced)
      .pipe(Stream.runForEach((bytes) => Effect.sync(() => checksum.update(bytes))));
    if (checksum.digest("hex") !== file.sha256)
      return yield* fail("A required native Codex file is missing or changed.");
  }
  return { home, descriptor, integrity };
});

/** A cursor names an opaque server-owned state directory, never a client-supplied host path. */
export const resolvePortableCodexHome = Effect.fn("resolvePortableCodexHome")(function* (
  input: PortableHomeIdentity,
) {
  const { home, descriptor } = yield* readPortableCodexHome(input);
  return { homePath: home, codexVersion: descriptor.native.codexVersion };
});

const readProbeBaseline = Effect.fnUntraced(
  function* (input: PortableHomeIdentity) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, descriptor, integrity } = yield* readPortableCodexHome(input).pipe(
      Effect.catchTags({
        CodexConversationTransferError: () => probeHistoryChanged(),
        SchemaError: () => probeHistoryChanged(),
      }),
    );
    const receipt = path.join(home, "launchpad-codex-probe-checkpoint.json");
    if (!(yield* fs.exists(receipt))) {
      const link = yield* fs
        .readLink(receipt)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : error,
          ),
        );
      if (link !== null) return yield* probeHistoryChanged();
      return {
        home,
        descriptor,
        receipt,
        ...integrity,
        fingerprint: hash(yield* encodeIntegrity(integrity)),
      };
    }
    const stat = yield* fs.stat(receipt);
    if ((yield* fs.realPath(receipt)) !== receipt || stat.type !== "File" || stat.size > 1_048_576n)
      return yield* probeHistoryChanged();
    const encoded = yield* fs.readFileString(receipt);
    const checkpoint = yield* decodeProbeCheckpoint(encoded).pipe(
      Effect.mapError(probeHistoryChanged),
    );
    const imported = new Map(
      integrity.rollouts.map((entry) => [entry.rolloutName, entry.sizeBytes]),
    );
    if (
      checkpoint.portableStateId !== input.portableStateId ||
      checkpoint.rollouts.length !== imported.size ||
      checkpoint.rollouts.some((entry) => {
        const size = imported.get(entry.rolloutName);
        return size === undefined || entry.sizeBytes < size || !imported.delete(entry.rolloutName);
      })
    )
      return yield* probeHistoryChanged();
    return { home, descriptor, receipt, ...checkpoint, fingerprint: hash(encoded) };
  },
  Effect.mapError((error) =>
    error._tag === "PlatformError" && isMissingOrInvalidHistory(error)
      ? probeHistoryChanged()
      : error,
  ),
);

const verifyProbeRollouts = Effect.fnUntraced(
  function* (home: string, rollouts: ReadonlyArray<RolloutIntegrity>, allowAppend = false) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const observed = [];
    let totalBytes = 0n;
    for (const entry of rollouts) {
      const file = rolloutPath(path, home, entry.rolloutName);
      const stat = yield* fs.stat(file);
      totalBytes += stat.size;
      if (
        (yield* fs.realPath(file)) !== file ||
        stat.type !== "File" ||
        stat.size > 64n * 1024n * 1024n ||
        totalBytes > 256n * 1024n * 1024n ||
        stat.size < BigInt(entry.sizeBytes) ||
        (!allowAppend && stat.size !== BigInt(entry.sizeBytes)) ||
        (yield* digestPrefix(file, entry.sizeBytes)) !== entry.sha256
      )
        return yield* probeHistoryChanged();
      const sizeBytes = Number(stat.size);
      const sha256 =
        sizeBytes === entry.sizeBytes ? entry.sha256 : yield* digestPrefix(file, sizeBytes);
      if ((yield* fs.stat(file)).size !== stat.size) return yield* probeHistoryChanged();
      observed.push({ rolloutName: entry.rolloutName, sizeBytes, sha256 });
    }
    return observed;
  },
  Effect.mapError((error) =>
    error._tag === "CodexConversationTransferError" ||
    (error._tag === "PlatformError" && isMissingOrInvalidHistory(error))
      ? probeHistoryChanged()
      : error,
  ),
);

/** Require exact known history before a probe, including old installs without a probe checkpoint. */
export const verifyPortableCodexProbeCheckpoint = Effect.fn("verifyPortableCodexProbeCheckpoint")(
  function* (input: PortableHomeIdentity) {
    const baseline = yield* readProbeBaseline(input);
    yield* verifyProbeRollouts(baseline.home, baseline.rollouts);
    return baseline.fingerprint;
  },
);

/** Only the readiness worker may call this after a successful, positively stopped probe. */
export const checkpointPortableCodexAfterProbe = Effect.fn("checkpointPortableCodexAfterProbe")(
  function* (input: PortableHomeIdentity, preflightFingerprint: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseline = yield* readProbeBaseline(input);
    if (baseline.fingerprint !== preflightFingerprint) {
      if (
        baseline.format !== "launchpad-codex-probe-checkpoint-v1" ||
        baseline.preflightFingerprint !== preflightFingerprint
      )
        return yield* probeHistoryChanged();
      yield* verifyProbeRollouts(baseline.home, baseline.rollouts);
      yield* syncPath(fs, baseline.home);
      return baseline.fingerprint;
    }
    const rollouts = yield* verifyProbeRollouts(baseline.home, baseline.rollouts, true);
    for (const [index, rollout] of rollouts.entries()) {
      const offset = baseline.rollouts[index]!.sizeBytes;
      if (rollout.sizeBytes === offset) continue;
      yield* validateCodexRollout(
        rolloutPath(path, baseline.home, rollout.rolloutName),
        baseline.descriptor.native.format === "codex-rollout-v3",
        { offset, bytesToRead: rollout.sizeBytes - offset },
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "CodexConversationTransferError"
            ? new PortableCodexProbeHistoryError({ message: error.message })
            : isMissingOrInvalidHistory(error)
              ? probeHistoryChanged()
              : error,
        ),
      );
    }
    if (
      baseline.format === "launchpad-codex-probe-checkpoint-v1" &&
      NodeUtil.isDeepStrictEqual(rollouts, baseline.rollouts)
    ) {
      yield* syncPath(fs, baseline.home);
      return baseline.fingerprint;
    }
    const encoded = yield* encodeProbeCheckpoint({
      format: "launchpad-codex-probe-checkpoint-v1",
      portableStateId: input.portableStateId,
      rollouts,
      preflightFingerprint,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: baseline.home,
          prefix: "probe-checkpoint-",
        });
        const staged = path.join(temporary, "receipt.json");
        yield* fs.writeFileString(staged, encoded, { mode: 0o600, flag: "wx" });
        for (const entry of rollouts)
          yield* syncPath(fs, rolloutPath(path, baseline.home, entry.rolloutName));
        yield* verifyProbeRollouts(baseline.home, rollouts);
        yield* syncPath(fs, staged);
        yield* fs.rename(staged, baseline.receipt);
        yield* syncPath(fs, baseline.home);
      }),
    );
    return hash(encoded);
  },
);

/** Save an imported conversation before its first destination turn. Never open a provider or carry auth files. */
export const exportUnstartedPortableCodexConversation = Effect.fn(
  "exportUnstartedPortableCodexConversation",
)(function* (input: PortableHomeIdentity & { readonly artifactRoot: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseline = yield* readProbeBaseline(input);
  yield* verifyProbeRollouts(baseline.home, baseline.rollouts);
  const archive = yield* exportCodexConversation({
    codexHome: baseline.home,
    threadId: input.nativeThreadId,
    rolloutPath: rolloutPath(path, baseline.home, baseline.descriptor.native.rolloutName),
    artifactRoot: input.artifactRoot,
  }).pipe(
    Effect.catchTags({
      CodexConversationTransferError: (error) =>
        new PortableCodexProbeHistoryError({ message: error.message }),
      SchemaError: () => probeHistoryChanged(),
    }),
  );
  return yield* Effect.gen(function* () {
    const expected = new Map(
      baseline.rollouts.map((entry) => [
        rolloutPath(path, baseline.home, entry.rolloutName),
        entry.sha256,
      ]),
    );
    if (
      archive.sourceRollouts.length !== expected.size ||
      archive.sourceRollouts.some(
        (source) =>
          expected.get(source.rolloutPath) !== source.sha256 ||
          !expected.delete(source.rolloutPath),
      )
    )
      return yield* probeHistoryChanged();
    const nativeFiles = new Map(
      (baseline.descriptor.native.files ?? []).map((entry) => [
        path.join(baseline.home, "native-files", entry.name),
        entry,
      ]),
    );
    if (
      (archive.manifest.files ?? []).some((file) => {
        const expectedFile = nativeFiles.get(file.sourcePath);
        return expectedFile?.sha256 !== file.sha256 || expectedFile.sizeBytes !== file.sizeBytes;
      })
    )
      return yield* probeHistoryChanged();
    if ((yield* verifyPortableCodexProbeCheckpoint(input)) !== baseline.fingerprint)
      return yield* probeHistoryChanged();
    return archive;
  }).pipe(
    Effect.onError(() => fs.remove(archive.directory, { recursive: true }).pipe(Effect.ignore)),
  );
});

/** Reuse the account already configured on this environment; native artifacts never
 * carry login data. A missing sign-in remains a setup prerequisite, not a fallback.
 */
export const preparePortableCodexAuthentication = Effect.fn("preparePortableCodexAuthentication")(
  function* (input: { readonly homePath: string; readonly configuredHomePath: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.join(input.configuredHomePath, "auth.json");
    if (!(yield* fs.exists(source)) || (yield* fs.stat(source)).type !== "File")
      return yield* fail(
        "Sign in to the configured Codex provider before continuing this transferred conversation.",
      );
    if ((yield* fs.stat(source)).size > 1_048_576n)
      return yield* fail("The configured Codex sign-in file is invalid.");
    const content = yield* fs.readFileString(source);
    // Use the same versioned credential placement as configured provider instances:
    // preserve a local token refresh until the configured sign-in changes. These
    // files stay environment-local and are excluded from native exports.
    for (const name of ["auth.json", ORGANIZATION_ACCOUNT_MARKER_FILE]) {
      const file = path.join(input.homePath, name);
      const link = yield* fs.readLink(file).pipe(Effect.orElseSucceed(() => null));
      if (link !== null || ((yield* fs.exists(file)) && (yield* fs.stat(file)).type !== "File"))
        return yield* fail("Portable Codex authentication must use regular private files.");
    }
    yield* materializeAuthStore({
      directory: input.homePath,
      files: [{ path: "auth.json", content }],
      version: hash(content),
    });
  },
);
