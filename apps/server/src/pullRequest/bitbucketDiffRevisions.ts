import { parseGitPatchHeaderPaths, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

const ENTRY = "diff --git ";

interface Entry {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  revision: string | null;
  /** Past the first hunk header every line is content, and content can start like a header. */
  inBody: boolean;
}

/**
 * `a/x`/`b/x` on a `---`/`+++` line; `/dev/null` marks the side that has no file. Git ends the
 * name with a tab when it holds a space, and a name with a tab of its own arrives quoted with
 * that tab escaped, so the first literal tab is never part of what the file is called.
 */
function sidePath(rest: string, prefix: string): string | null {
  const tab = rest.indexOf("\t");
  const token = tab === -1 ? rest : rest.slice(0, tab);
  if (token === "/dev/null") return null;
  const path = unquoteGitPatchPath(token);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The right-hand id of `index <before>..<after> <mode>`. */
function headRevision(rest: string): string | null {
  const gap = rest.indexOf("..");
  if (gap === -1) return null;
  const after = rest.slice(gap + 2);
  const end = after.indexOf(" ");
  const head = end === -1 ? after : after.slice(0, end);
  return head.length === 0 ? null : head;
}

/**
 * What the head has of each file, as the blob ids from a unified patch's `index <before>..<after>`
 * line: Bitbucket exposes no blob id for a file anywhere else. Keyed by the head's name, except
 * for a deletion where only the old name exists. An entry with no `index` line (most often one
 * Bitbucket excluded by pattern) is left out.
 */
export function parseDiffFileRevisions(patch: string): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>();
  let entry: Entry | null = null;

  const close = () => {
    if (entry === null) return;
    const path = entry.deleted ? entry.oldPath : (entry.newPath ?? entry.oldPath);
    if (path !== null && path.length > 0 && entry.revision !== null) {
      revisions.set(path, entry.revision);
    }
    entry = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith(ENTRY)) {
      close();
      const [oldPath, newPath] = parseGitPatchHeaderPaths(line.slice(ENTRY.length));
      entry = { oldPath, newPath, deleted: false, revision: null, inBody: false };
      continue;
    }
    if (entry === null || entry.inBody) continue;
    if (line.startsWith("@@")) {
      entry.inBody = true;
    } else if (line.startsWith("index ")) {
      entry.revision = headRevision(line.slice("index ".length));
    } else if (line.startsWith("deleted file mode")) {
      entry.deleted = true;
    } else if (line.startsWith("rename from ")) {
      entry.oldPath = unquoteGitPatchPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      entry.newPath = unquoteGitPatchPath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      entry.oldPath = sidePath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      const side = sidePath(line.slice(4), "b/");
      entry.newPath = side;
      if (side === null) entry.deleted = true;
    }
  }
  close();
  return revisions;
}
