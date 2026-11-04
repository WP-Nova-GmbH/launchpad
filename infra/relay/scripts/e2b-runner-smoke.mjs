import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import { Sandbox, SandboxNotFoundError, Template, CommandExitError } from "e2b";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  WORKFLOW_VM_ISOLATION_VERSION,
  WORKFLOW_VM_MODEL_PROOF_VERSION,
  WorkflowVmModelProof,
  verifiedWorkflowVmModelProof,
  workflowVmModelProofPath,
} from "../src/threads/ThreadVmWorkflowModelProof.ts";
import { writeJsonAtomically } from "./e2b-build-template.mjs";
const { values } = NodeUtil.parseArgs({
  options: {
    receipt: { type: "string" },
    output: { type: "string" },
    "workflow-isolation": { type: "boolean", default: false },
  },
});
NodeAssert.ok(values.receipt && values.output, "Provide --receipt and a new --output directory.");
NodeAssert.ok(
  process.env.E2B_API_KEY_FILE && process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL,
  "Configure explicit self-hosted endpoints and the host key file.",
);
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey: (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim(),
  requestTimeoutMs: 30000,
  retries: 0,
};
const receipt = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
NodeAssert.equal(receipt.state, "built");
NodeAssert.equal(new URL(receipt.apiUrl).href, new URL(options.apiUrl).href);
NodeAssert.equal(receipt.templateRef, `${receipt.templateId}:${receipt.buildTag}`);
NodeAssert.ok(/^build-[a-f0-9-]+$/.test(receipt.buildTag));
NodeAssert.match(receipt.buildId, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
const resources = receipt.resources ?? receipt.versions?.resources;
NodeAssert.match(receipt.workloadSha256, /^[a-f0-9]{64}$/);
NodeAssert.match(receipt.workloadServiceSha256, /^[a-f0-9]{64}$/);
NodeAssert.match(receipt.installerSha256, /^[a-f0-9]{64}$/);
if (values["workflow-isolation"]) {
  NodeAssert.match(receipt.workflowExecSha256, /^[a-f0-9]{64}$/);
  NodeAssert.match(receipt.workflowCheckpointReaderSha256, /^[a-f0-9]{64}$/);
}
NodeAssert.ok(
  resources && resources.cpuCount > 0 && resources.memoryMB > 0 && resources.minFreeDiskMb > 0,
);
await requireBuildTag();
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const proof = `launchpad-runner-${NodeCrypto.randomUUID()}`;
const save = (name, data) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
await save("identity.json", { proof, templateRef: receipt.templateRef, buildId: receipt.buildId });
let sandboxId;
let modelProof;
let stage = "allocation";
try {
  const vm = await Sandbox.create(receipt.templateRef, {
    ...options,
    timeoutMs: 600000,
    secure: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: { action: "kill" }, autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  sandboxId = vm.sandboxId;
  await save("allocation.json", { proof, sandboxId: vm.sandboxId });
  stage = "runner";
  const script = await NodeFSP.readFile(
    new URL("../../e2b/runner-guest-proof.py", import.meta.url),
    "utf8",
  );
  const result = await vm.commands.run(`python3 - <<'RUNNER_PROOF'\n${script}\nRUNNER_PROOF`, {
    user: "user",
    timeoutMs: 120000,
    envs: {
      LAUNCHPAD_EXPECTED_RESOURCES: JSON.stringify(resources),
      LAUNCHPAD_WORKLOAD_SHA256: receipt.workloadSha256,
      LAUNCHPAD_WORKLOAD_SERVICE_SHA256: receipt.workloadServiceSha256,
      LAUNCHPAD_INSTALLER_SHA256: receipt.installerSha256,
    },
  });
  stage = "model-catalog";
  const modelScript = await NodeFSP.readFile(
    new URL("../../e2b/workflow-model-proof.py", import.meta.url),
    "utf8",
  );
  const modelResult = await vm.commands.run(
    `python3 - <<'WORKFLOW_MODEL_PROOF'\n${modelScript}\nWORKFLOW_MODEL_PROOF`,
    { user: "user", timeoutMs: 50_000 },
  );
  const guestCatalog = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        defaultModel: Schema.String,
        models: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            name: Schema.String,
          }),
        ),
      }),
    ),
  )(modelResult.stdout);
  if (values["workflow-isolation"]) {
    stage = "workflow-isolation";
    const isolationScript = await NodeFSP.readFile(
      new URL("../../e2b/workflow-isolation-proof.py", import.meta.url),
      "utf8",
    );
    const isolation = await vm.commands.run(
      [
        "set -eu",
        "proof=$(mktemp /tmp/launchpad-workflow-isolation.XXXXXX.py)",
        `trap 'rm -f "$proof"' EXIT`,
        `cat > "$proof" <<'WORKFLOW_ISOLATION_PROOF'`,
        isolationScript,
        "WORKFLOW_ISOLATION_PROOF",
        `/usr/bin/python3 "$proof"`,
      ].join("\n"),
      {
        user: "root",
        timeoutMs: 120_000,
        envs: { LAUNCHPAD_CHECKPOINT_READER_SHA256: receipt.workflowCheckpointReaderSha256 },
      },
    );
    const checks = {
      workflowEnrollment: true,
      workflowLauncher: true,
      coordinatorCredentialsProtected: true,
      coordinatorSignallingDenied: true,
      reviewGitProtected: true,
      privilegedControlDenied: true,
      envdRootCommandDenied: true,
      envdRootFileReadDenied: true,
      workspaceWritable: true,
      detachedWorkloadStopped: true,
      unrelatedWorkloadPreserved: true,
      setupOwnerVerified: true,
      nativeCodexPeerVerified: true,
      otherCodexPeersDenied: true,
      privateCheckpointReaderVerified: true,
    };
    NodeAssert.deepEqual(JSON.parse(isolation.stdout), checks);
    await requireBuildTag();
    await save("workflow-isolation.json", {
      proof,
      sandboxId: vm.sandboxId,
      buildId: receipt.buildId,
      templateRef: receipt.templateRef,
      ...checks,
    });
    console.log("Workflow credential isolation passed inside the packaged launcher.");
  }
  modelProof = Schema.decodeUnknownSync(WorkflowVmModelProof)({
    schemaVersion: WORKFLOW_VM_MODEL_PROOF_VERSION,
    templateRef: receipt.templateRef,
    buildId: receipt.buildId,
    ...(values["workflow-isolation"] ? { isolationVersion: WORKFLOW_VM_ISOLATION_VERSION } : {}),
    catalog: {
      defaultModel: guestCatalog.defaultModel,
      models: guestCatalog.models.map(({ slug, name }) => ({
        slug,
        name,
        isCustom: false,
        ...(slug === guestCatalog.defaultModel ? { isDefault: true } : {}),
        capabilities: null,
      })),
    },
  });
  await save("result.json", {
    proof,
    sandboxId: vm.sandboxId,
    ...JSON.parse(result.stdout.trim()),
  });
  console.log(
    "Runner tools, native terminal, resource monitor, server startup and Codex model probe passed.",
  );
} catch (error) {
  // The fixed guest proof has no credentials. Capture its command output only;
  // SDK transport errors may embed authorization headers and must stay opaque.
  if (error instanceof CommandExitError) {
    await save("guest-failure.json", {
      exitCode: error.exitCode,
      stderr: error.stderr,
      stdout: error.stdout,
    });
    if (error.stderr.split(/\r?\n/u).includes("launchpad-workflow-model-policy-unavailable")) {
      console.error("Rebuild the selected VM runner to publish its Codex model catalog.");
    }
  }
  await save("failure.json", { proof, stage, errorType: error?.name ?? "Error" });
  console.error(`Runner proof failed during ${stage} (${error?.name ?? "Error"}).`);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    await save("cleanup.json", {
      proof,
      nativeDeleteAcknowledged: false,
      errorType: error?.name ?? "Error",
    });
    console.error("Runner proof cleanup needs reconciliation using its saved identity.");
    process.exitCode = 1;
  }
}

