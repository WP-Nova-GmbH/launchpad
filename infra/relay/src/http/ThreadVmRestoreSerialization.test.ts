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
  targetGeneration: null,
  enrollmentIssued: false,
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

  it("offers native cancellation through bootstrap and reports the actual committed generation", () => {
    for (const phase of ["prepared", "committed", "creating", "bootstrapping", "booted"] as const) {
      const restored = { ...identity, phase, targetGeneration: 5 };
      expect(
        decode(
          serializeThreadVmRestore({
            ...restored,
            savedDiskOperationId: identity.operationId,
          }),
        ),
      ).toMatchObject({ phase, generation: 5, canCancel: true });
      expect(serializeThreadVmRestore({ ...restored, savedDiskOperationId: null }).canCancel).toBe(
        false,
      );
      expect(
        serializeThreadVmRestore({
          ...restored,
          savedDiskOperationId: identity.operationId,
          enrollmentIssued: true,
        }).canCancel,
      ).toBe(false);
    }
    expect(
      serializeThreadVmRestore({
        ...identity,
        phase: "importing",
        targetGeneration: 5,
        savedDiskOperationId: identity.operationId,
      }).canCancel,
    ).toBe(false);
  });
});
