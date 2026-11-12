import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type {
  RelayThreadVmProviderAuth,
  ThreadVmProviderAuthControl,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { makeE2BThreadVmProviderAuth } from "./E2BThreadVmProviderAuth.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const settings = {
  apiUrl: "http://127.0.0.1:3000",
  sandboxUrl: "http://127.0.0.1:3002",
  apiKey: Redacted.make("host-management-secret"),
  templateId: "template:build",
  hostAddresses: [],
  timeoutMs: 600000,
};
const control: ThreadVmProviderAuthControl = {
  action: "status",
  binding: {
    operationId: "move",
    allocationId: "allocation",
    environmentId: EnvironmentId.make("guest"),
    generation: 2,
    instanceId: "codex",
  },
};
const input = {
  threadId: "thread",
  repositoryId: "repo",
  computeRef: "sandbox",
  templateId: settings.templateId,
  control,
};
const state: RelayThreadVmProviderAuth = {
  ...control.binding,
  requirement: "sign_in_required",
  auth: {
    instanceId: ProviderInstanceId.make("codex"),
    phase: "waiting",
    flowId: "flow",
    authorizationUrl: "https://auth.openai.com/codex/device",
    expiresAt: null,
    interaction: {
      type: "deviceCode",
      id: "code",
      userCode: "TEST-CODE",
      url: "https://auth.openai.com/codex/device",
    },
    message: "Complete sign-in.",
  },
};
const info = {
  sandboxID: "sandbox",
  templateID: "template",
  state: "running",
  envdVersion: "0.9",
  envdAccessToken: "private-envd-token",
  metadata: {
    "launchpad.managed": "thread-vm-v1",
    "launchpad.allocation_id": "allocation",
    "launchpad.operation_id": "move",
    "launchpad.thread_id": "thread",
    "launchpad.generation": "2",
  },
  lifecycle: { autoResume: false },
};
describe("private pending VM auth transport", () => {
  it.effect(
    "returns structured device sign-in data and keeps management credentials internal",
    () =>
      Effect.gen(function* () {
        const guest = vi.fn(async (_connection: unknown, payload: string) => {
          expect(JSON.parse(payload)).toEqual(control);
          return JSON.stringify(state);
        });
        const transport = vi.fn<typeof fetch>(async () => Response.json(info));
        const result = yield* makeE2BThreadVmProviderAuth(settings, transport, guest)(input);
        expect(result).toEqual(state);
        expect(encodeJson(result)).not.toContain("private-envd-token");
        expect(encodeJson(result)).not.toContain("host-management-secret");
        expect(transport.mock.calls).toHaveLength(1);
        expect(transport.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3000/sandboxes/sandbox");
      }),
  );
  for (const change of [
    { state: "paused" },
    { metadata: { ...info.metadata, "launchpad.generation": "3" } },
    { metadata: { ...info.metadata, "launchpad.operation_id": "other" } },
  ]) {
    it.effect(`refuses a paused or different guest ${JSON.stringify(change)}`, () =>
      Effect.gen(function* () {
        const guest = vi.fn(async () => JSON.stringify(state));
        const error = yield* makeE2BThreadVmProviderAuth(
          settings,
          async () => Response.json({ ...info, ...change }),
          guest,
        )(input).pipe(Effect.flip);
        expect(error._tag).toBe("ThreadVmComputeError");
        expect(guest).not.toHaveBeenCalled();
      }),
    );
  }
  it.effect("rejects a different reply identity and sanitizes guest failures", () =>
    Effect.gen(function* () {
      for (const reply of [
        { ...state, allocationId: "other" },
        { ...state, environmentId: EnvironmentId.make("other") },
        { ...state, generation: 3 },
      ]) {
        expect(
          yield* makeE2BThreadVmProviderAuth(
            settings,
            async () => Response.json(info),
            async () => JSON.stringify(reply),
          )(input).pipe(Effect.isFailure),
        ).toBe(true);
      }
      const error = yield* makeE2BThreadVmProviderAuth(
        settings,
        async () => Response.json(info),
        async () => {
          throw new Error("private-envd-token host-management-secret");
        },
      )(input).pipe(Effect.flip);
      expect(encodeJson(error)).not.toContain("private-envd-token");
      expect(encodeJson(error)).not.toContain("host-management-secret");
    }),
  );
});
