// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - Standalone opt-in E2B proofs.
import * as NodeCrypto from "node:crypto";

/** Each disposable creation has its own durable identity, even inside a multi-VM proof. */
export const threadVmSmokeMetadata = (proof: string) => ({
  "launchpad.managed": "thread-vm-v1",
  "launchpad.proof": proof,
  "launchpad.operation_id": NodeCrypto.randomUUID(),
  "launchpad.allocation_id": NodeCrypto.randomUUID(),
  "launchpad.thread_id": NodeCrypto.randomUUID(),
  "launchpad.generation": "1",
});
