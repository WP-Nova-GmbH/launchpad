// @effect-diagnostics nodeBuiltinImport:off - Local VM image build artifacts.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function matchingSelection(content: string, apiUrl: string) {
  const selected: unknown = JSON.parse(content);
  if (
    typeof selected !== "object" ||
    selected === null ||
    !("schemaVersion" in selected) ||
    selected.schemaVersion !== 1 ||
    !("state" in selected) ||
    selected.state !== "built" ||
    !("templateRef" in selected) ||
    typeof selected.templateRef !== "string" ||
    !/^[^:]+:build-[^:]+$/u.test(selected.templateRef.trim()) ||
    !("buildId" in selected) ||
    typeof selected.buildId !== "string" ||
    !selected.buildId.trim() ||
    !("apiUrl" in selected) ||
    typeof selected.apiUrl !== "string"
  )
    throw new Error("The selected VM image is not a successful build.");
  if (new URL(selected.apiUrl).href.replace(/\/+$/u, "") !== apiUrl)
    throw new Error("The selected VM image belongs to a different E2B_API_URL.");
}

/** Reuse a selected runner, or build once using temporary Linux server artifacts. */
export async function ensureDevVmImage(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  rebuild?: boolean;
  buildArchive: (outputDirectory: string) => Promise<{ archive: string; sha256: string }>;
  buildTemplate: (server: { archive: string; sha256: string }) => Promise<void>;
}) {
  const override = input.env.E2B_TEMPLATE_FILE?.trim();
  if (override && !NodePath.isAbsolute(override))
    throw new Error("E2B_TEMPLATE_FILE must be an absolute path.");
  const selectionPath =
    override || NodePath.join(input.repoRoot, "infra", "relay", ".t3", "e2b-template.json");
  let apiUrl: string;
  try {
    apiUrl = new URL(input.env.E2B_API_URL ?? "").href.replace(/\/+$/u, "");
  } catch {
    throw new Error("Configure a valid E2B_API_URL before building a VM image.");
  }
  if (!input.rebuild) {
    let content: string | undefined;
    try {
      content = await NodeFSP.readFile(selectionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`Cannot read the selected VM image (${selectionPath}).`, { cause: error });
    }
    if (content !== undefined) {
      try {
        matchingSelection(content, apiUrl);
      } catch (error) {
        throw new Error(
          `Cannot use the selected VM image (${selectionPath}). Run vp run build:vm-template to rebuild it.`,
          { cause: error },
        );
      }
      return { built: false, selectionPath };
    }
    if (
      !override &&
      /^[^:]+:build-[^:]+$/u.test(input.env.E2B_TEMPLATE_REF ?? "") &&
      input.env.E2B_TEMPLATE_BUILD_ID?.trim()
    )
      return { built: false, selectionPath };
  }

  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "launchpad-vm-image-"));
  try {
    const server = await input.buildArchive(temporary);
    await input.buildTemplate(server);
    matchingSelection(await NodeFSP.readFile(selectionPath, "utf8"), apiUrl);
    return { built: true, selectionPath };
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
