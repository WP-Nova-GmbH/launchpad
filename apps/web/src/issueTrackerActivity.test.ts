import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "./session-logic";
import { issueTrackerActivityLabel } from "./issueTrackerActivity";
import {
  liveWorkEntryLabel,
  workEntryDisplayLabel,
} from "./components/chat/MessagesTimeline.logic";

const result = {
  service: "linear",
  accountLabel: "WP Nova · Launchpad app",
  identifier: "LP-214",
  title: "Queue design",
  description: "Issue context",
  url: "https://linear.app/wp-nova/issue/LP-214",
  status: "In progress",
  assignee: null,
};

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: EventId.make("issue-read"),
    kind: "tool.completed",
    summary: "Tool call completed",
    tone: "tool",
    createdAt: "2026-09-30T10:00:00Z",
    turnId: null,
    payload,
  };
}

const fixtures = [
  [
    "Codex",
    {
      itemType: "mcp_tool_call",
      title: "t3-code · read_linear_issue",
      data: {
        item: {
          server: "t3-code",
          tool: "read_linear_issue",
          result: { structuredContent: result },
        },
      },
    },
  ],
  [
    "Claude",
    {
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      data: {
        toolName: "mcp__t3_code__read_linear_issue",
        result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify(result) }] },
      },
    },
  ],
  [
    "OpenCode",
    {
      itemType: "dynamic_tool_call",
      title: "Read issue",
      data: { tool: "t3-code_read_linear_issue", state: { output: JSON.stringify(result) } },
    },
  ],
  [
    "ACP raw output",
    {
      itemType: "dynamic_tool_call",
      title: "read_linear_issue",
      data: { rawOutput: { structuredContent: result } },
    },
  ],
  [
    "ACP content",
    {
      itemType: "dynamic_tool_call",
      title: "mcp__t3-code__read_linear_issue",
      data: {
        content: [{ type: "content", content: { type: "text", text: JSON.stringify(result) } }],
      },
    },
  ],
] as const;

describe("issue tracker activity identity", () => {
  it.each([
    [
      "Codex",
      {
        itemType: "mcp_tool_call",
        title: "T3 Code · add_jira_comment",
        data: { item: { server: "t3-code", tool: "add_jira_comment" } },
      },
    ],
    [
      "Claude",
      {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        data: { toolName: "mcp__t3_code__add_jira_comment" },
      },
    ],
    [
      "OpenCode",
      {
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: { tool: "t3-code_add_jira_comment" },
      },
    ],
  ] as const)("shows a readable Jira write tool for %s", (_provider, payload) => {
    const [entry] = deriveWorkLogEntries([activity({ ...payload, status: "completed" })]);
    expect(entry).toBeDefined();
    expect(workEntryDisplayLabel(entry!, undefined)).toBe("Add Jira Comment");
  });

  it.each(fixtures)(
    "shows the shared account from %s's existing result envelope",
    (_provider, payload) => {
      const [entry] = deriveWorkLogEntries([activity({ ...payload, status: "completed" })]);
      expect(entry).toBeDefined();
      expect(workEntryDisplayLabel(entry!, undefined)).toBe(
        "Read Linear issue LP-214 · WP Nova · Launchpad app",
      );
      expect(liveWorkEntryLabel(entry!, undefined, false)).toBe(
        "Read Linear issue LP-214 · WP Nova · Launchpad app",
      );
    },
  );

  it("uses the returned Jira site identity", () => {
    expect(
      issueTrackerActivityLabel({
        label: "read_jira_issue",
        toolLifecycleStatus: "completed",
        toolData: {
          result: {
            ...result,
            service: "jira",
            accountLabel: "team.atlassian.net",
            identifier: "TEAM-4",
          },
        },
      }),
    ).toBe("Read Jira issue TEAM-4 · team.atlassian.net");
  });

  it.each(["failed", "declined", "stopped", "inProgress"])(
    "does not imply successful account access while %s",
    (status) => {
      const label = issueTrackerActivityLabel({
        label: "read_linear_issue",
        toolLifecycleStatus: status,
        toolData: { result },
      });
      expect(label).not.toContain(result.accountLabel);
      expect(label).toContain("Linear issue");
    },
  );

  it("does not turn another server's similarly named tool into shared organization access", () => {
    expect(
      issueTrackerActivityLabel({
        label: "read_linear_issue",
        toolLifecycleStatus: "completed",
        toolData: { server: "another-mcp", tool: "read_linear_issue", result },
      }),
    ).toBeUndefined();
  });

  it("does not infer account identity from inputs, issue prose, or a different service", () => {
    for (const data of [
      { input: result },
      { result: { description: JSON.stringify(result) } },
      { result: { ...result, service: "jira" } },
      { result: "Malformed JSON" },
    ]) {
      expect(
        issueTrackerActivityLabel({
          label: "read_linear_issue",
          toolLifecycleStatus: "completed",
          toolData: data,
        }),
      ).toBe("Read a Linear issue");
    }
  });
});

it("keeps Jira discussion identity through the web work-log path", () => {
  const [entry] = deriveWorkLogEntries([
    activity({
      itemType: "mcp_tool_call",
      title: "read_jira_comments",
      status: "completed",
      data: {
        issueTrackerIdentity: {
          service: "jira",
          identifier: "ENG-42",
          accountLabel: "team.atlassian.net",
          url: "https://team.atlassian.net/browse/ENG-42",
        },
      },
    }),
  ]);
  expect(entry).toBeDefined();
  expect(workEntryDisplayLabel(entry!, undefined)).toBe(
    "Read Jira issue ENG-42 discussion · team.atlassian.net",
  );
  expect(liveWorkEntryLabel(entry!, undefined, false)).toBe(
    "Read Jira issue ENG-42 discussion · team.atlassian.net",
  );
});
