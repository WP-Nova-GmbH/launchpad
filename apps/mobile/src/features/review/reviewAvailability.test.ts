import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayRepositoryId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveReviewAvailability,
  resolveWorkflowReviewRoute,
  savedWorkflowDiffParams,
} from "./reviewAvailability";

const jobOrigin = {
  accountId: "account",
  organizationId: "org",
  repositoryId: RelayRepositoryId.make("repo"),
  jobId: "job",
  threadId: "thread",
};
const reviewOrigin = {
  ...jobOrigin,
  reviewVisitId: "visit",
  reviewCheckpoint: {
    checkpointId: "checkpoint",
    turnId: "review-turn",
    checkpointTurnCount: 1,
  },
};

describe("saved workflow diff navigation", () => {
  const environmentId = EnvironmentId.make("result-vm");
  const threadId = ThreadId.make("thread");

  it("opens saved turn browsing and keeps the return link to the workflow", () => {
    const params = savedWorkflowDiffParams(environmentId, threadId, {
      ...reviewOrigin,
      workflowVmResultReader: true,
    });
    expect(params).toEqual({
      environmentId,
      threadId,
      workflowOrigin: { ...jobOrigin, workflowVmResultReader: true },
    });
    expect(resolveWorkflowReviewRoute(params.workflowOrigin, "account", threadId)).toEqual({
      origin: { ...jobOrigin, workflowVmResultReader: true },
      blocked: false,
    });
  });

  it("opens a direct result without inventing a workflow origin", () => {
    expect(savedWorkflowDiffParams(environmentId, threadId, undefined)).toEqual({
      environmentId,
      threadId,
    });
    expect(
      savedWorkflowDiffParams(environmentId, ThreadId.make("another-thread"), reviewOrigin),
    ).toEqual({ environmentId, threadId: "another-thread" });
  });
});

describe("resolveWorkflowReviewRoute", () => {
  it("keeps the declared review blocked until the matching account hydrates", () => {
    expect(resolveWorkflowReviewRoute(reviewOrigin, undefined, "thread")).toEqual({
      origin: null,
      blocked: true,
    });
    expect(resolveWorkflowReviewRoute(reviewOrigin, "account", "thread")).toEqual({
      origin: reviewOrigin,
      blocked: false,
    });
  });

  it("keeps stale or incomplete review routes from falling back to ordinary diffs", () => {
    expect(resolveWorkflowReviewRoute(reviewOrigin, "other-account", "thread").blocked).toBe(true);
    expect(resolveWorkflowReviewRoute(reviewOrigin, "account", "other-thread").blocked).toBe(true);
    expect(
      resolveWorkflowReviewRoute({ ...jobOrigin, reviewVisitId: "visit" }, "account", "thread")
        .blocked,
    ).toBe(true);
  });

  it("allows ordinary reviews and older workflow result links without a review visit", () => {
    expect(resolveWorkflowReviewRoute(undefined, undefined, "thread").blocked).toBe(false);
    expect(resolveWorkflowReviewRoute(jobOrigin, undefined, "thread").blocked).toBe(false);
    expect(resolveWorkflowReviewRoute(jobOrigin, "account", "thread").origin).toEqual(jobOrigin);
  });
});

describe("resolveReviewAvailability", () => {
  it("keeps section navigation available when another section is cached offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: true,
    });
  });

  it("hides section navigation when no review section is available offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: false,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: false,
    });
  });

  it("shows cached selected content and navigation while offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: true,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: false,
      showSectionToolbar: true,
    });
  });
});
