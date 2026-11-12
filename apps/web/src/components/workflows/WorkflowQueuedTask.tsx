import { Link } from "@tanstack/react-router";
import type { Ref } from "react";
import { ClockIcon, LinkIcon, Settings2Icon, TriangleAlertIcon } from "lucide-react";
import type { WorkflowQueueReason } from "@t3tools/contracts/workflows";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

type QueuedTask = {
  title: string;
  description: string;
  relayDetails: readonly string[];
  recovery?: {
    label: string;
    hash: "workflow-vms" | "workflow-sources";
    icon: typeof Settings2Icon;
  };
};

export const workflowQueuedTasks: Partial<Record<WorkflowQueueReason["code"], QueuedTask>> = {
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

export function WorkflowQueuedTask({
  task: { title, description, recovery },
  organizationAdmin,
  recoveryLinkRef,
}: {
  task: QueuedTask;
  organizationAdmin: boolean;
  recoveryLinkRef: Ref<HTMLAnchorElement>;
}) {
  const StatusIcon = recovery ? TriangleAlertIcon : ClockIcon;

  return (
    <Alert variant={recovery ? "warning" : "default"} controlAlignment="first-line" role="group">
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
