import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { inspectE2BThreadVmIngress } from "./E2BThreadVmConnection.ts";
import {
  makeE2BThreadVmEndpoint,
  makeE2BThreadVmHealth,
  makeManagedThreadVmEndpoint,
} from "./E2BThreadVmEndpoint.ts";

const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("management-secret"),
  templateId: "template:build-pinned",
  hostAddresses: [],
  timeoutMs: 600000,
};
const identity = {
  operationId: "operation",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repo",
    generation: 1,
  },
};
const info = {
  sandboxID: "sandbox",
  templateID: "template",
  state: "running",
  envdVersion: "0.9",
  envdAccessToken: "envd-secret",
  trafficAccessToken: "traffic-secret",
  network: { allowPublicTraffic: false },
  lifecycle: { autoResume: false },
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "operation",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "1",
  },
};
const response = {
  credential: "one-time-client-credential",
  proof: "signed-response",
  expiresAt: "2099-01-01T00:00:00Z",
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
describe("private VM endpoint transport", () => {
  it.effect("cancels an oversized guest response before buffering more data", () =>
    Effect.gen(function* () {
      let cancelled = false;
      let chunks = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(32768));
        },
        cancel() {
          cancelled = true;
        },
      });
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(info))
        .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
        .mockResolvedValueOnce(new Response(body));
      yield* makeE2BThreadVmEndpoint(settings, transport)
        .mintCredential("sandbox", identity, "proof")
        .pipe(Effect.flip);
      expect(cancelled).toBe(true);
      expect(chunks).toBeLessThanOrEqual(4);
    }),
  );

  it.effect(
    "inspects without waking and routes a signed mint request without management credentials",
    () =>
      Effect.gen(function* () {
        const transport = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(Response.json(info))
          .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
          .mockResolvedValueOnce(Response.json(response));
        const endpoint = makeE2BThreadVmEndpoint(settings, transport);
        expect(yield* endpoint.mintCredential("sandbox", identity, "signed-proof")).toEqual(
          response,
        );
        const [inspect, capability, mint] = transport.mock.calls;
        expect(inspect?.[0]).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
        expect(inspect?.[1]?.method).toBeUndefined();
        expect(String(mint?.[0])).toBe("http://127.0.0.1:3002/api/t3-connect/mint-credential");
        expect(mint?.[1]?.method).toBe("POST");
        expect(mint?.[1]?.redirect).toBe("error");
        const headers = new Headers(mint?.[1]?.headers);
        expect(headers.get("E2b-Sandbox-Id")).toBe("sandbox");
        expect(headers.get("E2b-Sandbox-Port")).toBe("3773");
        expect(headers.get("e2b-traffic-access-token")).toBe("traffic-secret");
        expect(headers.get("X-API-Key")).toBeNull();
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
        expect(decodeJson(mint?.[1]?.body)).toEqual({ proof: "signed-proof" });
        expect(transport).toHaveBeenCalledTimes(3);
        expect(String(capability?.[0])).toBe(
          "http://127.0.0.1:3000/extensions/launchpad/v1/capabilities",
        );
      }),
  );

  it.effect(
    "routes signed health through inspected private ingress without minting or waking",
    () =>
      Effect.gen(function* () {
        const health = {
          environmentId: "environment",
          status: "online",
          checkedAt: "2099-01-01T00:00:00Z",
          proof: "signed-health",
          descriptor: {
            environmentId: "environment",
            label: "VM",
            platform: { os: "linux", arch: "arm64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: false },
          },
        };
        const transport = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(Response.json(info))
          .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
          .mockResolvedValueOnce(Response.json(health));
        expect(
          yield* makeE2BThreadVmHealth(settings, transport)("sandbox", identity, "signed-proof"),
        ).toEqual(health);
        const request = transport.mock.calls[2];
        expect(String(request?.[0])).toBe("http://127.0.0.1:3002/api/t3-connect/health");
        expect(new Headers(request?.[1]?.headers).get("e2b-traffic-access-token")).toBe(
          "traffic-secret",
        );
        expect(transport).toHaveBeenCalledTimes(3);
      }),
  );

  it.effect("never connects, retries or mints for paused, public, stale or unrecognized VMs", () =>
    Effect.gen(function* () {
      for (const change of [
        { state: "paused" },
        { sandboxID: "other" },
        { templateID: "other" },
        { lifecycle: { autoResume: true } },
        { network: { allowPublicTraffic: true } },
        { network: undefined },
        { trafficAccessToken: undefined },
        { trafficAccessToken: "" },
        { metadata: { ...info.metadata, "launchpad.generation": "2" } },
        { metadata: { ...info.metadata, "launchpad.allocation_id": "other" } },
        { metadata: { ...info.metadata, "launchpad.operation_id": "other" } },
      ]) {
        const transport = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ ...info, ...change }));
        yield* makeE2BThreadVmEndpoint(settings, transport)
          .mintCredential("sandbox", identity, "proof")
          .pipe(Effect.flip);
        expect(transport).toHaveBeenCalledTimes(1);
      }
    }),
  );

  it.effect("does not retain secrets in failed transport or malformed responses", () =>
    Effect.gen(function* () {
      for (const reply of [
        async () => new Response("management-secret traffic-secret", { status: 403 }),
        async () => Response.json({ credential: "traffic-secret" }),
        async () => {
          throw new Error("management-secret traffic-secret");
        },
      ]) {
        const transport = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(Response.json(info))
          .mockResolvedValueOnce(Response.json({ version: 1, privatePreviewHeaderBoundary: true }))
          .mockImplementationOnce(reply);
        const error = yield* makeE2BThreadVmEndpoint(settings, transport)
          .mintCredential("sandbox", identity, "proof")
          .pipe(Effect.flip);
        expect(String(error)).not.toContain("secret");
        expect(error).not.toHaveProperty("cause");
      }
    }),
  );

  it("retains the traffic token as redacted data and never returns the envd or API key", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          String(url).endsWith("/capabilities")
            ? { version: 1, privatePreviewHeaderBoundary: true }
            : info,
        ),
      );
    const ingress = await inspectE2BThreadVmIngress(
      settings,
      "sandbox",
      identity,
      transport,
      new AbortController().signal,
    );
    expect(String(ingress.trafficAccessToken)).not.toContain("traffic-secret");
    expect(ingress).not.toHaveProperty("apiKey");
    expect(ingress).not.toHaveProperty("envdAccessToken");
  });
});

