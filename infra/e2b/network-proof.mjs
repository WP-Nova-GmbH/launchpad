import { Sandbox, SandboxNotFoundError } from "e2b";
import * as NodeFSP from "node:fs/promises";
import * as NodeAssert from "node:assert/strict";
const options = {
  apiUrl: process.env.LAUNCHPAD_PROOF_API_URL,
  sandboxUrl: process.env.LAUNCHPAD_PROOF_PROXY_URL,
  apiKey: (await NodeFSP.readFile("/run/e2b/team-api-key", "utf8")).trim(),
  requestTimeoutMs: 30000,
};
const proof = process.env.LAUNCHPAD_PROOF_ID;
NodeAssert.ok(proof?.startsWith("launchpad-network-"));
NodeAssert.ok(options.apiUrl && options.sandboxUrl);
const create = () =>
  Sandbox.create("base", {
    ...options,
    timeoutMs: 600000,
    secure: true,
    lifecycle: { onTimeout: "kill", autoResume: false },
    network: { allowPublicTraffic: false },
    metadata: { "launchpad.proof": proof },
  });
const cleanup = async () => {
  const page = Sandbox.list({
    ...options,
    query: { state: ["running", "paused"], metadata: { "launchpad.proof": proof } },
  });
  while (page.hasNext)
    for (const vm of await page.nextItems()) {
      await Sandbox.kill(vm.sandboxId, options);
      try {
        await Sandbox.getInfo(vm.sandboxId, options);
        throw Error("still present");
      } catch (e) {
        if (!(e instanceof SandboxNotFoundError)) throw e;
      }
    }
  console.log(JSON.stringify({ proof, cleaned: true }));
};
try {
  if (!process.argv.includes("--cleanup")) {
    const peer = await create();
    const guest = await create();
    await peer.commands.run(
      `python3 - <<'PYTHON'
import http.server,os
server=http.server.ThreadingHTTPServer(('0.0.0.0',18374),http.server.SimpleHTTPRequestHandler)
if os.fork()==0:
 os.setsid()
 null=os.open('/dev/null',os.O_RDWR)
 for fd in (0,1,2):os.dup2(null,fd)
 server.serve_forever()
else: print('listener-ready')
PYTHON`,
      { user: "root", timeoutMs: 15000 },
    );
    await peer.commands.run(
      "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',18374),5); s.close()\"",
      { user: "root" },
    );
    await NodeFSP.writeFile(
      "/probe/created.json",
      JSON.stringify({ proof, peer: peer.sandboxId, guest: guest.sandboxId }),
    );
    let config;
    const deadline = Date.now() + 90000;
    while (!config) {
      try {
        config = JSON.parse(await NodeFSP.readFile("/probe/host.json", "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        NodeAssert.ok(Date.now() < deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    NodeAssert.equal(config.proof, proof);
    if (config.error) throw Error(config.error);
    // Firecracker handles MMDS inside the VM, before packets reach the host.
    // It must contain only this VM's bootstrap identity, never host/cloud credentials.
    const python = `import json,socket,urllib.request,subprocess,os
assert os.getuid()==0
assert urllib.request.urlopen('https://example.com',timeout=15).status==200
subprocess.run(['ip','-6','addr','add','fd42:3::2/64','dev','eth0'],check=True)
subprocess.run(['ip','-6','route','replace','default','via','fd42:3::1','dev','eth0'],check=True)
with open('/etc/hosts','a') as f:f.write('\\n${config.publicHost} host-probe.invalid\\n${config.peerAddress} peer-probe.invalid\\n')
results=[]
for host,port in [('${config.publicHost}',18373),('host-probe.invalid',18373),('${config.peerAddress}',18374),('peer-probe.invalid',18374),('192.0.2.1',3000),('169.254.169.254',3000),('fd42:1::1',18375)]:
 try:
  s=socket.create_connection((host,port),2);s.close(); reachable=True
 except OSError:reachable=False
 results.append(dict(host=host,port=port,reachable=reachable))
print(json.dumps(results))
request=urllib.request.Request('http://169.254.169.254/latest/api/token',method='PUT',headers={'X-metadata-token-ttl-seconds':'60'})
with urllib.request.urlopen(request,timeout=3) as response:token=response.read().decode()
request=urllib.request.Request('http://169.254.169.254/',headers={'X-metadata-token':token,'Accept':'application/json'})
with urllib.request.urlopen(request,timeout=3) as response:metadata=json.load(response)
assert metadata['instanceID']=='${guest.sandboxId}'
assert set(metadata)<=set(['instanceID','envID','address','accessTokenHash'])
assert metadata.get('accessTokenHash')
assert not any(x['reachable'] for x in results)
`;
    const result = await guest.commands.run(`python3 - <<'PY'\n${python}\nPY`, {
      user: "root",
      timeoutMs: 60000,
    });
    const connections = JSON.parse(result.stdout.trim());
    const preview = await fetch(options.sandboxUrl, {
      headers: { "E2b-Sandbox-Id": peer.sandboxId, "E2b-Sandbox-Port": "18374" },
      signal: AbortSignal.timeout(15000),
    });
    NodeAssert.ok(
      [401, 403].includes(preview.status),
      "private preview allowed unauthenticated traffic: " + preview.status,
    );
    await preview.body?.cancel();
    NodeAssert.ok(peer.trafficAccessToken, "missing private preview token");
    const allowed = await fetch(options.sandboxUrl, {
      headers: {
        "E2b-Sandbox-Id": peer.sandboxId,
        "E2b-Sandbox-Port": "18374",
        "e2b-traffic-access-token": peer.trafficAccessToken,
      },
      signal: AbortSignal.timeout(15000),
    });
    NodeAssert.equal(allowed.status, 200, "authenticated preview control failed");
    await allowed.body?.cancel();
    console.log(
      JSON.stringify({ proof, connections, privatePreviewStatus: preview.status, passed: true }),
    );
    await NodeFSP.writeFile(
      "/probe/result.json",
      JSON.stringify({ proof, connections, privatePreviewStatus: preview.status, passed: true }),
    );
  }
} catch (e) {
  console.error(
    JSON.stringify({ name: e?.name, message: e?.message, stdout: e?.stdout, stderr: e?.stderr }),
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
