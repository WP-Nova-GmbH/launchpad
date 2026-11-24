import { Link } from "@tanstack/react-router";
import type { Ref } from "react";
import { ClockIcon, LinkIcon, Settings2Icon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import type { RepositoryWorkflowJob, WorkflowQueueReason } from "@t3tools/contracts/workflows";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

type QueuedTask = {
  title: string;
  description: string;
  relayDetails: readonly string[];
  warning?: true;
  icon?: typeof ClockIcon;
  recovery?: {
    label: string;
    hash: "workflow-vms" | "workflow-sources";
    icon: typeof Settings2Icon;
  };
};

const workflowQueuedTasks: Partial<Record<WorkflowQueueReason["code"], QueuedTask>> = {
  vm_waiting_capacity: {
    title: "Waiting for a VM slot",
    relayDetails: ["Waiting for a VM slot.", "Waiting for a workflow VM slot."],
    description: "This run will start automatically when a slot becomes available.",
  },
  vm_limit_disabled: {
    title: "Workflow VMs disabled",
    relayDetails: ["Ask an organization admin to raise the Workflow VMs limit to start this run."],
    description:
      "The organization’s VM limit is 0. An organization admin can raise it to let this run start.",
    recovery: { label: "Open Workflow VMs settings", hash: "workflow-vms", icon: Settings2Icon },
  },
  source_reconnect: {
    title: "Linear needs reconnecting",
    relayDetails: ["An organization admin must reconnect Linear before this job can start."],
    description:
      "An organization admin must reconnect the existing Linear connection before this run can start.",
    recovery: { label: "Open Workflow sources", hash: "workflow-sources", icon: LinkIcon },
  },
};

const machineQueuedTasks: Partial<Record<WorkflowQueueReason["code"], QueuedTask>> = {
  environment_offline: {
    title: "Machine is offline",
    relayDetails: ["Waiting for the selected environment to reconnect."],
    description: "Launchpad will retry automatically when the Machine reconnects.",
    warning: true,
    icon: WifiOffIcon,
  },
  environment_busy: {
    title: "Machine is busy",
    relayDetails: [
      "Waiting for the selected environment to become available.",
      "Waiting for the selected environment.",
      "Another workflow is executing on this environment.",
    ],
    description: "Launchpad will retry automatically when the Machine is available.",
  },
  environment_update: {
    title: "Machine update required",
    relayDetails: [
      "Update the selected environment to support this workflow.",
      "Update this environment before running automatic workflows.",
      "Update this environment to a version that supports repository workflows.",
    ],
    description:
      "Update Launchpad on the Machine. If it’s already up to date, change the workflow’s target to a supported Machine or ask a maintainer. This run will retry automatically.",
    warning: true,
  },
};

export function workflowQueuedTask(job: RepositoryWorkflowJob, detail: string | null | undefined) {
  const code = job.queueReason?.code;
  if (
    !code ||
    (job.status !== "queued" && !(job.status === "preparing" && code === "source_reconnect"))
  ) {
    return undefined;
  }

  const targetKind = job.runtime?.kind ?? job.workflow?.definition.target.kind;
  const origin = job.origin?.kind ?? job.originSummary?.kind;
  // Machine runs can be queued before the relay records a target or runtime.
  const machine = !job.vmAdmission && (targetKind ? targetKind === "machine" : !!origin);
  const task = workflowQueuedTasks[code] ?? (machine ? machineQueuedTasks[code] : undefined);
  // A failed retry can leave the queue reason intact while recording a new diagnostic.
  return task && (!detail || task.relayDetails.includes(detail)) ? task : undefined;
}

export function WorkflowQueuedTask({
  task: { title, description, recovery, warning, icon },
  organizationAdmin,
  recoveryLinkRef,
}: {
  task: QueuedTask;
  organizationAdmin: boolean;
  recoveryLinkRef: Ref<HTMLAnchorElement>;
}) {
  const needsAttention = warning || recovery;
  const StatusIcon = icon ?? (needsAttention ? TriangleAlertIcon : ClockIcon);

  return (
    <Alert
      variant={needsAttention ? "warning" : "default"}
      controlAlignment="first-line"
      role="group"
    >
      <StatusIcon aria-hidden />
      <AlertTitle role="heading" aria-level={2}>
        {title}
      </AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        {recovery && organizationAdmin ? (
          <div>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link ref={recoveryLinkRef} to="/settings/organization" hash={recovery.hash} />
              }
            >
              <recovery.icon aria-hidden /> {recovery.label}
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
