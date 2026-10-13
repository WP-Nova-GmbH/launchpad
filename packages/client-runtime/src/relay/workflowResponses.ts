import {
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  type WorkflowControl,
  type WorkflowJobProgress,
} from "@t3tools/contracts/workflows";

export interface WorkflowDraftSubmission {
  readonly checkpointId: string | null;
  readonly operation: WorkflowControl["operation"];
  readonly userId: string | null | undefined;
  readonly text: string | null;
}

/** Clear only the submitted draft, after exact durable evidence; edits made during delivery survive. */
export function clearAcknowledgedWorkflowDraft(
  drafts: Record<string, string>,
  submitted: WorkflowDraftSubmission,
  progress: WorkflowJobProgress | null | undefined,
): Record<string, string> {
  const { checkpointId, operation, userId, text } = submitted;
  if (
    !checkpointId ||
    !userId ||
    text === null ||
    !["input", "request_changes"].includes(operation) ||
    text.length >= WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT ||
    drafts[checkpointId] !== text
  )
    return drafts;
  // Ceiling-length summaries carry no truncation marker and cannot establish an exact match.
  const acknowledged = progress?.responses?.some(
    (response) =>
      response.checkpointId === checkpointId &&
      response.operation === operation &&
      response.userId === userId &&
      response.text === text &&
      response.text.length < WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  );
  if (!acknowledged) return drafts;
  const next = { ...drafts };
  delete next[checkpointId];
  return next;
}
