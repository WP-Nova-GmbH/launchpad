import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The SDK's Node dispatcher must send its real create request to an owned test socket.
import * as NodeHttp from "node:http";
import { vi } from "vite-plus/test";
import { Sandbox, SandboxNotFoundError, type SandboxInfo } from "e2b";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { makeE2BThreadVmCompute, type E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";

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
    create: vi.fn(async (): Promise<{ sandboxId: string; trafficAccessToken?: string }> => ({
      sandboxId: "sandbox-1",
    })),
    getInfo: vi.fn(async (): Promise<SandboxInfo> => info),
    kill: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    connect: vi.fn(async (): Promise<{ sandboxId: string; trafficAccessToken?: string }> => ({
      sandboxId: "sandbox-1",
    })),
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
  const transport = vi.fn<typeof fetch>(async () => Response.json({}, { status: 404 }));
  return {
    client,
    transport,
    compute: makeE2BThreadVmCompute({ ...settings, ...overrides }, client, transport),
  };
}

describe("E2B thread VM compute", () => {
  it.effect(
    "sends full-memory native lifecycle and never retries a 503 create or uses an idempotency key",
    () =>
      Effect.gen(function* () {
        const created: unknown[] = [],
          snapshots: unknown[] = [],
          idempotencyKeys: unknown[] = [],
          deleted: string[] = [],
          connects: string[] = [];
        let rejectCreate = false;
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            if (request.url === "/sandboxes/sandbox-1" && request.method === "GET") {
              response.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  sandboxID: "sandbox-1",
                  templateID: settings.templateId,
                  state: "paused",
                  startedAt: "2026-10-28T00:00:00Z",
                  endAt: "2026-10-28T01:00:00Z",
                  cpuCount: 2,
                  memoryMB: 4096,
                  envdVersion: "0.5.0",
                  metadata: {
                    "launchpad.managed": "thread-vm-v1",
                    "launchpad.allocation_id": input.allocationId,
                    "launchpad.operation_id": input.operationId,
                    "launchpad.thread_id": input.threadId,
                    "launchpad.generation": String(input.generation),
                  },
                  network: { allowPublicTraffic: false },
                  lifecycle: { onTimeout: "pause", autoResume: false },
                }),
              );
              return;
            }
            if (request.url === "/v2/sandboxes/sandbox-1/connect" && request.method === "POST") {
              connects.push(request.url);
              response
                .writeHead(503, { "content-type": "application/json" })
                .end(JSON.stringify({ code: 503, message: "management-key lost connect reply" }));
              return;
            }
            if (request.url === "/sandboxes/sandbox-1" && request.method === "DELETE") {
              deleted.push(request.url);
              response.writeHead(204).end();
              return;
            }
            if (request.url === "/sandboxes/sandbox-1/snapshots" && request.method === "POST") {
              snapshots.push(JSON.parse(body));
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ snapshotID: "snapshot-1", names: [] }));
              return;
            }
            if (request.url !== "/v2/sandboxes" || request.method !== "POST") {
              response.writeHead(404).end();
              return;
            }
            created.push(JSON.parse(body));
            idempotencyKeys.push(request.headers["idempotency-key"]);
            if (rejectCreate) {
              response.writeHead(503, { "content-type": "application/json" }).end(
                JSON.stringify({
                  code: 503,
                  message: "management-key native-traffic-secret ambiguous reply",
                }),
              );
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                sandboxID: "sandbox-1",
                templateID: settings.templateId,
                clientID: "test-client",
                envdVersion: "0.5.0",
                trafficAccessToken: "native-traffic-secret",
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
          const transport = vi.fn<typeof fetch>();
          const api = { ...settings, apiUrl: `http://127.0.0.1:${address.port}` };
          const compute = makeE2BThreadVmCompute(api, Sandbox, transport);
          const result = yield* compute.create(input);
          expect(result.sandboxId).toBe("sandbox-1");
          expect(Redacted.value(result.trafficAccessToken!)).toBe("native-traffic-secret");
          expect(String(result.trafficAccessToken)).not.toContain("native-traffic-secret");
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({
            autoPause: true,
            autoPauseMemory: true,
            autoResume: { enabled: false },
            timeout: settings.timeoutMs / 1000,
            network: { allowPublicTraffic: false },
          });
          rejectCreate = true;
          const error = yield* compute.create(input).pipe(Effect.flip);
          expect(error.operation).toBe("create");
          expect(error).not.toHaveProperty("cause");
          expect(String(error)).not.toMatch(/management-key|native-traffic-secret/);
          expect(created).toHaveLength(2);
          expect(idempotencyKeys).toEqual([undefined, undefined]);
          const recoveryError = yield* compute
            .recoverIngress("sandbox-1", {
              ...input,
              templateId: settings.templateId,
            })
            .pipe(Effect.flip);
          expect(recoveryError.connectUncertain).toBe(true);
          expect(recoveryError).not.toHaveProperty("cause");
          expect(String(recoveryError)).not.toContain("management-key");
          expect(connects).toEqual(["/v2/sandboxes/sandbox-1/connect"]);
          yield* Effect.promise(async () => {
            const connection = { apiUrl: api.apiUrl, apiKey: "fixture-key", retries: 0 };
            expect(
              await Sandbox.createSnapshot("sandbox-1", {
                ...connection,
                mode: "full",
              }),
            ).toEqual({ snapshotId: "snapshot-1", names: [] });
          });
          expect(snapshots).toEqual([{ memory: true }]);
          yield* compute.destroy("sandbox-1");
          expect(deleted).toEqual(["/sandboxes/sandbox-1"]);
          expect(transport).not.toHaveBeenCalled();
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
  it.effect("takes a full native backup without querying extension capabilities", () =>
    Effect.gen(function* () {
      const { client, compute, transport } = fixture();
      transport.mockRejectedValue(new Error("No custom endpoint exists"));
      expect(yield* compute.snapshot("sandbox-1", "capture-1")).toEqual({
        snapshotId: "snapshot-1",
        names: [],
      });
      expect(client.createSnapshot).toHaveBeenCalledWith(
        "sandbox-1",
        expect.objectContaining({
          mode: "full",
          name: "capture-1",
          retries: 0,
        }),
      );
      expect(transport).not.toHaveBeenCalled();
      expect(client.connect).not.toHaveBeenCalled();
    }),
  );

  it.effect("pauses with memory using only native E2B", () =>
    Effect.gen(function* () {
      const { client, compute, transport } = fixture();
      transport.mockRejectedValue(new Error("No custom endpoint exists"));
      yield* compute.pause("sandbox-1");
      expect(client.pause).toHaveBeenCalledWith(
        "sandbox-1",
        expect.objectContaining({
          mode: "full",
          retries: 0,
        }),
      );
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.createSnapshot).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    }),
  );

  it.effect("starts one private restore from the validated immutable native snapshot", () =>
    Effect.gen(function* () {
      const { client, compute, transport } = fixture();
      const sourceBuildId = "d9dc0c90-8d53-447e-997f-40359797d086";
      transport.mockImplementation(async () =>
        Response.json({
          templateID: "snapshot-template",
          builds: [{ buildID: sourceBuildId, status: "ready" }],
        }),
      );
      const restored = {
        ...input,
        sourceTemplateId: "snapshot-template",
        sourceBuildId,
        restoreOperationId: input.operationId,
        bootAttempt: 0,
      };
      yield* compute.createFromSnapshot(restored);
      expect(client.create).toHaveBeenCalledOnce();
      expect(client.create).toHaveBeenCalledWith(
        "snapshot-template",
        expect.objectContaining({
          retries: 0,
          secure: true,
          network: expect.objectContaining({ allowPublicTraffic: false }),
          lifecycle: { onTimeout: { action: "pause", mode: "full" }, autoResume: false },
          metadata: expect.objectContaining({
            "launchpad.restore": "v1",
            "launchpad.generation": "2",
            "launchpad.restore_parent_operation_id": input.operationId,
          }),
        }),
      );
      const mismatch = yield* compute
        .createFromSnapshot({ ...restored, sourceBuildId: "11111111-1111-4111-8111-111111111111" })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ reason: "identity" });
      expect(client.create).toHaveBeenCalledOnce();
      client.create.mockRejectedValue(new Error("management-key lost create reply"));
      expect(yield* compute.createFromSnapshot(restored).pipe(Effect.flip)).toMatchObject({
        operation: "create",
      });
      expect(client.create).toHaveBeenCalledTimes(2);
      expect(
        transport.mock.calls.every(([url]) => String(url).endsWith("/templates/snapshot-template")),
      ).toBe(true);
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
            lifecycle: { onTimeout: { action: "pause", mode: "full" }, autoResume: false },
            retries: 0,
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
        const recoveryError = yield* compute
          .recoverIngress("sandbox-1", {
            ...input,
            templateId: settings.templateId,
          })
          .pipe(Effect.flip);
        expect(recoveryError.connectUncertain).toBe(false);
        expect(client.getInfo).not.toHaveBeenCalled();
        expect(client.connect).not.toHaveBeenCalled();
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

  it.effect("creates without querying a patched capability or durable-create endpoint", () =>
    Effect.gen(function* () {
      const { compute, client, transport } = fixture();
      transport.mockRejectedValue(new Error("No custom E2B endpoint exists"));
      expect(yield* compute.create(input)).toEqual({ sandboxId: "sandbox-1" });
      expect(client.create).toHaveBeenCalledTimes(1);
      expect(transport).not.toHaveBeenCalled();
    }),
  );

  it.effect("treats a whitespace create token as unavailable so provisioning can recover it", () =>
    Effect.gen(function* () {
      const { compute, client } = fixture();
      client.create.mockResolvedValueOnce({ sandboxId: "sandbox-1", trafficAccessToken: "  " });
      expect(yield* compute.create(input)).toEqual({ sandboxId: "sandbox-1" });
    }),
  );

  it.effect(
    "recovers ingress only by explicitly connecting the already admitted exact identity",
    () =>
      Effect.gen(function* () {
        const { compute, client, transport } = fixture();
        const expected = { ...input, templateId: settings.templateId };
        const known: SandboxInfo = {
          ...info,
          metadata: {
            "launchpad.managed": "thread-vm-v1",
            "launchpad.allocation_id": input.allocationId,
            "launchpad.operation_id": input.operationId,
            "launchpad.thread_id": input.threadId,
            "launchpad.generation": String(input.generation),
          },
          network: { allowPublicTraffic: false },
          lifecycle: { onTimeout: "pause", autoResume: false },
        };
        client.getInfo
          .mockResolvedValueOnce(known)
          .mockResolvedValueOnce({ ...known, state: "running" });
        client.connect.mockResolvedValueOnce({
          sandboxId: "sandbox-1",
          trafficAccessToken: "recovered-secret",
        });
        const result = yield* compute.recoverIngress("sandbox-1", expected);
        expect(result.sandboxId).toBe("sandbox-1");
        expect(Redacted.value(result.trafficAccessToken!)).toBe("recovered-secret");
        expect(String(result.trafficAccessToken)).not.toContain("recovered-secret");
        expect(client.connect).toHaveBeenCalledWith(
          "sandbox-1",
          expect.objectContaining({
            retries: 0,
            timeoutMs: settings.timeoutMs,
            requestTimeoutMs: 420_000,
          }),
        );
        expect(client.getInfo).toHaveBeenCalledTimes(2);
        expect(client.create).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
      }),
  );

  it.effect("refuses ingress recovery for any foreign, public, auto-resuming or changed VM", () =>
    Effect.gen(function* () {
      const expected = { ...input, templateId: settings.templateId };
      const known: SandboxInfo = {
        ...info,
        state: "running",
        metadata: {
          "launchpad.managed": "thread-vm-v1",
          "launchpad.allocation_id": input.allocationId,
          "launchpad.operation_id": input.operationId,
          "launchpad.thread_id": input.threadId,
          "launchpad.generation": String(input.generation),
        },
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: "pause", autoResume: false },
      };
      const { network: _network, ...withoutNetwork } = known;
      const { lifecycle: _lifecycle, ...withoutLifecycle } = known;
      for (const foreign of [
        { ...known, sandboxId: "another-vm" },
        { ...known, templateId: "another-template" },
        { ...known, network: { allowPublicTraffic: true } },
        withoutNetwork,
        { ...known, lifecycle: { onTimeout: "pause" as const, autoResume: true } },
        withoutLifecycle,
        ...Object.keys(known.metadata).map((key) => ({
          ...known,
          metadata: { ...known.metadata, [key]: "other" },
        })),
      ]) {
        const { compute, client } = fixture();
        client.getInfo.mockResolvedValueOnce(foreign);
        const error = yield* compute.recoverIngress("sandbox-1", expected).pipe(Effect.flip);
        expect(error.operation).toBe("recover ingress");
        expect(error.connectUncertain).toBe(false);
        expect(error).not.toHaveProperty("cause");
        expect(client.connect).not.toHaveBeenCalled();
        expect(client.create).not.toHaveBeenCalled();
      }
      for (const stage of [
        "reply",
        "missing-token",
        "blank-token",
        "post-inspect",
        "post-paused",
      ] as const) {
        const { compute, client } = fixture();
        client.getInfo.mockResolvedValueOnce(known).mockResolvedValueOnce(
          stage === "post-paused"
            ? { ...known, state: "paused" }
            : {
                ...known,
                metadata: { ...known.metadata, "launchpad.generation": "3" },
              },
        );
        client.connect.mockResolvedValueOnce(
          stage === "reply"
            ? { sandboxId: "another-vm", trafficAccessToken: "secret" }
            : stage === "missing-token"
              ? { sandboxId: "sandbox-1" }
              : stage === "blank-token"
                ? { sandboxId: "sandbox-1", trafficAccessToken: "  " }
                : { sandboxId: "sandbox-1", trafficAccessToken: "secret" },
        );
        const error = yield* compute.recoverIngress("sandbox-1", expected).pipe(Effect.flip);
        expect(error.operation).toBe("recover ingress");
        expect(error.connectUncertain).toBe(stage === "reply");
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(client.create).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect(
    "classifies uncertain connect replies per execution and never shares state across retries",
    () =>
      Effect.gen(function* () {
        const { compute, client } = fixture();
        const known: SandboxInfo = {
          ...info,
          metadata: {
            "launchpad.managed": "thread-vm-v1",
            "launchpad.allocation_id": input.allocationId,
            "launchpad.operation_id": input.operationId,
            "launchpad.thread_id": input.threadId,
            "launchpad.generation": String(input.generation),
          },
          network: { allowPublicTraffic: false },
          lifecycle: { onTimeout: "pause", autoResume: false },
        };
        const attempt = compute.recoverIngress("sandbox-1", {
          ...input,
          templateId: settings.templateId,
        });
        client.getInfo.mockResolvedValueOnce(known);
        client.connect.mockRejectedValueOnce(new Error("management-key lost connect reply"));
        const uncertain = yield* attempt.pipe(Effect.flip);
        expect(uncertain.connectUncertain).toBe(true);
        expect(uncertain).not.toHaveProperty("cause");
        expect(String(uncertain)).not.toContain("management-key");
        client.getInfo.mockRejectedValueOnce(new Error("preflight unavailable"));
        const preflight = yield* attempt.pipe(Effect.flip);
        expect(preflight.connectUncertain).toBe(false);
        expect(client.connect).toHaveBeenCalledTimes(1);
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
    "acknowledges only native DELETE or native absence without claiming a physical stop",
    () =>
      Effect.gen(function* () {
        const { compute, client, transport } = fixture();
        yield* compute.destroy("sandbox-1");
        client.kill.mockResolvedValueOnce(false);
        yield* compute.destroy("sandbox-1");
        client.kill.mockRejectedValueOnce(new SandboxNotFoundError("missing"));
        yield* compute.destroy("sandbox-1");
        client.kill.mockRejectedValueOnce(
          new Error("management-key traffic-secret lost delete reply"),
        );
        const error = yield* compute.destroy("sandbox-1").pipe(Effect.flip);
        expect(error.operation).toBe("destroy");
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toMatch(/management-key|traffic-secret/);
        expect(client.kill).toHaveBeenCalledTimes(4);
        expect(client.kill).toHaveBeenLastCalledWith(
          "sandbox-1",
          expect.objectContaining({ retries: 0 }),
        );
        expect(client.getInfo).not.toHaveBeenCalled();
        expect(client.connect).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
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
      expect(client.list).toHaveBeenCalledWith(
        expect.objectContaining({
          retries: 0,
          query: {
            state: ["running", "paused"],
            metadata: { "launchpad.operation_id": "operation-1" },
          },
        }),
      );
      expect(client.create).not.toHaveBeenCalled();
      expect(client.connect).not.toHaveBeenCalled();
    }),
  );
});
