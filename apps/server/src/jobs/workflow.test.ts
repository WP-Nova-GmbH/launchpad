import { describe, expect, it } from "@effect/vitest";

import {
  GATE_FAIL_MARKER,
  GATE_PASS_MARKER,
  m0Workflow,
  parseGateVerdict,
  type JobAgentStep,
  type JobGateStep,
} from "./workflow.ts";

describe("parseGateVerdict", () => {
  it("passes on the pass marker alone", () => {
    expect(parseGateVerdict(`Looks good.\n${GATE_PASS_MARKER}`)).toEqual({
      passed: true,
      reason: "The review passed.",
    });
  });

  it("fails on the fail marker and reports the reason above it", () => {
    // The marker is asked for on its own final line, so the reason is the line
    // before it. Reporting the marker back would lose the only useful part.
    expect(parseGateVerdict(`Nope.\nThe tests do not run.\n${GATE_FAIL_MARKER}`)).toEqual({
      passed: false,
      reason: "The tests do not run.",
    });
  });

  it("says so plainly when a failing review gave no reason", () => {
    expect(parseGateVerdict(GATE_FAIL_MARKER)).toEqual({
      passed: false,
      reason: "The review failed without giving a reason.",
    });
  });

  it("fails closed when the review returned no verdict", () => {
    expect(parseGateVerdict("I had a look and it seems fine.").passed).toBe(false);
  });

  it("fails closed on an empty or absent review", () => {
    expect(parseGateVerdict(null).passed).toBe(false);
    expect(parseGateVerdict("   ").passed).toBe(false);
  });

  it("fails closed when both markers are present", () => {
    // An agent that hedged has not produced a verdict, and picking whichever
    // token appears first would let a review pass by accident.
    expect(parseGateVerdict(`${GATE_PASS_MARKER}\n${GATE_FAIL_MARKER}`).passed).toBe(false);
  });
});

describe("m0Workflow", () => {
  const workflow = m0Workflow({ instruction: "Add a health endpoint" });

  it("implements, reviews, pushes, then opens a pull request", () => {
    expect(workflow.steps.map((step) => [step.kind, step.id])).toEqual([
      ["agent", "implement"],
      ["gate", "review"],
      ["action", "push"],
      ["action", "open-pull-request"],
    ]);
  });

  it("never asks an agent to push or open a pull request", () => {
    // ADR-0009: irreversible operations are the runner's, which is what makes
    // a push request from an agent always anomalous.
    const agentText = workflow.steps
      .filter((step): step is JobAgentStep | JobGateStep => step.kind !== "action")
      .map((step) => step.instruction)
      .join("\n");
    expect(agentText).not.toMatch(/git push|gh pr create|open a pull request/i);
  });

  it("sets a runtime mode explicitly on every agent-facing step", () => {
    // DEFAULT_RUNTIME_MODE is full-access, so an omitted mode would hand an
    // unattended agent unrestricted shell.
    for (const step of workflow.steps) {
      if (step.kind === "action") {
        continue;
      }
      expect(step.runtimeMode).toBe("approval-required");
    }
  });

  it("carries the instruction into the implementation step and the review", () => {
    const implement = workflow.steps[0] as JobAgentStep;
    const review = workflow.steps[1] as JobGateStep;
    expect(implement.instruction).toBe("Add a health endpoint");
    expect(review.instruction).toContain("Add a health endpoint");
    expect(review.instruction).toContain(GATE_PASS_MARKER);
  });
});
