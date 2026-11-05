import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { restoreBootOperationId } from "./E2BThreadVmRestoreAttempt.ts";
import {
  inspectE2BThreadVmIngress,
  inspectE2BThreadVmConnection,
} from "./E2BThreadVmConnection.ts";
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
function inspect(sandbox: unknown = info, templateId = settings.templateId) {
  const calls: Request[] = [];
  const transport: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request);
    return Response.json(sandbox);
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
        Redacted.make("sealed-traffic-secret"),
      ),
  };
}
describe("private application ingress", () => {
  it("reads native GET without waking and uses only the separately stored relay credential", async () => {
    const h = inspect();
    const target = await h.read();
    expect(target.origin).toBe(settings.sandboxUrl);
    expect(target.sandboxId).toBe("sandbox");
    expect(Redacted.value(target.trafficAccessToken)).toBe("sealed-traffic-secret");
    expect(target).not.toHaveProperty("envdAccessToken");
    expect(h.calls.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/sandboxes/sandbox"],
    ]);
    expect(h.calls.every((r) => r.headers.get("x-api-key") === "host-key")).toBe(true);
  });
  it("keeps an admitted guest accessible after the configured template changes", async () => {
    const h = inspect(
      {
        ...info,
        templateID: "previously-admitted-template",
      },
      "previously-admitted-template:verified",
    );
    expect((await h.read()).sandboxId).toBe("sandbox");
    expect(h.calls).toHaveLength(1);
  });
  it("rejects a previous-template guest belonging to another allocation", async () => {
    const h = inspect(
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
    expect((await inspect(restored).read()).sandboxId).toBe("sandbox");
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
      const h = inspect({ ...restored, metadata: { ...metadata, ...change } });
      await expect(h.read()).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
    }
  });
  it("ignores a traffic token supplied by GET and never includes one in an envd connection", async () => {
    const h = inspect({ ...info, trafficAccessToken: "untrusted-response-token" });
    expect(Redacted.value((await h.read()).trafficAccessToken)).toBe("sealed-traffic-secret");
    const calls: Request[] = [];
    const options = await inspectE2BThreadVmConnection(
      settings,
      "sandbox",
      identity,
      async (url, init) => {
        calls.push(new Request(url, init));
        return Response.json(info);
      },
      new AbortController().signal,
    );
    expect(options.envdAccessToken).toBe("envd-secret");
    expect(options.retries).toBe(0);
    expect(options).not.toHaveProperty("trafficAccessToken");
    expect(calls.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/sandboxes/sandbox"],
    ]);
  });
  it("never wakes paused, public or differently scoped guests", async () => {
    for (const sandbox of [
      { ...info, state: "paused" },
      { ...info, templateID: "" },
      { ...info, network: { allowPublicTraffic: true } },
      { ...info, lifecycle: { autoResume: true } },
      { ...info, metadata: { ...info.metadata, "launchpad.generation": "4" } },
    ]) {
      const h = inspect(sandbox);
      await expect(h.read()).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
    }
  });
});
