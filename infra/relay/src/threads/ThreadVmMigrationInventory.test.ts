import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  MigrationPinId,
  threadVmMigrationBlockers,
  type ThreadVmMigrationCatalogue,
} from "./ThreadVmMigrationInventory.ts";
const isMigrationPinId = Schema.is(MigrationPinId);

const catalogue = {
  hostId: "host",
  hostConfigured: true,
  collectedAt: "2026-10-27T12:00:00.000Z",
  allocations: [
    {
      allocationId: "allocation",
      threadId: "thread",
      generation: 1,
      placementGeneration: 1,
      state: "running",
      computeRef: "compute",
      templateId: "template",
      nativePausedGeneration: null,
      runtimeProtocol: "legacy",
    },
  ],
  backups: [
    {
      operationId: "backup",
      allocationId: "allocation",
      threadId: "thread",
      generation: 1,
      phase: "verified",
      snapshotId: "snapshot",
      sourceTemplateId: "template",
      sourceBuildId: "build",
      hasLegacyColdProof: true,
      hasNativeCaptureReceipt: false,
      pinOperationIds: [],
    },
  ],
  savedDisks: [],
  pendingOperations: [],
} satisfies ThreadVmMigrationCatalogue;

describe("VM migration catalogue blockers", () => {
  it("allows protecting a stable backup without claiming its running VM is drained", () => {
    expect(threadVmMigrationBlockers(catalogue)).toEqual([]);
  });

  it("accepts native completion without requiring a historical cold-probe receipt", () => {
    expect(
      threadVmMigrationBlockers({
        ...catalogue,
        backups: [
          { ...catalogue.backups[0]!, hasLegacyColdProof: false, hasNativeCaptureReceipt: true },
        ],
      }),
    ).toEqual([]);
  });

  it("blocks allocations whose execution generation is unavailable", () => {
    expect(
      threadVmMigrationBlockers({
        ...catalogue,
        allocations: [{ ...catalogue.allocations[0]!, generation: null }],
      }),
    ).toEqual([{ kind: "allocation", id: "allocation", state: "missing-provision-generation" }]);
  });

  it("allows completed deletion of an allocation that never reached provisioning", () => {
    expect(
      threadVmMigrationBlockers({
        ...catalogue,
        allocations: [
          { ...catalogue.allocations[0]!, generation: null, state: "deleted", computeRef: null },
        ],
      }),
    ).toEqual([]);
  });

  for (const state of ["creating", "running", "paused", "deleting"]) {
    it(`still blocks missing execution identity for a ${state} allocation`, () => {
      expect(
        threadVmMigrationBlockers({
          ...catalogue,
          allocations: [{ ...catalogue.allocations[0]!, generation: null, state }],
        }),
      ).toContainEqual({
        kind: "allocation",
        id: "allocation",
        state: "missing-provision-generation",
      });
    });
  }

  for (const phase of [
    "pending",
    "creating",
    "captured",
    "verifying",
    "cleanup",
    "failed",
    "retiring",
  ]) {
    it(`blocks the unresolved ${phase} backup`, () => {
      expect(
        threadVmMigrationBlockers({ ...catalogue, backups: [{ ...catalogue.backups[0]!, phase }] }),
      ).toEqual([{ kind: "backup", id: "backup", state: phase }]);
    });
  }

  for (const missing of [
    "snapshotId",
    "sourceTemplateId",
    "sourceBuildId",
    "hasLegacyColdProof",
  ] as const) {
    it(`blocks a verified backup missing ${missing}`, () => {
      expect(
        threadVmMigrationBlockers({
          ...catalogue,
          backups: [
            {
              ...catalogue.backups[0]!,
              [missing]: missing === "hasLegacyColdProof" ? false : null,
            },
          ],
        }),
      ).toHaveLength(1);
    });
  }

  it("reports pending operations and disks already claimed for expiry", () => {
    expect(
      threadVmMigrationBlockers({
        ...catalogue,
        savedDisks: [
          {
            operationId: "disk",
            threadId: "thread",
            backupOperationId: "backup",
            generation: 1,
            phase: "expiring",
            savedAt: catalogue.collectedAt,
            expiresAt: catalogue.collectedAt,
          },
        ],
        pendingOperations: [
          { kind: "restore", operationId: "restore", threadId: "thread", phase: "prepared" },
        ],
      }),
    ).toEqual([
      { kind: "saved-disk", id: "disk", state: "expiring" },
      { kind: "restore", id: "restore", state: "prepared" },
    ]);
  });

  it("does not treat retired historical backups as unresolved work", () => {
    expect(
      threadVmMigrationBlockers({
        ...catalogue,
        backups: [{ ...catalogue.backups[0]!, phase: "retired", snapshotId: null }],
      }),
    ).toEqual([]);
  });

  it("restricts migration pins to a separate bounded namespace", () => {
    expect(isMigrationPinId("e2b-migration-stock-20261027")).toBe(true);
    for (const pin of [
      "saved-existing",
      "arbitrary-operation",
      "e2b-migration-",
      "e2b-migration-" + "x".repeat(50),
    ])
      expect(isMigrationPinId(pin)).toBe(false);
  });
});
