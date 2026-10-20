import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { Sandbox, Template, CommandExitError } from "e2b";
import * as Schema from "effect/Schema";
import { THREAD_VM_BLOCKED_NETWORKS } from "../src/machines/E2BThreadVmCompute.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    receipt: { type: "string" },
    source: { type: "string" },
    runner: { type: "string" },
    output: { type: "string" },
  },
});
NodeAssert.ok(
  values.receipt && values.source && values.runner && values.output,
  "Provide --receipt, --source, --runner and a new --output directory",
);
NodeAssert.ok(
  process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL && process.env.E2B_API_KEY_FILE,
  "Explicit self-hosted endpoints and a host key file are required",
);
for (const endpoint of [process.env.E2B_API_URL, process.env.E2B_SANDBOX_URL]) {
  const url = new URL(endpoint);
  NodeAssert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Invalid E2B endpoint",
  );
}
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 128 * 1024) throw new Error("Authentication input too large");
}
let auth;
try {
  auth = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ accessToken: Schema.String, accountId: Schema.String })),
  )(raw);
} catch {
  throw new Error("Expected authorized accessToken and accountId on stdin; values were not logged");
}
raw = "";
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey: (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim(),
  requestTimeoutMs: 60_000,
};
const receipt = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
const source = JSON.parse(await NodeFSP.readFile(values.source, "utf8"));
NodeAssert.equal(receipt.state, "built");
NodeAssert.equal(new URL(receipt.apiUrl).href, new URL(options.apiUrl).href);
NodeAssert.equal(receipt.templateRef, `${receipt.templateId}:${receipt.buildTag}`);
NodeAssert.ok(/^build-[a-f0-9-]+$/.test(receipt.buildTag));
NodeAssert.ok(
  source.fact && source.threadId && source.manifest && source.rollout && source.model,
  "Source proof result is incomplete",
);
NodeAssert.ok(
  (await Template.getTags(receipt.templateId, options)).some(
    (tag) => tag.tag === receipt.buildTag && tag.buildId === receipt.buildId,
  ),
  "Pinned template build changed",
);
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const proof = `launchpad-native-${NodeCrypto.randomUUID()}`;
const save = (name, data) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(data) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
await save("identity.json", { proof, templateRef: receipt.templateRef, buildId: receipt.buildId });
let vm,
  createAttempted = false;
try {
  createAttempted = true;
  vm = await Sandbox.create(receipt.templateRef, {
    ...options,
    timeoutMs: 20 * 60_000,
    secure: true,
    network: { allowPublicTraffic: false, denyOut: [...THREAD_VM_BLOCKED_NETWORKS] },
    lifecycle: { onTimeout: "pause", autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  await save("allocation.json", { proof, sandboxId: vm.sandboxId });
  const runnerPath = "/home/user/codex-portability-proof.mjs";
  await vm.files.write(runnerPath, await NodeFSP.readFile(values.runner, "utf8"));
  const request = {
    ...auth,
    action: "resume",
    root: "/home/user/launchpad-native-proof",
    binary: "codex",
    model: source.model,
    manifest: source.manifest,
    rollout: source.rollout,
    nativeFiles: source.nativeFiles,
    marker: "linux-destination-only",
    compact: true,
  };
  const guest = await vm.commands.run(`node ${runnerPath}`, {
    background: true,
    stdin: true,
    timeoutMs: 15 * 60_000,
  });
  await guest.sendStdin(JSON.stringify(request));
  await guest.closeStdin();
  const result = await guest.wait();
  NodeAssert.equal(result.exitCode, 0, "Linux native proof failed");
  const exported = JSON.parse(await vm.files.read(request.root + "/result.json"));
  NodeAssert.equal(exported.threadId, source.threadId);
  NodeAssert.ok(
    exported.answer.includes(source.fact) && exported.afterRestart.includes(source.fact),
    "Conversation-only fact did not survive",
  );
  NodeAssert.equal(exported.compacted, true);
  NodeAssert.equal(exported.credentialCacheAbsent, true);
  NodeAssert.equal(source.providerReferencedFilesVerified, true);
  NodeAssert.equal(exported.providerReferencedFilesVerified, true);
  NodeAssert.deepEqual(
    exported.manifest.files.map((file) => file.sha256),
    source.manifest.files.map((file) => file.sha256),
  );
  NodeAssert.ok(
    !JSON.stringify(exported).includes(auth.accessToken),
    "Credential appeared in native result",
  );
  await save("linux-result.json", exported);
  console.log(
    JSON.stringify({
      proof,
      sandboxId: vm.sandboxId,
      sameNativeThread: true,
      realToolCompleted: true,
      compactionAndRestartPassed: true,
    }),
  );
} catch (error) {
  if (error instanceof CommandExitError) {
    const redact = (value) => value.replaceAll(auth.accessToken, "[REDACTED]");
    await save("guest-failure.json", {
      exitCode: error.exitCode,
      stdout: redact(error.stdout),
      stderr: redact(error.stderr),
    });
  }
  await save("failure.json", { proof, errorType: error?.name ?? "Error" });
  console.error("Native VM proof failed; inspect saved identities before retrying.");
  process.exitCode = 1;
} finally {
  const ids = new Set(vm ? [vm.sandboxId] : []);
  try {
    if (!vm && createAttempted) {
      const page = Sandbox.list({
        ...options,
        query: { state: ["running", "paused"], metadata: { "launchpad.proof": proof } },
      });
      while (page.hasNext) for (const found of await page.nextItems()) ids.add(found.sandboxId);
    }
    for (const id of ids) {
      const response = await fetch(
        `${options.apiUrl.replace(/\/$/, "")}/extensions/launchpad/v1/executions/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "X-API-Key": options.apiKey },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      NodeAssert.equal(response.status, 200);
      const stopped = await response.json();
      NodeAssert.equal(stopped.sandboxID, id);
      NodeAssert.equal(stopped.physicallyStopped, true);
    }
    NodeAssert.ok(
      vm || !createAttempted,
      "Create result was uncertain; reconcile tagged resources before retrying",
    );
    await save("cleanup.json", { proof, physicallyStopped: [...ids] });
  } catch {
    await save("cleanup-pending.json", { proof, sandboxIds: [...ids] });
    console.error("Native VM cleanup is unconfirmed; reconcile the saved proof identity.");
    process.exitCode = 1;
  }
}
