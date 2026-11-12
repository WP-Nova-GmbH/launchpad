import { renderCodexFileCitationsAsMarkdown } from "@t3tools/client-runtime/codex-markdown-directives";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { resolveWorkflowResultAccess } from "../../state/workflow-result-access";
import { fileChipMenu, resolveFileChipTarget } from "./fileChipMenu";
import { resolveThreadMarkdownLink } from "./threadMarkdownLink";

const thread = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  workspaceRoot: "/repo",
};

const workflowResult = {
  ...thread,
  workspaceFilesAvailable: resolveWorkflowResultAccess(
    { workflowVmResultReader: true },
    undefined,
    thread.threadId,
  ).workspaceEnabled,
};

describe("conversation file actions", () => {
  it("makes an assistant citation copyable in the workflow result feed", () => {
    const markdown = renderCodexFileCitationsAsMarkdown(
      'Wrote :codex-file-citation{path="outputs/report.pdf" purpose="output"}.',
    );
    const href = /\]\(<([^>]+)>\)/.exec(markdown)?.[1];
    expect(href).toBe("outputs/report.pdf");
    expect(resolveThreadMarkdownLink(href!, workflowResult)).toEqual({
      kind: "copy-path",
      path: "outputs/report.pdf",
    });
  });

  it.each([
    ["src/app.ts:12", "src/app.ts", ["copy-full-path", "copy-relative-path"]],
    ["/tmp/report.pdf", "/tmp/report.pdf", ["copy-full-path"]],
    ["screens/image.PNG", "screens/image.PNG", ["copy-full-path", "copy-relative-path"]],
    ["/tmp/demo.mp4#t=2", "/tmp/demo.mp4", ["copy-full-path"]],
  ])(
    "makes a direct VM result link to %s copyable without opening the workspace",
    (href, path, actions) => {
      expect(resolveThreadMarkdownLink(href, workflowResult)).toEqual({ kind: "copy-path", path });
      const target = resolveFileChipTarget(href, thread.workspaceRoot)!;
      expect(
        fileChipMenu(target, workflowResult.workspaceFilesAvailable).actions.map(({ id }) => id),
      ).toEqual(actions);
    },
  );

  it("leaves external links and media available and blocks host-backed inline previews", () => {
    const url = "https://example.com/pull/42";
    expect(resolveThreadMarkdownLink(url, workflowResult)).toEqual({ kind: "external", url });
    expect(resolveThreadMarkdownLink("https://example.com/demo.mp4", workflowResult)).toMatchObject(
      {
        kind: "video",
        source: { uri: "https://example.com/demo.mp4" },
      },
    );
    expect(
      resolveMarkdownMediaPreview("screens/image.PNG", { ...workflowResult, imageEmbed: true }),
    ).toBeNull();
    expect(
      resolveMarkdownMediaPreview("https://example.com/render?id=42", {
        ...workflowResult,
        imageEmbed: true,
      }),
    ).toMatchObject({ kind: "image", source: { uri: "https://example.com/render?id=42" } });
  });

  it("keeps normal Machine file navigation, viewer and share actions", () => {
    const machineResult = {
      ...thread,
      workspaceFilesAvailable: resolveWorkflowResultAccess(
        { workflowVmResultReader: false },
        undefined,
        thread.threadId,
      ).workspaceEnabled,
    };
    expect(resolveThreadMarkdownLink("src/app.ts:12", machineResult)).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 12,
    });
    expect(resolveThreadMarkdownLink("/tmp/report.pdf", machineResult)).toMatchObject({
      kind: "pdf",
      source: { resource: { _tag: "media-file", path: "/tmp/report.pdf" } },
    });
    const target = resolveFileChipTarget("screens/image.PNG", thread.workspaceRoot)!;
    expect(
      fileChipMenu(target, machineResult.workspaceFilesAvailable).actions.map(({ id }) => id),
    ).toEqual(["copy-full-path", "copy-relative-path", "open-file", "save"]);
  });
});
