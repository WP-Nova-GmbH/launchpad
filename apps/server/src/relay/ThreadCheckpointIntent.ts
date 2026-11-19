import * as NodeCrypto from "node:crypto";

/** Derived from immutable outbox identity so a worker restart cannot invent another upload. */
export const checkpointPublicationOperationId = (
  format: string,
  threadId: string,
  generation: number,
  turnId: string,
  point: {
    environmentId: string;
    captureOperationId?: string | null;
    manifestSha256: string;
    archiveSha256: string;
    additionalManifestSha256?: string;
    sourceSequence: number;
  },
) => {
  const bytes = NodeCrypto.createHash("sha1")
    .update(Buffer.from("d19b6bcaaf9a41989db96e90d15dfe05", "hex"))
    .update(
      JSON.stringify([
        format,
        threadId,
        generation,
        turnId,
        point.environmentId,
        point.sourceSequence,
        point.manifestSha256,
        point.archiveSha256,
        ...(point.additionalManifestSha256 === undefined ? [] : [point.additionalManifestSha256]),
        ...(point.captureOperationId ? [point.captureOperationId] : []),
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
