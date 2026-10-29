import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ThreadVmCodexAuthSourceError } from "../../relay/ThreadVmCodexAuthSource.ts";
const decodeManagedSettings = Schema.decodeUnknownSync(CodexSettings);
const noManagedSpawn = ChildProcessSpawner.make(() => Effect.die("Unexpected provider spawn"));
const managedConnection = {
  connectionId: "selected-connection",
  label: "Organization account",
  status: "connected" as const,
  epoch: 1,
  tokenRevision: 1,
  errorCode: null,
  refreshing: false,
};

import {
  checkCodexProviderStatus,
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Faster responses · increased usage",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "Faster responses · increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it.each([false, true])("uses generic Fast copy with legacy catalog: %s", (legacy) => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: legacy ? "fast" : "priority",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: legacy
      ? []
      : [{ id: "priority", name: "Fast", description: "2x speed, 2x usage" }],
    supportedReasoningEfforts: [],
  });
  const tier = capabilities.optionDescriptors?.find((option) => option.id === "serviceTier");
  if (tier?.type !== "select") throw new Error("Missing service tier options");
  assert.equal(tier.currentValue, legacy ? "fast" : "priority");
  assert.deepStrictEqual(tier.options[1], {
    id: legacy ? "fast" : "priority",
    label: "Fast",
    description: "Faster responses · increased usage",
    isDefault: true,
  });
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.effect(
  "uses organization metadata with a filtered catalog instead of treating native account=null as signed out",
  () =>
    Effect.gen(function* () {
      let received: { managedConnectionId?: string } | undefined;
      const provider = yield* checkCodexProviderStatus(
        decodeManagedSettings({}),
        (input) => {
          received = input;
          return Effect.succeed({
            account: { account: null, requiresOpenaiAuth: false },
            version: "0.159.3",
            skills: [],
            models: ["gpt-6-astra", "gpt-5.5", "custom-unknown"].map((slug) => ({
              slug,
              name: slug,
              isCustom: false,
              capabilities: null,
            })),
          });
        },
        {},
        {
          connectionId: "selected-connection",
          label: "Organization account",
          status: Effect.succeed(managedConnection),
          preflight: Effect.die("A read-only status probe must not admit a turn"),
        },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noManagedSpawn));
      assert.equal(received?.managedConnectionId, "selected-connection");
      assert.equal(provider.auth.status, "authenticated");
      assert.equal(provider.auth.type, "organization-managed");
      assert.deepEqual(
        provider.models.map((model) => model.slug),
        ["gpt-6-astra"],
      );
      assert.equal(provider.usageLimits?.unavailable?.reason, "unsupported");
    }),
);

it.effect(
  "distinguishes an unavailable relay from a confirmed organization reconnect requirement",
  () =>
    Effect.gen(function* () {
      for (const unavailable of [false, true]) {
        const provider = yield* checkCodexProviderStatus(
          decodeManagedSettings({}),
          () => Effect.die("An unavailable managed account must not start a probe"),
          {},
          {
            connectionId: "selected-connection",
            label: "Organization account",
            status: unavailable
              ? Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "unavailable" }))
              : Effect.succeed({ ...managedConnection, status: "reconnect_required" }),
            preflight: Effect.void,
          },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noManagedSpawn));
        assert.equal(provider.auth.status, unavailable ? "unknown" : "unauthenticated");
        assert.ok(provider.message);
        assert.ok(!provider.message!.includes("codex login"));
      }
    }),
);

it.effect(
  "does not publish personal readiness after the VM selection changed to organization authentication",
  () =>
    Effect.gen(function* () {
      const provider = yield* checkCodexProviderStatus(
        decodeManagedSettings({}),
        () => Effect.die("A stale personal provider must not probe native auth"),
        {},
        undefined,
        Effect.fail(new ThreadVmCodexAuthSourceError({ reason: "selection_changed" })),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noManagedSpawn));
      assert.equal(provider.status, "error");
      assert.equal(provider.auth.status, "unknown");
      assert.match(provider.message!, /selection changed/);
    }),
);
