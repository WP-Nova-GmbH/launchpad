import type { ModelSelection } from "@t3tools/contracts";
import type { WorkflowStep, WorkflowVmModelCatalog } from "@t3tools/contracts/workflows";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { workflowVmCodexInstanceId, type workflowModelState } from "../settings/workflowModels";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkflowAlert } from "./WorkflowAlert";

export function WorkflowAgentModelPicker({
  step,
  models,
  vm,
  vmModels,
  targetConfirmed,
  disabled,
  onChange,
  registerControl,
}: {
  step: Extract<WorkflowStep, { kind: "agent" }>;
  models: ReturnType<typeof workflowModelState>;
  vm: boolean;
  vmModels: WorkflowVmModelCatalog | null | undefined;
  targetConfirmed: boolean;
  disabled: boolean;
  onChange: (selection: ModelSelection | null) => void;
  registerControl: (node: HTMLElement | null) => void;
}) {
  const id = useId();
  const [machineOpen, setMachineOpen] = useState(false);
  const control = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!step.modelSelection && restoreFocus.current) control.current?.focus();
    restoreFocus.current = false;
  }, [step.modelSelection]);

  const register = (node: HTMLElement | null) => {
    control.current = node;
    registerControl(node);
  };
  const selection = models.describeSelection(step);
  const defaultModel = models.describeDefault(step);
  const defaultDisabledReason = models.defaultDisabledReason(step);
  const savedIssue = step.modelSelection !== null && selection.issue;
  const effective = models.effectiveSelection(step);
  const machineOptions = models.entries.filter((entry) =>
    models.modelOptions
      .get(entry.instanceId)
      ?.some(
        (model) =>
          !model.isUnavailable && !models.disabledReason(entry.instanceId, model.slug, step.id),
      ),
  );
  const machineEntry =
    machineOptions.find((entry) => entry.instanceId === effective?.instanceId) ?? machineOptions[0];
  const hasPicker = vm ? !!vmModels?.models.length : !!machineEntry;
  if (machineOpen && (vm || !machineEntry || disabled)) setMachineOpen(false);
  const invalid = selection.issue?.kind === "unavailable" || (!!savedIssue && vm);
  const issueTitle = savedIssue
    ? savedIssue.kind === "unavailable"
      ? "Saved model unavailable"
      : "Saved model unverified"
    : `${selection.title} ${invalid ? "unavailable" : "unverified"}`;
  const label = savedIssue ? "Choose another model" : selection.title;
  const pickerLabel = savedIssue
    ? label
    : `${vm ? "Managed Codex model" : "Machine model"}, ${label}`;
  const describedBy = [
    selection.issue && `${id}-issue`,
    !selection.issue && selection.detail && `${id}-detail`,
    `${id}-approvals`,
  ]
    .filter(Boolean)
    .join(" ");
  const useDefault = () => {
    if (disabled || defaultDisabledReason) return;
    setMachineOpen(false);
    if (!step.modelSelection) return;
    restoreFocus.current = true;
    onChange(null);
  };
  const TargetIcon = vm ? CloudIcon : MonitorIcon;
  const modelPicker =
    vm && hasPicker ? (
      <Select
        disabled={disabled}
        value={
          savedIssue ? null : step.modelSelection ? `model:${step.modelSelection.model}` : "default"
        }
        onValueChange={(value) => {
          if (disabled) return;
          if (value === "default") {
            useDefault();
            return;
          }
          const model = vmModels?.models.find(({ slug }) => value === `model:${slug}`);
          if (model && !models.disabledReason(workflowVmCodexInstanceId, model.slug, step.id))
            onChange({ instanceId: workflowVmCodexInstanceId, model: model.slug });
        }}
      >
        <SelectTrigger
          aria-label={pickerLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          ref={register}
        >
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="default" disabled={!!defaultDisabledReason}>
            <span className="block">{defaultModel.title}</span>
            {defaultModel.detail || defaultDisabledReason ? (
              <span className="block text-xs text-muted-foreground">
                {defaultModel.detail ?? defaultDisabledReason}
              </span>
            ) : null}
          </SelectItem>
          {vmModels?.models.map((model) => (
            <SelectItem key={model.slug} value={`model:${model.slug}`}>
              {model.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : machineEntry ? (
      <ProviderModelPicker
        disabled={disabled}
        open={machineOpen}
        onOpenChange={setMachineOpen}
        triggerClassName="w-full max-w-none sm:max-w-none"
        triggerLabel={label}
        triggerAriaLabel={pickerLabel}
        triggerProps={{
          ref: register,
          "aria-describedby": describedBy,
          "aria-invalid": invalid || undefined,
        }}
        activeInstanceId={machineEntry.instanceId}
        model={
          !selection.issue && step.modelSelection?.instanceId === machineEntry.instanceId
            ? step.modelSelection.model
            : ""
        }
        lockedProvider={step.id === models.first?.id ? null : (models.anchor?.driverKind ?? null)}
        lockedContinuationGroupKey={
          step.id === models.first?.id ? null : (models.anchor?.continuationGroupKey ?? null)
        }
        instanceEntries={models.entries}
        getDisabledInstanceTooltip={(entry) =>
          `${entry.displayName} can’t continue the first Agent’s conversation.`
        }
        modelOptionsByInstance={models.modelOptions}
        getModelDisabledReason={(instanceId, model) =>
          models.disabledReason(instanceId, model, step.id)
        }
        onInstanceModelChange={(instanceId, model) => {
          if (!disabled && !models.disabledReason(instanceId, model, step.id))
            onChange({ instanceId, model });
        }}
        pickerHeader={
          <div className="space-y-1 border-b px-3 py-2" data-model-picker-content="true">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-current={!step.modelSelection || undefined}
              disabled={disabled || !!defaultDisabledReason}
              onClick={useDefault}
            >
              {defaultModel.title}
            </Button>
            {defaultModel.detail || defaultDisabledReason ? (
              <p className="text-xs text-muted-foreground">
                {defaultModel.detail ?? defaultDisabledReason}
              </p>
            ) : null}
            {step.id !== models.first?.id && models.anchor ? (
              <p className="text-xs text-muted-foreground">
                Choose a model that can continue the first Agent’s {models.anchor.displayName}{" "}
                conversation.
              </p>
            ) : null}
          </div>
        }
      />
    ) : null;
  const resetModel =
    step.modelSelection && (savedIssue || !hasPicker) && !defaultDisabledReason ? (
      <Button type="button" size="sm" variant="outline" onClick={useDefault}>
        {vm ? "Use managed default" : "Use project default"}
      </Button>
    ) : null;

  return (
    <section className="space-y-2" aria-labelledby={`${id}-label`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-label`} className="text-sm">
          Model
        </h3>
        {targetConfirmed ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TargetIcon aria-hidden className="size-3.5 shrink-0" />
            {vm ? "Workflow VM" : "Machine"}
          </span>
        ) : null}
      </div>
      {!hasPicker && !selection.issue ? (
        <p tabIndex={-1} ref={register} className="text-sm">
          {selection.title}
        </p>
      ) : null}
      {selection.issue ? (
        <div
          tabIndex={hasPicker ? undefined : -1}
          ref={hasPicker ? undefined : register}
          role={hasPicker ? undefined : "group"}
          aria-label={hasPicker ? undefined : issueTitle}
          aria-describedby={hasPicker ? undefined : describedBy}
        >
          <WorkflowAlert variant={invalid ? "warning" : "info"} title={issueTitle}>
            {savedIssue ? (
              <p className="mb-1 font-medium wrap-anywhere">{selection.title}</p>
            ) : null}
            <p id={`${id}-issue`}>
              {savedIssue ? <span className="sr-only">{selection.title}. </span> : null}
              {selection.issue.detail}
            </p>
          </WorkflowAlert>
        </div>
      ) : null}
      {modelPicker || resetModel ? (
        <div className={cn(resetModel && "flex flex-wrap items-center gap-2")}>
          {resetModel}
          {modelPicker ? (
            <div className={cn(resetModel && "min-w-0 flex-1")}>{modelPicker}</div>
          ) : null}
        </div>
      ) : null}
      {!selection.issue && selection.detail ? (
        <p id={`${id}-detail`} className="text-xs text-muted-foreground">
          {selection.detail}
        </p>
      ) : null}
      <p id={`${id}-approvals`} className="text-xs text-muted-foreground">
        Approvals required
      </p>
    </section>
  );
}
