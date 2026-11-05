import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { WorkflowVmAttemptEnvironment } from "../relay/WorkflowVmAttempts.ts";
import {
  classifyApprovalRequest,
  MASKED_UNSAFE_WORKFLOW_APPROVAL,
} from "../jobs/approvalClassification.ts";

export function workflowVmSecretMask(input: WorkflowVmAttemptEnvironment) {
  const secrets = input.secretNames.flatMap((name) => {
    const value = input.environment[name];
    return value ? [value, ...value.split(/\r\n|\r|\n/u).filter(Boolean)] : [];
  });
  const alternatives = [...new Set(secrets)]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = alternatives.length ? new RegExp(alternatives.join("|"), "gu") : null;
  const text = (value: string) => (pattern ? value.replace(pattern, "[redacted]") : value);
  const mask = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [text(key), mask(child)]),
      );
    return value;
  };
  return (event: ProviderRuntimeEvent): ProviderRuntimeEvent | null => {
    // Only complete snapshots can be safely shared. Secret bytes can straddle two stream events.
    if (
      event.type === "content.delta" ||
      event.type === "turn.proposed.delta" ||
      event.type === "task.progress" ||
      event.type === "hook.progress" ||
      event.type === "tool.progress"
    )
      return null;
    const { raw: _raw, ...normalized } = event;
    const payload = Object.fromEntries(
      Object.entries(event.payload).map(([key, value]) => [
        key,
        [
          "itemType",
          "requestType",
          "state",
          "status",
          "decision",
          "class",
          "responseMode",
        ].includes(key)
          ? value
          : mask(value),
      ]),
    );
    if (
      event.type === "request.opened" &&
      event.payload.detail !== payload.detail &&
      classifyApprovalRequest({
        requestType: event.payload.requestType,
        detail: event.payload.detail,
      }).kind === "deny"
    )
      payload.detail = MASKED_UNSAFE_WORKFLOW_APPROVAL;
    return { ...normalized, payload } as ProviderRuntimeEvent;
  };
}
