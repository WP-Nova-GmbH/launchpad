// @effect-diagnostics nodeBuiltinImport:off globalConsole:off cryptoRandomUUID:off - Runs in the upstream E2B SDK container without an Effect runtime.
import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import { Sandbox, SandboxNotFoundError, Template } from "e2b";

// Opt-in destructive test of disposable resources only. The enabled service is
// deliberately never started at the source: its marker reveals early execution
// by a purportedly quarantined restore, including during template construction.
const apiUrl = process.env.E2B_API_URL;
const sandboxUrl = process.env.E2B_SANDBOX_URL;
NodeAssert.ok(apiUrl && sandboxUrl, "Explicit self-hosted E2B endpoints are required.");
const keyFile = process.env.E2B_API_KEY_FILE;
NodeAssert.ok(keyFile, "Set E2B_API_KEY_FILE to the host's management key file.");
const apiKey = (await NodeFSP.readFile(keyFile, "utf8")).trim();
NodeAssert.ok(apiKey, "The E2B management key is empty.");
const options = { apiUrl, sandboxUrl, apiKey, requestTimeoutMs: 60_000 };
const name = `launchpad-restore-proof-${crypto.randomUUID()}`;
const snapshotName = `${name}-disk`;
let source: Sandbox | undefined;
let restored: Sandbox | undefined;
let snapshotId: string | undefined;
let buildRequested = false;
let snapshotRequested = false;
const errors: unknown[] = [];

async function removeVm(sandboxId: string) {
  await Sandbox.kill(sandboxId, options);
  try {
    await Sandbox.getInfo(sandboxId, options);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return;
    throw error;
  }
  throw new Error(`Cleanup could not confirm deletion of ${sandboxId}`);
}

try {
  source = await Sandbox.create("base", {
    ...options,
    timeoutMs: 10 * 60_000,
    secure: true,
    metadata: threadVmSmokeMetadata(name),
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "pause", autoResume: false },
  });
  await source.files.write(
    "/tmp/launchpad-startup-probe.service",
    `[Unit]
Description=Launchpad restore safety canary
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c "echo unexpectedly-started >> /home/user/launchpad-startup-canary"
[Install]
WantedBy=multi-user.target
`,
  );
  await source.commands.run(
    "cp /tmp/launchpad-startup-probe.service /etc/systemd/system/launchpad-startup-probe.service && " +
      "systemctl enable launchpad-startup-probe.service && " +
      "test ! -e /home/user/launchpad-startup-canary && " +
      "printf preserved > /home/user/launchpad-disk-canary && sync",
    { user: "root" },
  );
  // A unique name lets cleanup find a snapshot even if the creation reply is lost.
  snapshotRequested = true;
  snapshotId = (await source.createSnapshot({ name: snapshotName })).snapshotId;
  // Saving/verification must leave the original VM's credentials usable.
  NodeAssert.equal(await source.files.read("/home/user/launchpad-disk-canary"), "preserved");
  await removeVm(source.sandboxId);
  source = undefined;

  buildRequested = true;
  await Template.build(Template().fromTemplate(snapshotId).runCmd("true"), name, {
    ...options,
    cpuCount: 2,
    memoryMB: 512,
  });
  restored = await Sandbox.create(name, {
    ...options,
    timeoutMs: 120_000,
    metadata: { "launchpad.proof": name },
    network: { allowPublicTraffic: false },
  });
  NodeAssert.equal(await restored.files.read("/home/user/launchpad-disk-canary"), "preserved");
  const earlyStart = await restored.files.exists("/home/user/launchpad-startup-canary");
  NodeAssert.equal(
    earlyStart,
    false,
    "Restore is unsafe: a saved systemd service executed before ownership activation. Keep automatic deletion disabled.",
  );
  console.log("Independent disk recovery passed without running the saved startup service.");
} catch (error) {
  errors.push(error);
} finally {
  // Attempt every cleanup even if an earlier one fails. A cleanup error keeps
  // the script failed rather than claiming its disposable resources are gone.
  for (const clean of [
    () => (source ? removeVm(source.sandboxId) : undefined),
    () => (restored ? removeVm(restored.sandboxId) : undefined),
    async () => {
      // Creation may have succeeded even if its reply was lost.
      const pages = Sandbox.list({ ...options, query: { metadata: { "launchpad.proof": name } } });
      while (pages.hasNext) {
        for (const vm of await pages.nextItems()) {
          try {
            await removeVm(vm.sandboxId);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    },
    () => (snapshotRequested ? Sandbox.deleteSnapshot(snapshotName, options) : undefined),
    () => (buildRequested ? Sandbox.deleteSnapshot(name, options) : undefined),
  ]) {
    try {
      await clean();
    } catch (error) {
      errors.push(error);
    }
  }
  console.log(`Restore proof cleanup attempted for ${name}; failures remain fatal.`);
}
if (errors.length) throw new AggregateError(errors, `Restore proof failed; resource tag: ${name}`);
