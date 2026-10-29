import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import { Sandbox, SandboxNotFoundError, Template } from "e2b";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";

const { values } = NodeUtil.parseArgs({
  options: {
    receipt: { type: "string" },
    output: { type: "string" },
    replay: { type: "boolean", default: false },
  },
});
NodeAssert.ok(values.output && (values.replay || values.receipt));
NodeAssert.ok(
  process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL && process.env.E2B_API_KEY_FILE,
);
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey: (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim(),
  requestTimeoutMs: 30000,
  retries: 0,
};
const save = (name, data) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
const stop = async (sandboxId, proof) => {
  const current = await Sandbox.getInfo(sandboxId, options).catch((error) => {
    if (error instanceof SandboxNotFoundError) return null;
    throw error;
  });
  if (current)
    NodeAssert.equal(current.metadata["launchpad.proof"], proof, "Cleanup identity differs");
  await Sandbox.kill(sandboxId, options);
  return { sandboxId, kind: "native-delete-acknowledgement", acknowledged: true };
};

if (values.replay) {
  const allocation = JSON.parse(
    await NodeFSP.readFile(NodePath.join(values.output, "allocation.json"), "utf8"),
  );
  await save("replay.json", await stop(allocation.sandboxId, allocation.proof));
  console.log("Native DELETE for the saved identity acknowledged.");
} else {
  const template = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
  NodeAssert.equal(template.state, "built");
  NodeAssert.equal(new URL(template.apiUrl).href, new URL(options.apiUrl).href);
  NodeAssert.equal(template.templateRef, `${template.templateId}:${template.buildTag}`);
  const tags = await Template.getTags(template.templateId, options);
  NodeAssert.ok(
    tags.some((tag) => tag.tag === template.buildTag && tag.buildId === template.buildId),
  );
  await NodeFSP.mkdir(values.output, { mode: 0o700 });
  const proof = `launchpad-stop-${NodeCrypto.randomUUID()}`;
  await save("identity.json", { proof, templateRef: template.templateRef });
  let sandboxId;
  try {
    const vm = await Sandbox.create(template.templateRef, {
      ...options,
      timeoutMs: 600000,
      secure: true,
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: { action: "kill" }, autoResume: false },
      metadata: threadVmSmokeMetadata(proof),
    });
    sandboxId = vm.sandboxId;
    await save("allocation.json", { proof, sandboxId });
    const result = await vm.commands.run(
      "nohup sleep 600 >/tmp/launchpad-stop-child.log 2>&1 </dev/null & echo ready",
      {
        user: "user",
        timeoutMs: 30000,
      },
    );
    NodeAssert.equal(result.stdout.trim(), "ready");
    await save("stop.json", await stop(sandboxId, proof));
    await save("replay.json", await stop(sandboxId, proof));
    console.log("Native DELETE and repeated request acknowledged for the exact VM.");
  } catch (error) {
    // SDK exceptions can contain authorization headers; persist only their type.
    await save("failure.json", { proof, errorType: error?.name ?? "Error" });
    console.error(`Native delete proof failed (${error?.name ?? "Error"}).`);
    process.exitCode = 1;
  } finally {
    try {
      const identities = new Set(sandboxId ? [sandboxId] : []);
      const page = Sandbox.list({ ...options, query: { metadata: { "launchpad.proof": proof } } });
      while (page.hasNext) for (const vm of await page.nextItems()) identities.add(vm.sandboxId);
      NodeAssert.ok(
        identities.size > 0,
        "Creation outcome is unknown; reconcile by saved proof identity.",
      );
      for (const id of identities) await stop(id, proof);
      await save("cleanup.json", {
        proof,
        sandboxIds: [...identities],
        nativeDeleteAcknowledged: true,
      });
    } catch (error) {
      await save("cleanup.json", {
        proof,
        nativeDeleteAcknowledged: false,
        errorType: error?.name ?? "Error",
      });
      console.error("Cleanup is unconfirmed; reconcile using the saved proof identity.");
      process.exitCode = 1;
    }
  }
}
