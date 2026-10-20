import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import { Sandbox, Template, CommandExitError } from "e2b";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";
const { values } = NodeUtil.parseArgs({
  options: { receipt: { type: "string" }, output: { type: "string" } },
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
};
const receipt = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
NodeAssert.equal(receipt.state, "built");
NodeAssert.equal(new URL(receipt.apiUrl).href, new URL(options.apiUrl).href);
NodeAssert.equal(receipt.templateRef, `${receipt.templateId}:${receipt.buildTag}`);
NodeAssert.ok(/^build-[a-f0-9-]+$/.test(receipt.buildTag));
const tags = await Template.getTags(receipt.templateId, options);
NodeAssert.ok(
  tags.some((tag) => tag.tag === receipt.buildTag && tag.buildId === receipt.buildId),
  "The recorded build tag changed or disappeared.",
);
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const resources = receipt.versions.resources;
NodeAssert.match(receipt.workloadSha256, /^[a-f0-9]{64}$/);
NodeAssert.match(receipt.workloadServiceSha256, /^[a-f0-9]{64}$/);
NodeAssert.ok(
  resources && resources.cpuCount > 0 && resources.memoryMB > 0 && resources.minFreeDiskMb > 0,
);
const proof = `launchpad-runner-${NodeCrypto.randomUUID()}`;
const save = (name, data) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
await save("identity.json", { proof, templateRef: receipt.templateRef, buildId: receipt.buildId });
let sandboxId;
try {
  const vm = await Sandbox.create(receipt.templateRef, {
    ...options,
    timeoutMs: 600000,
    secure: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  sandboxId = vm.sandboxId;
  await save("allocation.json", { proof, sandboxId: vm.sandboxId });
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
    },
  });
  await save("result.json", {
    proof,
    sandboxId: vm.sandboxId,
    ...JSON.parse(result.stdout.trim()),
  });
  console.log("Runner tools, native terminal, resource monitor and server startup passed.");
} catch (error) {
  // The fixed guest proof has no credentials. Capture its command output only;
  // SDK transport errors may embed authorization headers and must stay opaque.
  if (error instanceof CommandExitError)
    await save("guest-failure.json", {
      exitCode: error.exitCode,
      stderr: error.stderr,
      stdout: error.stdout,
    });
  await save("failure.json", { proof, errorType: error?.name ?? "Error" });
  console.error(`Runner proof failed (${error?.name ?? "Error"}).`);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    await save("cleanup.json", {
      proof,
      absentFromApi: false,
      physicalStopVerified: false,
      errorType: error?.name ?? "Error",
    });
    console.error("Runner proof cleanup needs reconciliation using its saved identity.");
    process.exitCode = 1;
  }
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
    const response = await fetch(
      `${options.apiUrl}/extensions/launchpad/v1/executions/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { "X-API-Key": options.apiKey },
        signal: AbortSignal.timeout(30000),
      },
    );
    NodeAssert.equal(response.status, 200);
    const stopped = await response.json();
    NodeAssert.equal(stopped.sandboxID, id);
    NodeAssert.equal(stopped.physicallyStopped, true);
    await save(`stop-${id}.json`, stopped);
  }
  await save("cleanup.json", { proof, physicalStopVerified: true });
  console.log("Runner proof allocations physically stopped.");
}
