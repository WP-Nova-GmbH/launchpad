import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayThreadVmRestoreImportReceipt,
  ThreadVmRestoreBoot,
  ThreadVmWarmRestoreBootstrap,
  ThreadVmWarmRestoreBootstrapReceipt,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import {
  makeE2BThreadVmRestoreCleanup,
  makeE2BThreadVmRestoreImport,
  makeE2BThreadVmWarmRestoreBootstrap,
} from "./E2BThreadVmRestoreImport.ts";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknown = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const sdk = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("e2b", () => ({
  Sandbox: class {
    commands = { run: sdk.run };
  },
}));
const operationId = "00000000-0000-4000-8000-000000000001",
  allocationId = "00000000-0000-4000-8000-000000000002";
const identity = {
  operationId,
  scope: { allocationId, threadId: ThreadId.make("thread"), repositoryId: "repo", generation: 2 },
};
const receipt: RelayThreadVmRestoreImportReceipt = {
  version: 1,
  operationId,
  environmentId: EnvironmentId.make("fresh"),
  scope: identity.scope,
  projectId: ProjectId.make("vm:thread"),
  workspaceRoot: "/workspace/project",
  checkoutPath: "/workspace/project",
  branch: "main",
  revision: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  sourceEnvironmentId: EnvironmentId.make("old"),
  sourceSequence: 12,
  nativeManifestArtifactId: "00000000-0000-4000-8000-000000000003",
  attachmentManifestArtifactId: "00000000-0000-4000-8000-000000000004",
  sequence: 12,
  execution: "frozen",
};
const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("host-secret"),
  templateId: "template:build",
  hostAddresses: [],
  timeoutMs: 900000,
};
const info = {
  sandboxID: "sandbox",
  templateID: "sandbox",
  state: "running",
  envdVersion: "0.9",
  envdAccessToken: "transport-secret",
  lifecycle: { autoResume: false },
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.operation_id": operationId,
    "launchpad.allocation_id": allocationId,
    "launchpad.thread_id": "thread",
    "launchpad.generation": "2",
    "launchpad.restore": "v1",
  },
};
const encode = Schema.encodeSync(Schema.fromJsonString(RelayThreadVmRestoreImportReceipt)),
  decodeBoot = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadVmRestoreBoot));
