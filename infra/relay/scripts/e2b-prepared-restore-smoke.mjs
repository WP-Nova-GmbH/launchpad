import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import { Sandbox, SandboxNotFoundError, Template } from "e2b";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeE2BThreadVmCompute } from "../src/machines/E2BThreadVmCompute.ts";
const apiUrl = process.env.E2B_API_URL,
  sandboxUrl = process.env.E2B_SANDBOX_URL;
NodeAssert.ok(apiUrl && sandboxUrl && process.env.E2B_API_KEY_FILE);
const apiKey = (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim();
const options = { apiUrl, sandboxUrl, apiKey, requestTimeoutMs: 60000 };
NodeAssert.ok(process.env.E2B_TEMPLATE_RECEIPT, "A verified runner template receipt is required.");
const template = JSON.parse(await NodeFSP.readFile(process.env.E2B_TEMPLATE_RECEIPT, "utf8"));
NodeAssert.equal(template.state, "built");
NodeAssert.equal(new URL(template.apiUrl).href, new URL(apiUrl).href);
NodeAssert.equal(template.templateRef, `${template.templateId}:${template.buildTag}`);
NodeAssert.ok(
  (await Template.getTags(template.templateId, options)).some(
    (tag) => tag.tag === template.buildTag && tag.buildId === template.buildId,
  ),
);
const compute = makeE2BThreadVmCompute({
  apiUrl,
  sandboxUrl,
  apiKey: Redacted.make(apiKey),
  templateId: template.templateRef,
  hostAddresses: [],
  timeoutMs: 600_000,
});
const runtime = compute.restore;
const pausedSource = process.argv.includes("--paused-source");
const generation = "proof-1";
const proof = `launchpad-prepared-${NodeCrypto.randomUUID()}`;
const operationID = NodeCrypto.randomUUID();

const snapshotName = pausedSource
  ? `${process.argv.includes("--final-save") ? "launchpad-final" : "launchpad-backup"}-${NodeCrypto.randomUUID()}`
  : `${proof}-disk`;
let snapshotRequested = false;
let prepareRequested = false;
let prepareAbsenceConfirmed = false;
let activatedCleanupConfirmed = false;
const gate = process.env.E2B_RESTORE_PROOF_GATE_DIR;
NodeAssert.ok(gate, "The proof requires a host-verification gate directory before activation.");
let source, destination, snapshot, status;
const errors = [];
async function absent(id) {
  try {
    await Sandbox.getInfo(id, options);
  } catch (e) {
    if (e instanceof SandboxNotFoundError) return;
    throw e;
  }
  throw new Error(`Expected allocation ${id} to be absent`);
}
async function remove(id) {
  await Effect.runPromise(compute.destroy(id));
  await absent(id);
}
async function waitFor(state) {
  const until = Date.now() + 15 * 60000;
  let previous;
  while (Date.now() < until) {
    status = await Effect.runPromise(runtime.inspect(operationID, generation));
    const phase = `${status.state}:${status.error ?? ""}`;
    if (phase !== previous)
      console.log(JSON.stringify({ operationID, state: status.state, error: status.error }));
    previous = phase;
    if (status.state === state) return status;
    // A persisted retry diagnostic is not a terminal failure. The runtime keeps
    // the same operation and reservation while reconciling incomplete preparation.
    if (["failed", "cancelled"].includes(status.state))
      throw new Error(`Restore ended in ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Restore did not reach ${state}; retained ${operationID}`);
}
try {
  NodeAssert.equal((await Effect.runPromise(runtime.capabilities())).diskRestore, true);
  source = await Sandbox.create(template.templateRef, {
    ...options,
    timeoutMs: 20 * 60000,
    secure: true,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "pause", autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  console.log(JSON.stringify({ proof, operationID, source: source.sandboxId }));
  await source.files.write(
    "/tmp/launchpad-startup.service",
    `[Unit]\nDescription=Restore startup proof\nAfter=local-fs.target\n[Service]\nType=oneshot\nExecStart=/bin/sh -c 'echo activated >> /home/user/launchpad-startup-canary'\n[Install]\nWantedBy=multi-user.target\n`,
  );
  await source.commands.run(
    "cp /tmp/launchpad-startup.service /etc/systemd/system/launchpad-startup.service && systemctl enable launchpad-startup.service && test ! -e /home/user/launchpad-startup-canary && printf 'preserved dirty content' > /home/user/launchpad-dirty && printf '#!/bin/sh\\necho installed-tool\\n' > /usr/local/bin/launchpad-proof-tool && chmod +x /usr/local/bin/launchpad-proof-tool && sync",
    { user: "root" },
  );
  await source.commands.run(
    `python3 -c "import sqlite3; c=sqlite3.connect('/home/user/launchpad-proof.sqlite'); c.execute('create table proof(value text)'); c.execute('insert into proof values (?)', ('retained',)); c.commit(); c.close()"`,
  );
  await source.commands.run("sync");
  NodeAssert.equal(
    (
      await source.commands.run(
        "python3 -c \"import sqlite3; print(sqlite3.connect('/home/user/launchpad-proof.sqlite').execute('select value from proof').fetchone()[0])\"",
      )
    ).stdout.trim(),
    "retained",
  );
  const bootID = (await source.commands.run("cat /proc/sys/kernel/random/boot_id")).stdout.trim();
  await source.commands.run("bash -c 'exec -a launchpad-ram-proof sleep 1200'", {
    background: true,
  });
  const workloadSource = await NodeFSP.readFile(
    new URL("../../e2b/busy-disk-proof.py", import.meta.url),
    "utf8",
  );
  await source.files.write("/home/user/launchpad-busy-disk-proof.py", workloadSource);
  // Resolve readiness from the guest's explicit output, never a guessed sleep.
  let ready;
  const readiness = new Promise((resolve) => {
    ready = resolve;
  });
  let output = "";
  const workload = await source.commands.run(
    "python3 /home/user/launchpad-busy-disk-proof.py serve",
    {
      user: "user",
      background: true,
      onStdout: (chunk) => {
        output += chunk;
        if (output.includes('"ready": true')) ready();
      },
    },
  );
  await Promise.race([
    readiness,
    workload.wait().then(() => {
      throw new Error("Busy workload exited before the snapshot");
    }),
  ]);
  const readBusy = async () =>
    JSON.parse(
      (
        await source.commands.run(
          "python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://127.0.0.1:3765/proof\", timeout=10).read().decode())'",
          { user: "user" },
        )
      ).stdout,
    );
  const busyBefore = await readBusy();
  NodeAssert.equal(busyBefore.writerTransactionOpen, true);
  snapshotRequested = true;
  if (pausedSource) {
    await Effect.runPromise(compute.pause(source.sandboxId));
    NodeAssert.equal((await Sandbox.getInfo(source.sandboxId, options)).state, "paused");
    snapshot = (await Effect.runPromise(compute.snapshotPaused(source.sandboxId, snapshotName)))
      .snapshotId;
    NodeAssert.equal(
      (await Effect.runPromise(compute.snapshotPaused(source.sandboxId, snapshotName))).snapshotId,
      snapshot,
    );
    NodeAssert.equal((await Sandbox.getInfo(source.sandboxId, options)).state, "paused");
    await NodeFSP.writeFile(
      `${gate}/paused.json`,
      JSON.stringify({ proof, source: source.sandboxId, snapshot }),
    );
    console.log(
      JSON.stringify({ hostPausedVerificationRequired: true, proof, source: source.sandboxId }),
    );
    const until = Date.now() + 120000;
    while (true) {
      try {
        const receipt = JSON.parse(await NodeFSP.readFile(`${gate}/paused-verified.json`, "utf8"));
        NodeAssert.equal(receipt.source, source.sandboxId);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() > until) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } else {
    snapshotRequested = true;
    snapshot = (await source.createSnapshot({ name: snapshotName })).snapshotId;
    console.log(JSON.stringify({ snapshot }));
    NodeAssert.equal(
      await source.files.read("/home/user/launchpad-dirty"),
      "preserved dirty content",
    );
    NodeAssert.equal(
      (
        await source.commands.run(
          "python3 -c \"import sqlite3; print(sqlite3.connect('/home/user/launchpad-proof.sqlite').execute('select value from proof').fetchone()[0])\"",
        )
      ).stdout.trim(),
      "retained",
    );
    const busyAfter = await readBusy();
    NodeAssert.equal(busyAfter.writerTransactionOpen, true);
    NodeAssert.equal(busyAfter.pid, busyBefore.pid);
    NodeAssert.equal(
      (await source.commands.run("cat /proc/sys/kernel/random/boot_id")).stdout.trim(),
      bootID,
    );
  }
  const immutableSource = await Effect.runPromise(runtime.resolveNamedSnapshot(snapshot));
  console.log(JSON.stringify(immutableSource));
  await remove(source.sandboxId);
  source = undefined;
  const body = {
    ...immutableSource,
    generation,
    bootstrap: { version: 1, proof, placementGeneration: "proof-1" },
    metadata: threadVmSmokeMetadata(proof),
    leaseSeconds: 600,
  };
  prepareRequested = true;
  status = await Effect.runPromise(runtime.prepare(operationID, body));
  NodeAssert.equal(
    (await Effect.runPromise(runtime.prepare(operationID, body))).sandboxID,
    status.sandboxID,
  );
  await waitFor("prepared");
  await absent(status.sandboxID);
  console.log(
    JSON.stringify({
      preparedBuildID: status.preparedBuildID,
      manifestSHA256: status.manifestSHA256,
      preparedWithoutVM: true,
    }),
  );
  if (process.env.E2B_RESTORE_PROOF_GATE_DIR) {
    await NodeFSP.writeFile(
      `${gate}/prepared.json`,
      JSON.stringify({
        operationID,
        proof,
        preparedBuildID: status.preparedBuildID,
        sandboxID: status.sandboxID,
      }),
    );
    console.log(JSON.stringify({ hostVerificationRequired: true, operationID }));
    const until = Date.now() + 120000;
    while (true) {
      try {
        const receipt = JSON.parse(await NodeFSP.readFile(`${gate}/verified.json`, "utf8"));
        NodeAssert.equal(receipt.operationID, operationID);
        break;
      } catch (e) {
        if (e.code !== "ENOENT" || Date.now() > until) throw e;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  // Test coordinator's explicit ownership-commit boundary; production uses durable relay ownership.
  status = await Effect.runPromise(runtime.activate(operationID, generation));
  await waitFor("active");
  await Effect.runPromise(runtime.activate(operationID, generation));
  destination = await Sandbox.connect(status.sandboxID, options);
  NodeAssert.equal(
    await destination.files.read("/home/user/launchpad-dirty"),
    "preserved dirty content",
  );
  NodeAssert.notEqual(
    (await destination.commands.run("cat /proc/sys/kernel/random/boot_id")).stdout.trim(),
    bootID,
  );
  NodeAssert.equal(
    (await destination.commands.run("/usr/local/bin/launchpad-proof-tool")).stdout.trim(),
    "installed-tool",
  );
  NodeAssert.equal(
    (
      await destination.commands.run(
        `python3 -c "import sqlite3; c=sqlite3.connect('/home/user/launchpad-proof.sqlite'); assert c.execute('pragma integrity_check').fetchone()[0]=='ok'; print(c.execute('select value from proof').fetchone()[0])"`,
      )
    ).stdout.trim(),
    "retained",
  );
  NodeAssert.equal(
    (
      await destination.commands.run(
        "ps -eo args | awk '$1 == \"launchpad-ram-proof\" {n++} END {print n+0}'",
      )
    ).stdout.trim(),
    "0",
  );
  await destination.commands.run(
    "systemctl is-active launchpad-startup.service || test -f /home/user/launchpad-startup-canary",
    { user: "root" },
  );
  NodeAssert.equal(
    (await destination.files.read("/home/user/launchpad-startup-canary")).trim(),
    "activated",
  );
  NodeAssert.equal(
    await destination.files.read("/home/user/launchpad-busy-disk-proof.py"),
    workloadSource,
    "Snapshot lost the workload script that was still in the guest page cache",
  );
  const recovered = JSON.parse(
    (
      await destination.commands.run("python3 /home/user/launchpad-busy-disk-proof.py verify", {
        user: "user",
      })
    ).stdout,
  );
  NodeAssert.equal(recovered.committedWalRetained, true);
  NodeAssert.equal(recovered.uncommittedTransactionAbsent, true);
  NodeAssert.equal(recovered.dirtyFileRetained, true);
  await destination.commands.run(
    "python3 -c 'import socket; s=socket.socket(); assert s.connect_ex((\"127.0.0.1\",3765)) != 0'",
    { user: "user" },
  );
  const enrollment = JSON.parse(
    (await destination.commands.run("cat /launchpad-restore.json", { user: "root" })).stdout,
  );
  NodeAssert.equal(enrollment.proof, proof);
  console.log(
    pausedSource
      ? "PASS: paused disk retained without waking, source deletion, busy WAL recovery, dirty files, cold boot and explicit activation."
      : "PASS: independent whole disk, busy WAL recovery, dirty files, cold boot, explicit activation, retry and enrollment.",
  );
} catch (e) {
  errors.push(e);
} finally {
  for (const cleanup of [
    async () => {
      if (source) await remove(source.sandboxId);
    },
    async () => {
      if (!status) {
        const pages = Sandbox.list({
          ...options,
          query: { metadata: { "launchpad.proof": proof } },
        });
        while (pages.hasNext) {
          for (const vm of await pages.nextItems()) await remove(vm.sandboxId);
        }
      }
    },

    async () => {
      if (prepareRequested && !status) {
        try {
          status = await Effect.runPromise(runtime.inspect(operationID, generation));
        } catch (error) {
          if (error?._tag !== "E2BRestoreError" || error.reason !== "http" || error.status !== 404)
            throw error;
          prepareAbsenceConfirmed = true;
        }
      }
      if (status) {
        status = await Effect.runPromise(runtime.inspect(operationID, generation));
        if (["active", "activating", "failed"].includes(status.state)) {
          await remove(status.sandboxID);
          if (status.state === "activating") await waitFor("failed");
          await Sandbox.deleteSnapshot(status.sandboxID, options);
          activatedCleanupConfirmed = true;
        } else {
          await Effect.runPromise(runtime.cancel(operationID, generation));
          await waitFor("cancelled");
          await absent(status.sandboxID);
        }
      }
    },
    async () => {
      if (
        snapshotRequested &&
        (!prepareRequested ||
          prepareAbsenceConfirmed ||
          status?.state === "cancelled" ||
          activatedCleanupConfirmed)
      )
        await Sandbox.deleteSnapshot(snapshotName, options);
    },
  ]) {
    try {
      await cleanup();
    } catch (e) {
      errors.push(e);
    }
  }
  console.log(
    JSON.stringify({ proof, operationID, finalState: status?.state, cleanupErrors: errors.length }),
  );
}
if (errors.length) {
  console.error(
    "Prepared restore proof failed:",
    errors.map((error) => ({
      type: error?.name ?? "Error",
      ...(error?._tag === "E2BRestoreError"
        ? { operation: error.operation, reason: error.reason, status: error.status }
        : {}),
      frames: error?.stack
        ?.split("\n")
        .filter((line) => /^\s+at .*restore-proof\.mjs:/u.test(line)),
    })),
  );
  process.exitCode = 1;
}
