import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The SDK's Node dispatcher must send its real create request to an owned test socket.
import * as NodeHttp from "node:http";
import { vi } from "vite-plus/test";
import { Sandbox, SandboxNotFoundError, type SandboxInfo } from "e2b";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { makeE2BThreadVmCompute, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const settings: E2BThreadVmSettings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("management-key"),
  templateId: "verified-launchpad-template",
  hostAddresses: ["203.0.113.4/32"],
  timeoutMs: 900_000,
};
const input = {
  allocationId: "allocation-1",
  operationId: "operation-1",
  threadId: "thread-1",
  generation: 2,
  environment: { LAUNCHPAD_ENROLLMENT: "single-use-seed" },
};
const info: SandboxInfo = {
  sandboxId: "sandbox-1",
  templateId: settings.templateId,
  metadata: {},
  startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  endAt: DateTime.toDateUtc(DateTime.makeUnsafe(900_000)),
  state: "paused",
  cpuCount: 2,
  memoryMB: 4096,
  envdVersion: "test",
};

function fixture(overrides: Partial<E2BThreadVmSettings> = {}) {
  const client = {
    create: vi.fn(async () => ({ sandboxId: "sandbox-1" })),
    getInfo: vi.fn(async (): Promise<SandboxInfo> => info),
    kill: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    connect: vi.fn(async () => ({ sandboxId: "sandbox-1" })),
    createSnapshot: vi.fn(async () => ({ snapshotId: "snapshot-1", names: [] })),
    listSnapshots: vi.fn(() => {
      let page = 0;
      return {
        get hasNext() {
          return page < 1;
        },
        nextItems: async () => {
          page++;
          return [{ snapshotId: "snapshot-1", names: ["team/backup-1:default"] }];
        },
      };
    }),
    deleteSnapshot: vi.fn(async () => true),
    list: vi.fn(() => ({ hasNext: false, nextItems: async (): Promise<SandboxInfo[]> => [] })),
  };
  const transport = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith("/capabilities")
        ? {
            version: 1,
            diskRestore: true,
            quiescedSnapshots: true,
            renewableLifetime: true,
            durableCreationIdentity: true,
          }
        : { sandboxID: "sandbox-1", physicallyStopped: true },
    ),
  );
  return {
    client,
    transport,
    compute: makeE2BThreadVmCompute({ ...settings, ...overrides }, client, transport),
  };
}