function fixture() {
  const transport = vi.fn<typeof fetch>(async () => Response.json(info)),
    guest = vi.fn(async (_connection: unknown, _payload: string) => encode(receipt));
  return { transport, guest, import: makeE2BThreadVmRestoreImport(settings, transport, guest) };
}
describe("warm restore bootstrap", () => {
  const input: ThreadVmWarmRestoreBootstrap = {
    boot: { version: 1, operationId, allocationId, threadId: "thread", generation: 5 },
    source: {
      operationId: "00000000-0000-4000-8000-000000000003",
      allocationId: "00000000-0000-4000-8000-000000000004",
      threadId: "thread",
      generation: 2,
      bootId: "00000000-0000-4000-8000-000000000005",
      captureOperationId: "00000000-0000-4000-8000-000000000006",
      sealEpoch: 7,
    },
  };
  const positive: ThreadVmWarmRestoreBootstrapReceipt = {
    version: 1,
    kind: "native-warm-restore-bootstrap-v1",
    ...input,
    targetSealEpoch: 8,
    coordinatorStopped: true,
    sealRebound: true,
  };
  const next = { ...identity, scope: { ...identity.scope, generation: 5 } };
  const nextInfo = { ...info, metadata: { ...info.metadata, "launchpad.generation": "5" } };
  it.effect(
    "uses root envd stdin before enrollment and requires an exact stopped/rebound/fresh identity receipt",
    () =>
      Effect.gen(function* () {
        sdk.run.mockReset();
        const stdin = vi.fn(async (_bytes: string) => {});
        sdk.run.mockResolvedValueOnce({
          sendStdin: stdin,
          wait: async () => ({
            exitCode: 0,
            stdout: encodeUnknown(positive),
          }),
        });
        const transport = vi.fn<typeof fetch>(async () => Response.json(nextInfo));
        expect(
          yield* makeE2BThreadVmWarmRestoreBootstrap(settings, transport)("sandbox", next, input),
        ).toEqual(positive);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0]![0]).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
        expect(sdk.run.mock.calls[0]![0]).toContain("__thread-vm-restore-identity");
        expect(sdk.run.mock.calls[0]![1]).toMatchObject({ user: "root", stdin: true });
        expect(decodeJson(stdin.mock.calls[0]![0])).toEqual(input);
        expect(stdin.mock.calls[0]![0]).not.toContain("secret");
      }),
  );
  it.effect("rejects foreign source, epoch, coordinator or target acknowledgements", () =>
    Effect.gen(function* () {
      for (const changed of [
        { ...positive, source: { ...positive.source, captureOperationId: operationId } },
        { ...positive, boot: { ...positive.boot, generation: 6 } },
        { ...positive, targetSealEpoch: 9 },
        { ...positive, coordinatorStopped: false },
        { ...positive, sealRebound: false },
      ]) {
        const transport = vi.fn<typeof fetch>(async () => Response.json(nextInfo));
        const guest = vi.fn(async () => encodeUnknown(changed));
        const error = yield* makeE2BThreadVmWarmRestoreBootstrap(settings, transport, guest)(
          "sandbox",
          next,
          input,
        ).pipe(Effect.flip);
        expect(error.operation).toBe("bootstrap");
        expect(error).not.toHaveProperty("cause");
      }
    }),
  );
  it.effect(
    "does not dispatch root bootstrap for a paused VM or an uncommitted target identity",
    () =>
      Effect.gen(function* () {
        const guest = vi.fn(async () => encodeUnknown(positive));
        const transport = vi.fn<typeof fetch>(async () =>
          Response.json({ ...nextInfo, state: "paused" }),
        );
        yield* makeE2BThreadVmWarmRestoreBootstrap(settings, transport, guest)(
          "sandbox",
          next,
          input,
        ).pipe(Effect.flip);
        expect(guest).not.toHaveBeenCalled();
        transport.mockClear();
        yield* makeE2BThreadVmWarmRestoreBootstrap(settings, transport, guest)(
          "sandbox",
          identity,
          input,
        ).pipe(Effect.flip);
        expect(transport).not.toHaveBeenCalled();
      }),
  );
});
describe("restore import delivery", () => {
  it.effect(
    "inspects without waking and sends only public restore scope to the offline import",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(yield* f.import("sandbox", "fresh", identity)).toEqual(receipt);
        expect(f.transport.mock.calls[0]![0]).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
        expect(f.transport.mock.calls[0]![1]?.method).toBeUndefined();
        expect(yield* decodeBoot(f.guest.mock.calls[0]![1])).toEqual({
          version: 1,
          operationId,
          allocationId,
          threadId: "thread",
          generation: 2,
        });
        expect(f.guest.mock.calls[0]![1]).not.toContain("secret");
        sdk.run.mockReset();
        const stdin = vi.fn(async (_value: string) => {});
        sdk.run.mockResolvedValueOnce({
          sendStdin: stdin,
          wait: async () => ({ exitCode: 0, stdout: encode(receipt) }),
        });
        expect(
          yield* makeE2BThreadVmRestoreImport(settings, f.transport)("sandbox", "fresh", identity),
        ).toEqual(receipt);
        expect(sdk.run.mock.calls[0]![0]).toContain("__thread-vm-restore-import");
        expect(sdk.run.mock.calls[0]![1]).toMatchObject({
          user: "user",
          background: true,
          stdin: true,
        });
        expect(stdin.mock.calls[0]![0]).not.toContain("secret");
      }),
  );
  it.effect(
    "refuses paused, auto-resuming and mismatched allocations before executing guest code",
    () =>
      Effect.gen(function* () {
        for (const changed of [
          { ...info, state: "paused" },
          { ...info, lifecycle: { autoResume: true } },
          { ...info, envdAccessToken: "" },
          { ...info, metadata: { ...info.metadata, "launchpad.operation_id": "other" } },
          { ...info, templateID: "other" },
        ]) {
          const f = fixture();
          f.transport.mockResolvedValueOnce(Response.json(changed));
          yield* Effect.flip(f.import("sandbox", "fresh", identity));
          expect(f.guest).not.toHaveBeenCalled();
        }
      }),
  );
  it.effect("rejects foreign import receipts and redacts failed guest output", () =>
    Effect.gen(function* () {
      for (const changed of [
        { ...receipt, environmentId: EnvironmentId.make("old") },
        { ...receipt, scope: { ...receipt.scope, generation: 3 } },
        { ...receipt, checkoutPath: "/etc" },
        { ...receipt, operationId: "00000000-0000-4000-8000-000000000005" },
      ]) {
        const f = fixture();
        f.guest.mockResolvedValueOnce(encode(changed));
        expect(yield* Effect.flip(f.import("sandbox", "fresh", identity))).toMatchObject({
          _tag: "ThreadVmComputeError",
        });
      }
      const f = fixture();
      f.guest.mockRejectedValueOnce(new Error("host-secret transport-secret"));
      const error = yield* Effect.flip(f.import("sandbox", "fresh", identity));
      expect(error.message).not.toContain("secret");
      sdk.run.mockReset();
      sdk.run.mockResolvedValueOnce({
        sendStdin: async () => {},
        wait: async () => ({ exitCode: 1, stdout: encode(receipt), stderr: "secret" }),
      });
      yield* Effect.flip(
        makeE2BThreadVmRestoreImport(settings, f.transport)("sandbox", "fresh", identity),
      );
    }),
  );
  it.effect("cleans only the inspected allocation as root using public scope", () =>
    Effect.gen(function* () {
      const f = fixture(),
        stdin = vi.fn(async (_value: string) => {});
      sdk.run.mockReset();
      sdk.run.mockResolvedValueOnce({
        sendStdin: stdin,
        wait: async () => ({ exitCode: 0, stdout: '{"cleaned":true}' }),
      });
      yield* makeE2BThreadVmRestoreCleanup(settings, f.transport)("sandbox", identity);
      expect(sdk.run.mock.calls[0]![0]).toContain("__thread-vm-restore-cleanup");
      expect(sdk.run.mock.calls[0]![1]).toMatchObject({ user: "root", stdin: true });
      expect(yield* decodeBoot(stdin.mock.calls[0]![0])).toEqual({
        version: 1,
        operationId,
        allocationId,
        threadId: "thread",
        generation: 2,
      });
      sdk.run.mockClear();
      f.transport.mockResolvedValueOnce(Response.json({ ...info, state: "paused" }));
      yield* Effect.flip(makeE2BThreadVmRestoreCleanup(settings, f.transport)("sandbox", identity));
      expect(sdk.run).not.toHaveBeenCalled();
    }),
  );
});
