import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  WORKFLOW_VM_DEFAULT_CODEX_MODEL,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowVmModelCatalog,
} from "@t3tools/contracts/workflows";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";

export const workflowVmCodexInstanceId = defaultInstanceIdForDriver(
  ProviderDriverKind.make("codex"),
);

type AgentStep = Extract<WorkflowStep, { kind: "agent" }>;
type ModelIssue = { kind: "unavailable" | "unverified"; detail: string };

export type WorkflowModelPresentation = {
  title: string;
  detail: string | null;
  issue: ModelIssue | null;
};

const unavailable = (detail: string): ModelIssue => ({ kind: "unavailable", detail });
const unverified = (detail: string): ModelIssue => ({ kind: "unverified", detail });

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
  // Start resolves the managed default from the runtime's model slug.
  const defaultModel = catalog?.models.find(({ slug }) => slug === WORKFLOW_VM_DEFAULT_CODEX_MODEL);
  const defaultPresentation: WorkflowModelPresentation = {
    title: "Managed default",
    detail: defaultModel ? `Currently ${defaultModel.name}` : null,
    issue: !catalog
      ? unverified("VM model choices could not be loaded. You can save with the managed default.")
      : !defaultModel
        ? unavailable("This VM build does not support the managed default Codex model.")
        : null,
  };
  const describeSelection = (step: AgentStep): WorkflowModelPresentation => {
    if (!step.modelSelection) return defaultPresentation;
    const { instanceId, model, options } = step.modelSelection;
    const managedCodex = instanceId === workflowVmCodexInstanceId;
    const title =
      (managedCodex && catalog?.models.find(({ slug }) => slug === model)?.name) || model;
    const detail =
      disabledReason(instanceId, model) ??
      (options?.length ? "Choose a model without saved options." : null);
    const issue = !managedCodex
      ? unavailable("Workflow VMs use managed Codex models.")
      : !catalog
        ? unverified("A verified VM model catalog is required to keep this model.")
        : detail
          ? unavailable(detail)
          : null;
    return { title, detail: managedCodex ? "Managed Codex" : null, issue };
  };
  return {
    entries: [],
    modelOptions: new Map(),
    anchor: undefined,
    first: definition.steps.find((step) => step.kind === "agent"),
    effectiveSelection: (step) => step.modelSelection,
    describeSelection,
    describeDefault: () => defaultPresentation,
    defaultDisabledReason: () =>
      defaultPresentation.issue?.kind === "unavailable" ? defaultPresentation.issue.detail : null,
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
  const effectiveSelection = (step: AgentStep) => step.modelSelection ?? projectDefault;
  const compatibilityIssue = (
    instanceId: ProviderInstanceId,
    model: string,
    stepId: string,
  ): ModelIssue | null => {
    const entry = entries.find((entry) => entry.instanceId === instanceId);
    if (!configurationReady)
      return unverified("Connect to the selected environment to verify provider compatibility.");
    if (!entry?.enabled || !entry.installed || !entry.isAvailable)
      return unavailable("This provider is unavailable on the selected environment.");
    if (stepId === first?.id) return null;
    if (!firstSelection || !anchor)
      return unverified("Choose or connect the first Agent's provider to verify compatibility.");
    if (entry.driverKind !== anchor.driverKind)
      return unavailable(
        `Choose a compatible ${anchor.displayName} provider to continue the shared conversation.`,
      );
    if (
      entry.instanceId !== anchor.instanceId &&
      (!anchor.continuationGroupKey || !entry.continuationGroupKey)
    )
      return unverified("Compatibility between these provider instances is unverified.");
    if (
      entry.continuationGroupKey &&
      anchor.continuationGroupKey &&
      entry.continuationGroupKey !== anchor.continuationGroupKey
    )
      return unavailable("These providers cannot share conversation state.");
    if (
      (instanceId !== firstSelection.instanceId || model !== firstSelection.model) &&
      (anchor.snapshot.requiresNewThreadForModelChange ||
        entry.snapshot.requiresNewThreadForModelChange)
    )
      return unavailable(
        "This provider cannot change models or instances within the shared conversation.",
      );
    return null;
  };
  const disabledReason = (instanceId: ProviderInstanceId, model: string, stepId: string) =>
    compatibilityIssue(instanceId, model, stepId)?.detail ?? null;

  const describe = (
    step: AgentStep,
    selection: ModelSelection | null | undefined,
    inherited: boolean,
  ): WorkflowModelPresentation => {
    const defaultTitle = "Project default";
    if (!selection)
      return {
        title: defaultTitle,
        detail: null,
        issue:
          configurationReady && selection === null
            ? unavailable("No default model is configured for this checkout.")
            : unverified("Connect to the selected project to verify its default provider."),
      };
    const { instanceId, model } = selection;
    const entry = entries.find((candidate) => candidate.instanceId === instanceId);
    // Resolve inherited labels like the runtime, without changing the stored routing comparison.
    const modelSlug =
      inherited && entry ? (normalizeModelSlug(model, entry.driverKind) ?? model) : model;
    // Hidden built-ins remain usable project defaults.
    const option =
      modelOptions.get(instanceId)?.find(({ slug }) => slug === modelSlug) ??
      (inherited
        ? entry?.models.find(({ slug, isCustom }) => !isCustom && slug === modelSlug)
        : null);
    const issue =
      compatibilityIssue(instanceId, model, step.id) ??
      (option
        ? null
        : unavailable("This model is not available in the selected provider's choices."));
    return {
      title: inherited ? defaultTitle : (option?.name ?? model),
      detail: inherited
        ? !issue && option && entry
          ? `Currently ${option.name} on ${entry.displayName}`
          : null
        : (entry?.displayName ?? null),
      issue,
    };
  };
  const describeDefault = (step: AgentStep) => describe(step, projectDefault, true);
  const describeSelection = (step: AgentStep) =>
    step.modelSelection ? describe(step, step.modelSelection, false) : describeDefault(step);
  const triggerLabel = (step: AgentStep): string | undefined => {
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
    describeSelection,
    describeDefault,
    defaultDisabledReason: (step: AgentStep) => {
      const issue = describeDefault(step).issue;
      return issue?.kind === "unavailable" ? issue.detail : null;
    },
    disabledReason,
    triggerLabel,
    issues,
  };
}
