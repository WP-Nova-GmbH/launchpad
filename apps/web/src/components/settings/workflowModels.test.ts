import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import {
  WORKFLOW_VM_DEFAULT_CODEX_MODEL,
  type WorkflowDefinition,
} from "@t3tools/contracts/workflows";
import { describe, expect, it } from "vite-plus/test";
import {
  workflowModelState,
  workflowVmCodexInstanceId,
  workflowVmModelState,
} from "./workflowModels";

const instanceId = ProviderInstanceId.make("codex_work");
const selection = { instanceId, model: "custom-a" };
const definition: WorkflowDefinition = {
  name: "Workflow",
  target: {
    kind: "machine" as const,
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project"),
  },
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
      {
        ...definition,
        target: {
          kind: "machine",
          environmentId: EnvironmentId.make("environment-b"),
          projectId: ProjectId.make("project"),
        },
      },
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

describe("Agent model picker presentation", () => {
  it("uses the effective Machine project default even when its built-in model is hidden", () => {
    const projectDefault = { ...selection, model: "built-in" };
    const inherited = { ...first, modelSelection: null };
    const hidden: UnifiedSettings = {
      ...settings(),
      providerModelPreferences: {
        [instanceId]: { hiddenModels: ["built-in"], modelOrder: [] },
      },
    };
    const state = workflowModelState(definition, providers, hidden, projectDefault, true);
    expect(state.describeSelection(inherited)).toMatchObject({
      title: "Project default",
      detail: expect.stringMatching(/^Currently Built in on /),
      issue: null,
    });
    expect(state.defaultDisabledReason(first)).toBeNull();
  });

  it("distinguishes an unverified Machine default from a known incompatible default", () => {
    const projectDefault = { ...selection, model: "built-in" };
    const restrictedProviders = providers.map((provider) => ({
      ...provider,
      requiresNewThreadForModelChange: true,
    }));
    const next = definition.steps[1];
    if (next?.kind !== "agent") throw new Error("Invalid later Agent fixture");
    const verified = workflowModelState(
      definition,
      restrictedProviders,
      settings(),
      projectDefault,
      true,
    );
    expect(verified.describeDefault(next).issue?.kind).toBe("unavailable");
    expect(verified.defaultDisabledReason(next)).toContain("cannot change models");
    const unverified = workflowModelState(
      definition,
      restrictedProviders,
      settings(),
      projectDefault,
      false,
    );
    expect(unverified.describeDefault(next)).toMatchObject({
      detail: null,
      issue: { kind: "unverified" },
    });
    expect(unverified.defaultDisabledReason(next)).toBeNull();
  });

  it("resolves a legacy project default for display without changing Machine continuation checks", () => {
    const projectDefault = { instanceId, model: "gpt-5-codex" };
    const firstAgent = { ...first, modelSelection: { instanceId, model: "gpt-5.4" } };
    const nextAgent = { ...firstAgent, id: "next" };
    const workflow = { ...definition, steps: [firstAgent, nextAgent] };
    const legacyProvider: ServerProvider = {
      ...providers[0]!,
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: {} }],
      requiresNewThreadForModelChange: true,
    };
    const state = workflowModelState(workflow, [legacyProvider], settings(), projectDefault, true);
    expect(state.describeDefault(firstAgent)).toMatchObject({
      detail: expect.stringMatching(/^Currently GPT-5\.4 on /),
      issue: null,
    });
    expect(state.defaultDisabledReason(firstAgent)).toBeNull();
    expect(state.defaultDisabledReason(nextAgent)).toContain("cannot change models");
  });

  it("distinguishes a checkout with no configured default from missing project data", () => {
    const noDefaults = workflowModelState(definition, providers, settings(), null, true);
    expect(noDefaults.describeDefault(first).issue).toMatchObject({ kind: "unavailable" });
    expect(noDefaults.defaultDisabledReason(first)).toBe(
      "No default model is configured for this checkout.",
    );
    const missingProject = workflowModelState(definition, providers, settings(), undefined, true);
    expect(missingProject.describeDefault(first).issue).toMatchObject({ kind: "unverified" });
    expect(missingProject.defaultDisabledReason(first)).toBeNull();
    const disconnected = workflowModelState(definition, providers, settings(), null, false);
    expect(disconnected.describeDefault(first).issue).toMatchObject({ kind: "unverified" });
    expect(disconnected.defaultDisabledReason(first)).toBeNull();
  });

  it("names the actual VM runtime default and preserves unverified managed overrides", () => {
    const alternative = {
      name: "Catalog default",
      slug: "catalog-default",
      isCustom: false,
      capabilities: null,
    };
    const catalog = {
      defaultModel: alternative.slug,
      models: [
        alternative,
        {
          name: "Runtime model",
          slug: WORKFLOW_VM_DEFAULT_CODEX_MODEL,
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    const explicit = {
      ...first,
      modelSelection: { instanceId: workflowVmCodexInstanceId, model: alternative.slug },
    };
    expect(workflowVmModelState(definition, catalog).describeDefault(explicit)).toEqual({
      title: "Managed default",
      detail: "Currently Runtime model",
      issue: null,
    });
    const missing = workflowVmModelState(definition, { ...catalog, models: [alternative] });
    expect(missing.defaultDisabledReason(explicit)).toContain("does not support");
    expect(missing.describeSelection(explicit).title).toBe("Catalog default");
    const unverified = workflowVmModelState(definition, null);
    expect(unverified.describeSelection(explicit)).toMatchObject({
      title: alternative.slug,
      issue: { kind: "unverified" },
    });
    expect(unverified.defaultDisabledReason(explicit)).toBeNull();
    expect(unverified.describeSelection(first).issue?.kind).toBe("unavailable");
  });
});
