/**
 * The YAML frontmatter at the top of a `SKILL.md`, as every agent CLI reads
 * it: Claude Code, Codex, Cursor, and OpenCode all take the skill's `name`
 * and `description` from it. Shared so the relay validating an upload, the
 * client naming one, and the server enumerating installed skills agree on
 * what a skill is called.
 *
 * @module skillFrontmatter
 */
import { parse as parseYamlDocument } from "yaml";

/** The file every skill directory carries at its root. */
export const SKILL_MANIFEST_FILE = "SKILL.md";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

/**
 * Best-effort read of a manifest's frontmatter. `missing` means the file has
 * no frontmatter block at all (the CLIs then fall back to the directory
 * name); `malformed` means the block is there but is not a YAML mapping, in
 * which case the CLIs will not load the skill either.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}
