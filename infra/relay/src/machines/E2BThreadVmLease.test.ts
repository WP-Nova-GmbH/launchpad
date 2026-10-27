// @effect-diagnostics globalDate:off - E2B SDK fixtures expose native Date deadlines.
import { ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import type { SandboxInfo } from "e2b";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { restoreBootOperationId } from "./E2BThreadVmRestoreAttempt.ts";
import { makeE2BThreadVmLease } from "./E2BThreadVmLease.ts";

const settings = {
  apiUrl: "http://e2b-api.test",
  sandboxUrl: "http://e2b-sandbox.test",
  apiKey: Redacted.make("test"),
  templateId: "template:build-version",
  hostAddresses: [],
  timeoutMs: 600_000,
};
const identity = {
  operationId: "provision",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: RelayRepositoryId.make("repo"),
    generation: 1,
  },
};
const info: SandboxInfo = {
  sandboxId: "sandbox",
  templateId: "template",
  state: "running",
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "provision",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "1",
  },
  startedAt: new Date(0),
  endAt: new Date(8_000_000_000_000),
  cpuCount: 2,
  memoryMB: 4096,
  envdVersion: "1",
};

describe("thread VM infrastructure lease", () => {
  it.effect("renews only a verified running VM without a waking connection", () =>
    Effect.gen(function* () {
      const transport = vi.fn(async () =>
        Response.json({
          sandboxID: "sandbox",
          templateID: "template",
          state: "running",
          envdVersion: "1",
          envdAccessToken: "token",
          lifecycle: { autoResume: false },
          metadata: {
            "launchpad.managed": "thread-vm-v1",
            "launchpad.allocation_id": "allocation",
            "launchpad.operation_id": "provision",
            "launchpad.thread_id": "thread",
            "launchpad.generation": "1",
          },
        }),
      );
      const setTimeout = vi.fn(async () => {});
      const inspect = vi.fn(async (): Promise<SandboxInfo> => info);
      const renew = makeE2BThreadVmLease(settings, transport as typeof fetch, setTimeout, inspect);
      yield* renew("sandbox", identity);
      expect(transport).toHaveBeenCalledOnce();
      expect(inspect).toHaveBeenCalledOnce();
      expect(setTimeout).toHaveBeenCalledWith(
        "sandbox",
        600_000,
        expect.objectContaining({ apiUrl: settings.apiUrl, sandboxUrl: settings.sandboxUrl }),
      );
      expect(
        yield* Effect.flip(
          renew("sandbox", {
            ...identity,
            scope: { ...identity.scope, allocationId: "other" },
          }),
        ),
      ).toMatchObject({ _tag: "ThreadVmComputeError" });
      expect(setTimeout).toHaveBeenCalledOnce();
    }),
  );

  it.effect("renews an exact retry boot and rechecks its child identity after renewal", () =>
    Effect.gen(function* () {
      const metadata = {
        ...info.metadata,
        "launchpad.restore": "v1",
        "launchpad.restore_parent_operation_id": identity.operationId,
        "launchpad.restore_boot_attempt": "1",
        "launchpad.operation_id": restoreBootOperationId(identity.operationId, 1),
      };
      const transport = vi.fn(async () =>
        Response.json({
          sandboxID: "sandbox",
          templateID: "sandbox",
          state: "running",
          envdVersion: "1",
          envdAccessToken: "token",
          lifecycle: { autoResume: false },
          metadata,
        }),
      );
      const setTimeout = vi.fn(async () => {});
      let returned = { ...info, templateId: "sandbox", metadata };
      const renew = makeE2BThreadVmLease(
        settings,
        transport as typeof fetch,
        setTimeout,
        async () => returned,
      );
      yield* renew("sandbox", identity);
      returned = {
        ...returned,
        metadata: { ...metadata, "launchpad.restore_parent_operation_id": "foreign" },
      };
      expect(yield* Effect.flip(renew("sandbox", identity))).toMatchObject({
        _tag: "ThreadVmComputeError",
        operation: "renew lease",
      });
      expect(setTimeout).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("does not confirm a lease silently shortened by E2B", () =>
    Effect.gen(function* () {
      const transport = vi.fn(async () =>
        Response.json({
          sandboxID: "sandbox",
          templateID: "template",
          state: "running",
          envdVersion: "1",
          envdAccessToken: "token",
          lifecycle: { autoResume: false },
          metadata: info.metadata,
        }),
      );
      const setTimeout = vi.fn(async () => {});
      const inspect = vi.fn(async (): Promise<SandboxInfo> => ({
        ...info,
        endAt: new Date(60_000),
      }));
      const renew = makeE2BThreadVmLease(settings, transport as typeof fetch, setTimeout, inspect);
      expect(yield* Effect.flip(renew("sandbox", identity))).toMatchObject({
        _tag: "ThreadVmComputeError",
        operation: "renew lease",
      });
      expect(setTimeout).toHaveBeenCalledOnce();
      expect(inspect).toHaveBeenCalledOnce();
    }),
  );
});
