import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
const NativeIntegrity = Schema.Struct({
  format: Schema.Literal("launchpad-native-integrity-v1"),
  portableStateId: Digest,
  rollouts: Schema.Array(
    Schema.Struct({
      rolloutName: CodexConversationManifest.fields.rolloutName,
      sizeBytes: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
      ),
      sha256: Digest,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const decodeIntegrity = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeIntegrity));
const encodeIntegrity = Schema.encodeEffect(Schema.fromJsonString(NativeIntegrity));
const decodeHome = Schema.decodeUnknownEffect(Schema.fromJsonString(PortableCodexHome));
const encodeHome = Schema.encodeEffect(Schema.fromJsonString(PortableCodexHome));
const decodeDescriptor = Schema.decodeUnknownEffect(PortableCodexHome);
const decodeKey = Schema.decodeUnknownEffect(Digest);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (message: string) => new CodexConversationTransferError({ message });
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
  if (input.codexVersion !== descriptor.native.codexVersion)
    return yield* fail("Codex continuation requires the verified transfer version.");
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

/** A cursor names an opaque server-owned state directory, never a client-supplied host path. */
export const resolvePortableCodexHome = Effect.fn("resolvePortableCodexHome")(function* (input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly nativeThreadId: string;
  readonly portableStateId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(input.stateDir);
  const home = yield* homePath(root, input.threadId, input.portableStateId);
  if ((yield* fs.realPath(home)) !== home)
    return yield* fail("Portable Codex state cannot use a linked provider home.");
  const receipt = path.join(home, "launchpad-state.json");
  if ((yield* fs.realPath(receipt)) !== receipt || (yield* fs.stat(receipt)).size > 1_048_576n)
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
  yield* Effect.gen(function* () {
    if (
      (yield* fs.realPath(integrityReceipt)) !== integrityReceipt ||
      (yield* fs.stat(integrityReceipt)).size > 1_048_576n
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
      const file = path.join(
        home,
        "sessions",
        ...entry.rolloutName.slice(8, 18).split("-"),
        entry.rolloutName,
      );
      if (
        (yield* fs.realPath(file)) !== file ||
        (yield* fs.stat(file)).type !== "File" ||
        (yield* fs.stat(file)).size < BigInt(entry.sizeBytes) ||
        (yield* digestPrefix(file, entry.sizeBytes)) !== entry.sha256
      )
        return yield* fail("Required native Codex history is missing or changed.");
    }
  }).pipe(Effect.mapError(() => fail("Required native Codex history is missing or changed.")));
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
  return { homePath: home, codexVersion: descriptor.native.codexVersion };
});

/** Save an imported conversation before its first destination turn. Never open a provider or carry auth files. */
export const exportUnstartedPortableCodexConversation = Effect.fn(
  "exportUnstartedPortableCodexConversation",
)(function* (input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly nativeThreadId: string;
  readonly portableStateId: string;
  readonly artifactRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const resolved = yield* resolvePortableCodexHome(input);
  const descriptor = yield* decodeHome(
    yield* fs.readFileString(path.join(resolved.homePath, "launchpad-state.json")),
  );
  const integrity = yield* decodeIntegrity(
    yield* fs.readFileString(path.join(resolved.homePath, "launchpad-native-integrity.json")),
  );
  const verifyUnstarted = Effect.fnUntraced(function* () {
    yield* resolvePortableCodexHome(input);
    for (const entry of integrity.rollouts) {
      const rollout = path.join(
        resolved.homePath,
        "sessions",
        ...entry.rolloutName.slice(8, 18).split("-"),
        entry.rolloutName,
      );
      if (
        (yield* fs.stat(rollout)).size !== BigInt(entry.sizeBytes) ||
        (yield* digestPrefix(rollout, entry.sizeBytes)) !== entry.sha256
      )
        return yield* fail(
          "The imported native conversation has changed; retain its settled destination checkpoint first.",
        );
    }
  });
  yield* verifyUnstarted();
  const archive = yield* exportCodexConversation({
    codexHome: resolved.homePath,
    threadId: input.nativeThreadId,
    rolloutPath: path.join(
      resolved.homePath,
      "sessions",
      ...descriptor.native.rolloutName.slice(8, 18).split("-"),
      descriptor.native.rolloutName,
    ),
    artifactRoot: input.artifactRoot,
    referencedFileRoots: [resolved.homePath],
  });
  return yield* verifyUnstarted().pipe(
    Effect.as(archive),
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
