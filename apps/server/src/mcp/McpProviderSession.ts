import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { cancelIssueWritesForSession } from "./IssueTrackerApprovalBroker.ts";

export interface McpProviderSessionConfig {
  readonly issueTrackerAuthorizationId?: string;
  readonly issueTrackerTurnId?: string;
  readonly issueTrackerTurnComplete?: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

/** Only admission of the submitted prompt can activate this process's personal grant. */
export function bindIssueTrackerTurn(
  threadId: ThreadId,
  providerSessionId: string,
  turnId: string,
): void {
  const current = sessionsByThread.get(threadId);
  if (
    current?.issueTrackerAuthorizationId &&
    current.providerSessionId === providerSessionId &&
    !current.issueTrackerTurnComplete &&
    !current.issueTrackerTurnId
  ) {
    sessionsByThread.set(threadId, { ...current, issueTrackerTurnId: turnId });
  }
}

export function revokeIssueTrackerTurn(threadId: ThreadId, providerSessionId: string): void {
  cancelIssueWritesForSession(threadId, providerSessionId);
  const current = sessionsByThread.get(threadId);
  if (current?.providerSessionId === providerSessionId && current.issueTrackerAuthorizationId)
    sessionsByThread.set(threadId, { ...current, issueTrackerTurnComplete: true });
}

export function completeIssueTrackerTurn(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  turnId: string,
): void {
  const current = sessionsByThread.get(threadId);
  if (
    current?.issueTrackerAuthorizationId &&
    current.providerInstanceId === providerInstanceId &&
    current.issueTrackerTurnId === turnId
  ) {
    cancelIssueWritesForSession(threadId, current.providerSessionId);
    sessionsByThread.set(threadId, { ...current, issueTrackerTurnComplete: true });
  }
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
