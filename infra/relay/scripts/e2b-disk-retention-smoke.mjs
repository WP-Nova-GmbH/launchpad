import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import { Sandbox, Template, SandboxNotFoundError } from "e2b";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeE2BThreadVmCompute } from "../src/machines/E2BThreadVmCompute.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    fixture: { type: "string" },
    collector: { type: "string" },
    output: { type: "string" },
  },
});
NodeAssert.ok(values.fixture && values.collector && values.output);
NodeAssert.ok(
  process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL && process.env.E2B_API_KEY_FILE,
);
const host = JSON.parse(await NodeFSP.readFile(NodePath.join(values.fixture, "host.json"), "utf8"));
// Only an operator-created independent fixture may be collected by this proof.
NodeAssert.equal(host.activeScope, "fixture");
NodeAssert.equal(NodePath.resolve(host.fixture), NodePath.resolve(values.fixture));
NodeAssert.notEqual(host.fixtureStorage, host.originalStorage);
NodeAssert.ok(/^lp_recovery[0-9]+_[a-f0-9]+$/u.test(host.database));
const receipt = JSON.parse(
  await NodeFSP.readFile(NodePath.join(values.fixture, "template.json"), "utf8"),
);
NodeAssert.equal(receipt.state, "built");
const apiKey = (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim();
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey,
  requestTimeoutMs: 60_000,
};
NodeAssert.equal(new URL(receipt.apiUrl).href, new URL(options.apiUrl).href);
NodeAssert.ok(
  (await Template.getTags(receipt.templateId, options)).some(
    (tag) => tag.tag === receipt.buildTag && tag.buildId === receipt.buildId,
  ),
);
const collector = JSON.parse(
  await NodeFSP.readFile(NodePath.join(values.fixture, "collector.json"), "utf8"),
);
NodeAssert.equal(collector.storagePath, host.fixtureStorage);
NodeAssert.equal(new URL(collector.databaseURL).pathname, `/${host.database}`);
NodeAssert.equal(collector.apiURL, options.apiUrl);
NodeAssert.ok(collector.apiKey === apiKey, "Fixture authentication does not match");
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const proof = `launchpad-retention-${NodeCrypto.randomUUID()}`;
const generation = "retention-proof";
const operationID = NodeCrypto.randomUUID();
const compute = makeE2BThreadVmCompute({
  ...options,
  apiKey: Redacted.make(apiKey),
  templateId: receipt.templateRef,
  hostAddresses: [],
  timeoutMs: 600_000,
});
const runtime = compute.restore;
const ledger = {
  proof,
  operationID,
  snapshots: [],
  sandboxIDs: [],
  stopped: [],
  createRequested: false,
  stage: "create",
};
const save = () =>
  NodeFSP.writeFile(NodePath.join(values.output, "result.json"), JSON.stringify(ledger), {
    mode: 0o600,
  });
const exists = (build) =>
  NodeFSP.stat(NodePath.join(host.fixtureStorage, build)).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
