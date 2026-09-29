import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentThreadShell extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export type EnvironmentMessage = OrchestrationMessage;

export interface EnvironmentThread extends OrchestrationThread {
  readonly environmentId: EnvironmentId;
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentThreadShell {
  return { ...thread, environmentId };
}

export function scopeThread(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThread {
  const queue = thread.promptQueue;
  if (!queue || queue.entries.length === 0) return { ...thread, environmentId };
  const staged = new Set(queue.entries.map((entry) => entry.messageId));
  const messages = thread.messages.filter((message) => !staged.has(message.id));
  // Admission/removal can arrive in separate frames; recovery can also restore
  // an admitted entry. Keep one visible identity until the queue resolves it.
  return {
    ...thread,
    environmentId,
    messages: messages.length === thread.messages.length ? thread.messages : messages,
  };
}
