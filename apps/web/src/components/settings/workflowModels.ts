import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import type { WorkflowDefinition, WorkflowStep } from "@t3tools/contracts/workflows";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";

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
