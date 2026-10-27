import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { restoreBootOperationId } from "./E2BThreadVmRestoreAttempt.ts";
import { inspectE2BThreadVmIngress } from "./E2BThreadVmConnection.ts";
const settings = {
  apiUrl: "https://api.test",
  sandboxUrl: "https://ingress.test",
  apiKey: Redacted.make("host-key"),
  templateId: "template:verified",
  timeoutMs: 60_000,
  hostAddresses: [],
};
const identity = {
  operationId: "operation",
  scope: {
    threadId: ThreadId.make("thread"),
    allocationId: "allocation",
    generation: 3,
    environmentId: EnvironmentId.make("vm"),
    repositoryId: "repository",
  },
};
const info = {
  sandboxID: "sandbox",
  templateID: "template",
  state: "running",
  envdVersion: "version",
  envdAccessToken: "envd-secret",
  trafficAccessToken: "traffic-secret",
  network: { allowPublicTraffic: false },
  lifecycle: { autoResume: false },
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "operation",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "3",
  },
};
function inspect(capability: unknown, sandbox: unknown = info, templateId = settings.templateId) {
  const calls: Request[] = [];
  const transport: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request);
    return Response.json(request.url.endsWith("/capabilities") ? capability : sandbox);
  };
  return {
    calls,
    read: () =>
      inspectE2BThreadVmIngress(
        settings,
        "sandbox",
        { ...identity, templateId },
        transport,
        new AbortController().signal,
      ),
  };
}
describe("private application ingress", () => {
  it("reads without waking and returns only relay-owned traffic credentials after the patched capability", async () => {
    const h = inspect({ version: 1, privatePreviewHeaderBoundary: true });
    const target = await h.read();
    expect(target.origin).toBe(settings.sandboxUrl);
    expect(target.sandboxId).toBe("sandbox");
    expect(Redacted.value(target.trafficAccessToken)).toBe("traffic-secret");
    expect(target).not.toHaveProperty("envdAccessToken");
    expect(h.calls.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/sandboxes/sandbox"],
      ["GET", "/extensions/launchpad/v1/capabilities"],
    ]);
    expect(h.calls.every((r) => r.headers.get("x-api-key") === "host-key")).toBe(true);
  });
  it("keeps an admitted guest accessible after the configured template changes", async () => {
    const h = inspect(
      { version: 1, privatePreviewHeaderBoundary: true },
      {
        ...info,
        templateID: "previously-admitted-template",
      },
      "previously-admitted-template:verified",
    );
    expect((await h.read()).sandboxId).toBe("sandbox");
    expect(h.calls).toHaveLength(2);
  });
  it("rejects a previous-template guest belonging to another allocation", async () => {
    const h = inspect(
      { version: 1, privatePreviewHeaderBoundary: true },
      {
        ...info,
        templateID: "previously-admitted-template",
        metadata: { ...info.metadata, "launchpad.allocation_id": "another-allocation" },
      },
      "previously-admitted-template:verified",
    );
    await expect(h.read()).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  });
  it("accepts an exact retry boot and rejects forged parent, attempt and child identities", async () => {
    const metadata = {
      ...info.metadata,
      "launchpad.restore": "v1",
      "launchpad.restore_parent_operation_id": identity.operationId,
      "launchpad.restore_boot_attempt": "2",
      "launchpad.operation_id": restoreBootOperationId(identity.operationId, 2),
    };
    const restored = { ...info, templateID: "sandbox", metadata };
    const capability = { version: 1, privatePreviewHeaderBoundary: true };
    expect((await inspect(capability, restored).read()).sandboxId).toBe("sandbox");
    for (const change of [
      { "launchpad.restore_parent_operation_id": "another-operation" },
      { "launchpad.restore_boot_attempt": "1" },
      { "launchpad.restore_boot_attempt": "02" },
      { "launchpad.restore_boot_attempt": "0" },
      { "launchpad.operation_id": restoreBootOperationId("another-operation", 2) },
      { "launchpad.allocation_id": "another-allocation" },
      { "launchpad.generation": "4" },
      { "launchpad.restore": "v2" },
    ]) {
      const h = inspect(capability, { ...restored, metadata: { ...metadata, ...change } });
      await expect(h.read()).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
    }
  });
  it("rejects old runtimes before any traffic credential can be sent to an application", async () => {
    for (const capability of [
      { version: 1 },
      { version: 1, privatePreviewHeaderBoundary: false },
      { version: 2, privatePreviewHeaderBoundary: true },
    ])
      await expect(inspect(capability).read()).rejects.toThrow();
  });
  it("never wakes paused, public or differently scoped guests", async () => {
    for (const sandbox of [
      { ...info, state: "paused" },
      { ...info, templateID: "" },
      { ...info, network: { allowPublicTraffic: true } },
      { ...info, lifecycle: { autoResume: true } },
      { ...info, metadata: { ...info.metadata, "launchpad.generation": "4" } },
    ]) {
      const h = inspect({ version: 1, privatePreviewHeaderBoundary: true }, sandbox);
      await expect(h.read()).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
    }
  });
});
