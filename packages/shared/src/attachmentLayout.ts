import type { ChatAttachment } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Mime from "effect/unstable/http/Mime";

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
/** Attachment names are display filenames, so only a final basename extension is accepted. */
const portableExtension = (name: string) => {
  const base = name.slice(name.lastIndexOf("/") + 1),
    dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
};

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

/** Extract the exact thread identity rather than accepting a matching prefix. */
export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const match =
    /^([a-z0-9_]+(?:-[a-z0-9_]+)*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([a-z0-9]{1,10}))?$/iu.exec(
      attachmentId,
    );
  return match?.[1]?.toLowerCase() ?? null;
}

export function attachmentFileExtension(fileName: string, extname = portableExtension): string {
  const extension = extname(fileName).toLowerCase();
  // ".part" is reserved for in-flight uploads; a stored "archive.part" would
  // look stale to sweepStalePendingAttachments and get deleted.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, key)
    ? IMAGE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) {
    return fromMime;
  }

  // The registry returns bare extensions ("png"); the safe list is dotted.
  const fromMimeExtension = Option.map(Mime.getExtension(input.mimeType), (ext) => `.${ext}`);
  if (Option.isSome(fromMimeExtension) && SAFE_IMAGE_FILE_EXTENSIONS.has(fromMimeExtension.value)) {
    return fromMimeExtension.value;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_IMAGE_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}

/** Null for attachment types this build does not know; callers skip those. */
export function attachmentRelativePath(
  attachment: ChatAttachment,
  extensionForFile = attachmentFileExtension,
): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}${extensionForFile(attachment.name)}`;
    default:
      return null;
  }
}
