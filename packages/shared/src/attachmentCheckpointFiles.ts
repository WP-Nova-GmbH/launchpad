import type { ThreadAttachmentCheckpointArchiveManifest } from "@t3tools/contracts/relay";
import {
  THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES,
  THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES,
} from "@t3tools/contracts/relay";
import { attachmentRelativePath, toSafeThreadAttachmentSegment } from "./attachmentLayout.ts";

/** Credentials and unrelated files cannot enter the independent chat-attachment catalog. */
export function attachmentCheckpointFiles(header: ThreadAttachmentCheckpointArchiveManifest) {
  const manifest = header.attachments;
  const thread = toSafeThreadAttachmentSegment(header.threadId);
  if (
    !thread ||
    manifest.threadId !== header.threadId ||
    manifest.files.length > THREAD_ATTACHMENT_CHECKPOINT_MAX_FILES ||
    manifest.files.reduce((sum, file) => sum + file.attachment.sizeBytes, 0) >
      THREAD_ATTACHMENT_CHECKPOINT_MAX_BYTES
  )
    return null;
  const files = new Map<string, { readonly sha256: string; readonly sizeBytes?: number }>([
    ["attachments/manifest.json", { sha256: header.attachmentManifestSha256 }],
  ]);
  const ids = new Set<string>(),
    names = new Set<string>(["manifest.json"]);
  for (const file of manifest.files) {
    const match =
      /^([a-z0-9_]+(?:-[a-z0-9_]+)*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([a-z0-9]{1,10}))?$/iu.exec(
        file.attachment.id,
      );
    const name = attachmentRelativePath(file.attachment);
    if (
      !name ||
      match?.[1]?.toLowerCase() !== thread ||
      ids.has(file.attachment.id) ||
      names.has(name.toLowerCase())
    )
      return null;
    ids.add(file.attachment.id);
    names.add(name.toLowerCase());
    files.set(`attachments/${name}`, { sha256: file.sha256, sizeBytes: file.attachment.sizeBytes });
  }
  return files;
}
