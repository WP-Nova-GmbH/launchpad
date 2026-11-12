import * as Schema from "effect/Schema";

const Identifier = Schema.NonEmptyString;
const UUID = Schema.String.check(Schema.isUUID());
const Source = { sourceTemplateId: Identifier, sourceBuildId: UUID };

/** Native catalog completion; no VM has been created or checked offline. */
export const NativeThreadVmRestoreCatalogReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native-restore-catalog-v1"),
  ...Source,
});
export type NativeThreadVmRestoreCatalogReceipt = typeof NativeThreadVmRestoreCatalogReceipt.Type;

const BootIdentity = {
  version: Schema.Literal(1),
  operationId: UUID,
  allocationId: Identifier,
  threadId: Identifier,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  bootAttempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sandboxId: Identifier,
  ...Source,
};
/** A known native boot, bound to ownership that committed before its create. */
export const NativeThreadVmRestoreBootReceipt = Schema.Struct({
  ...BootIdentity,
  kind: Schema.Literal("native-restore-boot-v1"),
});
export type NativeThreadVmRestoreBootReceipt = typeof NativeThreadVmRestoreBootReceipt.Type;

/** Native DELETE acknowledgement, without a claim about physical process exit. */
export const NativeThreadVmRestoreDeletedBootReceipt = Schema.Struct({
  ...BootIdentity,
  kind: Schema.Literal("native-restore-deleted-boot-v1"),
  acknowledged: Schema.Literal(true),
});
export type NativeThreadVmRestoreDeletedBootReceipt =
  typeof NativeThreadVmRestoreDeletedBootReceipt.Type;

export const NativeThreadVmRecoverySourceDeletedReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native-recovery-source-deleted-v1"),
  operationId: UUID,
  sourceAllocationId: Identifier,
  computeRef: Identifier,
  sourceOperationId: UUID,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  acknowledged: Schema.Literal(true),
});
export type NativeThreadVmRecoverySourceDeletedReceipt =
  typeof NativeThreadVmRecoverySourceDeletedReceipt.Type;
