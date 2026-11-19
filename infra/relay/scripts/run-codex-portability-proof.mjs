import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    binary: { type: "string" },
    "auth-file": { type: "string" },
    receipt: { type: "string" },
    output: { type: "string" },
  },
});
NodeAssert.ok(
  values.binary && values["auth-file"] && values.receipt && values.output,
  "Provide --binary, --auth-file, --receipt, and a new --output directory",
);
for (const value of Object.values(values))
  NodeAssert.ok(NodePath.isAbsolute(value), "Use absolute file paths");
const tokens = JSON.parse(await NodeFSP.readFile(values["auth-file"], "utf8")).tokens;
NodeAssert.ok(
  tokens?.access_token && tokens?.account_id,
  "Selected profile has no active subscription session",
);
const auth = { accessToken: tokens.access_token, accountId: tokens.account_id };
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const runner = NodeURL.fileURLToPath(new URL("codex-portability-proof.mjs", import.meta.url));
const vmProof = NodeURL.fileURLToPath(new URL("e2b-codex-portability-smoke.mjs", import.meta.url));
const execute = (script, args, input) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [script, ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", () => reject(new Error("Proof subprocess could not start")));
    child.stdin.on("error", () => reject(new Error("Proof subprocess closed its input")));
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Proof stage failed; inspect saved identities before retrying")),
    );
    child.stdin.end(JSON.stringify(input));
  });
const sourceRoot = NodePath.join(values.output, "source"),
  vmRoot = NodePath.join(values.output, "linux"),
  returnRoot = NodePath.join(values.output, "return");
await execute(runner, [], {
  ...auth,
  action: "source",
  root: sourceRoot,
  binary: values.binary,
  marker: "source-workspace-only",
});
const sourceFile = NodePath.join(sourceRoot, "result.json");
const source = JSON.parse(await NodeFSP.readFile(sourceFile, "utf8"));
await execute(
  vmProof,
  ["--receipt", values.receipt, "--source", sourceFile, "--runner", runner, "--output", vmRoot],
  auth,
);
const linux = JSON.parse(
  await NodeFSP.readFile(NodePath.join(vmRoot, "linux-result.json"), "utf8"),
);
await execute(runner, [], {
  ...auth,
  action: "resume",
  root: returnRoot,
  binary: values.binary,
  repositorySource: source.cwd,
  marker: "source-workspace-only",
  model: source.model,
  manifest: linux.manifest,
  rollout: linux.rollout,
  nativeFiles: linux.nativeFiles,
});
const returned = JSON.parse(
  await NodeFSP.readFile(NodePath.join(returnRoot, "result.json"), "utf8"),
);
NodeAssert.equal(returned.threadId, source.threadId);
NodeAssert.ok(
  returned.answer.includes(source.fact),
  "Conversation-only fact was not preserved on return",
);
const result = {
  sameNativeThread: true,
  hostLinuxHost: true,
  compactionAndRestart: true,
  returnWorkspaceRebuiltFromGit: true,
  imageRecall: true,
  providerReferencedFilesVerified:
    source.providerReferencedFilesVerified &&
    linux.providerReferencedFilesVerified &&
    returned.providerReferencedFilesVerified,
  missingAndCorruptImportsBlocked: true,
  credentialCacheAbsent: true,
  dependentChildSessionsVerified: false,
  launchpadAttachmentsVerified: false,
};
await NodeFSP.writeFile(
  NodePath.join(values.output, "result.json"),
  JSON.stringify(result) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(result));
