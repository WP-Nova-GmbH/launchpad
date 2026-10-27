import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { build } from "vite";
import * as Effect from "effect/Effect";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
const platform = Effect.runSync(HostProcessPlatform);
const architecture = Effect.runSync(HostProcessArchitecture);
// Run with the relay's installed dependencies; no browser or external service is used.
const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const alchemy = NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("alchemy")));
const runtimeRequire = NodeModule.createRequire(
  await NodeFSP.realpath(
    NodePath.resolve(alchemy, "../../@alchemy.run/cloudflare-runtime/dist/core/node/index.mjs"),
  ),
);
const workerdRequire = NodeModule.createRequire(runtimeRequire.resolve("workerd/package.json"));
const binary = workerdRequire.resolve(
  "@cloudflare/workerd-" +
    platform +
    "-" +
    (architecture === "x64" ? "64" : architecture) +
    "/bin/workerd",
);
const { WebSocket } = NodeModule.createRequire(
  import.meta.resolve("@effect/platform-node/NodeSocket"),
)("ws");
const effect = NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("effect/Effect")));
const output = process.argv[2];
NodeAssert.ok(
  output && NodePath.isAbsolute(output) && process.argv.length === 3,
  "Provide one new absolute output directory.",
);
const dir = output;
await NodeFSP.mkdir(dir, { mode: 0o700 });
let accessRevoked = false;
const continuedChecks = Promise.withResolvers();
let checks = 0;
const authServer = NodeHttp.createServer((request, response) => {
  if (++checks >= 350) continuedChecks.resolve();
  response.writeHead(accessRevoked ? 403 : 204);
  response.end();
});
let child, exited, deadline, client;
let out = "",
  err = "";
