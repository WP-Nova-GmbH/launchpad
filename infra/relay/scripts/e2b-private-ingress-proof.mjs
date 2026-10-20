import { threadVmSmokeMetadata } from "./e2b-smoke-metadata.ts";
import { Sandbox } from "e2b";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: { receipt: { type: "string" }, output: { type: "string" } },
});
NodeAssert.ok(
  values.receipt && values.output,
  "Provide a template receipt and a new output directory.",
);
NodeAssert.ok(
  process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL && process.env.E2B_API_KEY_FILE,
);
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey: (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim(),
  requestTimeoutMs: 30_000,
};
const receipt = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
NodeAssert.equal(receipt.state, "built");
NodeAssert.equal(new URL(receipt.apiUrl).origin, new URL(options.apiUrl).origin);
NodeAssert.equal(receipt.templateRef, `${receipt.templateId}:${receipt.buildTag}`);
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const proof = `launchpad-private-ingress-${NodeCrypto.randomUUID()}`;
const save = (name, data) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(data) + "\n", {
    mode: 0o600,
  });
const control = (path, init = {}) =>
  fetch(options.apiUrl + path, {
    ...init,
    headers: { "X-API-Key": options.apiKey, ...init.headers },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
await save("identity.json", { proof, templateRef: receipt.templateRef, buildId: receipt.buildId });
let sandboxId,
  creationAttempted = false;
try {
  const capabilityResponse = await control("/extensions/launchpad/v1/capabilities");
  NodeAssert.equal(capabilityResponse.status, 200);
  const capabilities = await capabilityResponse.json();
  NodeAssert.equal(capabilities.version, 1);
  NodeAssert.equal(capabilities.privatePreviewHeaderBoundary, true);
  creationAttempted = true;
  const vm = await Sandbox.create(receipt.templateRef, {
    ...options,
    secure: true,
    timeoutMs: 600_000,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    metadata: threadVmSmokeMetadata(proof),
  });
  sandboxId = vm.sandboxId;
  await save("allocation.json", { proof, sandboxId });
  const app = `import http.server,json,os
class App(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  headers={k.lower():v for k,v in self.headers.items()}
  data=json.dumps(headers).encode(); self.send_response(200); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def log_message(self,*args): pass
server=http.server.HTTPServer(('0.0.0.0',4080),App)
os.write(int(os.environ['READY_FD']),b'READY\\n'); os.close(int(os.environ['READY_FD']))
server.serve_forever()`;
  const launcher = `import os,subprocess
read,write=os.pipe()
p=subprocess.Popen(['python3','-u','-c',${JSON.stringify(app)}],env={**os.environ,'READY_FD':str(write)},pass_fds=(write,),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
os.close(write)
with os.fdopen(read) as stream: assert stream.readline()=='READY\\n'
print('Application ready')`;
  const started = await vm.commands.run(`python3 - <<'START_APP'\n${launcher}\nSTART_APP`, {
    user: "user",
    timeoutMs: 30_000,
  });
  NodeAssert.equal(started.stdout.trim(), "Application ready");
  const infoResponse = await control(`/sandboxes/${encodeURIComponent(sandboxId)}`);
  NodeAssert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  NodeAssert.equal(info.sandboxID, sandboxId);
  NodeAssert.equal(info.state, "running");
  NodeAssert.equal(info.network.allowPublicTraffic, false);
  NodeAssert.ok(info.trafficAccessToken);
  const request = (token) =>
    fetch(new URL("/credential-boundary?proof=1", options.sandboxUrl), {
      headers: {
        "E2b-Sandbox-Id": sandboxId,
        "E2b-Sandbox-Port": "4080",
        ...(token ? { "e2b-traffic-access-token": token } : {}),
        authorization: "Bearer application-only",
        cookie: "app_session=application-cookie",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  for (const token of [undefined, "invalid-edge-token"]) {
    const denied = await request(token);
    NodeAssert.ok([401, 403, 404].includes(denied.status));
    await denied.body?.cancel();
  }
  const response = await request(info.trafficAccessToken);
  NodeAssert.equal(response.status, 200);
  const seen = await response.json();
  for (const name of ["e2b-traffic-access-token", "e2b-sandbox-id", "e2b-sandbox-port"])
    NodeAssert.equal(seen[name], undefined);
  NodeAssert.equal(seen.authorization, "Bearer application-only");
  NodeAssert.equal(seen.cookie, "app_session=application-cookie");
  // An envd call also verifies that stripping application headers did not break guest control.
  const envd = await vm.commands.run("printf envd-ok", { user: "user", timeoutMs: 30_000 });
  NodeAssert.equal(envd.stdout, "envd-ok");
  await save("result.json", {
    proof,
    sandboxId,
    anonymousDenied: true,
    invalidTokenDenied: true,
    applicationRoutingHeadersAbsent: true,
    applicationCredentialsPreserved: true,
    envdAccessible: true,
  });
  console.log(
    "PASS: private guest ingress rejects anonymous access and strips routing credentials before application delivery.",
  );
} catch (error) {
  // SDK/HTTP assertion errors can contain credentials. Persist only the opaque error type.
  await save("failure.json", { proof, errorType: error?.name ?? "Error" });
  console.error("Private ingress proof failed; check its isolated host state.");
  process.exitCode = 1;
} finally {
  try {
    const ids = new Set(sandboxId ? [sandboxId] : []);
    const page = Sandbox.list({
      ...options,
      query: { state: ["running", "paused"], metadata: { "launchpad.proof": proof } },
    });
    while (page.hasNext) for (const vm of await page.nextItems()) ids.add(vm.sandboxId);
    // An absent list after an unknown create does not prove physical absence.
    // Preserve the request identity for reconciliation instead of claiming cleanup.
    if (creationAttempted) NodeAssert.ok(ids.size > 0);
    for (const id of ids) {
      const stoppedResponse = await control(
        `/extensions/launchpad/v1/executions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      NodeAssert.equal(stoppedResponse.status, 200);
      const stopped = await stoppedResponse.json();
      NodeAssert.equal(stopped.sandboxID, id);
      NodeAssert.equal(stopped.physicallyStopped, true);
    }
    await save("cleanup.json", {
      proof,
      physicalStopVerified: ids.size > 0,
      sandboxCount: ids.size,
    });
  } catch (error) {
    await save("cleanup.json", {
      proof,
      physicalStopVerified: false,
      errorType: error?.name ?? "Error",
    });
    console.error("Private ingress proof cleanup needs reconciliation using its saved identity.");
    process.exitCode = 1;
  }
}
