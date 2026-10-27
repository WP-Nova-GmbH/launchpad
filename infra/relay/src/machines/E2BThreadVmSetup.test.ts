import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { RelayThreadVmSetupInput } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { makeE2BThreadVmSetup } from "./E2BThreadVmSetup.ts";

const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("management-secret"),
  templateId: "template:immutable",
  hostAddresses: [],
  timeoutMs: 900000,
};
const input: RelayThreadVmSetupInput = {
  workspace: {
    operationId: "operation",
    scope: {
      allocationId: "allocation",
      threadId: ThreadId.make("thread"),
      repositoryId: "repo",
      generation: 1,
    },
    canonicalKey: "github.com/acme/project",
    branch: "main",
    revision: "a".repeat(40),
  },
  title: "Selected title",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "selected-model" },
  createdAt: "2026-10-05T10:00:00.000Z",
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
const receipt = {
  version: 1,
  operationId: "operation",
  environmentId: "environment",
  projectId: "vm:thread",
  scope: input.workspace.scope,
  workspaceRoot: "/workspace/project",
  revision: input.workspace.revision,
  sequence: 2,
  execution: "frozen",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmSetupInput));
const fixture = () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(info));
  const guest = vi.fn(async (_connection: unknown, _payload: Redacted.Redacted<string>) =>
    encode({ status: "prepared", receipt }),
  );
  return { transport, guest, prepare: makeE2BThreadVmSetup(settings, transport, guest) };
};
describe("E2B guest preparation delivery", () => {
  it.effect(
    "uses non-waking discovery, delivers the exact intent and accepts only frozen readiness",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(yield* f.prepare("sandbox", "environment", input)).toEqual({
          status: "prepared",
          receipt,
        });
        expect(f.transport.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
        expect(f.transport.mock.calls[0]?.[1]?.method).toBeUndefined();
        const payload = f.guest.mock.calls[0]![1];
        expect(decodeInput(Redacted.value(payload))).toEqual(input);
        expect(Redacted.value(payload)).not.toContain("management-secret");
        expect(Redacted.value(payload)).not.toContain("transport-secret");
        f.guest.mockResolvedValueOnce(
          encode({ status: "blocked", code: "provider_credentials_missing" }),
        );
        expect(yield* f.prepare("sandbox", "environment", input)).toEqual({
          status: "blocked",
          code: "provider_credentials_missing",
        });
      }),
  );
  it.effect(
    "rejects wrong identity, revision, project, workspace, generation and execution state",
    () =>
      Effect.gen(function* () {
        for (const change of [
          { environmentId: "other" },
          { operationId: "other" },
          { projectId: "other" },
          { revision: "b".repeat(40) },
          { workspaceRoot: "/other" },
          { execution: "active" },
          { scope: { ...receipt.scope, generation: 2 } },
          { scope: { ...receipt.scope, repositoryId: "other" } },
          { scope: { ...receipt.scope, threadId: "other" } },
          { scope: { ...receipt.scope, allocationId: "other" } },
        ]) {
          const f = fixture();
          f.guest.mockResolvedValueOnce(
            encode({ status: "prepared", receipt: { ...receipt, ...change } }),
          );
          expect(yield* f.prepare("sandbox", "environment", input).pipe(Effect.flip)).toMatchObject(
            { _tag: "ThreadVmComputeError", operation: "setup" },
          );
        }
      }),
  );
  it.effect(
    "does not run setup on paused or differently assigned VMs and sanitizes transport errors",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.transport.mockResolvedValueOnce(Response.json({ ...info, state: "paused" }));
        yield* f.prepare("sandbox", "environment", input).pipe(Effect.flip);
        expect(f.guest).not.toHaveBeenCalled();
        f.guest.mockRejectedValueOnce(
          new Error("transport-secret management-secret private-output"),
        );
        const error = yield* f.prepare("sandbox", "environment", input).pipe(Effect.flip);
        expect(String(error)).not.toContain("secret");
        expect(error.message).toContain("unconfirmed");
      }),
  );
});
