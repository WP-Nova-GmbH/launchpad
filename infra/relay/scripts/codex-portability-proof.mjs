// Receives an explicitly authorized access token over stdin; never reads a personal home.
// Bundle with build-codex-portability-proof.mjs before copying to the Linux runner.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CODEX_CONVERSATION_TRANSFER_VERSION,
  exportCodexConversation,
  importCodexConversation,
} from "../../../apps/server/src/provider/Drivers/CodexConversationTransfer.ts";

const Text = Schema.String.check(Schema.isMinLength(1));
const Input = Schema.Struct({
  action: Schema.Literals(["source", "resume"]),
  root: Text,
  binary: Text,
  accessToken: Text,
  accountId: Text,
  model: Schema.optionalKey(Text),
  marker: Text,
  compact: Schema.optionalKey(Schema.Boolean),
  manifest: Schema.optionalKey(Schema.Unknown),
  rollout: Schema.optionalKey(Text),
  nativeFiles: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/)),
      Schema.String,
    ),
  ),
  repositorySource: Schema.optionalKey(Text),
});
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error("Proof input exceeds 64 MiB");
}
let input;
try {
  input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(raw);
} catch {
  throw new Error("Invalid proof input; credentials were not logged");
}
raw = "";
NodeAssert.ok(NodePath.isAbsolute(input.root), "Proof root must be absolute and must not exist");
await NodeFSP.mkdir(input.root, { mode: 0o700 });
const root = input.root,
  cwd = NodePath.join(root, "workspace");
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
};
const git = (args) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "pipe",
    env: gitEnvironment,
  }).toString();
