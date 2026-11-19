// @effect-diagnostics nodeBuiltinImport:off - runs before dependency installation, so only Node built-ins exist.
/**
 * Worktree setup, run by the launchpad.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error(
    "T3CODE_PROJECT_ROOT is not set. Run this through the launchpad.json setup action.",
  );
}
const worktree = NodePath.dirname(import.meta.dirname);

// Preserve Vite+ hosts; clean runners can bootstrap the local CLI with pnpm.
// `shell` resolves commands through PATH, including Windows command shims.
const hasVitePlus =
  NodeChildProcess.spawnSync("vp --version", { cwd: worktree, shell: true, stdio: "ignore" })
    .status === 0;
const constrainedMemory = NodeOS.totalmem() <= 6 * 1024 ** 3;
const installCommand = hasVitePlus ? "vp i" : "pnpm install";
// Small runners cannot afford re-resolving the graph or many parallel tarball workers.
const installOptions = constrainedMemory
  ? ` --frozen-lockfile${hasVitePlus ? " --" : ""} --network-concurrency=4 --child-concurrency=1`
  : "";
const install = NodeChildProcess.spawnSync(`${installCommand}${installOptions}`, {
  cwd: worktree,
  shell: true,
  stdio: "inherit",
  env: constrainedMemory
    ? {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=1536",
        PNPM_MAX_WORKERS: process.env.PNPM_MAX_WORKERS ?? "1",
      }
    : process.env,
});
if (install.status !== 0) process.exit(install.status ?? 1);

// In the main checkout itself, relinking would replace the real env files.
if (NodeFS.realpathSync(projectRoot) !== NodeFS.realpathSync(worktree)) {
  for (const file of ENV_FILES) {
    const source = NodePath.join(projectRoot, file);
    if (!NodeFS.existsSync(source)) continue;
    const target = NodePath.join(worktree, file);
    NodeFS.rmSync(target, { force: true });
    NodeFS.symlinkSync(source, target);
  }
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