try {
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  const authPort = authServer.address().port;
  const source = `
import { WorkerExecutionContext, fromExecutionContext } from ${JSON.stringify(alchemy + "/Cloudflare/Workers/WorkerRuntime.js")};
import * as Effect from ${JSON.stringify(effect + "/Effect.js")};
import * as ManagedRuntime from ${JSON.stringify(effect + "/ManagedRuntime.js")};
import * as Schedule from ${JSON.stringify(effect + "/Schedule.js")};
import * as HttpServerRequest from ${JSON.stringify(effect + "/unstable/http/HttpServerRequest.js")};
import * as HttpServerResponse from ${JSON.stringify(effect + "/unstable/http/HttpServerResponse.js")};
import { threadVmPreviewCloudflare } from ${JSON.stringify(root + "/infra/relay/src/http/ThreadVmPreviewCloudflare.ts")};
import { ThreadVmPreviewWebSocket } from ${JSON.stringify(root + "/infra/relay/src/http/ThreadVmPreviewWebSocket.ts")};
import { ThreadVmPreviewDenied } from ${JSON.stringify(root + "/infra/relay/src/threads/ThreadVmPreviewStore.ts")};
const runtime=ManagedRuntime.make(threadVmPreviewCloudflare);
let upstreamClosed=false, upstreamProtocol=false, routingHeaders=false;
export default { async fetch(request,env,ctx) {
 const url=new URL(request.url);
 if(url.pathname==='/upstream'){
  const pair=new WebSocketPair(), client=pair[0],server=pair[1];
  routingHeaders=request.headers.get('E2b-Sandbox-Id')==='private-vm' && request.headers.get('E2b-Sandbox-Port')==='4080' && request.headers.get('e2b-traffic-access-token')==='fixture-routing';
  upstreamProtocol=request.headers.get('sec-websocket-protocol')==='vite-hmr';
  server.accept();
  server.addEventListener('message',event=>server.send(event.data));
  server.addEventListener('close',()=>{upstreamClosed=true;server.close(1000,'closed')});
  return new Response(null,{status:101,headers:{'sec-websocket-protocol':'vite-hmr'},webSocket:client});
 }
 if(url.pathname==='/status')return Response.json({upstreamClosed,upstreamProtocol,routingHeaders});
 if(url.pathname==='/relay'){
  const response=await runtime.runPromise(Effect.gen(function*(){
   const bridge=yield* ThreadVmPreviewWebSocket;
   return yield* bridge.open({ request:HttpServerRequest.fromWeb(request),url:request.url.replace('/relay','/upstream').replace(/^http/,'ws'),headers:{'E2b-Sandbox-Id':'private-vm','E2b-Sandbox-Port':'4080','e2b-traffic-access-token':'fixture-routing'},guard:Effect.tryPromise({try:()=>fetch('http://127.0.0.1:${authPort}/'),catch:()=>new ThreadVmPreviewDenied()}).pipe(Effect.flatMap(response=>response.ok?Effect.void:Effect.fail(new ThreadVmPreviewDenied())),Effect.repeat(Schedule.spaced('100 millis')))});
  }).pipe(Effect.provideService(WorkerExecutionContext,fromExecutionContext(ctx,env))));
  return HttpServerResponse.toWeb(response);
 }
 return new Response('ready');
}};
`;
  await NodeFSP.writeFile(dir + "/entry.mjs", source);
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    resolve: {
      alias: { "alchemy/Cloudflare/Workers": alchemy + "/Cloudflare/Workers/WorkerRuntime.js" },
    },
    build: {
      target: "es2022",
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: dir + "/entry.mjs", formats: ["es"], fileName: () => "worker.mjs" },
      rollupOptions: { external: ["node:*"] },
    },
  });
  await NodeFSP.writeFile(
    dir + "/worker.capnp",
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [(name="preview",worker=(modules=[(name="worker.mjs",esModule=embed "worker.mjs")],compatibilityDate="2026-09-01")),(name="internet",network=(allow=["local"]))],
 sockets=[(name="main",address="127.0.0.1:0",http=(),service="preview")]
);
`,
  );
  child = NodeChildProcess.spawn(binary, ["serve", dir + "/worker.capnp", "--control-fd=3"], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (v) => {
    out += v;
  });
  child.stderr.on("data", (v) => {
    err += v;
    process.stderr.write(v);
  });
  exited = new Promise((resolve) => child.once("exit", resolve));
  deadline = setTimeout(() => child.kill("SIGKILL"), 65000);
  const ready = await new Promise((resolve, reject) => {
    let data = "";
    child.stdio[3].on("data", (v) => {
      data += v;
      const lines = data.split("\n");
      for (const line of lines.slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.port) resolve(message);
        } catch {}
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("workerd exited " + code)));
    setTimeout(() => reject(new Error("workerd readiness receipt timeout")), 15000).unref();
  });
  const origin = "http://127.0.0.1:" + ready.port;
  console.log("workerd listening on isolated loopback port", ready.port);
  await NodeFSP.writeFile(
    dir + "/spawn.json",
    JSON.stringify({ pid: child.pid, port: ready.port }),
  );
  NodeAssert.equal((await fetch(origin, { signal: AbortSignal.timeout(5000) })).status, 200);
  const closed = Promise.withResolvers(),
    echo = Promise.withResolvers();
  client = new WebSocket(origin.replace(/^http/, "ws") + "/relay", "vite-hmr");
  client.on("close", () => closed.resolve());
  client.on("message", (v) => echo.resolve(v.toString()));
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
    setTimeout(() => reject(new Error("WebSocket upgrade timeout")), 15000).unref();
  });
  NodeAssert.equal(client.protocol, "vite-hmr");
  client.send("hmr-update");
  NodeAssert.equal(
    await Promise.race([
      echo.promise,
      new Promise((_, r) => setTimeout(() => r(new Error("echo timeout")), 10000).unref()),
    ]),
    "hmr-update",
  );
  const first = await (
    await fetch(origin + "/status", { signal: AbortSignal.timeout(5000) })
  ).json();
  NodeAssert.equal(first.upstreamProtocol, true);
  NodeAssert.equal(first.routingHeaders, true);
  await Promise.race([
    continuedChecks.promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Authorization guard stopped after upgrade")),
        40000,
      ).unref(),
    ),
  ]);
  NodeAssert.equal(client.readyState, WebSocket.OPEN);
  const lateEcho = Promise.withResolvers();
  client.once("message", (value) => lateEcho.resolve(value.toString()));
  client.send("hmr-after-30s");
  NodeAssert.equal(
    await Promise.race([
      lateEcho.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Late frame timeout")), 5000).unref(),
      ),
    ]),
    "hmr-after-30s",
  );
  accessRevoked = true;
  await Promise.race([
    closed.promise,
    new Promise((_, r) => setTimeout(() => r(new Error("revocation timeout")), 10000).unref()),
  ]);
  const final = await (
    await fetch(origin + "/status", { signal: AbortSignal.timeout(5000) })
  ).json();
  NodeAssert.equal(final.upstreamClosed, true);
  await NodeFSP.writeFile(
    dir + "/result.json",
    JSON.stringify({
      framesForwarded: true,
      subprotocolPreserved: true,
      upstreamHeadersPreserved: true,
      bothSocketsClosedOnRevocation: true,
      authorizationChecksAfter30Seconds: true,
    }) + "\n",
  );
  console.log(
    "PASS: actual Cloudflare runtime forwards HMR frames and closes both sockets on revocation",
  );
} finally {
  client?.terminate();
  child?.kill("SIGKILL");
  await exited;
  if (deadline) clearTimeout(deadline);
  await new Promise((resolve) => authServer.close(resolve));
  await NodeFSP.writeFile(dir + "/runtime.log", out + err, { mode: 0o600 });
  console.log("Proof directory:", dir);
}
