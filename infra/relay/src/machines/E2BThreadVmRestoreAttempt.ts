import { sha256 } from "@noble/hashes/sha2.js";

/** E2B restore requests are immutable by operation ID. A stopped boot retry
 * gets its own infrastructure ID while the thread's durable intent stays fixed. */
export function restoreBootOperationId(operationId: string, attempt = 0) {
  if (attempt === 0) return operationId;
  const bytes = sha256(
    new TextEncoder().encode(
      `launchpad-thread-vm-restore-boot-v1:${operationId.toLowerCase()}:${attempt}`,
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Used only with an authenticated, exact sandbox lookup. Guests cannot set
 * these control-plane tags; every caller still checks allocation/thread/generation. */
export function threadVmOperationMatches(
  metadata: Readonly<Record<string, string>>,
  operationId: string,
) {
  if (metadata["launchpad.operation_id"] === operationId) return true;
  const attempt = metadata["launchpad.restore_boot_attempt"] ?? "";
  return (
    metadata["launchpad.restore"] === "v1" &&
    metadata["launchpad.restore_parent_operation_id"] === operationId &&
    /^[1-9][0-9]{0,8}$/u.test(attempt) &&
    metadata["launchpad.operation_id"] === restoreBootOperationId(operationId, Number(attempt))
  );
}
