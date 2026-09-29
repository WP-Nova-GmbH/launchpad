import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

// Retained thread atoms outlive their sockets. A filtered shell must invalidate
// them as well as disk snapshots, including atoms currently off screen.
const revoked = new Set<string>();
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const threadProjects = new Map<EnvironmentId, Map<ThreadId, ProjectId>>();
const key = (environmentId: EnvironmentId, threadId: ThreadId) => `${environmentId}:${threadId}`;
export const isThreadRevoked = (environmentId: EnvironmentId, threadId: ThreadId) =>
  revoked.has(key(environmentId, threadId));
export const threadVisibilityRevision = (environmentId: EnvironmentId, threadId: ThreadId) =>
  revisions.get(key(environmentId, threadId)) ?? 0;
function notify(id: string) {
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  for (const listener of listeners.get(id) ?? []) listener();
}
export function revokeThreadVisibility(environmentId: EnvironmentId, threadId: ThreadId) {
  const id = key(environmentId, threadId);
  revoked.add(id);
  notify(id);
}
// Cached identity records only the association. An authoritative shell decides
// whether that project is accessible, including when all its threads are archived.
export function rememberThreadProject(
  environmentId: EnvironmentId,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
) {
  const projects = threadProjects.get(environmentId) ?? new Map<ThreadId, ProjectId>();
  projects.set(thread.id, thread.projectId);
  threadProjects.set(environmentId, projects);
}
/** Only a newly authorized response from this visibility revision can recover
 * an uncached archived task. Invalidate older in-flight responses before retry. */
export function restoreThreadVisibility(
  environmentId: EnvironmentId,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
  revision: number,
) {
  const id = key(environmentId, thread.id);
  if (!revoked.has(id) || threadVisibilityRevision(environmentId, thread.id) !== revision)
    return false;
  rememberThreadProject(environmentId, thread);
  revoked.delete(id);
  notify(id);
  return true;
}

export function reconcileThreadVisibility(
  environmentId: EnvironmentId,
  previous: ReadonlyArray<{ id: ThreadId; projectId: ProjectId }>,
  current: ReadonlyArray<{ id: ThreadId; projectId: ProjectId }>,
  projects: ReadonlyArray<{ id: ProjectId }>,
) {
  for (const thread of previous) rememberThreadProject(environmentId, thread);
  for (const thread of current) rememberThreadProject(environmentId, thread);
  const accessibleProjects = new Set(projects.map((project) => project.id));
  const invalidated = new Set<ThreadId>();
  for (const [threadId, projectId] of threadProjects.get(environmentId) ?? []) {
    const id = key(environmentId, threadId);
    if (!accessibleProjects.has(projectId)) {
      if (!revoked.has(id)) {
        revokeThreadVisibility(environmentId, threadId);
        invalidated.add(threadId);
      }
    } else if (revoked.delete(id)) {
      notify(id);
      invalidated.add(threadId);
    }
  }
  const active = new Set(current.map((thread) => thread.id));
  for (const thread of previous) {
    if (
      active.has(thread.id) ||
      invalidated.has(thread.id) ||
      !accessibleProjects.has(thread.projectId)
    )
      continue;
    // Active-list removal can be archival or deletion. Drop the stale body and
    // let a new authorized detail subscription decide, without revoking access.
    notify(key(environmentId, thread.id));
    invalidated.add(thread.id);
  }
  return [...invalidated].map((id) => ({ id }));
}
export function onThreadVisibilityChanged(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  listener: () => void,
) {
  const id = key(environmentId, threadId);
  const callbacks = listeners.get(id) ?? new Set();
  callbacks.add(listener);
  listeners.set(id, callbacks);
  if (revoked.has(id)) listener();
  return () => {
    callbacks.delete(listener);
    if (callbacks.size === 0) listeners.delete(id);
  };
}
