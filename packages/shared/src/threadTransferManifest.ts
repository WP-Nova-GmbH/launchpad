import {
  ThreadTransferArtifactManifest,
  type ThreadTransferPackedManifest,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

export const THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES = 8 * 1024 * 1024;
export const THREAD_TRANSFER_LEGACY_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
export const THREAD_TRANSFER_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
export const THREAD_TRANSFER_MAX_FILES = 100_000;
export const THREAD_TRANSFER_MAX_OBJECTS = 100_000;
export const THREAD_TRANSFER_MAX_SLICES = 100_000;
export const THREAD_TRANSFER_MAX_BYTES = 64 * 1024 ** 3;

export type ThreadTransferArtifactKind = ThreadTransferPackedManifest["objects"][number]["kind"];
export type NormalizedThreadTransferManifest = Omit<ThreadTransferPackedManifest, "format"> & {
  readonly format: ThreadTransferArtifactManifest["format"];
};

export class ThreadTransferManifestError extends Schema.TaggedError<ThreadTransferManifestError>()(
  "ThreadTransferManifestError",
  { message: Schema.String },
) {}

const invalid = (message: string): never => {
  throw new ThreadTransferManifestError({ message });
};
const decodeManifest = Schema.decodeUnknownSync(ThreadTransferArtifactManifest);
const isManifestError = Schema.is(ThreadTransferManifestError);
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const threadTransferArtifactKind = (path: string): ThreadTransferArtifactKind | null => {
  if (path === "manifest.json") return "manifest";
  if (path.startsWith("history/")) return "history";
  if (path.startsWith("workspace/")) return "workspace";
  if (path.startsWith("attachments/")) return "attachment";
  if (path.startsWith("native/")) return "native";
  return null;
};

export const isThreadTransferPackEligible = (file: {
  readonly path: string;
  readonly sizeBytes: number;
}) =>
  file.sizeBytes > 0 &&
  file.sizeBytes <= THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES &&
  /^workspace\/objects\/[0-9a-f]{64}$/u.test(file.path);

const safePath = (path: string) =>
  path.length <= 4096 &&
  !path
    .split("/")
    .some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes(":") ||
        /[. ]$/u.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32),
    );

