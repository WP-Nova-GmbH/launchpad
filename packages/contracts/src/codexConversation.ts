import * as Schema from "effect/Schema";
export const NativeThreadId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
export const RolloutName = Schema.String.check(
  Schema.isPattern(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[\da-f-]+(?:_[\da-f-]+)?\.jsonl$/i),
);
// Runner image and portability-proof default, not a transfer compatibility gate.
// Transfers retain the source version and require a successful destination resume.
export const CODEX_CONVERSATION_TRANSFER_VERSION = "0.159.3";

const ReferencedFile = Schema.Struct({
  sourcePath: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  name: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
  ),
});
export const CodexConversationManifest = Schema.Struct({
  format: Schema.Literals(["codex-rollout-v1", "codex-rollout-v2", "codex-rollout-v3"]),
  threadId: NativeThreadId,
  codexVersion: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  historyMode: Schema.Literal("paginated"),
  rolloutName: RolloutName,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  files: Schema.optionalKey(Schema.Array(ReferencedFile).check(Schema.isMaxLength(256))),
  heads: Schema.optionalKey(Schema.Record(NativeThreadId, RolloutName)),
  rollouts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        rolloutName: RolloutName,
        sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
        sizeBytes: Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
        ),
      }),
    ).check(Schema.isMaxLength(256)),
  ),
});
export type CodexConversationManifest = typeof CodexConversationManifest.Type;
