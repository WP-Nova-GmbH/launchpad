import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { WorkflowDefinition } from "@t3tools/contracts/workflows";
import { describe, expect, it } from "vite-plus/test";
import { workflowModelState } from "./workflowModels";

const instanceId = ProviderInstanceId.make("codex_work");
const selection = { instanceId, model: "custom-a" };
const definition: WorkflowDefinition = {
  name: "Workflow",
  environmentId: EnvironmentId.make("environment-a"),
  projectId: ProjectId.make("project"),
  steps: [
    { id: "first", kind: "agent", title: "First", instruction: "Work", modelSelection: selection },
    {
      id: "next",
      kind: "agent",
      title: "Next",
      instruction: "Continue",
      modelSelection: selection,
    },
  ],
};
const providers: ServerProvider[] = [
  {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-12T00:00:00.000Z",
    continuation: { groupKey: "home-a" },
    models: [
      { slug: "built-in", name: "Built in", isCustom: false, capabilities: {} },
      { slug: "custom-a", name: "Old snapshot custom", isCustom: true, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
  },
];
const settings = (custom = "custom-a"): UnifiedSettings => ({
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make("codex"),
      config: { customModels: custom ? [custom] : [] },
    },
  },
});
const first = definition.steps[0]!;
if (first.kind !== "agent") throw new Error("Invalid test fixture");

