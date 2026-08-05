/**
 * Deciding what to do with an approval request before any model is consulted.
 *
 * ADR-0008 puts classification first for cost — `file-read` auto-approves and
 * never reaches the supervisor — and ADR-0009 adds a category floor: actions
 * that leave the workspace are the runner's, never an agent's, so a request
 * for one is anomalous by construction and needs no judgement.
 *
 * Everything here is pure, so the interesting cases are cheap to test.
 *
 * @module jobs/approvalClassification
 */
import {
  ApprovalRequestId,
  providerRuntimeToolKindForRequestType,
  type ProviderRuntimeToolKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The activity payload is `Schema.Unknown` on the wire, so it is decoded here
 * rather than trusted. `requestType` and `detail` are optional because the
 * ingestion path omits them for request types it cannot classify.
 */
export const ApprovalRequestedActivityPayload = Schema.Struct({
  requestId: ApprovalRequestId,
  requestType: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type ApprovalRequestedActivityPayload = typeof ApprovalRequestedActivityPayload.Type;

export type ApprovalDisposition =
  /** Settled without a model call. */
  | { readonly kind: "auto-approve"; readonly reason: string }
  /** Settled without a model call, because no workflow legitimately asks for this. */
  | { readonly kind: "deny"; readonly reason: string }
  /** Needs the supervisor model. */
  | { readonly kind: "consult"; readonly toolKind: ProviderRuntimeToolKind };

/**
 * Commands that escape the checkpointed workspace. `refs/t3/checkpoints/*`
 * makes local mistakes cheap to reverse; these have no such backstop, and
 * ADR-0009 removes them from agents entirely rather than asking a supervisor
 * to be right about them every time.
 */
const ESCAPES_THE_WORKSPACE: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bgit\b[^\n]*\bpush\b/i, what: "pushing" },
  { pattern: /\bgit\b[^\n]*\bremote\b[^\n]*\b(add|set-url|remove)\b/i, what: "changing remotes" },
  {
    pattern: /\bgh\b[^\n]*\bpr\b[^\n]*\b(create|merge|close|edit|ready|review)\b/i,
    what: "acting on a pull request",
  },
  { pattern: /\bgh\b[^\n]*\b(release|repo|api|workflow|secret)\b/i, what: "acting on the forge" },
  {
    pattern: /\bglab\b[^\n]*\bmr\b[^\n]*\b(create|merge|close)\b/i,
    what: "acting on a merge request",
  },
  { pattern: /\baz\b[^\n]*\brepos\b[^\n]*\bpr\b/i, what: "acting on a pull request" },
  {
    pattern: /\bnpm\b[^\n]*\bpublish\b|\bpnpm\b[^\n]*\bpublish\b|\byarn\b[^\n]*\bpublish\b/i,
    what: "publishing a package",
  },
];

/**
 * Classify one approval request.
 *
 * `stepInstruction` is not consulted here — this layer answers only the
 * questions that have an answer independent of what the job was asked to do.
 */
export function classifyApprovalRequest(input: {
  readonly requestType: string | undefined;
  readonly detail: string | undefined;
}): ApprovalDisposition {
  const toolKind = providerRuntimeToolKindForRequestType(input.requestType);

  if (toolKind === "file-read") {
    // Reading is how an agent understands the code it was asked to change.
    // Paying for a model call to say yes every time is the cost ADR-0008
    // avoids by classifying first.
    return { kind: "auto-approve", reason: "Reading files needs no supervision." };
  }

  const detail = input.detail ?? "";
  for (const { pattern, what } of ESCAPES_THE_WORKSPACE) {
    if (pattern.test(detail)) {
      return {
        kind: "deny",
        reason: `Agents do not perform operations that leave the workspace (${what}); the job runner does.`,
      };
    }
  }

  return { kind: "consult", toolKind };
}
