import { describe, expect, it } from "vite-plus/test";
import { withAgentDeviceEnvironment } from "./McpProviderSession.ts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  setMcpProviderSession,
  readMcpProviderSession,
  bindIssueTrackerTurn,
  completeIssueTrackerTurn,
  clearAllMcpProviderSessions,
  clearMcpProviderSession,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

it("does not let a late completion revoke the next user's authorization", () => {
  const config = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "alice-session",
    endpoint: "http://localhost/mcp",
    authorizationHeader: "Bearer alice",
    capabilities: new Set(["issue-trackers"]),
    issueTrackerAuthorizationId: "alice-grant",
  };
  setMcpProviderSession(config);
  bindIssueTrackerTurn(config.threadId, config.providerSessionId, "alice-turn");
  completeIssueTrackerTurn(config.threadId, config.providerInstanceId, "alice-turn");
  expect(readMcpProviderSession(config.threadId)?.issueTrackerTurnComplete).toBe(true);
  // The next idle-session rotation installs a different immutable grant.
  setMcpProviderSession({
    ...config,
    providerSessionId: "bob-session",
    issueTrackerAuthorizationId: "bob-grant",
  });
  bindIssueTrackerTurn(config.threadId, config.providerSessionId, "late-alice-admission");
  expect(readMcpProviderSession(config.threadId)?.issueTrackerTurnId).toBeUndefined();
  bindIssueTrackerTurn(config.threadId, "bob-session", "bob-turn");
  completeIssueTrackerTurn(config.threadId, config.providerInstanceId, "alice-turn");
  expect(readMcpProviderSession(config.threadId)?.issueTrackerTurnComplete).toBeUndefined();
  expect(readMcpProviderSession(config.threadId)?.issueTrackerAuthorizationId).toBe("bob-grant");
  clearAllMcpProviderSessions();
});

it("does not let late cleanup delete a replacement credential", () => {
  const config = {
    threadId: ThreadId.make("late-credential-cleanup"),
    environmentId: EnvironmentId.make("environment"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "new-native",
    endpoint: "http://localhost/mcp",
    authorizationHeader: "Bearer fixture",
    capabilities: new Set<string>(),
  };
  setMcpProviderSession(config);
  clearMcpProviderSession(config.threadId, "old-native");
  expect(readMcpProviderSession(config.threadId)).toBe(config);
  clearMcpProviderSession(config.threadId, "new-native");
  expect(readMcpProviderSession(config.threadId)).toBeUndefined();
});
