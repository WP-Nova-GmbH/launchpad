import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Native and SDK requests use an owned test socket.
import * as NodeHttp from "node:http";
import { vi } from "vite-plus/test";
import { Sandbox, SandboxNotFoundError, type SandboxInfo } from "e2b";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  makeE2BThreadVmCompute,
  THREAD_VM_BLOCKED_NETWORKS,
  type E2BThreadVmSettings,
} from "./E2BThreadVmCompute.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ sandboxID: "sandbox-1", envdVersion: "0.5.0" }),
  );
  return {
    client,
    transport,
    compute: makeE2BThreadVmCompute({ ...settings, ...overrides }, client, transport),
  };
}

describe("E2B thread VM compute", () => {
  it.effect(
    "classifies only the original HTTP 400 as rejected and preserves the native create wire contract",
    () =>
      Effect.gen(function* () {
        const created: unknown[] = [],
          snapshots: unknown[] = [],
          idempotencyKeys: unknown[] = [],
          deleted: string[] = [],
          connects: string[] = [];
        let responseMode = "success";
        let redirects = 0;
        // @effect-diagnostics-next-line abortControllerInEffect:off - The owned socket triggers a transport abort, independently of Effect interruption.
        const abortController = new AbortController();
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            if (request.url === "/sandboxes/sandbox-1" && request.method === "GET") {
              response.writeHead(200, { "content-type": "application/json" }).end(
                encodeJson({
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
                .end(encodeJson({ code: 503, message: "management-key lost connect reply" }));
              return;
            }
            if (request.url === "/sandboxes/sandbox-1" && request.method === "DELETE") {
              deleted.push(request.url);
              response.writeHead(204).end();
              return;
            }
            if (request.url === "/sandboxes/sandbox-1/snapshots" && request.method === "POST") {
              snapshots.push(decodeJson(body));
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(encodeJson({ snapshotID: "snapshot-1", names: [] }));
              return;
            }
            if (request.url === "/create-rejected") {
              redirects++;
              response.writeHead(400).end("management-key redirected rejection");
              return;
            }
            if (request.url !== "/v2/sandboxes" || request.method !== "POST") {
              response.writeHead(404).end();
              return;
            }
            created.push(decodeJson(body));
            idempotencyKeys.push(request.headers["idempotency-key"]);
            if (responseMode === "400") {
              response.writeHead(400).end("management-key malformed rejection body {");
              return;
            }
            if (responseMode === "network") {
              request.socket.destroy();
              return;
            }
            if (responseMode === "abort") {
              abortController.abort();
              return;
            }
            if (responseMode === "redirect") {
              response.writeHead(302, { location: "/create-rejected" }).end();
              return;
            }
            if (responseMode === "malformed") {
              response.writeHead(200).end("management-key malformed success body {");
              return;
            }
            if (responseMode === "invalid") {
              response.writeHead(200, { "content-type": "application/json" }).end(
                encodeJson({
                  code: 400,
                  message: "management-key success is not a rejection",
                }),
              );
              return;
            }
            if (responseMode === "old-envd" || responseMode === "invalid-envd") {
              response.writeHead(200, { "content-type": "application/json" }).end(
                encodeJson({
                  sandboxID: "sandbox-1",
                  envdVersion: responseMode === "old-envd" ? "0.0.9" : "invalid",
                }),
              );
              return;
            }
            if (responseMode === "500" || responseMode === "503") {
              response.writeHead(Number(responseMode), { "content-type": "application/json" }).end(
                encodeJson({
                  code: 503,
                  message: "management-key native-traffic-secret ambiguous reply",
                }),
              );
              return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
              encodeJson({
                sandboxID: "sandbox-1",
                templateID: settings.templateId,
                clientID: "test-client",
                envdVersion: "0.5.0+custom.1",
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
          const transport = vi.fn<typeof fetch>(fetch);
          const api = { ...settings, apiUrl: `http://127.0.0.1:${address.port}` };
          const compute = makeE2BThreadVmCompute(api, Sandbox, transport);
          const result = yield* compute.create(input);
          expect(result.sandboxId).toBe("sandbox-1");
          expect(Redacted.value(result.trafficAccessToken!)).toBe("native-traffic-secret");
          expect(String(result.trafficAccessToken)).not.toContain("native-traffic-secret");
          expect(created).toHaveLength(1);
          expect(created[0]).toEqual({
            templateID: settings.templateId,
            metadata: {
              "launchpad.managed": "thread-vm-v1",
              "launchpad.allocation_id": input.allocationId,
              "launchpad.operation_id": input.operationId,
              "launchpad.thread_id": input.threadId,
              "launchpad.generation": String(input.generation),
            },
            envVars: input.environment,
            autoPause: true,
            autoPauseMemory: true,
            autoResume: { enabled: false },
            timeout: settings.timeoutMs / 1000,
            network: {
              denyOut: [...THREAD_VM_BLOCKED_NETWORKS, ...settings.hostAddresses],
              allowPublicTraffic: false,
            },
          });
          expect(transport).toHaveBeenCalledWith(
            `${api.apiUrl}/v2/sandboxes`,
            expect.objectContaining({
              method: "POST",
              headers: { "X-API-Key": "management-key", "Content-Type": "application/json" },
              redirect: "error",
              signal: expect.any(AbortSignal),
            }),
          );
          for (const mode of [
            "400",
            "500",
            "503",
            "network",
            "abort",
            "redirect",
            "malformed",
            "invalid",
            "old-envd",
            "invalid-envd",
          ]) {
            responseMode = mode;
            if (mode === "abort")
              transport.mockImplementationOnce((url, options) =>
                // @effect-diagnostics-next-line globalFetch:off - Exercise the owned HTTP socket through the native transport.
                fetch(url, {
                  ...options,
                  signal: AbortSignal.any([options!.signal!, abortController.signal]),
                }),
              );
            const error = yield* compute.create(input).pipe(Effect.flip);
            expect(error.operation).toBe("create");
            expect(error.createRejected === true).toBe(mode === "400");
            expect(error).not.toHaveProperty("cause");
            expect(String(error)).not.toMatch(
              /management-key|native-traffic-secret|single-use-seed/,
            );
          }
          expect(created).toHaveLength(11);
          expect(idempotencyKeys).toEqual(Array.from({ length: 11 }, () => undefined));
          expect(redirects).toBe(0);
          expect(deleted).toEqual([]);
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
          expect(transport).toHaveBeenCalledTimes(11);
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
      transport.mockImplementation(async (url) =>
        String(url).endsWith("/templates/snapshot-template")
          ? Response.json({
              templateID: "snapshot-template",
              builds: [{ buildID: sourceBuildId, status: "ready" }],
            })
          : Response.json({ sandboxID: "sandbox-1", envdVersion: "0.5.0" }),
      );
      const restored = {
        ...input,
        sourceTemplateId: "snapshot-template",
        sourceBuildId,
        restoreOperationId: input.operationId,
        bootAttempt: 0,
      };
      yield* compute.createFromSnapshot(restored);
      const creates = () =>
        transport.mock.calls.filter(([, options]) => options?.method === "POST");
      expect(creates()).toHaveLength(1);
      expect(decodeJson(String(creates()[0]![1]!.body))).toEqual({
        templateID: "snapshot-template",
        metadata: {
          "launchpad.managed": "thread-vm-v1",
          "launchpad.allocation_id": input.allocationId,
          "launchpad.operation_id": input.operationId,
          "launchpad.thread_id": input.threadId,
          "launchpad.generation": "2",
          "launchpad.restore": "v1",
          "launchpad.restore_boot_attempt": "0",
          "launchpad.restore_parent_operation_id": input.operationId,
        },
        envVars: input.environment,
        timeout: 900,
        network: {
          denyOut: [...THREAD_VM_BLOCKED_NETWORKS, ...settings.hostAddresses],
          allowPublicTraffic: false,
        },
        autoPause: true,
        autoPauseMemory: true,
        autoResume: { enabled: false },
      });
      const mismatch = yield* compute
        .createFromSnapshot({ ...restored, sourceBuildId: "11111111-1111-4111-8111-111111111111" })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ reason: "identity" });
      expect(creates()).toHaveLength(1);
      transport.mockImplementation(async (url) => {
        if (String(url).endsWith("/v2/sandboxes"))
          throw new Error("management-key lost create reply");
        return Response.json({
          templateID: "snapshot-template",
          builds: [{ buildID: sourceBuildId, status: "ready" }],
        });
      });
      const error = yield* compute.createFromSnapshot(restored).pipe(Effect.flip);
      expect(error).toMatchObject({ operation: "create" });
      expect(error).not.toHaveProperty("createRejected", true);
      expect(creates()).toHaveLength(2);
      expect(client.create).not.toHaveBeenCalled();
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

  it.effect("uses the SDK wire payload with a rounded-up infrastructure lease", () =>
    Effect.gen(function* () {
      const { compute, transport, client } = fixture({ timeoutMs: 900_001 });
      yield* compute.create(input);
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0]![0]).toBe(`${settings.apiUrl}/v2/sandboxes`);
      expect(decodeJson(String(transport.mock.calls[0]![1]!.body))).toEqual({
        templateID: settings.templateId,
        metadata: {
          "launchpad.managed": "thread-vm-v1",
          "launchpad.allocation_id": input.allocationId,
          "launchpad.operation_id": input.operationId,
          "launchpad.thread_id": input.threadId,
          "launchpad.generation": "2",
        },
        envVars: input.environment,
        timeout: 901,
        network: {
          denyOut: [...THREAD_VM_BLOCKED_NETWORKS, ...settings.hostAddresses],
          allowPublicTraffic: false,
        },
        autoPause: true,
        autoPauseMemory: true,
        autoResume: { enabled: false },
      });
      expect(client.create).not.toHaveBeenCalled();
    }),
  );

  it.effect("creates from the allocation's immutable template tag after a rollout", () =>
    Effect.gen(function* () {
      const selected = "verified-launchpad-template:build-b";
      const pinned = "verified-launchpad-template:build-a";
      const { transport, compute } = fixture({ templateId: selected });

      yield* compute.create(input, pinned);
      yield* compute.create(input);

      expect(transport.mock.calls.map(([, options]) => decodeJson(String(options!.body)))).toEqual([
        expect.objectContaining({ templateID: pinned }),
        expect.objectContaining({ templateID: selected }),
      ]);
    }),
  );

  it.effect(
    "sends disjoint IPv4 deny ranges while retaining public hosts and IPv6 protections",
    () =>
      Effect.gen(function* () {
        const redundantHosts = [
          ...Array.from({ length: 32 }, (_, index) => `10.12.0.${index + 1}`),
          "172.17.0.1/32",
          "172.18.0.1/24",
          "192.168.5.1",
        ];
        const { transport, compute } = fixture({
          hostAddresses: [
            ...redundantHosts,
            "10.0.0.0/8",
            "10.12.0.1",
            "203.0.113.4/32",
            "203.0.113.4/32",
            "fc00::/7",
            "2001:db8::9/128",
          ],
        });
        yield* compute.create(input);
        expect(decodeJson(String(transport.mock.calls[0]![1]!.body))).toMatchObject({
          network: {
            denyOut: [...THREAD_VM_BLOCKED_NETWORKS, "203.0.113.4/32", "2001:db8::9/128"],
            allowPublicTraffic: false,
          },
        });
      }),
  );

  for (const { hostAddresses, expected } of [
    {
      hostAddresses: ["192.0.0.0/8"],
      expected: [
        ...THREAD_VM_BLOCKED_NETWORKS.filter(
          (range) => range !== "192.0.0.0/24" && range !== "192.168.0.0/16",
        ),
        "192.0.0.0/8",
      ],
    },
    {
      hostAddresses: ["203.0.113.14", "203.0.113.11/29", "203.0.113.8/29", "203.0.113.16"],
      expected: [...THREAD_VM_BLOCKED_NETWORKS, "203.0.113.11/29", "203.0.113.16"],
    },
    {
      hostAddresses: ["0.0.0.0/0"],
      expected: [...THREAD_VM_BLOCKED_NETWORKS.filter((range) => range.includes(":")), "0.0.0.0/0"],
    },
  ]) {
    it.effect(
      `keeps the complete deny union when host ranges include ${hostAddresses.join(", ")}`,
      () =>
        Effect.gen(function* () {
          const { transport, compute } = fixture({ hostAddresses });
          yield* compute.create(input);
          expect(decodeJson(String(transport.mock.calls[0]![1]!.body))).toMatchObject({
            network: { denyOut: expected, allowPublicTraffic: false },
          });
        }),
    );
  }

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
        const { client, compute, transport } = fixture(override);
        expect(yield* Effect.flip(compute.create(input))).toMatchObject({
          _tag: "ThreadVmComputeError",
          operation: "configuration",
          createRejected: true,
        });
        expect(transport).not.toHaveBeenCalled();
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
      const { transport, compute } = fixture();
      transport.mockRejectedValue(new Error("reply lost after allocation"));
      expect(yield* Effect.flip(compute.create(input))).toMatchObject({
        operation: "create",
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("propagates Effect interruption into the create transport", () =>
    Effect.gen(function* () {
      const { compute, transport } = fixture();
      let requestSignal: AbortSignal | undefined;
      let dispatched: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        transport.mockImplementation(async (_url, options) => {
          requestSignal = options!.signal!;
          dispatched!();
          return await new Promise<Response>((_resolve, reject) => {
            requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), {
              once: true,
            });
          });
        });
        const pending = yield* compute.create(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => started);
        expect(timeout).toHaveBeenCalledWith(420_000);
        expect(requestSignal!.aborted).toBe(false);
        yield* Fiber.interrupt(pending);
        expect(requestSignal!.aborted).toBe(true);
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        timeout.mockRestore();
      }
    }),
  );

  it.effect("creates without querying a patched capability or durable-create endpoint", () =>
    Effect.gen(function* () {
      const { compute, client, transport } = fixture();
      expect(yield* compute.create(input)).toEqual({ sandboxId: "sandbox-1" });
      expect(client.create).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0]![0]).toBe(`${settings.apiUrl}/v2/sandboxes`);
    }),
  );

  for (const trafficAccessToken of [null, "  "]) {
    it.effect(
      `preserves the created VM identity when its traffic token is ${trafficAccessToken === null ? "null" : "blank"}`,
      () =>
        Effect.gen(function* () {
          const { compute, transport } = fixture();
          transport.mockResolvedValueOnce(
            Response.json({ sandboxID: "sandbox-1", envdVersion: "0.5.0", trafficAccessToken }),
          );
          expect(yield* compute.create(input)).toEqual({ sandboxId: "sandbox-1" });
          expect(transport).toHaveBeenCalledOnce();
        }),
    );
  }

  for (const envdVersion of ["0.5.0+custom.1", "0.5.0-alpha.2+custom.1"]) {
    it.effect(`preserves the created VM identity and token with envd ${envdVersion}`, () =>
      Effect.gen(function* () {
        const { compute, transport } = fixture();
        transport.mockResolvedValueOnce(
          Response.json({
            sandboxID: "sandbox-1",
            envdVersion,
            trafficAccessToken: "private-token",
          }),
        );
        const created = yield* compute.create(input);
        expect(created.sandboxId).toBe("sandbox-1");
        expect(Redacted.value(created.trafficAccessToken!)).toBe("private-token");
        expect(transport).toHaveBeenCalledOnce();
      }),
    );
  }

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