describe("managed private VM transport", () => {
  it.effect("uses the managed origin without sending infrastructure credentials", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      const endpoint = makeManagedThreadVmEndpoint("https://vm.relay.test/", transport);
      expect(yield* endpoint.mintCredential("sandbox", identity, "signed-proof")).toEqual(response);
      const [url, request] = transport.mock.calls[0]!;
      expect(String(url)).toBe("https://vm.relay.test/api/t3-connect/mint-credential");
      expect(request?.redirect).toBe("error");
      expect([...new Headers(request?.headers).entries()]).toEqual([
        ["content-type", "application/json"],
      ]);
    }),
  );
  it.effect("refuses malformed origins for both mint and status before making any request", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>();
      for (const origin of [
        "http://vm.relay.test",
        "https://user:password@vm.relay.test",
        "https://vm.relay.test/other",
        "https://vm.relay.test/?token=secret",
        "https://vm.relay.test/#fragment",
      ]) {
        const endpoint = makeManagedThreadVmEndpoint(origin, transport);
        yield* endpoint.mintCredential("sandbox", identity, "proof").pipe(Effect.flip);
        yield* endpoint.health("proof").pipe(Effect.flip);
      }
      expect(transport).not.toHaveBeenCalled();
    }),
  );
  it.effect("returns only a sanitized error when a managed endpoint fails", () =>
    Effect.gen(function* () {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("sensitive body", { status: 502 }));
      const error = yield* makeManagedThreadVmEndpoint("https://vm.relay.test", transport)
        .health("proof")
        .pipe(Effect.flip);
      expect(error.message).not.toContain("sensitive");
      expect("cause" in error).toBe(false);
    }),
  );
});
