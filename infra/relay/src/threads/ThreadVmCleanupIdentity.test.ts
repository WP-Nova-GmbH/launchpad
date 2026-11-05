import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { restoreBootOperationId } from "../machines/E2BThreadVmRestoreAttempt.ts";
import { confirmThreadVmCleanupIdentity } from "./ThreadVmCleanupIdentity.ts";

const input = {
  allocationId: "allocation-1",
  threadId: "thread-1",
  operationId: "operation-1",
  generation: 2,
  computeRef: "sandbox-1",
};
const info = {
  sandboxId: input.computeRef,
  templateId: "template-1",
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": input.allocationId,
    "launchpad.thread_id": input.threadId,
    "launchpad.operation_id": input.operationId,
    "launchpad.generation": String(input.generation),
  },
  state: "running" as const,
  cpuCount: 2,
  memoryMB: 4096,
  envdVersion: "test",
  startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  endAt: DateTime.toDateUtc(DateTime.makeUnsafe(86400000)),
};

const sql = { unsafe: () => Effect.succeed([]) };

describe("native VM cleanup identity", () => {
  it.effect("blocks an unsettled native connect before native identity lookup", () =>
    Effect.gen(function* () {
      const pending = { unsafe: () => Effect.succeed([{}]) };
      expect(
        yield* confirmThreadVmCleanupIdentity(
          pending,
          {
            inspect: () => Effect.die("An unsettled resume cannot authorize DELETE"),
          },
          input,
        ),
      ).toBe(false);
    }),
  );
  it.effect("permits an exact native identity or native missing result", () =>
    Effect.gen(function* () {
      for (const found of [info, null]) {
        expect(
          yield* confirmThreadVmCleanupIdentity(
            sql,
            { inspect: () => Effect.succeed(found) },
            input,
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect("retains an unreadable allocation instead of using custom fallback identity", () =>
    Effect.gen(function* () {
      const compute = {
        inspect: () =>
          Effect.fail(new ThreadVmComputeError({ operation: "inspect", message: "Unavailable" })),
        inspectCreation: () => Effect.die("A failed native GET cannot authorize fallback cleanup"),
        restore: {
          inspect: () => Effect.die("A persisted restore cannot authorize fallback cleanup"),
        },
      };
      expect(yield* confirmThreadVmCleanupIdentity(sql, compute, input)).toBe(false);
    }),
  );

  it.effect("rejects every foreign native identity field", () =>
    Effect.gen(function* () {
      const foreign = [
        { ...info, sandboxId: "another-sandbox" },
        ...Object.keys(info.metadata).map((key) => ({
          ...info,
          metadata: { ...info.metadata, [key]: "another-value" },
        })),
      ];
      for (const found of foreign)
        expect(
          yield* confirmThreadVmCleanupIdentity(
            sql,
            { inspect: () => Effect.succeed(found) },
            input,
          ),
        ).toBe(false);
    }),
  );

  it.effect("accepts an exact restored child only through its native metadata", () =>
    Effect.gen(function* () {
      const found = {
        ...info,
        metadata: {
          ...info.metadata,
          "launchpad.restore": "v1",
          "launchpad.restore_parent_operation_id": input.operationId,
          "launchpad.restore_boot_attempt": "1",
          "launchpad.operation_id": restoreBootOperationId(input.operationId, 1),
        },
      };
      expect(
        yield* confirmThreadVmCleanupIdentity(sql, { inspect: () => Effect.succeed(found) }, input),
      ).toBe(true);
    }),
  );
});
