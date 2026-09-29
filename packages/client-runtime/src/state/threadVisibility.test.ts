import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  isThreadRevoked,
  onThreadVisibilityChanged,
  reconcileThreadVisibility,
  rememberThreadProject,
  revokeThreadVisibility,
  restoreThreadVisibility,
  threadVisibilityRevision,
} from "./threadVisibility.ts";

describe("thread visibility", () => {
  it("invalidates a retained body on filtered snapshots and allows a later grant", () => {
    const environmentId = EnvironmentId.make("visibility-test");
    const thread = { id: ThreadId.make("private-thread"), projectId: ProjectId.make("project") };
    const projects = [{ id: thread.projectId }];
    const revisions: number[] = [];
    const unsubscribe = onThreadVisibilityChanged(environmentId, thread.id, () => {
      revisions.push(threadVisibilityRevision(environmentId, thread.id));
    });
    expect(reconcileThreadVisibility(environmentId, [thread], [], [])).toEqual([{ id: thread.id }]);
    expect(revisions).toEqual([1]);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
    expect(isThreadRevoked(EnvironmentId.make("another-environment"), thread.id)).toBe(false);
    reconcileThreadVisibility(environmentId, [], [thread], projects);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(false);
    expect(revisions).toEqual([1, 2]);
    reconcileThreadVisibility(environmentId, [thread], [thread], projects);
    expect(revisions).toEqual([1, 2]);
    unsubscribe();
    reconcileThreadVisibility(environmentId, [thread], [], []);
    expect(revisions).toEqual([1, 2]);
  });

  it("invalidates active-list removal without revoking an archived-only project", () => {
    const environmentId = EnvironmentId.make("archived-visibility");
    const thread = { id: ThreadId.make("archived"), projectId: ProjectId.make("project") };
    const projects = [{ id: thread.projectId }];
    expect(reconcileThreadVisibility(environmentId, [thread], [], projects)).toEqual([
      { id: thread.id },
    ]);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(false);
    expect(threadVisibilityRevision(environmentId, thread.id)).toBe(1);
    reconcileThreadVisibility(environmentId, [], [], projects);
    expect(threadVisibilityRevision(environmentId, thread.id)).toBe(1);

    reconcileThreadVisibility(environmentId, [], [], []);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
    reconcileThreadVisibility(environmentId, [], [], projects);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(false);
    expect(threadVisibilityRevision(environmentId, thread.id)).toBe(3);
  });

  it("uses cached detail only to associate a thread with its project", () => {
    const environmentId = EnvironmentId.make("archived-detail-visibility");
    const thread = { id: ThreadId.make("detail-only"), projectId: ProjectId.make("private") };
    rememberThreadProject(environmentId, thread);
    reconcileThreadVisibility(environmentId, [], [], []);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
    rememberThreadProject(environmentId, thread);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
    reconcileThreadVisibility(environmentId, [], [], [{ id: thread.projectId }]);
    expect(isThreadRevoked(environmentId, thread.id)).toBe(false);
  });
});

it("recovers uncached archived detail only from a response newer than the latest denial", () => {
  const environmentId = EnvironmentId.make("uncached-archived-regrant");
  const thread = { id: ThreadId.make("archived"), projectId: ProjectId.make("project") };
  revokeThreadVisibility(environmentId, thread.id);
  const firstRequest = threadVisibilityRevision(environmentId, thread.id);
  revokeThreadVisibility(environmentId, thread.id);
  expect(restoreThreadVisibility(environmentId, thread, firstRequest)).toBe(false);
  expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
  const freshRequest = threadVisibilityRevision(environmentId, thread.id);
  expect(restoreThreadVisibility(environmentId, thread, freshRequest)).toBe(true);
  expect(isThreadRevoked(environmentId, thread.id)).toBe(false);
  expect(threadVisibilityRevision(environmentId, thread.id)).toBe(freshRequest + 1);
  reconcileThreadVisibility(environmentId, [], [], []);
  expect(isThreadRevoked(environmentId, thread.id)).toBe(true);
  expect(restoreThreadVisibility(environmentId, thread, freshRequest)).toBe(false);
});
