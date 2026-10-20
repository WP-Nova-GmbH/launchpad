import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RelayThreadVmRestore } from "@t3tools/contracts/relay";
import {
  serializeBackupRecovery,
  serializeThreadVmRestore,
} from "./ThreadVmRestoreSerialization.ts";

const identity = {
  operationId: "221a1c93-a0dc-46ab-aea1-f75c24b11947",
  allocationId: "359d5916-d0d9-4cf2-a3a7-13fd5ec87dd4",
  threadId: "thread",
  generation: 2,
  errorCode: null,
};
const decode = Schema.decodeUnknownSync(RelayThreadVmRestore);

describe("VM recovery progress replies", () => {
  it.each([
    ["pending", "saving_history", true],
    ["retaining", "retaining_source", false],
    ["retained", "stopping_source", false],
    ["stopped", "restoring_workspace", false],
  ] as const)(
    "reports the %s stage and safe cancellation boundary",
    (phase, recoveryStage, canCancel) => {
      const reply = decode(serializeBackupRecovery({ ...identity, phase }));
      expect(reply).toMatchObject({ generation: 3, phase: "pending", recoveryStage, canCancel });
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "does not reopen a %s admission on retry",
    (phase) => {
      const reply = decode(serializeBackupRecovery({ ...identity, phase }));
      expect(reply.phase).toBe(phase === "cancelled" ? "aborted" : "completed");
      expect(reply.canCancel).toBe(false);
    },
  );

  it.each(["importing", "completed"] as const)(
    "preserves real %s restore progress after an admission retry",
    (phase) => {
      const reply = decode(
        serializeThreadVmRestore({ ...identity, phase, savedDiskOperationId: null }),
      );
      expect(reply).toMatchObject({ generation: 3, phase, canCancel: false });
    },
  );

  it("only offers precommit cancellation for an ordinary saved-disk restore", () => {
    const restored = { ...identity, phase: "prepared" as const };
    expect(
      serializeThreadVmRestore({ ...restored, savedDiskOperationId: identity.operationId })
        .canCancel,
    ).toBe(true);
    expect(serializeThreadVmRestore({ ...restored, savedDiskOperationId: null }).canCancel).toBe(
      false,
    );
  });
});
