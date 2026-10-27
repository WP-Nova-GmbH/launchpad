// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off cryptoRandomUUID:off - Opt-in SDK proof on an isolated E2B host.
import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { Sandbox, SandboxNotFoundError } from "e2b";

// The host controller acknowledges explicit stages. This client never changes
// runtime policy, renews its own lease, or calls connect (which could wake a VM).
const apiUrl = process.env.E2B_API_URL;
const sandboxUrl = process.env.E2B_SANDBOX_URL;
const keyFile = process.env.E2B_API_KEY_FILE;
const gate = process.env.E2B_LIFETIME_PROOF_GATE_DIR;
const maxHours = Number(process.env.E2B_LIFETIME_PROOF_MAX_HOURS);
NodeAssert.ok(
  apiUrl && sandboxUrl && keyFile && gate,
  "Explicit endpoints, key file and empty proof gate directory are required.",
);
NodeAssert.ok(
  Number.isInteger(maxHours) && maxHours >= 1 && maxHours <= 24,
  "Set the isolated team's actual maximum lifetime in hours.",
);
NodeAssert.deepEqual(await NodeFSP.readdir(gate), [], "Use a new gate directory per proof.");
const options = {
  apiUrl,
  sandboxUrl,
  apiKey: (await NodeFSP.readFile(keyFile, "utf8")).trim(),
  requestTimeoutMs: 30_000,
};
NodeAssert.ok(options.apiKey);
const proof = `launchpad-lifetime-${crypto.randomUUID()}`;
const errors: unknown[] = [];
let ordinary: Sandbox | undefined;
let renewable: Sandbox | undefined;
const checkpointName = `${proof}-checkpoint`;
let checkpointRequested = false;
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
async function wait(ms: number) {
  await NodeTimersPromises.setTimeout(ms, undefined, { signal: stop.signal });
}
async function hostStage(stage: string, details: Record<string, unknown> = {}) {
  await NodeFSP.writeFile(
    NodePath.join(gate!, `${stage}.request.json`),
    JSON.stringify({ proof, stage, ...details }),
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(
        await NodeFSP.readFile(NodePath.join(gate!, `${stage}.done.json`), "utf8"),
      );
      NodeAssert.equal(receipt.proof, proof);
      NodeAssert.equal(receipt.stage, stage);
      NodeAssert.equal(receipt.ok, true);
      console.log(JSON.stringify({ proof, stage, verified: true }));
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await wait(500);
  }
  throw new Error(`Host stage ${stage} did not complete before its deadline`);
}
async function absent(id: string) {
  try {
    await Sandbox.getInfo(id, options);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return;
    throw error;
  }
  throw new Error(`Allocation ${id} is still present`);
}
async function remove(id: string) {
  await Sandbox.kill(id, options);
  await absent(id);
}
try {
  // Start with the proof team outside the allowlist. Forged metadata must not
  // grant renewable lifetime. Host setup records the real team limit first.
  await hostStage("bounded-policy", { maxHours });
  ordinary = await Sandbox.create("base", {
    ...options,
    timeoutMs: maxHours * 3_600_000,
    secure: true,
    lifecycle: { onTimeout: "kill", autoResume: false },
    network: { allowPublicTraffic: false },
    metadata: { "launchpad.proof": proof, "launchpad.renewableLifetime": "true" },
  });
  const ordinaryInfo = await Sandbox.getInfo(ordinary.sandboxId, options);
  await hostStage("renewable-policy", { ordinary: ordinary.sandboxId });
  renewable = await Sandbox.create("base", {
    ...options,
    timeoutMs: 600_000,
    secure: true,
    lifecycle: { onTimeout: "pause", autoResume: false },
    network: { allowPublicTraffic: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  const initial = await Sandbox.getInfo(renewable.sandboxId, options);
  const token = crypto.randomUUID();
  const worker = await renewable.commands.run(
    `python3 -u -c 'import json,os,time; token="${token}"; start=open("/proc/self/stat").read().split()[21]; boot=open("/proc/sys/kernel/random/boot_id").read().strip(); tick=0\nwhile True:\n tick+=1; f=open("/tmp/lifetime-proof.json.tmp","w"); json.dump(dict(token=token,pid=os.getpid(),start=start,boot=boot,tick=tick),f); f.close(); os.replace("/tmp/lifetime-proof.json.tmp","/tmp/lifetime-proof.json"); time.sleep(1)'`,
    { background: true, timeoutMs: maxHours * 3_600_000 + 900_000 },
  );
  let identity:
    | { token: string; pid: number; start: string; boot: string; tick: number }
    | undefined;
  async function verifyProcess(requireAdvance = false) {
    NodeAssert.ok(renewable);
    // A new authenticated command request, not a previously-open process stream.
    const started = Date.now();
    let response;
    try {
      response = await renewable.commands.run(
        `kill -0 ${worker.pid} && cat /tmp/lifetime-proof.json`,
      );
    } catch (error) {
      // SDK error bodies may contain credentials. Record only known categories
      // and independent read-only observations before the finalizer removes VMs.
      const message = error instanceof Error ? error.message : "";
      console.error(
        JSON.stringify({
          proof,
          stage: "command-failed",
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          requestTimeout: message.includes("'requestTimeoutMs'"),
          executionTimeout: message.includes("'timeoutMs'"),
          unavailable: message.includes("sandbox timeout"),
          ended: message.includes("end of life"),
        }),
      );
      try {
        const observed = await Sandbox.getInfo(renewable.sandboxId, options);
        console.error(
          JSON.stringify({
            proof,
            stage: "failure-state",
            state: observed.state,
            endAt: observed.endAt,
          }),
        );
      } catch {
        console.error(JSON.stringify({ proof, stage: "failure-state", unavailable: true }));
      }
      try {
        const healthy = await renewable.isRunning({ requestTimeoutMs: 5_000 });
        console.error(JSON.stringify({ proof, stage: "failure-health", healthy }));
      } catch {
        console.error(JSON.stringify({ proof, stage: "failure-health", unavailable: true }));
      }
      throw error;
    }
    NodeAssert.equal(response.exitCode, 0);
    const current = JSON.parse(response.stdout) as NonNullable<typeof identity>;
    NodeAssert.equal(current.token, token);
    NodeAssert.equal(current.pid, worker.pid);
    if (identity) {
      NodeAssert.equal(current.start, identity.start);
      NodeAssert.equal(current.boot, identity.boot);
      NodeAssert.ok(
        requireAdvance ? current.tick > identity.tick : current.tick >= identity.tick,
        "The original process must still advance",
      );
    }
    identity = current;
  }
  const readyUntil = Date.now() + 15_000;
  while (!(await renewable.files.exists("/tmp/lifetime-proof.json"))) {
    NodeAssert.ok(Date.now() < readyUntil, "Background process did not become ready");
    await wait(100);
  }
  await verifyProcess();
  await hostStage("start-keeper", {
    renewable: renewable.sandboxId,
    ordinary: ordinary.sandboxId,
    initialEndAt: initial.endAt.toISOString(),
  });
  const renewedUntil = Date.now() + 90_000;
  let info = await Sandbox.getInfo(renewable.sandboxId, options);
  while (info.endAt <= initial.endAt) {
    NodeAssert.ok(Date.now() < renewedUntil, "Independent host keeper did not extend the lease");
    await wait(1_000);
    info = await Sandbox.getInfo(renewable.sandboxId, options);
  }
  await hostStage("restart-services", {
    renewable: renewable.sandboxId,
    activeLease: info.endAt.toISOString(),
  });
  await verifyProcess();
  checkpointRequested = true;
  await renewable.createSnapshot({ name: checkpointName });
  await verifyProcess();
  const boundary =
    Math.max(initial.startedAt.getTime(), ordinaryInfo.startedAt.getTime()) + maxHours * 3_600_000;
  console.log(
    JSON.stringify({
      proof,
      stage: "crossing-original-lifetime",
      renewable: renewable.sandboxId,
      ordinary: ordinary.sandboxId,
      boundary: new Date(boundary).toISOString(),
    }),
  );
  // Wait for the actual deadline crossing, verifying progress and finite leases
  // along the way. The relay is never started by this proof.
  while (Date.now() <= boundary + 5_000) {
    await wait(Math.min(30_000, Math.max(1_000, boundary + 5_001 - Date.now())));
    await verifyProcess(true);
    info = await Sandbox.getInfo(renewable.sandboxId, options);
    NodeAssert.equal(info.state, "running");
    NodeAssert.ok(info.endAt.getTime() > Date.now(), "Keeper failed to retain a finite live lease");
  }
  await verifyProcess();
  const expiryDeadline = Date.now() + 120_000;
  while (true) {
    try {
      await absent(ordinary.sandboxId);
      break;
    } catch (error) {
      NodeAssert.ok(Date.now() < expiryDeadline, "The ordinary bounded VM did not expire");
      if (!(error instanceof Error && error.message.includes("is still present"))) throw error;
      await wait(1_000);
    }
  }
  await Sandbox.pause(renewable.sandboxId, options);
  NodeAssert.equal((await Sandbox.getInfo(renewable.sandboxId, options)).state, "paused");
  // Controller forces a completed keeper sweep and verifies the host registry
  // and route are absent. Inspection itself must not wake this paused VM.
  await hostStage("paused-sweep", { renewable: renewable.sandboxId });
  NodeAssert.equal((await Sandbox.getInfo(renewable.sandboxId, options)).state, "paused");
  await remove(renewable.sandboxId);
  await hostStage("deleted-sweep", { renewable: renewable.sandboxId });
  await absent(renewable.sandboxId);
  console.log(JSON.stringify({ proof, passed: true, processIdentity: identity }));
} catch (error) {
  errors.push(error);
  if (error instanceof Error)
    console.error(
      JSON.stringify({
        name: error.name,
        callsite: error.stack
          ?.split("\n")
          .filter((line) => line.includes("/app/lifetime-proof.ts")),
      }),
    );
  if (error instanceof NodeAssert.AssertionError) console.error(error.message);
} finally {
  // Find creations with lost replies too. Every test allocation bears this ID.
  try {
    const pages = Sandbox.list({
      ...options,
      query: { state: ["running", "paused"], metadata: { "launchpad.proof": proof } },
    });
    while (pages.hasNext)
      for (const vm of await pages.nextItems()) {
        try {
          await remove(vm.sandboxId);
        } catch (error) {
          errors.push(error);
        }
      }
  } catch (error) {
    errors.push(error);
  }
  if (checkpointRequested) {
    try {
      await Sandbox.deleteSnapshot(checkpointName, options);
    } catch (error) {
      errors.push(error);
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(gate!, "finished.json"),
    JSON.stringify({ proof, passed: errors.length === 0 }),
  );
}
// Transport errors can contain credentials. Leave IDs and explicit stages in the
// log, not raw SDK errors. A failed proof remains a nonzero result.
if (errors.length) {
  console.error(JSON.stringify({ proof, passed: false, failures: errors.length }));
  process.exitCode = 1;
}
