import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import type { WorkflowDefinition, WorkflowStep } from "@t3tools/contracts/workflows";
import type { WorkflowVmModelCatalog } from "@t3tools/contracts/workflows";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";

export const workflowVmCodexInstanceId = defaultInstanceIdForDriver(
  ProviderDriverKind.make("codex"),
);

export function workflowVmModelState(
  definition: WorkflowDefinition,
  catalog: WorkflowVmModelCatalog | null,
): ReturnType<typeof workflowModelState> {
  const disabledReason = (instanceId: ProviderInstanceId, model: string): string | null => {
    if (!catalog)
      return "A verified VM model catalog is required to keep this model. Select the managed default before saving, or refresh once the catalog is available.";
    if (instanceId !== workflowVmCodexInstanceId) return "Choose a managed Codex model.";
    if (!catalog.models.some((entry) => entry.slug === model))
      return "Choose a model supported by this VM build.";
    return null;
  };
  const issues = definition.steps.flatMap((step) => {
    if (step.kind !== "agent" || !step.modelSelection) return [];
    const { instanceId, model, options } = step.modelSelection;
    const detail =
      disabledReason(instanceId, model) ??
      (options?.length ? "Choose a model without saved options." : null);
    return detail ? [{ stepId: step.id, title: step.title, detail }] : [];
  });
  return {
    entries: [],
    modelOptions: new Map(),
    anchor: undefined,
    first: definition.steps.find((step) => step.kind === "agent"),
    effectiveSelection: (step) => step.modelSelection,
    disabledReason,
    triggerLabel: (step) => {
      const selection = step.modelSelection;
      if (!selection) return "Managed default";
      if (!catalog) return selection.model + " (Unverified)";
      const label =
        catalog.models.find((entry) => entry.slug === selection.model)?.name ?? selection.model;
      return issues.some((issue) => issue.stepId === step.id) ? label + " (Unavailable)" : label;
    },
    issues,
  };
}

/** Project defaults and model choices must come from the workflow's execution environment. */
export function workflowModelState(
  definition: WorkflowDefinition,
  providers: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
  projectDefault: ModelSelection | null | undefined,
  configurationReady: boolean,
) {
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
  ).filter((entry) => ["codex", "claudeAgent"].includes(entry.driverKind));
  const modelOptions = getCustomModelOptionsByInstance(settings, providers);
  const first = definition.steps.find((step) => step.kind === "agent");
  const firstSelection = first?.modelSelection ?? projectDefault;
  const anchor = entries.find((entry) => entry.instanceId === firstSelection?.instanceId);
  const effectiveSelection = (step: Extract<WorkflowStep, { kind: "agent" }>) =>
    step.modelSelection ?? projectDefault;
  const disabledReason = (
    instanceId: ProviderInstanceId,
    model: string,
    stepId: string,
  ): string | null => {
    const entry = entries.find((entry) => entry.instanceId === instanceId);
    if (!configurationReady)
      return "Connect to the selected environment to verify provider compatibility.";
    if (!entry?.enabled || !entry.installed || !entry.isAvailable)
      return "This provider is unavailable on the selected environment.";
    if (stepId === first?.id) return null;
    if (!firstSelection || !anchor)
      return "Choose or connect the first Agent's provider to verify compatibility.";
    if (entry.driverKind !== anchor.driverKind)
      return `Choose a compatible ${anchor.displayName} provider to continue the shared conversation.`;
    if (
      entry.instanceId !== anchor.instanceId &&
      (!anchor.continuationGroupKey || !entry.continuationGroupKey)
    )
      return "Compatibility between these provider instances is unverified.";
    if (
      entry.continuationGroupKey &&
      anchor.continuationGroupKey &&
      entry.continuationGroupKey !== anchor.continuationGroupKey
    )
      return "These providers cannot share conversation state.";
    if (
      (instanceId !== firstSelection.instanceId || model !== firstSelection.model) &&
      (anchor.snapshot.requiresNewThreadForModelChange ||
        entry.snapshot.requiresNewThreadForModelChange)
    )
      return "This provider cannot change models or instances within the shared conversation.";
    return null;
  };
  const triggerLabel = (step: Extract<WorkflowStep, { kind: "agent" }>): string | undefined => {
    const selection = step.modelSelection;
    if (!selection) return "Project default";
    const entry = entries.find((entry) => entry.instanceId === selection.instanceId);
    if (!configurationReady) return `${selection.model} (Unverified)`;
    if (
      !entry?.enabled ||
      !entry.installed ||
      !entry.isAvailable ||
      !modelOptions.get(selection.instanceId)?.some((option) => option.slug === selection.model)
    )
      return `${selection.model} (Unavailable)`;
    return undefined;
  };
  const issues = definition.steps.flatMap((step) => {
    if (step.kind !== "agent") return [];
    const selection = effectiveSelection(step);
    const detail = selection
      ? disabledReason(selection.instanceId, selection.model, step.id)
      : "Connect to the selected project to verify its default provider.";
    return detail ? [{ stepId: step.id, title: step.title, detail }] : [];
  });
  if (first && anchor && !anchor.continuationGroupKey && !issues.length)
    issues.push({
      stepId: first.id,
      title: first.title,
      detail: "Provider compatibility will be verified by the execution environment.",
    });
  return {
    entries,
    modelOptions,
    anchor,
    first,
    effectiveSelection,
    disabledReason,
    triggerLabel,
    issues,
  };
}