const collect = async (stage, unpublishedPreparation = false) => {
  const run = NodeChildProcess.spawnSync(values.collector, ["--live", "--apply"], {
    input: JSON.stringify(collector),
    encoding: "utf8",
    timeout: 300_000,
  });
  await NodeFSP.writeFile(
    NodePath.join(values.output, `${stage}.collection.json`),
    run.stdout ?? "",
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(
    NodePath.join(values.output, `${stage}.collection.stderr`),
    run.stderr ?? "",
    { mode: 0o600 },
  );
  const result = JSON.parse(run.stdout);
  if (unpublishedPreparation && run.status === 1) {
    // The prepared disk lives outside published template storage. Until
    // publication the collector may refuse the whole catalog; it must delete nothing.
    NodeAssert.deepEqual(result.deletedBuilds, []);
    NodeAssert.deepEqual(result.unreferencedBuilds, []);
    ledger.prepublicationCollectionDeferred = true;
    await save();
  } else NodeAssert.equal(run.status, 0, "Collection refused; inspect the private host receipt");
  NodeAssert.equal(result.dryRun, false);
  for (const ancestor of host.baseBuildIds)
    NodeAssert.equal(await exists(ancestor), true, "Shared template ancestry was deleted");
  return result;
};
const stop = async (id) => {
  await Effect.runPromise(compute.destroy(id));
  if (!ledger.stopped.includes(id)) ledger.stopped.push(id);
  await save();
};
const capture = async (vm, label) => {
  const result = await vm.createSnapshot({ name: `${proof}-${label}` });
  const tag = (await Template.getTags(result.snapshotId, options)).find(
    (value) => value.tag === "default",
  );
  NodeAssert.ok(tag?.buildId);
  const immutable = await Effect.runPromise(runtime.resolveNamedSnapshot(result.snapshotId));
  NodeAssert.equal(immutable.sourceBuildID, tag.buildId);
  const point = { snapshotID: result.snapshotId, buildID: tag.buildId, ...immutable };
  ledger.snapshots.push(point);
  await save();
  return point;
};
let status;
let prepareRequested = false;
const inspectKnownRequest = async () => {
  try {
    return await Effect.runPromise(runtime.inspect(operationID, generation));
  } catch (error) {
    if (error?._tag === "E2BRestoreError" && error.reason === "http" && error.status === 404)
      return undefined;
    throw error;
  }
};
const waitFor = async (state) => {
  const end = Date.now() + 900_000;
  while (Date.now() < end) {
    status = await Effect.runPromise(runtime.inspect(operationID, generation));
    await save();
    if (status.state === state) return;
    NodeAssert.ok(
      status.state === state || !["failed", "cancelled"].includes(status.state),
      "Restore failed; exact identity retained",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Restore receipt deadline; operation retained");
};
const absent = async (id) => {
  try {
    await Sandbox.getInfo(id, options);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return;
    throw error;
  }
  throw new Error("Stopped VM still has a serving route");
};
let vm;
try {
  await save();
  ledger.createRequested = true;
  await save();
  vm = await Sandbox.create(receipt.templateRef, {
    ...options,
    timeoutMs: 20 * 60_000,
    secure: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "pause", autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  ledger.sandboxIDs.push(vm.sandboxId);
  await save();
  await vm.files.write("/home/user/retention-proof.txt", "independent saved disk");
  const saved = await capture(vm, "saved");
  const other = await capture(vm, "other-thread");
  await stop(vm.sandboxId);
  await absent(vm.sandboxId);
  vm = undefined;
  ledger.stage = "prepare";
  prepareRequested = true;
  await save();
  status = await Effect.runPromise(
    runtime.prepare(operationID, {
      sourceTemplateID: saved.sourceTemplateID,
      sourceBuildID: saved.sourceBuildID,
      generation,
      bootstrap: { version: 1, proof, placementGeneration: generation },
      metadata: threadVmSmokeMetadata(proof),
      leaseSeconds: 900,
    }),
  );
  ledger.sandboxIDs.push(status.sandboxID);
  await save();
  await waitFor("prepared");
  ledger.preparedBuildID = status.preparedBuildID;
  await save();
  const preparedDisk = NodePath.join(
    values.fixture,
    "orchestrator",
    "prepared-restores",
    status.preparedBuildID,
    "rootfs.ext4",
  );
  NodeAssert.equal((await NodeFSP.stat(preparedDisk)).isFile(), true, "Prepared disk is missing");
  const protectedSource = await fetch(
    `${options.apiUrl}/templates/${encodeURIComponent(saved.sourceTemplateID)}`,
    { method: "DELETE", headers: { "X-API-Key": apiKey }, redirect: "error" },
  );
  await protectedSource.body?.cancel();
  NodeAssert.equal(protectedSource.status, 409, "An admitted restore must protect its source");
  ledger.stage = "collect-prepared";
  await save();
  await collect("prepared", true);
  NodeAssert.equal(await exists(saved.buildID), true, "Pinned restore source was deleted");
  NodeAssert.equal(await exists(other.buildID), true, "Another saved disk was deleted");
  ledger.stage = "activate";
  await save();
  await Effect.runPromise(runtime.activate(operationID, generation));
  await waitFor("active");
  vm = await Sandbox.connect(status.sandboxID, options);
  NodeAssert.equal(await vm.files.read("/home/user/retention-proof.txt"), "independent saved disk");
  const servingSource = await fetch(
    `${options.apiUrl}/templates/${encodeURIComponent(saved.sourceTemplateID)}`,
    { method: "DELETE", headers: { "X-API-Key": apiKey }, redirect: "error" },
  );
  await servingSource.body?.cancel();
  NodeAssert.equal(servingSource.status, 400, "A serving descendant must protect its source");
  ledger.activeSourceProtected = true;
  ledger.stage = "collect-active";
  await save();
  await collect("active");
  NodeAssert.equal(await exists(status.preparedBuildID), true, "Serving restored disk was deleted");
  await stop(status.sandboxID);
  await absent(status.sandboxID);
  await Sandbox.deleteSnapshot(status.sandboxID, options);
  await Sandbox.deleteSnapshot(saved.snapshotID, options);
  vm = undefined;
  ledger.stage = "collect-stopped";
  await save();
  await collect("stopped");
  await NodeFSP.stat(preparedDisk).then(
    () => {
      throw new Error("Released private prepared disk bytes remain");
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  NodeAssert.equal(
    await exists(ledger.preparedBuildID),
    false,
    "Deleted restored disk bytes remain",
  );
  NodeAssert.equal(await exists(other.buildID), true, "Another saved disk was deleted");
  await Sandbox.deleteSnapshot(other.snapshotID, options);
  ledger.stage = "collect-final";
  await save();
  await collect("final");
  NodeAssert.equal(await exists(saved.buildID), false, "Retired restore source bytes remain");
  NodeAssert.equal(await exists(other.buildID), false, "Deleted independent snapshot bytes remain");
  ledger.passed = true;
  console.log(
    "PASS: pinned source, serving restored disk and shared ancestry preserved; stopped and deleted disk bytes reclaimed",
  );
} catch (error) {
  ledger.failure = error?.name ?? "Error";
  if (error?._tag === "E2BRestoreError")
    ledger.restoreError = {
      operation: error.operation,
      reason: error.reason,
      status: error.status,
    };
  ledger.failureMessage = String(error?.message ?? "Proof failed")
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/https?:\/\/\S+/gu, "[URL]")
    .slice(0, 1000);
  console.error(`Disk retention proof failed (${ledger.failure}); private receipts retained`);
  process.exitCode = 1;
} finally {
  try {
    if (prepareRequested && !status) {
      status = await inspectKnownRequest();
      if (status && !ledger.sandboxIDs.includes(status.sandboxID))
        ledger.sandboxIDs.push(status.sandboxID);
    }
    if (status) {
      status = await Effect.runPromise(runtime.inspect(operationID, generation));
      if (["active", "activating", "failed"].includes(status.state)) {
        await stop(status.sandboxID);
        await absent(status.sandboxID);
        if (status.state === "activating") await waitFor("failed");
        await Sandbox.deleteSnapshot(status.sandboxID, options);
      } else {
        await Effect.runPromise(runtime.cancel(operationID, generation));
        await waitFor("cancelled");
        if (!ledger.stopped.includes(status.sandboxID)) ledger.stopped.push(status.sandboxID);
      }
    }
    for (const id of ledger.sandboxIDs) if (!ledger.stopped.includes(id)) await stop(id);
    ledger.physicalStopVerified =
      ledger.sandboxIDs.length > 0 && ledger.sandboxIDs.every((id) => ledger.stopped.includes(id));
  } catch {
    ledger.physicalStopVerified = false;
    console.error("Physical cleanup unconfirmed; preserve isolated runtime and exact identities");
    process.exitCode = 1;
  }
  await save();
}
