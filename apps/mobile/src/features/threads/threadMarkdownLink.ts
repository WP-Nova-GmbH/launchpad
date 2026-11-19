import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";

import { isPdfFile } from "../../lib/filePreview";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { basename, isAbsolutePath, resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { resolveFileChipTarget } from "./fileChipMenu";

/** Resolve a tap in the conversation without granting access to the backing workspace. */
export function resolveThreadMarkdownLink(
  href: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string | null | undefined;
    readonly workspaceFilesAvailable: boolean;
  },
) {
  const presentation = resolveMarkdownLinkPresentation(href);
  const openFile = (path: string, scope: "workspace-file" | "media-file", line?: number) =>
    isPdfFile({ name: path })
      ? ({
          kind: "pdf",
          source: {
            kind: "pdf",
            name: basename(path),
            environmentId: input.environmentId,
            resource: { _tag: scope, threadId: input.threadId, path },
          },
        } as const)
      : ({ kind: "file", path, line } as const);

  if (presentation.kind === "file") {
    if (!input.workspaceFilesAvailable) {
      const target = resolveFileChipTarget(href, input.workspaceRoot);
      const path = target?.relativePath ?? target?.fullPath;
      return path ? ({ kind: "copy-path", path } as const) : null;
    }
    const relativePath = resolveWorkspaceRelativeFilePath(input.workspaceRoot, presentation.path);
    if (relativePath) return openFile(relativePath, "workspace-file", presentation.line);
  }

  const media = resolveMarkdownMediaPreview(href, input);
  if (media) return media;

  if (presentation.kind === "file") {
    return isAbsolutePath(presentation.path)
      ? openFile(presentation.path, "media-file", presentation.line)
      : null;
  }

  const url = presentation.href;
  if (!url) return null;
  return /^https?:\/\//i.test(url) && isPdfFile({ name: url })
    ? ({ kind: "pdf", source: { kind: "pdf", uri: url, name: "Document.pdf" } } as const)
    : ({ kind: "external", url } as const);
}
