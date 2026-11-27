import type { WorkflowVmRecovery } from "@t3tools/contracts/workflows";
import {
  ClockIcon,
  HardDriveIcon,
  PauseIcon,
  TriangleAlertIcon,
  UnlinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

type RecoveryTask = {
  title: string;
  message: string;
  warning: boolean;
  icon: LucideIcon;
};

const recoveryTasks = {
  paused: {
    title: "Workflow VM paused",
    message: "The VM resumes after an authorized response is submitted.",
    warning: false,
    icon: PauseIcon,
  },
  saved: {
    title: "Workspace saved",
    message: "The VM restores this workspace after an authorized response is submitted.",
    warning: false,
    icon: HardDriveIcon,
  },
  waiting_capacity: {
    title: "Waiting for a VM slot",
    message: "Recovery continues automatically when a slot opens.",
    warning: false,
    icon: ClockIcon,
  },
  waiting_codex: {
    title: "Reconnect Codex to continue",
    message:
      "An organization admin needs to reconnect the run’s original account in Codex for VMs. Recovery continues automatically.",
    warning: true,
    icon: UnlinkIcon,
  },
  resuming: {
    title: "Resuming workflow VM",
    message: "The run continues when the VM is ready.",
    warning: false,
    icon: ClockIcon,
  },
  restoring: {
    title: "Restoring workspace",
    message: "The run continues when the workspace is ready.",
    warning: false,
    icon: ClockIcon,
  },
  recovery_error: {
    title: "Recovery needs attention",
    message: "The run needs a recoverable workspace before it can continue.",
    warning: true,
    icon: TriangleAlertIcon,
  },
} satisfies Record<WorkflowVmRecovery["state"], RecoveryTask>;

export function workflowVmRecoveryTask(
  recovery: WorkflowVmRecovery,
  acknowledgedResponse: boolean,
): RecoveryTask {
  if (recovery.reason === "codex_connection_replaced") {
    return {
      title: "Original Codex connection unavailable",
      message: recovery.detail ?? "Start a new run with a connected Codex account.",
      warning: true,
      icon: UnlinkIcon,
    };
  }
  const task = recoveryTasks[recovery.state];
  if (acknowledgedResponse) {
    const sleeping = recovery.state === "saved" || recovery.state === "paused";
    if (sleeping || recovery.state === "waiting_capacity") {
      return {
        title: "Response queued",
        message:
          recovery.detail ??
          (sleeping
            ? "The response will be applied when the VM is ready."
            : "Waiting for a VM slot. The run will continue when a slot opens."),
        warning: false,
        icon: ClockIcon,
      };
    }
  }
  return { ...task, message: recovery.detail ?? task.message };
}

export function WorkflowVmRecoveryStatus({
  task: { title, message, warning, icon: Icon },
  actions,
  receipt,
}: {
  task: RecoveryTask;
  actions?: ReactNode;
  receipt?: { label: string; text: string } | undefined;
}) {
  return (
    <div className="min-w-0 space-y-3 wrap-anywhere">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            warning ? "bg-warning/10 text-warning-foreground" : "bg-info/10 text-info",
          )}
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
      {receipt ? (
        <div className="space-y-1 rounded-md border bg-muted/25 px-3 py-2.5">
          <h4 className="text-xs font-medium text-muted-foreground">{receipt.label}</h4>
          <p className="text-sm whitespace-pre-wrap">{receipt.text}</p>
        </div>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