if (modelProof && !process.exitCode) {
  const selection =
    process.env.E2B_TEMPLATE_FILE?.trim() ||
    NodePath.join(import.meta.dirname, "../.t3/e2b-template.json");
  NodeAssert.ok(NodePath.isAbsolute(selection), "E2B_TEMPLATE_FILE must be an absolute path.");
  await writeJsonAtomically(NodePath.join(values.output, "workflow-models.json"), modelProof);
  const installedPath = workflowVmModelProofPath(selection, modelProof.buildId);
  const published = await writeJsonAtomically(installedPath, modelProof, {
    ifAbsent: modelProof.isolationVersion !== WORKFLOW_VM_ISOLATION_VERSION,
  });
  if (!published) {
    const retained = await NodeFSP.readFile(installedPath, "utf8").catch(() => "");
    NodeAssert.ok(
      verifiedWorkflowVmModelProof(retained, modelProof.templateRef, modelProof.buildId),
      `The existing workflow proof is invalid (${installedPath}). Remove it before repeating the model check or run with --workflow-isolation.`,
    );
  }
}

async function requireBuildTag() {
  const tags = await Template.getTags(receipt.templateId, options);
  NodeAssert.ok(
    tags.some((tag) => tag.tag === receipt.buildTag && tag.buildId === receipt.buildId),
    "The recorded build tag changed or disappeared.",
  );
}

async function cleanup() {
  const ids = new Set(sandboxId ? [sandboxId] : []);
  const page = Sandbox.list({
    ...options,
    query: { state: ["running", "paused"], metadata: { "launchpad.proof": proof } },
  });
  while (page.hasNext) for (const vm of await page.nextItems()) ids.add(vm.sandboxId);
  if (ids.size === 0)
    throw new Error("Create outcome is unknown; retain the proof identity for reconciliation.");
  for (const id of ids) {
    const current = await Sandbox.getInfo(id, options).catch((error) => {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    });
    if (current)
      NodeAssert.equal(current.metadata["launchpad.proof"], proof, "Cleanup identity differs");
    await Sandbox.kill(id, options);
    await save(`stop-${id}.json`, { sandboxId: id, nativeDeleteAcknowledged: true });
  }
  await save("cleanup.json", { proof, nativeDeleteAcknowledged: true });
  console.log("Runner proof native DELETE acknowledgements received.");
}
