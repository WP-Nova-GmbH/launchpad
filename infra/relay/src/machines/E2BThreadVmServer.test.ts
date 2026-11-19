import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { vi } from "vite-plus/test";
import { makeE2BThreadVmServer } from "./E2BThreadVmServer.ts";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknown = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const sdk = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("e2b", () => ({
  Sandbox: class {
    commands = { run: sdk.run };
  },
}));

const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("management-secret"),
  templateId: "template:immutable",
  hostAddresses: [],
  timeoutMs: 900000,
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
  envdAccessToken: "transport-secret",
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "operation",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "1",
  },
  lifecycle: { autoResume: false },
};
const fixture = () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(info));
  const guest = vi.fn(async (_connection: unknown, _command: string, _identity: unknown) => {});
  return { transport, guest, start: makeE2BThreadVmServer(settings, transport, guest) };
};
describe("private VM server launch", () => {
  it.effect(
    "starts only the root-owned fixed coordinator launcher with public scope, then drops privilege in the helper",
    () =>
      Effect.gen(function* () {
        sdk.run.mockResolvedValueOnce({});
        const transport = vi.fn<typeof fetch>(async () => Response.json(info));
        yield* makeE2BThreadVmServer(settings, transport)("sandbox", identity, "a".repeat(64));
        expect(sdk.run.mock.lastCall?.[1]).toMatchObject({ user: "root", background: true });
        expect(decodeJson(sdk.run.mock.lastCall?.[1].envs.LAUNCHPAD_COORDINATOR_SCOPE)).toEqual({
          allocationId: identity.scope.allocationId,
          operationId: identity.operationId,
          threadId: identity.scope.threadId,
          generation: identity.scope.generation,
        });
        expect(encodeUnknown(sdk.run.mock.lastCall?.[1])).not.toContain("secret");
      }),
  );
  it.effect(
    "requests an idempotent start without exporting management secrets or granting readiness",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(yield* f.start("sandbox", identity, "a".repeat(64))).toBeUndefined();
        const command = f.guest.mock.calls[0]![1];
        expect(command).toBe(
          "/opt/launchpad/bin/launchpad-workload coordinator-run " + "a".repeat(64) + " initial",
        );
        expect(f.guest.mock.calls[0]![2]).toEqual(identity);
        expect(command).not.toContain("secret");
        expect(f.transport.mock.calls[0]?.[1]?.method).toBeUndefined();
      }),
  );
  it.effect("launches the move receiver with its own enrollment receipt", () =>
    Effect.gen(function* () {
      const f = fixture(),
        next = { ...identity, scope: { ...identity.scope, generation: 2 } };
      f.transport.mockResolvedValueOnce(
        Response.json({ ...info, metadata: { ...info.metadata, "launchpad.generation": "2" } }),
      );
      yield* f.start("sandbox", next, "a".repeat(64), "move");
      expect(f.guest.mock.calls[0]![1]).toBe(
        "/opt/launchpad/bin/launchpad-workload coordinator-run " + "a".repeat(64) + " move",
      );
    }),
  );
  it.effect("never wakes paused VMs or launches under changed ownership", () =>
    Effect.gen(function* () {
      for (const change of [
        { state: "paused" },
        { sandboxID: "other" },
        { metadata: { ...info.metadata, "launchpad.generation": "2" } },
        { lifecycle: { autoResume: true } },
      ]) {
        const f = fixture();
        f.transport.mockResolvedValueOnce(Response.json({ ...info, ...change }));
        yield* f.start("sandbox", identity, "a".repeat(64)).pipe(Effect.flip);
        expect(f.guest).not.toHaveBeenCalled();
      }
    }),
  );
  it.effect("rejects command injection and treats lost launch replies as unconfirmed", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.start("sandbox", identity, "a".repeat(64) + ";echo unsafe").pipe(Effect.flip);
      expect(f.transport).not.toHaveBeenCalled();
      f.guest.mockRejectedValueOnce(new Error("transport-secret"));
      const error = yield* f.start("sandbox", identity, "b".repeat(64)).pipe(Effect.flip);
      expect(error.message).toContain("unconfirmed");
      expect(String(error)).not.toContain("secret");
    }),
  );
});
