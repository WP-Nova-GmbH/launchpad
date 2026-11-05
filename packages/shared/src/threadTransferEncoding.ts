import type {
  ThreadTransferEncodingPolicy,
  ThreadTransferFormat,
} from "@t3tools/contracts/threadTransferFormat";

export const THREAD_TRANSFER_SUPPORTED_FORMATS = [
  "launchpad-thread-chunks-v1",
  "launchpad-thread-chunks-v2",
] as const satisfies readonly ThreadTransferFormat[];

/** Missing capability claims are legacy support; an unfinished enrollment stays unknown at its caller. */
export function normalizeThreadTransferFormats(
  formats?: readonly ThreadTransferFormat[] | null,
): readonly ThreadTransferFormat[] {
  if (formats == null) return ["launchpad-thread-chunks-v1"];
  return THREAD_TRANSFER_SUPPORTED_FORMATS.filter((format) => formats.includes(format));
}

export const threadTransferFormatForPolicy = (
  policy: ThreadTransferEncodingPolicy,
): ThreadTransferFormat =>
  policy === "v1-64MiB" ? "launchpad-thread-chunks-v1" : "launchpad-thread-chunks-v2";

export const threadTransferPolicyForFormat = (
  format: ThreadTransferFormat,
): ThreadTransferEncodingPolicy =>
  format === "launchpad-thread-chunks-v1" ? "v1-64MiB" : "workspace-raw-v2-8MiB";