if (input.repositorySource) {
  NodeAssert.ok(NodePath.isAbsolute(input.repositorySource), "Repository source must be absolute");
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--", input.repositorySource, cwd],
    {
      stdio: "pipe",
      env: gitEnvironment,
    },
  );
  NodeAssert.equal(git(["status", "--porcelain"]), "");
} else {
  await NodeFSP.mkdir(cwd);
  await NodeFSP.writeFile(NodePath.join(cwd, "README.txt"), `Workspace marker: ${input.marker}\n`);
  git(["init"]);
  git(["add", "README.txt"]);
  git([
    "-c",
    "user.name=Launchpad Proof",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "-m",
    "Disposable portability fixture",
  ]);
}
let home, threadId, rolloutPath;
if (input.action === "resume") {
  NodeAssert.ok(input.manifest && input.rollout, "Resume requires a manifest and rollout");
  const incoming = NodePath.join(root, "incoming.jsonl"),
    corrupt = NodePath.join(root, "corrupt.jsonl");
  await NodeFSP.writeFile(incoming, input.rollout, { mode: 0o600 });
  await NodeFSP.writeFile(corrupt, input.rollout + "corrupt", { mode: 0o600 });
  if (input.nativeFiles) {
    const files = NodePath.join(root, "files");
    await NodeFSP.mkdir(files, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(input.nativeFiles))
      await NodeFSP.writeFile(NodePath.join(files, name), Buffer.from(bytes, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
  }
  const request = {
    manifest: input.manifest,
    rolloutPath: incoming,
    destinationRoot: NodePath.join(root, "homes"),
    codexVersion: CODEX_CONVERSATION_TRANSFER_VERSION,
  };
  await NodeAssert.rejects(
    run(importCodexConversation({ ...request, rolloutPath: NodePath.join(root, "missing.jsonl") })),
  );
  await NodeAssert.rejects(run(importCodexConversation({ ...request, rolloutPath: corrupt })));
  NodeAssert.deepEqual(
    await NodeFSP.readdir(request.destinationRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }),
    [],
    "Failed import left a provider home",
  );
  const imported = await run(importCodexConversation(request));
  for (const file of input.manifest.files ?? []) {
    const destination = NodePath.join(imported.homePath, "native-files", file.name);
    const bytes = await NodeFSP.readFile(destination);
    NodeAssert.equal(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    NodeAssert.ok(
      (await NodeFSP.readFile(imported.rolloutPath, "utf8")).includes(destination),
      "Native image reference still points to the old host",
    );
  }
  home = imported.homePath;
  threadId = imported.resumeCursor.threadId;
  rolloutPath = imported.rolloutPath;
} else {
  home = NodePath.join(root, "home");
  await NodeFSP.mkdir(home, { mode: 0o700 });
}
const fact = input.action === "source" ? "opal-lantern-" + NodeCrypto.randomUUID() : undefined;
const image = NodePath.join(root, "attachment.png");
if (fact)
  await NodeFSP.writeFile(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
let child,
  exited,
  lines,
  next = 0,
  model = input.model;
const pending = new Map(),
  events = [],
  waiters = new Set();
function failPending(error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.reject(error);
  }
  waiters.clear();
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timed out: ${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function receipt(test, after = 0) {
  const prior = events.slice(after).find(test);
  if (prior) return Promise.resolve(prior);
  return new Promise((resolve, reject) => {
    const waiter = { test, resolve, reject, timer: undefined };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error("Native receipt timed out"));
    }, 300_000);
    waiters.add(waiter);
  });
}
async function start() {
  child = NodeChildProcess.spawn(
    input.binary,
    ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'],
    {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  exited = new Promise((resolve) => {
    child.once("error", () => {
      failPending(new Error("Codex could not start"));
      resolve();
    });
    child.once("exit", () => {
      failPending(new Error("Codex exited before a receipt"));
      resolve();
    });
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => failPending(new Error("Codex input closed")));
  lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      failPending(new Error("Invalid native protocol response"));
      return;
    }
    if (v.method && v.id !== undefined) {
      child.stdin.write(
        JSON.stringify({
          id: v.id,
          error: {
            code: -32000,
            message: "Proof does not authorize additional credentials or approvals",
          },
        }) + "\n",
      );
      return;
    }
    if (v.id !== undefined && pending.has(v.id)) {
      const p = pending.get(v.id);
      pending.delete(v.id);
      clearTimeout(p.timer);
      if (v.error) p.reject(new Error(`RPC failed: ${p.method}`));
      else p.resolve(v.result);
      return;
    }
    if (v.method?.startsWith("account/")) return;
    events.push(v);
    for (const w of waiters)
      if (w.test(v)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(v);
      }
  });
  await request("initialize", {
    clientInfo: { name: "launchpad-portability-proof", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  await request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: input.accessToken,
    chatgptAccountId: input.accountId,
  });
  if (!model) {
    const models = await request("model/list", {});
    model = (models.data.find((m) => m.isDefault) ?? models.data[0])?.model;
    NodeAssert.ok(model, "No model available for this account");
  }
  const args = { cwd, model, approvalPolicy: "never", sandbox: "read-only" };
  // A transferred thread must never silently start a replacement conversation.
  const opened = threadId
    ? await request("thread/resume", { ...args, threadId, excludeTurns: true })
    : await request("thread/start", args);
  NodeAssert.equal(opened.thread.cliVersion, CODEX_CONVERSATION_TRANSFER_VERSION);
  if (threadId) NodeAssert.equal(opened.thread.id, threadId);
  threadId = opened.thread.id;
  rolloutPath = opened.thread.path ?? rolloutPath;
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  lines?.close();
}
async function turn(source) {
  const text = source
    ? `This is a disposable portability test. Remember the exact phrase ${fact} in conversation only; never write it to a file. Run a shell command to print the working directory and read only README.txt. State the phrase, directory, README marker and the attached image's dominant color. Do not inspect other files.`
    : "Continue this portability test. Recall the exact phrase from the earlier conversation without reading it from disk. Run a shell command to print the working directory and read only README.txt. State the phrase, directory, README marker and the original image's dominant color. Do not inspect other files.";
  const requested = await request("turn/start", {
    threadId,
    input: [{ type: "text", text }, ...(source ? [{ type: "localImage", path: image }] : [])],
  });
  const done = await receipt(
    (v) => v.method === "turn/completed" && v.params?.turn?.id === requested.turn.id,
  );
  NodeAssert.equal(done.params.turn.status, "completed");
  const items = events
    .filter((v) => v.method === "item/completed" && v.params?.turnId === requested.turn.id)
    .map((v) => v.params.item);
  NodeAssert.ok(
    items.some((i) => i.type === "commandExecution" && i.status === "completed"),
    "No completed destination tool action",
  );
  const answer = items
    .filter((i) => i.type === "agentMessage")
    .map((i) => i.text)
    .join("\n");
  NodeAssert.ok(answer.includes(cwd), "Answer omitted destination directory");
  NodeAssert.ok(answer.includes(input.marker), "Answer omitted destination marker");
  NodeAssert.ok(/red/i.test(answer), "Original image was not recalled");
  if (source) NodeAssert.ok(answer.includes(fact), "Conversation-only fact was not retained");
  return answer;
}
try {
  await start();
  const answer = await turn(input.action === "source");
  if (input.compact) {
    const after = events.length;
    await request("thread/compact/start", { threadId });
    await receipt(
      (v) =>
        v.params?.threadId === threadId &&
        v.method === "item/completed" &&
        v.params?.item?.type === "contextCompaction",
      after,
    );
    await stop();
    await start();
  }
  const afterRestart = input.compact ? await turn(false) : answer;
  await request("thread/unsubscribe", { threadId });
  await stop();
  const exported = await run(
    exportCodexConversation({
      codexHome: home,
      rolloutPath,
      threadId,
      artifactRoot: NodePath.join(root, "artifacts"),
      referencedFileRoots: [root],
    }),
  );
  const rollout = await NodeFSP.readFile(
    NodePath.join(exported.directory, "rollout.jsonl"),
    "utf8",
  );
  NodeAssert.ok(
    !(await NodeFSP.readdir(home)).includes("auth.json"),
    "External authentication was persisted",
  );
  NodeAssert.ok(
    !rollout.includes(input.accessToken),
    "Credential appeared in exported native state",
  );
  const result = {
    threadId,
    model,
    cwd,
    fact,
    manifest: exported.manifest,
    rollout,
    nativeFiles: Object.fromEntries(
      await Promise.all(
        (exported.manifest.files ?? []).map(async (file) => [
          file.name,
          (await NodeFSP.readFile(NodePath.join(exported.directory, "files", file.name))).toString(
            "base64",
          ),
        ]),
      ),
    ),
    providerReferencedFilesVerified: (exported.manifest.files ?? []).length > 0,
    answer,
    afterRestart,
    compacted: !!input.compact,
    credentialCacheAbsent: true,
  };
  await NodeFSP.writeFile(NodePath.join(root, "result.json"), JSON.stringify(result), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      action: input.action,
      threadId,
      nativeContinuationPassed: true,
      compacted: !!input.compact,
      credentialCacheAbsent: true,
    }),
  );
} catch {
  console.error(
    "Native portability proof failed; credentials and protocol payloads were not logged.",
  );
  process.exitCode = 1;
} finally {
  await stop();
  failPending(new Error("Proof finished"));
}
