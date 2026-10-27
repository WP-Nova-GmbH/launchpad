import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { makeE2BThreadVmEnrollment } from "./E2BThreadVmEnrollment.ts";

const sdk = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("e2b", () => ({
  Sandbox: class {
    commands = { run: sdk.run };
  },
}));

const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("host-management-secret"),
  templateId: "template:immutable",
  hostAddresses: [],
  timeoutMs: 900000,
};
const bootstrap: RelayThreadVmBootstrap = {
  version: 1,
  operationId: "operation",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repository",
    generation: 2,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  seed: Redacted.make("seed-secret"),
};
const info = {
  sandboxID: "sandbox",
  templateID: "template",
  state: "running",
  envdVersion: "0.9",
  envdAccessToken: "guest-transport-token",
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "operation",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "2",
  },
  lifecycle: { autoResume: false },
};
const receipt = {
  enrolled: true,
  environmentId: "environment",
  allocationId: "allocation",
  operationId: "operation",
  threadId: "thread",
  generation: 2,
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePublic = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RelayThreadVmBootstrap));
function fixture() {
  const transport = vi.fn<typeof fetch>(async () => Response.json(info));
  const guest = vi.fn(async (_connection: unknown, _payload: Redacted.Redacted<string>) =>
    encode(receipt),
  );
  return { transport, guest, enroll: makeE2BThreadVmEnrollment(settings, transport, guest) };
}
describe("non-waking E2B enrollment delivery", () => {
  it.effect(
    "prepares restore identity as root using public scope before enrolling as user with the narrow seed",
    () =>
      Effect.gen(function* () {
        sdk.run.mockReset();
        const input = {
          ...bootstrap,
          restore: true as const,
          operationId: "00000000-0000-4000-8000-000000000001",
          scope: { ...bootstrap.scope, allocationId: "00000000-0000-4000-8000-000000000002" },
        };
        const rootStdin = vi.fn(async (_bytes: string) => {}),
          userStdin = vi.fn(async (_bytes: string) => {});
        const root = {
          sendStdin: rootStdin,
          wait: async () => ({ exitCode: 0, stdout: '{"prepared":true}' }),
        };
        const installed = {
          ...receipt,
          operationId: input.operationId,
          allocationId: input.scope.allocationId,
        };
        sdk.run.mockResolvedValueOnce(root).mockResolvedValueOnce({
          sendStdin: userStdin,
          wait: async () => ({ exitCode: 0, stdout: encode(installed) }),
        });
        const transport = vi.fn<typeof fetch>(async () =>
          Response.json({
            ...info,
            templateID: "sandbox",
            metadata: {
              ...info.metadata,
              "launchpad.operation_id": input.operationId,
              "launchpad.allocation_id": input.scope.allocationId,
              "launchpad.restore": "v1",
            },
          }),
        );
        expect(yield* makeE2BThreadVmEnrollment(settings, transport)("sandbox", input)).toEqual(
          installed,
        );
        expect(sdk.run.mock.calls[0]![1]).toMatchObject({ user: "root", stdin: true });
        expect(sdk.run.mock.calls[0]![0]).toContain("__thread-vm-restore-identity");
        const publicInput = yield* decodePublic(rootStdin.mock.calls[0]![0]);
        expect(publicInput).toEqual({
          version: 1,
          operationId: input.operationId,
          allocationId: input.scope.allocationId,
          threadId: "thread",
          generation: 2,
        });
        expect(rootStdin.mock.calls[0]![0]).not.toContain("secret");
        expect(sdk.run.mock.calls[1]![1]).toMatchObject({ user: "user", stdin: true });
        expect(decode(userStdin.mock.calls[0]![0].trim())).toEqual(input);
      }),
  );
  it.effect("never delivers the enrollment seed if restore identity preparation fails", () =>
    Effect.gen(function* () {
      sdk.run.mockReset();
      const input = {
        ...bootstrap,
        restore: true as const,
        operationId: "00000000-0000-4000-8000-000000000001",
        scope: { ...bootstrap.scope, allocationId: "00000000-0000-4000-8000-000000000002" },
      };
      const stdin = vi.fn(async (_bytes: string) => {});
      sdk.run.mockResolvedValueOnce({
        sendStdin: stdin,
        wait: async () => ({ exitCode: 1, stdout: "failed" }),
      });
      const transport = vi.fn<typeof fetch>(async () =>
        Response.json({
          ...info,
          metadata: {
            ...info.metadata,
            "launchpad.operation_id": input.operationId,
            "launchpad.allocation_id": input.scope.allocationId,
          },
        }),
      );
      expect(
        yield* Effect.flip(makeE2BThreadVmEnrollment(settings, transport)("sandbox", input)),
      ).toMatchObject({ _tag: "ThreadVmComputeError", operation: "enroll" });
      expect(sdk.run).toHaveBeenCalledTimes(1);
      expect(stdin.mock.calls[0]![0]).not.toContain("seed-secret");
    }),
  );

  it.effect("discovers with GET and delivers only the thread bootstrap on stdin", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.enroll("sandbox", bootstrap)).toEqual(receipt);
      const [url, options] = f.transport.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
      expect(options?.method).toBeUndefined();
      expect(options?.body).toBeUndefined();
      expect(options?.headers).toEqual({ "X-API-Key": "host-management-secret" });
      const [connection, payload] = f.guest.mock.calls[0]!;
      expect(connection).toMatchObject({
        sandboxId: "sandbox",
        envdAccessToken: "guest-transport-token",
        sandboxUrl: settings.sandboxUrl,
      });
      expect(decode(Redacted.value(payload))).toEqual(bootstrap);
      expect(Redacted.value(payload)).not.toContain("host-management-secret");
    }),
  );
  it.effect("does not run guest code for paused, auto-resuming, unsecured or mismatched VMs", () =>
    Effect.gen(function* () {
      for (const changed of [
        { ...info, state: "paused" },
        { ...info, envdAccessToken: "" },
        { ...info, sandboxID: "other" },
        { ...info, templateID: "other" },
        { ...info, lifecycle: { autoResume: true } },
        { ...info, metadata: { ...info.metadata, "launchpad.allocation_id": "other" } },
      ]) {
        const f = fixture();
        f.transport.mockResolvedValueOnce(Response.json(changed));
        expect(yield* Effect.flip(f.enroll("sandbox", bootstrap))).toMatchObject({
          _tag: "ThreadVmComputeError",
          operation: "enroll",
        });
        expect(f.guest).not.toHaveBeenCalled();
      }
    }),
  );
  it.effect(
    "accepts only a scoped restored template and carries the explicit restore preparation mode",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const restored = {
          ...info,
          templateID: "sandbox",
          metadata: { ...info.metadata, "launchpad.restore": "v1" },
        };
        f.transport.mockResolvedValueOnce(Response.json(restored));
        expect(yield* f.enroll("sandbox", { ...bootstrap, restore: true })).toEqual(receipt);
        expect(decode(Redacted.value(f.guest.mock.calls[0]![1]))).toMatchObject({ restore: true });
        for (const changed of [
          { ...restored, templateID: "another-sandbox" },
          { ...restored, metadata: { ...restored.metadata, "launchpad.generation": "3" } },
          { ...restored, metadata: { ...restored.metadata, "launchpad.operation_id": "other" } },
          { ...restored, metadata: { ...restored.metadata, "launchpad.restore": "" } },
        ]) {
          const invalid = fixture();
          invalid.transport.mockResolvedValueOnce(Response.json(changed));
          expect(
            yield* Effect.flip(invalid.enroll("sandbox", { ...bootstrap, restore: true })),
          ).toMatchObject({ _tag: "ThreadVmComputeError" });
          expect(invalid.guest).not.toHaveBeenCalled();
        }
      }),
  );
  it.effect("rejects foreign receipts and strips guest or transport secrets from errors", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.guest.mockResolvedValueOnce(encode({ ...receipt, generation: 3 }));
      expect(yield* Effect.flip(f.enroll("sandbox", bootstrap))).toMatchObject({
        _tag: "ThreadVmComputeError",
      });
      f.guest.mockRejectedValueOnce(new Error("stderr seed-secret host-management-secret"));
      const error = yield* Effect.flip(f.enroll("sandbox", bootstrap));
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain("seed-secret");
      expect(yield* f.enroll("sandbox", bootstrap)).toEqual(receipt);
      expect(f.transport).toHaveBeenCalledTimes(3);
    }),
  );
});
