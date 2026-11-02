import * as Schema from "effect/Schema";

export const ThreadTransferFormat = Schema.Literals([
  "launchpad-thread-chunks-v1",
  "launchpad-thread-chunks-v2",
]);
export type ThreadTransferFormat = typeof ThreadTransferFormat.Type;
export const ThreadTransferFormats = Schema.Array(ThreadTransferFormat).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
);
export type ThreadTransferFormats = typeof ThreadTransferFormats.Type;

export const ThreadTransferEncodingPolicy = Schema.Literals(["v1-64MiB", "workspace-raw-v2-8MiB"]);
export type ThreadTransferEncodingPolicy = typeof ThreadTransferEncodingPolicy.Type;
