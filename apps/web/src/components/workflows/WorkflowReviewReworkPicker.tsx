import { useId, useState, type PropsWithChildren } from "react";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import type { WorkflowStep } from "@t3tools/contracts/workflows";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectItemIndicator,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

function ReviewAgentLabel({
  title,
  stepNumber,
  detail,
}: {
  title: string;
  stepNumber?: number | undefined;
  detail?: string | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-2 whitespace-normal">
      <span className="min-w-0 wrap-anywhere">
        <span className="block">{title}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {stepNumber !== undefined ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          Step {stepNumber}
        </span>
      ) : null}
    </span>
  );
}

function ReviewAgentOption({
  value,
  label,
  children,
}: PropsWithChildren<{ value: string; label: string }>) {
  return (
    <SelectItem value={value} label={label}>
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_0.875rem] items-center gap-2">
        {children}
        <SelectItemIndicator>
          <CheckIcon aria-hidden className="size-3.5" />
        </SelectItemIndicator>
      </span>
    </SelectItem>
  );
}

export function WorkflowReviewReworkPicker({
  steps,
  reviewIndex,
  reworkStepId,
  disabled,
  onChange,
  registerTrigger,
}: {
  steps: ReadonlyArray<WorkflowStep>;
  reviewIndex: number;
  reworkStepId: string | undefined;
  disabled: boolean;
  onChange: (stepId: string | undefined) => void;
  registerTrigger: (node: HTMLButtonElement | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const agents = steps.flatMap((step, index) =>
    step.kind === "agent"
      ? [{ id: step.id, title: step.title.trim() || "Untitled Agent step", index }]
      : [],
  );
  const earlierAgents = agents.filter((agent) => agent.index < reviewIndex);
  const previous = earlierAgents.at(-1);
  const canOpen = !!previous && !disabled;
  if (open && !canOpen) setOpen(false);
  const savedAgent = agents.find((agent) => agent.id === reworkStepId);
  const unavailableReason = !reworkStepId
    ? null
    : !savedAgent
      ? "The saved Agent is no longer available."
      : savedAgent.index >= reviewIndex
        ? "The saved Agent runs after Review."
        : null;
  const recovery = previous ? "Choose an earlier Agent." : "Add an Agent step before Review.";
  const issue = unavailableReason ? `${unavailableReason} ${recovery}` : previous ? null : recovery;
  const previousLabel = (
    <ReviewAgentLabel
      title="Previous Agent step"
      detail={previous ? `Currently ${previous.title}` : "No earlier Agent"}
      stepNumber={previous && previous.index + 1}
    />
  );
  return (
    <>
      <dl className="space-y-1 border-b pb-2.5">
        <dt className="text-sm">Saved result to review</dt>
        <dd className="text-sm">
          {previous ? (
            <ReviewAgentLabel title={previous.title} stepNumber={previous.index + 1} />
          ) : (
            <span className="text-muted-foreground">No earlier Agent</span>
          )}
        </dd>
      </dl>
      <div className="space-y-1">
        <p id={`${id}-rework`} className="text-sm">
          Send requested changes back to
        </p>
        {issue ? (
          <p
            id={`${id}-rework-issue`}
            role="alert"
            className="flex items-start gap-1.5 wrap-anywhere text-warning-foreground text-xs"
          >
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span>{issue}</span>
          </p>
        ) : null}
        <Select
          disabled={disabled}
          readOnly={!previous}
          open={canOpen && open}
          onOpenChange={(nextOpen) => setOpen(canOpen && nextOpen)}
          value={issue ? null : reworkStepId ? `agent:${reworkStepId}` : "nearest"}
          onValueChange={(value) => {
            if (disabled || !previous) return;
            if (value === "nearest") {
              onChange(undefined);
              return;
            }
            const chosen = earlierAgents.find((agent) => value === `agent:${agent.id}`);
            if (chosen) onChange(chosen.id);
          }}
        >
          <SelectTrigger
            aria-labelledby={`${id}-rework ${id}-rework-value`}
            aria-invalid={!!issue || undefined}
            aria-describedby={issue ? `${id}-rework-issue` : undefined}
            data-workflow-field="rework"
            icon={previous ? undefined : false}
            ref={registerTrigger}
          >
            <SelectValue>
              <span id={`${id}-rework-value`} className="block py-0.5">
                {reworkStepId ? (
                  <ReviewAgentLabel
                    title={savedAgent?.title ?? "Unavailable Agent step"}
                    detail={savedAgent && unavailableReason ? "Unavailable" : undefined}
                    stepNumber={savedAgent && savedAgent.index + 1}
                  />
                ) : (
                  previousLabel
                )}
              </span>
            </SelectValue>
          </SelectTrigger>
          {previous ? (
            <SelectPopup alignItemWithTrigger={false} className="w-(--anchor-width)">
              <ReviewAgentOption value="nearest" label="Previous Agent step">
                {previousLabel}
              </ReviewAgentOption>
              <SelectGroup>
                <SelectGroupLabel>Specific Agent</SelectGroupLabel>
                {earlierAgents.map((agent) => (
                  <ReviewAgentOption key={agent.id} value={`agent:${agent.id}`} label={agent.title}>
                    <ReviewAgentLabel title={agent.title} stepNumber={agent.index + 1} />
                  </ReviewAgentOption>
                ))}
              </SelectGroup>
            </SelectPopup>
          ) : null}
        </Select>
      </div>
    </>
  );
}
