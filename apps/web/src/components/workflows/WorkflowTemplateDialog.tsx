import { ArrowUpRightIcon, MonitorIcon, RefreshCwIcon, WorkflowIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { WorkflowAlert } from "./WorkflowAlert";
import { workflowTemplateNeedsCheckout, type WorkflowTemplate } from "./workflowState";

const templates = [
  { id: "review", title: "Agent and review", steps: "Agent → Review changes" },
  {
    id: "publish",
    title: "Review and open a pull request",
    steps: "Agent → Review changes → Push branch → Open PR",
  },
] as const;

export function WorkflowCatalogEmpty({
  actions,
  draftName,
}: {
  actions?: ReactNode;
  draftName?: string | undefined;
}) {
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-card-foreground">
      <WorkflowIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-48 space-y-1 wrap-anywhere">
        <h2 className="text-sm font-semibold">
          {draftName
            ? "Resume your workflow draft"
            : actions
              ? "Create your first workflow"
              : "No workflows yet"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {draftName
            ? draftName
            : actions
              ? "Choose a template to start a draft."
              : "A repository maintainer or organization admin can create workflows here."}
        </p>
      </div>
      {actions}
    </section>
  );
}

export function WorkflowTemplateDialog({
  repositoryName,
  vmAuthoring,
  hasMachineCheckout,
  projectsUnavailable,
  busy,
  error,
  onRefreshCheckouts,
  onOpenMachines,
  onCreate,
  onClose,
}: {
  repositoryName: string;
  vmAuthoring: boolean;
  hasMachineCheckout: boolean;
  projectsUnavailable: boolean;
  busy: boolean;
  error: string | null;
  onRefreshCheckouts: () => void;
  onOpenMachines?: (() => void) | undefined;
  onCreate: (template: WorkflowTemplate) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<WorkflowTemplate>("review");
  const groupId = useId();
  const checkoutHintId = useId();
  const canUse = (template: WorkflowTemplate) =>
    hasMachineCheckout || !workflowTemplateNeedsCheckout(template, vmAuthoring);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create workflow</DialogTitle>
          <DialogDescription>
            Choose a template for{" "}
            <strong className="font-medium text-foreground">{repositoryName}</strong>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset aria-label="Workflow templates" disabled={busy} className="space-y-2">
            {templates.map(({ id, title, steps }) => (
              <label
                key={id}
                className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5 has-checked:border-primary/55 has-checked:bg-primary/8 has-[:disabled]:cursor-default"
              >
                <input
                  type="radio"
                  name={groupId}
                  value={id}
                  checked={selected === id}
                  disabled={!canUse(id)}
                  aria-describedby={!canUse(id) ? checkoutHintId : undefined}
                  className="mt-1 size-3.5 shrink-0 accent-primary"
                  onChange={() => setSelected(id)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">{steps}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {!hasMachineCheckout ? (
            <div id={checkoutHintId}>
              <WorkflowAlert
                title={
                  projectsUnavailable
                    ? "Could not load Machine checkouts"
                    : "Requires a Machine checkout"
                }
                variant="warning"
                actions={
                  projectsUnavailable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={onRefreshCheckouts}
                    >
                      <RefreshCwIcon aria-hidden />
                      Retry loading checkouts
                    </Button>
                  ) : onOpenMachines ? (
                    <Button variant="outline" size="sm" disabled={busy} onClick={onOpenMachines}>
                      <MonitorIcon aria-hidden />
                      Machines settings
                      <ArrowUpRightIcon aria-hidden />
                    </Button>
                  ) : null
                }
              >
                {projectsUnavailable
                  ? "Reload the checkout list to see which templates are available."
                  : onOpenMachines
                    ? "Connect an organization machine with a checkout of this repository."
                    : "Ask an organization admin to connect a machine with a checkout of this repository."}
              </WorkflowAlert>
            </div>
          ) : null}
          {error ? (
            <WorkflowAlert title="Could not create workflow draft">{error}</WorkflowAlert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !canUse(selected)} onClick={() => onCreate(selected)}>
            Create draft
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
