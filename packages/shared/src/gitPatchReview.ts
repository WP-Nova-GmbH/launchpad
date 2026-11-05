const GIT_FILE_HEADER = /(?:^|\n)diff --git ([^\r\n]*)/gu;
const COPY_METADATA = /(?:^|\n)copy (?:from|to) /u;
const MODE_CHANGE = /(?:^|\n)(?:old|new) mode [0-7]{6}(?=\r?\n|$)/u;
const SPECIAL_FILE_MODE =
  /(?:^|\n)(?:(?:new|deleted) file mode (?!100644(?=\r?\n|$))[0-7]{6}|index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000))(?=\r?\n|$)/u;

/** Strict Git diffs use a/ and b/ prefixes. Preserve headers the renderer cannot show exactly. */
export function strictGitPatchFallbackReason(patch: string): string | null {
  for (const [, header = ""] of patch.matchAll(GIT_FILE_HEADER)) {
    const separator = header.indexOf(" b/");
    const oldPath = header.slice(2, separator);
    const newPath = header.slice(separator + 3);
    // Quoting can carry arbitrary path bytes. The structured renderer trims names and
    // decodes escaped bytes as UTF-8, so the original header is the reliable display.
    if (
      !header.startsWith("a/") ||
      separator < 0 ||
      separator !== header.lastIndexOf(" b/") ||
      /["\\\u2028\u2029]/u.test(header) ||
      oldPath.trim() !== oldPath ||
      newPath.trim() !== newPath
    ) {
      return "Showing the raw patch to preserve the exact filenames.";
    }
  }

  if (COPY_METADATA.test(patch)) return "Showing the raw patch to distinguish copies from renames.";

  // Git represents some type changes as separate deletion and addition blocks.
  // These metadata lines have no hunk prefix, so changed text cannot trigger the fallback.
  return MODE_CHANGE.test(patch) || SPECIAL_FILE_MODE.test(patch)
    ? "Showing the raw patch to include file modes and types."
    : null;
}
