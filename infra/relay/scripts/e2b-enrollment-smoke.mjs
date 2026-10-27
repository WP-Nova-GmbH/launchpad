import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { Sandbox, Template } from "e2b";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { makeE2BThreadVmCompute } from "../src/machines/E2BThreadVmCompute.ts";
import { inspectE2BThreadVmIngress } from "../src/machines/E2BThreadVmConnection.ts";
import { makeE2BThreadVmEnrollment } from "../src/machines/E2BThreadVmEnrollment.ts";

const { values } = NodeUtil.parseArgs({
  options: { receipt: { type: "string" }, output: { type: "string" } },
});
NodeAssert.ok(values.receipt && values.output);
NodeAssert.ok(
  process.env.E2B_API_URL && process.env.E2B_SANDBOX_URL && process.env.E2B_API_KEY_FILE,
);
const options = {
  apiUrl: process.env.E2B_API_URL,
  sandboxUrl: process.env.E2B_SANDBOX_URL,
  apiKey: (await NodeFSP.readFile(process.env.E2B_API_KEY_FILE, "utf8")).trim(),
};
const receipt = JSON.parse(await NodeFSP.readFile(values.receipt, "utf8"));
NodeAssert.equal(receipt.state, "built");
NodeAssert.equal(new URL(receipt.apiUrl).href, new URL(options.apiUrl).href);
NodeAssert.equal(receipt.templateRef, `${receipt.templateId}:${receipt.buildTag}`);
NodeAssert.ok(
  (await Template.getTags(receipt.templateId, options)).some(
    (tag) => tag.tag === receipt.buildTag && tag.buildId === receipt.buildId,
  ),
);
await NodeFSP.mkdir(values.output, { mode: 0o700 });
const operationId = NodeCrypto.randomUUID();
const scope = {
  allocationId: NodeCrypto.randomUUID(),
  threadId: NodeCrypto.randomUUID(),
  repositoryId: NodeCrypto.randomUUID(),
  generation: 2,
};
const settings = {
  ...options,
  apiKey: Redacted.make(options.apiKey),
  templateId: receipt.templateRef,
  timeoutMs: 600000,
  hostAddresses: [],
};
const compute = makeE2BThreadVmCompute(settings);
const save = (name, result) =>
  NodeFSP.writeFile(NodePath.join(values.output, name), JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
await save("identity.json", { operationId, scope, templateRef: receipt.templateRef });
let sandboxId;
let stage = "create";
let diagnosticVm;
try {
  ({ sandboxId } = await Effect.runPromise(
    compute.create({ ...scope, operationId, environment: {} }),
  ));
  await save("allocation.json", { sandboxId, operationId });
  const response = await fetch(`${options.apiUrl}/sandboxes/${sandboxId}`, {
    headers: { "X-API-Key": options.apiKey },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  NodeAssert.equal(response.status, 200);
  const info = await response.json();
  await save("connection.json", {
    state: info.state,
    templateID: info.templateID,
    envdVersion: info.envdVersion,
    lifecycle: info.lifecycle,
    secure: Boolean(info.envdAccessToken),
    metadata: info.metadata,
  });
  const vm = new Sandbox({
    ...options,
    sandboxId,
    envdVersion: info.envdVersion,
    envdAccessToken: info.envdAccessToken,
    ...(info.domain ? { sandboxDomain: info.domain } : {}),
  });
  diagnosticVm = vm;
  stage = "fixture";
  const origin = "http://127.0.0.1:47639";
  const seed = NodeCrypto.randomUUID();
  // Only dummy enrollment data enters this fixture. The real relay transaction
  // and owner-access checks are covered by the database integration tests.
  const fixture = `
import http from 'node:http'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
const scope=${JSON.stringify(scope)}, operationId=${JSON.stringify(operationId)}, seed=${JSON.stringify(seed)}, origin=${JSON.stringify(origin)};
const identities=[];
http.createServer(async(req,res)=>{
 try {
  if(req.url==='/stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({requests:identities.length,sameIdentity:identities.every(i=>i===identities[0])}));return;}
  assert.equal(req.url,'/v1/thread-vms/enroll');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const {proof}=JSON.parse(Buffer.concat(chunks)); const [header,body,signature]=proof.split('.');
  const h=JSON.parse(Buffer.from(header,'base64url')), p=JSON.parse(Buffer.from(body,'base64url'));
  assert.equal(h.alg,'EdDSA');assert.equal(h.typ,'launchpad-thread-vm-enroll+jwt');
  assert(crypto.verify(null,Buffer.from(header+'.'+body),p.environmentPublicKey,Buffer.from(signature,'base64url')));
  assert.equal(p.seed,seed);assert.equal(p.operationId,operationId);assert.equal(p.allocationId,scope.allocationId);
  assert.equal(p.aud,origin);assert.equal(p.iss,'t3-env:'+p.environmentId);assert(p.exp>Date.now()/1000);
  identities.push(p.environmentId+'|'+p.environmentPublicKey);
  if(identities.length===1){req.socket.destroy();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environmentId:p.environmentId,scope,relayIssuer:origin,cloudMintPublicKey:'fixture-public-key',environmentCredential:'fixture-credential'}));
 }catch{res.statusCode=400;res.end('{}');}
}).listen(47639,'127.0.0.1',()=>{
 http.createServer((_req,res)=>res.end('private-preview-proof')).listen(4080,'0.0.0.0',()=>console.log('fixture-ready'));
});
`;
  await vm.files.write("/tmp/launchpad-enrollment-fixture.mjs", fixture);
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  await vm.commands.run("node /tmp/launchpad-enrollment-fixture.mjs", {
    user: "user",
    background: true,
    timeoutMs: 600000,
    onStdout: (text) => {
      if (text.includes("fixture-ready")) readyResolve();
    },
  });
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture did not become ready")), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const bootstrap = {
    version: 1,
    operationId,
    scope,
    relayUrl: origin,
    relayIssuer: origin,
    seed: Redacted.make(seed),
  };
  const methods = [];
  const enroll = makeE2BThreadVmEnrollment(settings, (url, init) => {
    methods.push(init?.method ?? "GET");
    return fetch(url, init);
  });
  stage = "lost-reply";
  NodeAssert.equal(
    (await Effect.runPromise(Effect.result(enroll(sandboxId, bootstrap))))._tag,
    "Failure",
  );
  stage = "retry";
  const enrolled = await Effect.runPromise(enroll(sandboxId, bootstrap));
  NodeAssert.deepEqual(await Effect.runPromise(enroll(sandboxId, bootstrap)), enrolled);
  const stats = JSON.parse(
    (
      await vm.commands.run("curl --fail --silent http://127.0.0.1:47639/stats", {
        user: "user",
        timeoutMs: 30000,
      })
    ).stdout,
  );
  NodeAssert.deepEqual(stats, { requests: 2, sameIdentity: true });
  stage = "private-ingress";
  const ingress = await inspectE2BThreadVmIngress(
    settings,
    sandboxId,
    { scope, operationId },
    fetch,
    AbortSignal.timeout(30000),
  );
  const preview = (token) =>
    fetch(options.sandboxUrl, {
      headers: {
        "E2b-Sandbox-Id": sandboxId,
        "E2b-Sandbox-Port": "4080",
        ...(token ? { "e2b-traffic-access-token": token } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  for (const token of [undefined, "invalid-proof-token"]) {
    const denied = await preview(token);
    NodeAssert.equal(denied.ok, false, "Private preview admitted an unauthenticated request");
    await denied.body?.cancel();
  }
  const allowed = await preview(Redacted.value(ingress.trafficAccessToken));
  NodeAssert.equal(allowed.status, 200);
  NodeAssert.equal(await allowed.text(), "private-preview-proof");
  stage = "pause";
  await Effect.runPromise(compute.pause(sandboxId));
  stage = "paused-read";
  NodeAssert.equal(
    (await Effect.runPromise(Effect.result(enroll(sandboxId, bootstrap))))._tag,
    "Failure",
  );
  NodeAssert.equal((await Effect.runPromise(compute.inspect(sandboxId))).state, "paused");
  const pausedResponse = await fetch(`${options.apiUrl}/sandboxes/${sandboxId}`, {
    headers: { "X-API-Key": options.apiKey },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  NodeAssert.equal(pausedResponse.status, 200);
  const paused = await pausedResponse.json();
  NodeAssert.equal(paused.state, "paused");
  NodeAssert.equal(paused.trafficAccessToken, undefined);
  const pausedPreview = await preview(Redacted.value(ingress.trafficAccessToken));
  NodeAssert.equal(pausedPreview.ok, false, "A private preview woke a paused VM");
  await pausedPreview.body?.cancel();
  NodeAssert.equal((await Effect.runPromise(compute.inspect(sandboxId))).state, "paused");
  NodeAssert.deepEqual(methods, ["GET", "GET", "GET", "GET"]);
  await save("result.json", {
    sandboxId,
    deliveredThroughEnvd: true,
    signatureVerified: true,
    lostReplyRecovered: true,
    idempotentRetry: true,
    pausedVmStayedPaused: true,
    privateIngressReadOnly: true,
    privatePreviewRequiresToken: true,
    pausedInspectionOmitsToken: true,
    previewDoesNotWake: true,
    managementKeyAbsentFromGuestPayload: !fixture.includes(options.apiKey),
  });
  console.log("Actual E2B enrollment delivery, retry and non-waking checks passed.");
} catch (error) {
  await save("failure.json", {
    stage,
    errorType: error?.name ?? "Error",
    operation: error?.operation,
  });
  if (diagnosticVm && stage !== "paused-read") {
    try {
      const stats = await diagnosticVm.commands.run(
        "curl --fail --silent http://127.0.0.1:47639/stats",
        { user: "user", timeoutMs: 10000 },
      );
      await save("fixture-stats.json", JSON.parse(stats.stdout));
    } catch {
      /* The guest may already be paused or unavailable. */
    }
  }
  console.error(`Enrollment delivery proof failed (${error?.name ?? "Error"}).`);
  process.exitCode = 1;
} finally {
  try {
    const ids = new Set(sandboxId ? [sandboxId] : []);
    for (const vm of await Effect.runPromise(compute.findOperation(operationId)))
      ids.add(vm.sandboxId);
    NodeAssert.ok(ids.size > 0, "Unknown create outcome requires reconciliation");
    for (const id of ids) await Effect.runPromise(compute.destroy(id));
    await save("cleanup.json", { physicallyStopped: true, operationId });
  } catch {
    await save("cleanup.json", { physicallyStopped: false, operationId });
    console.error("Enrollment proof cleanup requires reconciliation using its saved operation.");
    process.exitCode = 1;
  }
}
