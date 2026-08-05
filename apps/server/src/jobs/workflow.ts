/**
 * Workflow shape for the job runner, and the one hard-coded workflow M0 runs.
 *
 * Steps have kinds (ADR-0009). `agent` runs a thread to settle; `action` is a
 * deterministic operation the runner performs itself, which is what makes
 * "agents never push" structural rather than a matter of judgement; `gate`
 * waits on a verdict, and is evaluated in a thread other than the one it
 * gates, because an agent assessing its own work is not a review.
 *
 * The workflow here is deliberately throwaway — layering, org workflows, and
 * repository overrides are M5. The step model and the runner are not.
 *
 * @module jobs/workflow
 */
import type { RuntimeMode } from "@t3tools/contracts";

/**
 * The closed set of deterministic operations a workflow can ask for. Adding a
 * member is a product decision, not configuration: a workflow cannot define an
 * arbitrary new side effect (ADR-0009).
 */
export type JobActionKind = "push" | "open_pull_request";

interface JobStepBase {
  readonly id: string;
  readonly title: string;
}

/**
 * `runtimeMode` is required rather than defaulted on purpose. The contract
 * default is `full-access` (`DEFAULT_RUNTIME_MODE`), so a step that inherited
 * it would hand an unattended agent unrestricted shell on a machine holding
 * organization credentials. Making it required means that cannot happen by
 * omission.
 */
export interface JobAgentStep extends JobStepBase {
  readonly kind: "agent";
  readonly instruction: string;
  readonly runtimeMode: RuntimeMode;
}

export interface JobGateStep extends JobStepBase {
  readonly kind: "gate";
  readonly instruction: string;
  readonly runtimeMode: RuntimeMode;
}

export interface JobActionStep extends JobStepBase {
  readonly kind: "action";
  readonly action: JobActionKind;
}

export type JobStep = JobAgentStep | JobGateStep | JobActionStep;

export interface JobWorkflow {
  readonly steps: ReadonlyArray<JobStep>;
}

/**
 * The marker a gate agent is asked to end its reply with. A gate has to reduce
 * to a decision, and reading one of two fixed tokens is the least that can go
 * wrong; anything richer is M5's problem.
 */
export const GATE_PASS_MARKER = "GATE: PASS";
export const GATE_FAIL_MARKER = "GATE: FAIL";

/**
 * Read a gate verdict out of a reviewing agent's final message.
 *
 * Fails closed: a reply with neither marker, or with both, is a fail. A gate
 * that cannot be read is not a gate that passed.
 */
export function parseGateVerdict(assistantText: string | null): {
  readonly passed: boolean;
  readonly reason: string;
} {
  if (assistantText === null || assistantText.trim().length === 0) {
    return { passed: false, reason: "The review produced no output." };
  }
  const hasPass = assistantText.includes(GATE_PASS_MARKER);
  const hasFail = assistantText.includes(GATE_FAIL_MARKER);
  if (hasPass && !hasFail) {
    return { passed: true, reason: "The review passed." };
  }
  if (hasFail && !hasPass) {
    return { passed: false, reason: failureReason(assistantText) };
  }
  if (hasPass && hasFail) {
    return { passed: false, reason: "The review returned both a pass and a fail marker." };
  }
  return { passed: false, reason: "The review returned no verdict marker." };
}

/**
 * The reason a review failed, which is the last line that is not the marker
 * itself. The marker is asked for on its own final line, so simply taking the
 * last line would report "GATE: FAIL" back as the explanation and lose the one
 * thing worth reading.
 */
function failureReason(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    if (line === GATE_FAIL_MARKER || line === GATE_PASS_MARKER) {
      continue;
    }
    return line;
  }
  return "The review failed without giving a reason.";
}

const REVIEW_INSTRUCTION = [
  "You are reviewing work another agent just did in this worktree.",
  "Read the changes against the original request below and decide whether they are complete and correct.",
  "",
  "Do not change any files. Do not run git commands that write.",
  "",
  `End your reply with exactly one of "${GATE_PASS_MARKER}" or "${GATE_FAIL_MARKER}" on its own final line.`,
  `If you answer "${GATE_FAIL_MARKER}", put the single most important reason on the line before it.`,
].join("\n");

/**
 * The M0 walking skeleton: implement, review, push, open a pull request.
 *
 * Both agent-facing steps run in `approval-required` so the provider genuinely
 * requests approval and the supervisor has something to answer (ADR-0008).
 */
export function m0Workflow(input: { readonly instruction: string }): JobWorkflow {
  return {
    steps: [
      {
        kind: "agent",
        id: "implement",
        title: "Implement",
        instruction: input.instruction,
        runtimeMode: "approval-required",
      },
      {
        kind: "gate",
        id: "review",
        title: "Review",
        instruction: `${REVIEW_INSTRUCTION}\n\n--- original request ---\n${input.instruction}`,
        runtimeMode: "approval-required",
      },
      { kind: "action", id: "push", title: "Push", action: "push" },
      {
        kind: "action",
        id: "open-pull-request",
        title: "Open pull request",
        action: "open_pull_request",
      },
    ],
  };
}