/** Validate metadata before storage access; callers additionally bind scope and domain budgets. */
export function normalizeThreadTransferManifest(input: unknown): NormalizedThreadTransferManifest {
  let manifest: ThreadTransferArtifactManifest;
  try {
    const encoded = typeof input === "string" ? input : JSON.stringify(input);
    if (typeof encoded !== "string") return invalid("Transfer index is not JSON.");
    if (
      encoded.length > THREAD_TRANSFER_MANIFEST_MAX_BYTES ||
      new TextEncoder().encode(encoded).length > THREAD_TRANSFER_MANIFEST_MAX_BYTES
    )
      return invalid("Transfer index exceeds its byte limit.");
    manifest = decodeManifest(typeof input === "string" ? JSON.parse(input) : input);
  } catch (error) {
    if (isManifestError(error)) throw error;
    return invalid("Transfer index does not match a supported manifest format.");
  }
  if (manifest.files.length > THREAD_TRANSFER_MAX_FILES)
    return invalid("Transfer file count exceeds its limit.");

  const objects: ThreadTransferPackedManifest["objects"][number][] = [];
  const files: ThreadTransferPackedManifest["files"][number][] = [];
  if (manifest.format === "launchpad-thread-chunks-v1") {
    for (const file of manifest.files) {
      const kind = threadTransferArtifactKind(file.path);
      if (!kind) return invalid("Transfer file has an unsupported kind.");
      for (const chunk of file.chunks) objects.push({ ...chunk, kind });
      files.push({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        slices: file.chunks.map((chunk) => ({
          artifactId: chunk.artifactId,
          offset: 0,
          length: chunk.sizeBytes,
        })),
      });
    }
  } else {
    for (const object of manifest.objects) objects.push(object);
    for (const file of manifest.files) files.push(file);
  }
  if (objects.length > THREAD_TRANSFER_MAX_OBJECTS)
    return invalid("Transfer object count exceeds its limit.");
  const byId = new Map<string, ThreadTransferPackedManifest["objects"][number]>();
  const maxObjectBytes =
    manifest.format === "launchpad-thread-chunks-v1"
      ? THREAD_TRANSFER_LEGACY_OBJECT_MAX_BYTES
      : THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES;
  let objectBytes = 0;
  for (const object of objects) {
    if (byId.has(object.artifactId)) return invalid("Transfer objects are duplicated.");
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes > maxObjectBytes)
      return invalid("Transfer object exceeds its byte limit.");
    objectBytes += object.sizeBytes;
    if (objectBytes > THREAD_TRANSFER_MAX_BYTES)
      return invalid("Transfer payload exceeds its byte limit.");
    byId.set(object.artifactId, object);
  }

  const names = new Set<string>();
  const prefixes = new Map<string, string>();
  const usedIds = new Set<string>();
  let fileBytes = 0;
  let references = 0;
  let previousPath: string | undefined;
  for (const file of files) {
    references += file.slices.length;
    if (references > THREAD_TRANSFER_MAX_SLICES)
      return invalid("Transfer reference count exceeds its limit.");
    if (!Number.isSafeInteger(file.sizeBytes)) return invalid("Transfer file size is unsafe.");
    fileBytes += file.sizeBytes;
    if (fileBytes > THREAD_TRANSFER_MAX_BYTES)
      return invalid("Transfer payload exceeds its byte limit.");
    const kind = threadTransferArtifactKind(file.path);
    if (!kind || !safePath(file.path) || names.has(file.path))
      return invalid("Transfer paths are unsafe or duplicated.");
    if (
      manifest.format === "launchpad-thread-chunks-v2" &&
      previousPath !== undefined &&
      previousPath >= file.path
    )
      return invalid("Transfer files are not in canonical order.");
    previousPath = file.path;
    names.add(file.path);
    const parts = file.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const folded = prefix.normalize("NFD").toLowerCase();
      const prior = prefixes.get(folded);
      if (prior !== undefined && prior !== prefix)
        return invalid("Transfer paths collide on the destination filesystem.");
      prefixes.set(folded, prefix);
    }
    if (file.path === "manifest.json" && file.sha256 !== manifest.transferManifestSha256)
      return invalid("Transfer root manifest checksum does not match its archive.");
    if (file.sizeBytes === 0 && (file.slices.length !== 0 || file.sha256 !== emptyHash))
      return invalid("Empty transfer files must have no payload and the empty checksum.");
    let size = 0;
    for (const slice of file.slices) {
      const object = byId.get(slice.artifactId);
      if (!object || object.kind !== kind)
        return invalid("Transfer reference is unknown or crosses kinds.");
      if (
        !Number.isSafeInteger(slice.offset) ||
        !Number.isSafeInteger(slice.length) ||
        slice.offset > object.sizeBytes - slice.length
      )
        return invalid("Transfer reference exceeds its object.");
      size += slice.length;
      if (size > file.sizeBytes)
        return invalid("Transfer file size does not match its references.");
      if (manifest.format === "launchpad-thread-chunks-v1" && usedIds.has(slice.artifactId))
        return invalid("Legacy transfer objects cannot be shared.");
      usedIds.add(slice.artifactId);
    }
    if (size !== file.sizeBytes)
      return invalid("Transfer file size does not match its references.");
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++)
      if (names.has(parts.slice(0, index).join("/")))
        return invalid("Transfer file collides with a directory.");
  }
  if (usedIds.size !== objects.length) return invalid("Transfer contains unreferenced objects.");

  if (manifest.format === "launchpad-thread-chunks-v2") validatePackedLayout(objects, files);
  return {
    format: manifest.format,
    threadId: manifest.threadId,
    operationId: manifest.operationId,
    sourceEnvironmentId: manifest.sourceEnvironmentId,
    generation: manifest.generation,
    transferManifestSha256: manifest.transferManifestSha256,
    objects,
    files,
  };
}

function validatePackedLayout(
  objects: ThreadTransferPackedManifest["objects"],
  files: ThreadTransferPackedManifest["files"],
) {
  let cursor = 0;
  let pack: {
    readonly object: ThreadTransferPackedManifest["objects"][number];
    used: number;
  } | null = null;
  const finishPack = () => {
    if (pack && pack.used !== pack.object.sizeBytes)
      return invalid("Packed object contains unexplained bytes.");
    pack = null;
  };
  const nextObject = (artifactId: string) => {
    const object = objects[cursor++];
    if (!object || object.artifactId !== artifactId)
      return invalid("Transfer object traversal is not canonical.");
    return object;
  };
  for (const file of files) {
    // Zero-byte files do not affect physical object traversal or flush a partial pack.
    if (file.sizeBytes === 0) continue;
    if (isThreadTransferPackEligible(file)) {
      if (file.slices.length !== 1)
        return invalid("Small workspace objects must occupy one whole pack slice.");
      const slice = file.slices[0]!;
      if (
        pack &&
        (pack.object.kind !== threadTransferArtifactKind(file.path) ||
          pack.used + file.sizeBytes > THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES)
      )
        finishPack();
      if (!pack) pack = { object: nextObject(slice.artifactId), used: 0 };
      if (
        slice.artifactId !== pack.object.artifactId ||
        slice.offset !== pack.used ||
        slice.length !== file.sizeBytes
      )
        return invalid("Workspace pack members are not contiguous and canonical.");
      pack.used += slice.length;
    } else {
      finishPack();
      let remaining = file.sizeBytes;
      for (const slice of file.slices) {
        const object = nextObject(slice.artifactId);
        const length = Math.min(remaining, THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES);
        if (slice.offset !== 0 || slice.length !== length || object.sizeBytes !== length)
          return invalid("Private transfer chunks must be exclusive and canonical.");
        remaining -= length;
      }
    }
  }
  finishPack();
  if (cursor !== objects.length) return invalid("Transfer object traversal is incomplete.");
}
