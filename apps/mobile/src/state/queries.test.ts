import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { environmentRpcKey } from "@t3tools/client-runtime/state/runtime";
import {
  buildCheckpointDiffTargets,
  isCompleteWorkflowReviewDiff,
} from "@t3tools/client-runtime/state/threads";

import { normalizeComposerPathSearchQuery } from "./queryTargets";

describe("appQueries", () => {
  it("normalizes composer path search input", () => {
    expect(normalizeComposerPathSearchQuery("  src/app  ")).toBe("src/app");
    expect(normalizeComposerPathSearchQuery(null)).toBe("");
  });

  it("routes the first turn range through the full-thread diff query", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");

    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      fullThread: {
        environmentId,
        input: {
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        },
      },
      turn: null,
    });
  });

  it("routes later ranges through the incremental turn diff query", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");

    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 3,
        toTurnCount: 4,
        ignoreWhitespace: false,
      }),
    ).toEqual({
      fullThread: null,
      turn: {
        environmentId,
        input: {
          threadId,
          fromTurnCount: 3,
          toTurnCount: 4,
          ignoreWhitespace: false,
        },
      },
    });
  });
  it.each([0, 3])(
    "loads a strict workflow review from checkpoint %i without ordinary cache entries",
    (fromTurnCount) => {
      const target = {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("thread-a"),
        fromTurnCount,
        toTurnCount: fromTurnCount + 1,
        ignoreWhitespace: false,
      };
      const ordinary = buildCheckpointDiffTargets({ ...target, requestKey: "first" });
      const cached = (ordinary.fullThread ?? ordinary.turn)!;
      const expectedTurnId = TurnId.make("turn-a");
      const strict = {
        ...target,
        ignoreWhitespace: true,
        strictWorkflowReview: true,
        expectedTurnId,
      };
      const firstVisit = buildCheckpointDiffTargets({ ...strict, requestKey: "first" });
      const first = firstVisit.turn!;
      const second = buildCheckpointDiffTargets({ ...strict, requestKey: "second" }).turn!;
      const otherTurn = buildCheckpointDiffTargets({
        ...strict,
        expectedTurnId: TurnId.make("turn-b"),
        requestKey: "first",
      }).turn!;
      expect(firstVisit.fullThread).toBeNull();
      expect(first.input).toEqual({
        threadId: target.threadId,
        fromTurnCount,
        toTurnCount: target.toTurnCount,
        ignoreWhitespace: false,
        strictWorkflowReview: true,
        expectedTurnId,
      });
      expect(second.input).toEqual(first.input);
      expect(new Set([cached, first, second, otherTurn].map(environmentRpcKey)).size).toBe(4);
    },
  );

  it("treats a complete result as unavailable without the exact target turn", () => {
    const expectedTurnId = TurnId.make("current-turn");
    const oldReply = {
      threadId: ThreadId.make("thread"),
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "",
      completeWorkflowReview: true as const,
    };
    expect(isCompleteWorkflowReviewDiff(oldReply, expectedTurnId)).toBe(false);
    expect(
      isCompleteWorkflowReviewDiff(
        { ...oldReply, targetTurnId: TurnId.make("old-turn") },
        expectedTurnId,
      ),
    ).toBe(false);
    expect(
      isCompleteWorkflowReviewDiff({ ...oldReply, targetTurnId: expectedTurnId }, expectedTurnId),
    ).toBe(true);
  });
});

it("keeps an older exact PR in the mobile menu ahead of twenty newer substring matches", () => {
  const exact = {
    number: 42,
    projectId: "project",
    repository: "example/repo",
    updatedAt: "2025-01-01",
  };
  const recent = Array.from({ length: 25 }, (_, index) => ({
    ...exact,
    number: 4200 + index,
    updatedAt: "2026-01-01",
  }));
  const matches = filterComposerPullRequestMatches({
    entries: [exact, ...recent, exact],
    projectId: exact.projectId,
    repository: exact.repository,
    query: "42",
    limit: 20,
  });
  expect(matches).toHaveLength(20);
  expect(matches[0]).toEqual(exact);
  expect(matches.filter((entry) => entry.number === 42)).toHaveLength(1);
});