describe("E2B thread VM compute", () => {
  it.effect("sends a filesystem-only timeout pause through the real SDK", () =>
    Effect.gen(function* () {
      const created: unknown[] = [];
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.url !== "/sandboxes" || request.method !== "POST") {
            response.writeHead(404).end();
            return;
          }
          created.push(JSON.parse(body));
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              sandboxID: "sandbox-1",
              templateID: settings.templateId,
              clientID: "test-client",
              envdVersion: "0.5.0",
            }),
          );
        });
      });
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          }),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No test listener");
        const transport: typeof fetch = async () =>
          Response.json({
            version: 1,
            diskRestore: true,
            renewableLifetime: true,
            quiescedSnapshots: true,
            durableCreationIdentity: true,
          });
        const compute = makeE2BThreadVmCompute(
          {
            ...settings,
            apiUrl: `http://127.0.0.1:${address.port}`,
          },
          Sandbox,
          transport,
        );
        expect(yield* compute.create(input)).toEqual({ sandboxId: "sandbox-1" });
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
          autoPause: true,
          autoPauseMemory: false,
          autoResume: { enabled: false },
          timeout: settings.timeoutMs / 1000,
        });
      } finally {
        server.closeAllConnections();
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        );
      }
    }),
  );
  it.effect("reads durable creation identity without waking an unreadable paused VM", () =>
    Effect.gen(function* () {
      const { compute, transport, client } = fixture();
      const metadata = { "launchpad.thread_id": input.threadId };
      transport.mockResolvedValueOnce(
        Response.json({
          operationID: input.operationId,
          sandboxID: "sandbox-1",
          metadata,
          cancelled: false,
        }),
      );
      expect(yield* compute.inspectCreation(input.operationId)).toEqual({
        operationId: input.operationId,
        computeRef: "sandbox-1",
        metadata,
      });
      expect(transport).toHaveBeenCalledWith(
        `${settings.apiUrl}/extensions/launchpad/v1/creations/${input.operationId}`,
        expect.objectContaining({ method: "GET", redirect: "error" }),
      );
      expect(client.getInfo).not.toHaveBeenCalled();
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.kill).not.toHaveBeenCalled();
    }),
  );
  it.effect("missing, foreign and unavailable creation identities never certify a VM", () =>
    Effect.gen(function* () {
      const { compute, transport } = fixture();
      transport.mockResolvedValueOnce(new Response(null, { status: 404 }));
      expect(yield* compute.inspectCreation(input.operationId)).toBeNull();
      for (const response of [
        new Response(null, { status: 503 }),
        Response.json({
          operationID: "another-operation",
          sandboxID: "sandbox-1",
          metadata: {},
          cancelled: false,
        }),
        Response.json({
          operationID: input.operationId,
          sandboxID: "",
          metadata: {},
          cancelled: false,
        }),
      ]) {
        transport.mockResolvedValueOnce(response);
        expect(yield* Effect.flip(compute.inspectCreation(input.operationId))).toMatchObject({
          operation: "inspect creation",
        });
      }
    }),
  );
  it.effect("refuses backups on runtimes that can lose the guest page cache", () =>
    Effect.gen(function* () {
      const { client, compute, transport } = fixture();
      transport.mockResolvedValueOnce(
        Response.json({ version: 1, diskRestore: true, renewableLifetime: false }),
      );
      expect(yield* Effect.flip(compute.snapshot("sandbox-1"))).toMatchObject({
        reason: "unsupported",
      });
      expect(client.createSnapshot).not.toHaveBeenCalled();
      transport.mockResolvedValueOnce(
        Response.json({
          version: 1,
          diskRestore: true,
          renewableLifetime: false,
          quiescedSnapshots: true,
        }),
      );
      expect(yield* compute.snapshot("sandbox-1")).toEqual({ snapshotId: "snapshot-1", names: [] });
      expect(client.createSnapshot).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("pauses without memory and retains that disk without resuming it", () =>
    Effect.gen(function* () {
      const { client, compute, transport } = fixture();
      const capabilities = {
        version: 1,
        diskRestore: true,
        renewableLifetime: true,
        quiescedSnapshots: true,
        pausedSnapshots: true,
        certifiedPauses: true,
      };
      transport.mockImplementation(async (url) =>
        String(url).endsWith("/snapshots")
          ? Response.json({
              snapshotID: "saved:default",
              names: ["team/launchpad-backup-test:default"],
            })
          : Response.json(capabilities),
      );
      yield* compute.pause("sandbox-1");
      expect(client.pause).toHaveBeenCalledWith(
        "sandbox-1",
        expect.objectContaining({ keepMemory: false }),
      );
      yield* compute.snapshotPaused("sandbox-1", "launchpad-backup-test");
      expect(transport.mock.lastCall?.[0]).toBe(`${settings.apiUrl}/sandboxes/sandbox-1/snapshots`);
      expect(yield* decodeJson(String(transport.mock.lastCall?.[1]?.body))).toEqual({
        name: "launchpad-backup-test",
      });
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.create).not.toHaveBeenCalled();
      transport.mockImplementation(async () =>
        Response.json({ ...capabilities, certifiedPauses: false }),
      );
      expect(yield* compute.pausedSnapshotsSupported).toBe(false);
      expect(yield* Effect.flip(compute.pause("sandbox-1"))).toMatchObject({ operation: "pause" });
      expect(yield* Effect.flip(compute.snapshotPaused("sandbox-1", "other"))).toMatchObject({
        reason: "unsupported",
      });
      transport.mockImplementation(async () =>
        Response.json({ ...capabilities, pausedSnapshots: false }),
      );
      expect(yield* Effect.flip(compute.pause("sandbox-1"))).toMatchObject({ operation: "pause" });
      expect(yield* Effect.flip(compute.snapshotPaused("sandbox-1", "other"))).toMatchObject({
        reason: "unsupported",
      });
      expect(client.pause).toHaveBeenCalledTimes(1);
      expect(client.createSnapshot).not.toHaveBeenCalled();
    }),
  );

  it.effect("inspects paused VMs without waking or renewing them", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      expect(yield* compute.inspect("sandbox-1")).toEqual(info);
      expect(client.connect).not.toHaveBeenCalled();
    }),
  );

  it.effect("reconciles an uncertain named snapshot without capturing again", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      expect(yield* compute.findSnapshot("sandbox-1", "backup-1")).toMatchObject({
        snapshotId: "snapshot-1",
      });
      expect(client.listSnapshots).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: "sandbox-1",
          name: "backup-1",
        }),
      );
      expect(client.createSnapshot).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not accept an unrelated snapshot from a broad list response", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      let page = 0;
      client.listSnapshots.mockReturnValueOnce({
        get hasNext() {
          return page === 0;
        },
        nextItems: async () => {
          page++;
          return [{ snapshotId: "other-snapshot", names: ["backup-10:latest"] }];
        },
      });
      expect(yield* compute.findSnapshot("sandbox-1", "backup-1")).toBeNull();
      expect(client.createSnapshot).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses explicit self-hosted endpoints, private ingress and allocation metadata", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      yield* compute.create(input);
      expect(client.create.mock.calls).toEqual([
        [
          settings.templateId,
          expect.objectContaining({
            apiUrl: settings.apiUrl,
            sandboxUrl: settings.sandboxUrl,
            secure: true,
            metadata: expect.objectContaining({
              "launchpad.managed": "thread-vm-v1",
              "launchpad.operation_id": input.operationId,
              "launchpad.generation": "2",
            }),
            envs: input.environment,
            network: expect.objectContaining({
              allowPublicTraffic: false,
              denyOut: expect.arrayContaining(["10.0.0.0/8", "fc00::/7", "203.0.113.4/32"]),
            }),
            lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
          }),
        ],
      ]);
    }),
  );

  for (const override of [
    { apiUrl: "" },
    { sandboxUrl: "" },
    { apiUrl: "file:///tmp/api" },
    { apiUrl: "https://secret@example.test" },
    { apiKey: Redacted.make("") },
    { templateId: "" },
    { timeoutMs: 0 },
  ]) {
    it.effect("refuses incomplete configuration before making a compute request", () =>
      Effect.gen(function* () {
        const { client, compute } = fixture(override);
        expect(yield* Effect.flip(compute.create(input))).toMatchObject({
          _tag: "ThreadVmComputeError",
          operation: "configuration",
        });
        expect(client.create).not.toHaveBeenCalled();
      }),
    );
  }

  it.effect("does not retry an ambiguous creation and risk allocating a second VM", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      client.create.mockRejectedValue(new Error("reply lost after allocation"));
      expect(yield* Effect.flip(compute.create(input))).toMatchObject({
        operation: "create",
      });
      expect(client.create).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect(
    "refuses creation before sending it when durable pre-boot identity is unsupported",
    () =>
      Effect.gen(function* () {
        const { compute, client, transport } = fixture();
        transport.mockResolvedValue(
          Response.json({
            version: 1,
            diskRestore: true,
            quiescedSnapshots: true,
            renewableLifetime: true,
          }),
        );
        expect(yield* Effect.flip(compute.create(input))).toMatchObject({ operation: "create" });
        expect(client.create).not.toHaveBeenCalled();
      }),
  );

  it.effect("accepts only exact positive creation-stop receipts and never uses SDK absence", () =>
    Effect.gen(function* () {
      const { compute, client, transport } = fixture();
      const receipt = {
        operationID: input.operationId,
        sandboxID: "failed-before-routing",
        metadata: { "launchpad.operation_id": input.operationId },
        cancelled: true,
        physicallyStopped: true,
      };
      for (const invalid of [
        { ...receipt, operationID: "other-operation" },
        { ...receipt, physicallyStopped: false },
        { ...receipt, cancelled: false },
        { operationID: input.operationId, sandboxID: null },
      ]) {
        transport.mockResolvedValueOnce(Response.json(invalid));
        expect(yield* Effect.flip(compute.cancelCreate(input.operationId))).toMatchObject({
          operation: "cancel create",
        });
      }
      transport.mockResolvedValueOnce(Response.json(receipt));
      expect(yield* compute.cancelCreate(input.operationId)).toEqual({
        operationId: input.operationId,
        computeRef: "failed-before-routing",
        metadata: receipt.metadata,
      });
      transport.mockResolvedValueOnce(Response.json({ ...receipt, sandboxID: null, metadata: {} }));
      expect(yield* compute.cancelCreate(input.operationId)).toEqual({
        operationId: input.operationId,
        computeRef: null,
        metadata: {},
      });
      expect(client.list).not.toHaveBeenCalled();
      expect(client.create).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not mistake an unavailable control plane for an absent VM", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      client.getInfo.mockRejectedValue(new Error("network unavailable"));
      expect(yield* Effect.flip(compute.inspect("sandbox-1"))).toMatchObject({
        operation: "inspect",
      });
      client.getInfo.mockRejectedValue(new SandboxNotFoundError("not found"));
      expect(yield* compute.inspect("sandbox-1")).toBeNull();
    }),
  );

  it.effect(
    "requires a matching physical stop receipt, even when the routing entry is absent",
    () =>
      Effect.gen(function* () {
        const { client, transport, compute } = fixture();
        client.getInfo.mockRejectedValue(new SandboxNotFoundError("not found"));
        for (const response of [
          new Response(null, { status: 404 }),
          new Response(null, { status: 503 }),
          Response.json({ sandboxID: "sandbox-1", physicallyStopped: false }),
          Response.json({ sandboxID: "other-vm", physicallyStopped: true }),
          new Response("invalid JSON"),
        ]) {
          transport.mockResolvedValueOnce(response);
          expect(yield* Effect.flip(compute.destroy("sandbox-1"))).toMatchObject({
            operation: "destroy",
          });
        }
        transport.mockRejectedValueOnce(new Error("reply lost after stop"));
        expect(yield* Effect.flip(compute.destroy("sandbox-1"))).toMatchObject({
          operation: "destroy",
        });
        yield* compute.destroy("sandbox-1");
        expect(client.kill).not.toHaveBeenCalled();
        expect(client.getInfo).not.toHaveBeenCalled();
        expect(transport).toHaveBeenLastCalledWith(
          "http://127.0.0.1:3000/extensions/launchpad/v1/executions/sandbox-1",
          expect.objectContaining({ method: "DELETE", redirect: "error" }),
        );
      }),
  );

  it.effect("reconciles every page by operation identity without starting compute", () =>
    Effect.gen(function* () {
      const { client, compute } = fixture();
      let page = 0;
      client.list.mockReturnValue({
        get hasNext() {
          return page < 2;
        },
        nextItems: async () => [{ ...info, sandboxId: `sandbox-${++page}` }],
      });
      expect((yield* compute.findOperation("operation-1")).map((x) => x.sandboxId)).toEqual([
        "sandbox-1",
        "sandbox-2",
      ]);
      expect(client.create).not.toHaveBeenCalled();
      expect(client.connect).not.toHaveBeenCalled();
    }),
  );
});