describe("workflow target model choices", () => {
  it("keeps an incomplete draft editable after its last Agent is removed", () => {
    const draft = { ...definition, steps: [] };
    const legacySnapshot = { ...providers[0]!, continuation: undefined };
    const state = workflowModelState(draft, [legacySnapshot], settings(), selection, true);
    expect(state.first).toBeUndefined();
    expect(state.issues).toEqual([]);
  });

  it("uses target settings for custom models and rebuilds choices on target/live settings changes", () => {
    const targetA = workflowModelState(definition, providers, settings(), null, true);
    expect(targetA.modelOptions.get(instanceId)?.map((option) => option.slug)).toEqual([
      "built-in",
      "custom-a",
    ]);
    const targetB = workflowModelState(
      { ...definition, environmentId: EnvironmentId.make("environment-b") },
      providers,
      settings("custom-b"),
      null,
      true,
    );
    expect(targetB.modelOptions.get(instanceId)?.map((option) => option.slug)).toEqual([
      "built-in",
      "custom-b",
    ]);
    expect(targetB.triggerLabel(first)).toBe("custom-a (Unavailable)");
    expect(first.modelSelection).toEqual(selection);
  });
  it.each(["codex", "claudeAgent"])(
    "keeps a removed %s custom selection visible instead of showing the first built-in model",
    (driver) => {
      const snapshots = providers.map((provider) => ({
        ...provider,
        driver: ProviderDriverKind.make(driver),
      }));
      const withCustom = {
        ...settings(),
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make(driver),
            config: { customModels: ["custom-a"] },
          },
        },
      };
      expect(
        workflowModelState(definition, snapshots, withCustom, null, true).triggerLabel(first),
      ).toBeUndefined();
      const removed = {
        ...withCustom,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make(driver), config: { customModels: [] } },
        },
      };
      const next = workflowModelState(definition, snapshots, removed, null, true);
      expect(next.triggerLabel(first)).toBe("custom-a (Unavailable)");
      expect(next.modelOptions.get(instanceId)?.map((option) => option.slug)).toEqual(["built-in"]);
      expect(first.modelSelection).toEqual(selection);
    },
  );
  it("preserves selected identity when the provider disappears or configuration is unavailable", () => {
    expect(workflowModelState(definition, [], settings(), null, true).triggerLabel(first)).toBe(
      "custom-a (Unavailable)",
    );
    expect(
      workflowModelState(definition, providers, settings(), null, false).triggerLabel(first),
    ).toBe("custom-a (Unverified)");
    expect(first.modelSelection).toEqual(selection);
  });
  it("honors disabled instances, hidden models and model ordering without changing the saved selection", () => {
    const hidden: UnifiedSettings = {
      ...settings(),
      providerModelPreferences: {
        [instanceId]: { hiddenModels: ["built-in"], modelOrder: ["custom-a"] },
      },
    };
    const hiddenFirst = { ...first, modelSelection: { ...selection, model: "built-in" } };
    const hiddenDefinition = { ...definition, steps: [hiddenFirst, definition.steps[1]!] };
    const state = workflowModelState(hiddenDefinition, providers, hidden, null, true);
    expect(state.modelOptions.get(instanceId)?.map((option) => option.slug)).toEqual(["custom-a"]);
    expect(state.triggerLabel(hiddenFirst)).toBe("built-in (Unavailable)");
    const disabled: UnifiedSettings = {
      ...settings(),
      providerInstances: {
        [instanceId]: { ...settings().providerInstances[instanceId]!, enabled: false },
      },
    };
    expect(
      workflowModelState(definition, providers, disabled, null, true).disabledReason(
        instanceId,
        "custom-a",
        "next",
      ),
    ).toContain("unavailable");
  });
  it("uses the scoped project default and reports existing conflicts after the first Agent changes or is reordered", () => {
    const inherited = {
      ...definition,
      steps: definition.steps.map((step) =>
        step.kind === "agent" && step.id === "first" ? { ...step, modelSelection: null } : step,
      ),
    };
    const state = workflowModelState(inherited, providers, settings(), selection, true);
    expect(state.effectiveSelection(inherited.steps[0] as typeof first)).toEqual(selection);
    expect(state.issues).toEqual([]);
    const otherId = ProviderInstanceId.make("claude_work");
    const other = {
      ...providers[0]!,
      instanceId: otherId,
      driver: ProviderDriverKind.make("claudeAgent"),
      continuation: { groupKey: "other-home" },
    };
    const mixed = {
      ...definition,
      steps: [
        first,
        { ...first, id: "next", modelSelection: { instanceId: otherId, model: "built-in" } },
      ],
    };
    const mixedSettings = {
      ...settings(),
      providerInstances: {
        ...settings().providerInstances,
        [otherId]: { driver: other.driver, config: {} },
      },
    };
    expect(
      workflowModelState(mixed, [...providers, other], mixedSettings, null, true).issues[0]?.stepId,
    ).toBe("next");
    expect(
      workflowModelState(
        { ...mixed, steps: mixed.steps.toReversed() },
        [...providers, other],
        mixedSettings,
        null,
        true,
      ).issues[0]?.stepId,
    ).toBe("first");
  });
  it("allows compatible instances, blocks unknown resume identities, and enforces model-switch rules", () => {
    const otherId = ProviderInstanceId.make("codex_second");
    const other = { ...providers[0]!, instanceId: otherId };
    const configured = {
      ...settings(),
      providerInstances: {
        ...settings().providerInstances,
        [otherId]: { driver: other.driver, config: {} },
      },
    };
    const build = (second: ServerProvider) =>
      workflowModelState(definition, [...providers, second], configured, null, true);
    expect(build(other).disabledReason(otherId, "built-in", "next")).toBeNull();
    expect(
      build({ ...other, continuation: undefined }).disabledReason(otherId, "built-in", "next"),
    ).toContain("unverified");
    expect(
      build({ ...other, continuation: { groupKey: "different-home" } }).disabledReason(
        otherId,
        "built-in",
        "next",
      ),
    ).toContain("conversation state");
    const restricted = workflowModelState(
      definition,
      providers.map((provider) => ({ ...provider, requiresNewThreadForModelChange: true })),
      settings(),
      null,
      true,
    );
    expect(restricted.disabledReason(instanceId, "built-in", "next")).toContain(
      "cannot change models",
    );
    expect(restricted.disabledReason(instanceId, "custom-a", "next")).toBeNull();
    expect(restricted.disabledReason(instanceId, "built-in", "first")).toBeNull();
  });
});
