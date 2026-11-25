import type { WorkflowEditorDraft } from "@t3tools/client-runtime/relay/workflow-session";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  FilePenLineIcon,
  MonitorIcon,
  RefreshCwIcon,
  WorkflowIcon,
} from "lucide-react";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
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
import type { WorkflowTemplate } from "./workflowState";

const templates = [
  { id: "review", title: "Agent and review", steps: "Agent → Review changes" },
  {
    id: "publish",
    title: "Review and open a pull request",
    steps: "Agent → Review changes → Push branch → Open PR",
  },
] as const;

export function WorkflowCatalogEmpty({ actions }: { actions?: ReactNode }) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border bg-card p-4 text-card-foreground sm:p-5"
    >
      <div className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
        <WorkflowIcon aria-hidden className="size-4" />
      </div>
      <div className="min-w-0 space-y-3 wrap-anywhere">
        <div className="space-y-1">
          <h2 id={titleId} className="text-sm font-semibold">
            {actions ? "Create your first workflow" : "No workflows yet"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {actions
              ? "Choose a template to start a draft."
              : "A repository maintainer or organization admin can create workflows here."}
          </p>
        </div>
        {actions}
      </div>
    </section>
  );
}

const draftSaveStatus = {
  pending: {
    title: "Saving draft…",
    description: "Wait for the save to finish before starting another workflow.",
  },
  uncertain: {
    title: "Save not confirmed",
    description: "Resume this draft to check whether it saved before starting another workflow.",
  },
  retryable: {
    title: "Save didn’t land",
    description: "Resume this draft to retry the original save.",
  },
  conflict: {
    title: "Saved version changed",
    description: "Resume this draft to review the saved version.",
  },
};

export function WorkflowCatalogDraft({
  draft,
  actions,
}: {
  draft: WorkflowEditorDraft;
  actions: ReactNode;
}) {
  const titleId = useId();
  const save = draft.operation?.state;
  const recovery = draft.saveRecovery;
  const recovering = save === "uncertain";
  const status = save
    ? draftSaveStatus[
        recovering && (recovery === "retryable" || recovery === "conflict") ? recovery : save
      ]
    : null;
  const Icon = recovering ? CircleAlertIcon : FilePenLineIcon;

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <Icon
        aria-hidden
        className={
          recovering
            ? "size-5 shrink-0 text-warning-foreground"
            : "size-5 shrink-0 text-muted-foreground"
        }
      />
      <div className="min-w-0 flex-1 basis-48 space-y-1 wrap-anywhere">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 id={titleId} className="text-sm font-semibold">
            {draft.definition.name.trim() || "New workflow"}
          </h2>
          {status ? (
            <Badge variant={recovering ? "warning" : "secondary"} role="status">
              {status.title}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{status?.description ?? "Unsaved draft"}</p>
      </div>
      {actions}
    </section>
  );
}

export function WorkflowDraftReplacementDialog({
  repositoryName,
  draft,
  template,
  onKeep,
  onReplace,
  finalFocus,
}: {
  repositoryName: string;
  draft: WorkflowEditorDraft;
  template: WorkflowTemplate;
  onKeep: () => void;
  onReplace: () => void;
  finalFocus?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const keepButton = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <AlertDialogPopup variant="scrollable" initialFocus={keepButton} finalFocus={finalFocus}>
        <AlertDialogHeader className="min-h-0 overflow-y-auto overscroll-contain">
          <AlertDialogTitle>Replace this draft?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-3 wrap-anywhere">
            <p>
              Replacing it will discard the unsaved draft in{" "}
              <strong className="font-medium text-popover-foreground">{repositoryName}</strong>.
            </p>
            <dl className="divide-y border-y">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                <dt className="basis-full sm:basis-32">Current draft</dt>
                <dd className="min-w-0 flex-1 font-medium text-popover-foreground">
                  {draft.definition.name.trim() || "New workflow"}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                <dt className="basis-full sm:basis-32">Selected template</dt>
                <dd className="min-w-0 flex-1 font-medium text-popover-foreground">
                  {templates.find(({ id }) => id === template)?.title}
                </dd>
              </div>
            </dl>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="shrink-0">
          <Button ref={keepButton} type="button" variant="outline" onClick={onKeep}>
            Keep draft
          </Button>
          <Button type="button" variant="destructive" onClick={onReplace}>
            Replace draft
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function WorkflowTemplateDialog({
  repositoryName,
  vmAuthoring,
  hasMachineCheckout,
  projectsUnavailable,
  selected,
  error,
  onSelect,
  onRefreshCheckouts,
  onOpenMachines,
  onCreate,
  onClose,
  finalFocus,
}: {
  repositoryName: string;
  vmAuthoring: boolean;
  hasMachineCheckout: boolean;
  projectsUnavailable: boolean;
  selected: WorkflowTemplate;
  error: string | null;
  onSelect: (template: WorkflowTemplate) => void;
  onRefreshCheckouts: () => void;
  onOpenMachines?: (() => void) | undefined;
  onCreate: (template: WorkflowTemplate) => void;
  onClose: () => void;
  finalFocus?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const groupId = useId();
  const checkoutHintId = useId();
  const canUse = hasMachineCheckout || vmAuthoring;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Create workflow</DialogTitle>
          <DialogDescription>
            Choose a template for{" "}
            <strong className="font-medium text-foreground">{repositoryName}</strong>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset aria-label="Workflow templates" className="space-y-2">
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
                  disabled={!canUse}
                  aria-describedby={!canUse ? checkoutHintId : undefined}
                  className="mt-1 size-3.5 shrink-0 accent-primary"
                  onChange={() => onSelect(id)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">{steps}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {!canUse ? (
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
                    <Button variant="outline" size="sm" onClick={onRefreshCheckouts}>
                      <RefreshCwIcon aria-hidden />
                      Retry loading checkouts
                    </Button>
                  ) : onOpenMachines ? (
                    <Button variant="outline" size="sm" onClick={onOpenMachines}>
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
          <Button disabled={!canUse} onClick={() => onCreate(selected)}>
            Create draft
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
