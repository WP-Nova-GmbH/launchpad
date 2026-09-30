import { describe, expect, it } from "vite-plus/test";
import { resolveWorkEntryToolPresentation } from "./presentation.ts";

const result = {
  service: "linear",
  identifier: "LP-1",
  accountLabel: "Team · Launchpad",
  url: "https://linear.app/team/issue/LP-1",
};
describe("shared issue activity", () => {
  it.each(["read_linear_issue", "read_linear_comments", "read_linear_images", "view_linear_image"])(
    "shows identity and a safe source link for %s",
    (tool) => {
      const value = resolveWorkEntryToolPresentation({
        label: tool,
        toolLifecycleStatus: "completed",
        toolData: { item: { server: "t3-code", tool, result: { structuredContent: result } } },
      });
      expect(value?.displayName).toContain("LP-1");
      expect(value?.displayName).toContain(result.accountLabel);
      expect(value?.issueUrl).toBe(result.url);
    },
  );
  it.each([
    "javascript:alert(1)",
    "https://attacker.test/issue",
    "https://user@linear.app/team/issue/LP-1",
  ])("rejects unsafe issue URLs: %s", (url) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "read_linear_issue",
        toolLifecycleStatus: "completed",
        toolData: { result: { ...result, url } },
      })?.issueUrl,
    ).toBeUndefined();
  });
  it("does not display identity or links from an unfinished result", () => {
    const value = resolveWorkEntryToolPresentation({
      label: "read_linear_comments",
      toolLifecycleStatus: "failed",
      toolData: { result },
    });
    expect(value?.displayName).not.toContain(result.accountLabel);
    expect(value?.issueUrl).toBeUndefined();
  });
});

it("renders identity from the compact activity metadata sent by the server", () => {
  const value = resolveWorkEntryToolPresentation({
    label: "read_linear_images",
    toolLifecycleStatus: "completed",
    toolData: {
      item: {
        server: "t3-code",
        tool: "read_linear_images",
        result: { content: "truncated result…" },
      },
      issueTrackerIdentity: result,
    },
  });
  expect(value?.displayName).toContain(result.identifier);
  expect(value?.displayName).toContain(result.accountLabel);
  expect(value?.issueUrl).toBe(result.url);
});
