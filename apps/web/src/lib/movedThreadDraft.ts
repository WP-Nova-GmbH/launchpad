import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { ComposerFileAttachment } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { readPreparedConnection } from "../state/session";

/** Recover a hydrated upload through its owning environment’s authenticated asset API. */
export async function recoverMovedDraftFile(file: ComposerFileAttachment): Promise<File | null> {
  const environmentId = file.uploadEnvironmentId ?? file.recoveryUpload?.environmentId;
  const attachmentId = file.uploadedAttachmentId ?? file.recoveryUpload?.attachmentId;
  if (!environmentId || !attachmentId) return null;
  const connection = readPreparedConnection(environmentId);
  if (!connection) return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "attachment", attachmentId } },
    }),
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") return null;
  const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (!url) return null;
  const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const blob = await response.blob();
  return blob.size === file.sizeBytes ? new File([blob], file.name, { type: file.mimeType }) : null;
}
