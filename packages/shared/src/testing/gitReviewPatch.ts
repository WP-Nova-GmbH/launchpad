// @effect-diagnostics nodeBuiltinImport:off - synchronous Git fixtures for plain unit tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function makeGitReviewPatchFixtures() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-review-"));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = NodePath.join(cwd, "unused-git-config");
  const git = (args: ReadonlyArray<string>, input?: string) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "core.protectNTFS=false",
        "-c",
        "core.protectHFS=false",
        "-c",
        "core.quotePath=true",
        ...args,
      ],
      { cwd, env, input, encoding: "utf8" },
    );
  // Stage paths and symlinks directly so the fixture is independent of filesystem rules.
  const stage = (path: string, content: string, mode = "100644") => {
    const blob = git(["hash-object", "-w", "--stdin"], content).trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`]);
  };
  try {
    git(["init", "--quiet"]);
    stage("file.txt", "before plain\n");
    stage("file.txt ", "before spaced\n");
    stage("rename.txt", "unchanged through rename\n");
    stage("quoted\tname.txt", "before quote\n");
    stage("link", "old file\n");
    stage("copy-source.txt", "original contents copied verbatim\n");
    stage("interior space.txt", "-- a/header-lookalike \nold mode 100755\n");
    const before = git(["write-tree"]).trim();
    stage("file.txt", "after plain\n");
    stage("file.txt ", "after spaced\n");
    git(["update-index", "--force-remove", "--", "rename.txt"]);
    stage(" renamed.txt ", "unchanged through rename\n");
    stage("quoted\tname.txt", "after quote\n");
    stage("link", "file.txt", "120000");
    stage("copy-source.txt", "original contents copied verbatim\nsource still exists\n");
    stage("copy-target.txt", "original contents copied verbatim\n");
    stage("interior space.txt", "++ b/header-lookalike \nnew file mode 120000\ncopy from x\n");
    const after = git(["write-tree"]).trim();
    const diff = (paths: ReadonlyArray<string>, detection = "--find-renames") =>
      git([
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        detection,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        before,
        after,
        "--",
        ...paths,
      ]);
    return {
      trailing: diff(["file.txt", "file.txt "]),
      rename: diff(["rename.txt", " renamed.txt "]),
      quoted: diff(["quoted\tname.txt"]),
      fileType: diff(["link"]),
      copy: diff(["copy-source.txt", "copy-target.txt"], "--find-copies"),
      interior: diff(["interior space.txt"]),
    };
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
}
