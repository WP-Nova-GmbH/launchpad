import { ThreadVmPolicy, WorkflowVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

export const THREAD_VM_POLICY_FIELDS = [
  {
    key: "maxVmsPerUser",
    label: "VMs per user",
    description: "Preparing, running and paused VMs count. Set 0 to prevent new VMs.",
    min: 0,
  },
  {
    key: "pauseAfterIdleMinutes",
    label: "Pause after idle minutes",
    description: "Active agent work and workload processes keep a VM awake.",
    min: 1,
  },
  {
    key: "deleteAfterIdleWeekdays",
    label: "Delete after idle weekdays",
    description:
      "Count elapsed time Monday–Friday, including nights. Keep a recoverable disk before deleting the VM.",
    min: 1,
  },
  {
    key: "backupIntervalMinutes",
    label: "Backup interval in minutes",
    description: "Keep the last verified disk while a new backup is prepared.",
    min: 1,
  },
  {
    key: "savedDiskRetentionDays",
    label: "Saved disk retention in days",
    description:
      "After expiry, keep the conversation and require Reset VM to rebuild its workspace.",
    min: 1,
  },
] as const;

export type ThreadVmPolicyDraft = { readonly [Key in keyof ThreadVmPolicy]: string };

export function threadVmPolicyDraft(policy: ThreadVmPolicy): ThreadVmPolicyDraft {
  return {
    maxVmsPerUser: String(policy.maxVmsPerUser),
    pauseAfterIdleMinutes: String(policy.pauseAfterIdleMinutes),
    deleteAfterIdleWeekdays: String(policy.deleteAfterIdleWeekdays),
    backupIntervalMinutes: String(policy.backupIntervalMinutes),
    savedDiskRetentionDays: String(policy.savedDiskRetentionDays),
    calendarTimeZone: policy.calendarTimeZone,
  };
}

const decodeWholeNumber = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^\d+$/)));
const decodePolicy = Schema.decodeUnknownSync(ThreadVmPolicy);

/** Reject partial and empty numbers instead of quietly changing a lifecycle threshold. */
export function parseThreadVmPolicyDraft(draft: ThreadVmPolicyDraft): ThreadVmPolicy {
  const number = (key: (typeof THREAD_VM_POLICY_FIELDS)[number]["key"]) =>
    Number(decodeWholeNumber(draft[key].trim()));
  return decodePolicy({
    maxVmsPerUser: number("maxVmsPerUser"),
    pauseAfterIdleMinutes: number("pauseAfterIdleMinutes"),
    deleteAfterIdleWeekdays: number("deleteAfterIdleWeekdays"),
    backupIntervalMinutes: number("backupIntervalMinutes"),
    savedDiskRetentionDays: number("savedDiskRetentionDays"),
    calendarTimeZone: draft.calendarTimeZone.trim(),
  });
}

export const THREAD_VM_POLICY_INPUT_ERROR =
  "Enter whole numbers for VM limits and durations, and a valid time zone such as UTC or Europe/Berlin. Durations must be at least 1.";

export const WORKFLOW_VM_LIMIT_DESCRIPTION =
  "Applies across the organization. Counts VMs that are starting, running, or kept ready after a run.";
export const WORKFLOW_VM_LIMIT_ZERO_HINT = "Set to 0 to block new starts and resumes.";
export const WORKFLOW_VM_LIMIT_ZERO_STATUS =
  "Workflow VMs can’t start or resume while the limit is 0.";
export const WORKFLOW_VM_LIMIT_INPUT_ERROR = "Enter a whole number from 0 to 2,147,483,647.";
const decodeWorkflowVmLimit = Schema.decodeUnknownSync(WorkflowVmPolicyRecord.fields.maxRunningVms);

export function parseWorkflowVmLimit(value: string): number {
  return decodeWorkflowVmLimit(Number(decodeWholeNumber(value.trim())));
}

export function workflowVmLimitDraftStatus(draft: string, savedLimit: number) {
  try {
    return parseWorkflowVmLimit(draft) === savedLimit ? "unchanged" : "changed";
  } catch {
    return "invalid";
  }
}
