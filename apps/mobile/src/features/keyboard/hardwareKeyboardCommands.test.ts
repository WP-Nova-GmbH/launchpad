import { describe, expect, it } from "vite-plus/test";

import { savedWorkflowDiffParams } from "../review/reviewAvailability";
import { activeThreadWorkflowOrigin, parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("extracts the active thread from thread subroutes", () => {
    expect(parseActiveThreadPath("/threads/environment-1/thread-1/files/src/index.ts")).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });

  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores non-thread routes", () => {
    expect(parseActiveThreadPath("/settings")).toBeNull();
    expect(parseActiveThreadPath("/threads/environment-only")).toBeNull();
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});

it("opens keyboard review with the current workflow origin but without a stale review visit", () => {
  const thread = parseActiveThreadPath(
    "/threads/guest/workflow%3Arun?workflowOrigin=%5Bobject%20Object%5D",
  )!;
  const workflowOrigin = {
    accountId: "account",
    organizationId: "organization",
    repositoryId: "repository",
    jobId: "run",
    threadId: "workflow:run",
    workflowVmResultReader: true,
  };
  const params = {
    ...thread,
    workflowOrigin: {
      ...workflowOrigin,
      reviewVisitId: "prior-visit",
      reviewCheckpoint: { checkpointId: "checkpoint", turnId: "turn", checkpointTurnCount: 1 },
    },
  };
  expect(thread).toEqual({ environmentId: "guest", threadId: "workflow:run" });
  expect(
    savedWorkflowDiffParams(
      thread.environmentId,
      thread.threadId,
      activeThreadWorkflowOrigin(thread, params, "account"),
    ),
  ).toEqual({ ...thread, workflowOrigin });
  expect(activeThreadWorkflowOrigin(thread, params, "other-account")).toBeUndefined();
  expect(
    activeThreadWorkflowOrigin(thread, { ...params, environmentId: "other-guest" }, "account"),
  ).toBeUndefined();
});
