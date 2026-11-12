import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The guest needs a short-lived raw streaming listener for each provider session.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import { MANAGED_CODEX_MODELS } from "../provider/Layers/codexLaunchArgs.ts";

export const WORKFLOW_CODEX_PERMIT_ENV = "LAUNCHPAD_WORKFLOW_CODEX_PERMIT";
const bodyLimit = 32 * 1024 * 1024;
const decompressZstd = NodeUtil.promisify(NodeZlib.zstdDecompress);

class WorkflowCodexProxyError extends Schema.TaggedError<WorkflowCodexProxyError>()(
  "WorkflowCodexProxyError",
  {},
) {
  override get message() {
    return "Workflow Codex proxy is unavailable.";
  }
}

export interface WorkflowCodexProxy {
  readonly baseUrl: string;
  readonly permit: string;
  readonly bindPeer: (verify: WorkflowCodexPeerVerifier) => void;
  readonly activate: () => void;
  readonly revoke: () => void;
}

export type WorkflowCodexPeerVerifier = (
  listenerPort: number,
  clientPort: number,
  signal: AbortSignal,
) => Promise<boolean>;

/** Inference requires both the active turn's permit and the registered Codex peer. */
export const openWorkflowCodexProxy = (
  authorize: (signal: AbortSignal) => Promise<string | undefined>,
  forward: typeof fetch = fetch,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const permit = NodeCrypto.randomBytes(32).toString("base64url");
        const expected = Buffer.from(`Bearer ${permit}`);
        const requests = new Set<AbortController>();
        let state: "waiting" | "active" | "revoked" = "waiting";
        let verifyPeer: WorkflowCodexPeerVerifier | undefined;
        const revoke = () => {
          state = "revoked";
          for (const request of requests) request.abort();
        };
        const active = () => state === "active";
        const serve = async (
          request: NodeHttp.IncomingMessage,
          response: NodeHttp.ServerResponse,
        ) => {
          const deny = (status: number) => {
            response.writeHead(status, { "content-type": "application/json", connection: "close" });
            response.end(
              JSON.stringify({ error: { message: "Workflow Codex request unavailable." } }),
            );
          };
          if (
            request.method !== "POST" ||
            (request.url !== "/v1/responses" && request.url !== "/v1/responses/compact")
          )
            return deny(404);
          const presented = Buffer.from(request.headers.authorization ?? "");
          const { localAddress, localPort, remoteAddress, remotePort } = request.socket;
          if (
            !active() ||
            !verifyPeer ||
            localAddress !== "127.0.0.1" ||
            remoteAddress !== "127.0.0.1" ||
            localPort === undefined ||
            remotePort === undefined ||
            presented.length !== expected.length ||
            !NodeCrypto.timingSafeEqual(presented, expected)
          )
            return deny(401);
          if (requests.size >= 8) return deny(429);

          const controller = new AbortController();
          requests.add(controller);
          response.once("close", () => {
            if (!response.writableFinished) controller.abort();
          });
          try {
            const matched = await verifyPeer(localPort, remotePort, controller.signal).catch(
              () => false,
            );
            if (!matched || !active() || controller.signal.aborted) return deny(401);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
              if (controller.signal.aborted) return deny(401);
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > bodyLimit) return deny(413);
              chunks.push(bytes);
            }
            const encoding = request.headers["content-encoding"];
            if (encoding !== undefined && encoding !== "identity" && encoding !== "zstd")
              return deny(415);
            const input = Buffer.concat(chunks, size);
            const decoded =
              encoding === "zstd"
                ? await decompressZstd(input, { maxOutputLength: bodyLimit })
                : input;
            const body: unknown = JSON.parse(decoded.toString("utf8"));
            if (
              !body ||
              typeof body !== "object" ||
              !("model" in body) ||
              typeof body.model !== "string" ||
              !MANAGED_CODEX_MODELS.has(body.model)
            )
              return deny(400);
            if (!active() || controller.signal.aborted) return deny(401);
            const token = await authorize(controller.signal);
            if (!token || !active() || controller.signal.aborted) return deny(401);
            const headers = new Headers({
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            });
            for (const [name, value] of Object.entries(request.headers)) {
              if (
                typeof value === "string" &&
                (name === "accept" ||
                  name === "openai-beta" ||
                  name === "originator" ||
                  name === "session_id" ||
                  name.startsWith("x-codex-"))
              )
                headers.set(name, value);
            }
            const upstream = await forward(`https://api.openai.com${request.url}`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              redirect: "manual",
              signal: controller.signal,
            });
            if (upstream.status >= 300 && upstream.status < 400) {
              await upstream.body?.cancel();
              return deny(502);
            }
            response.statusCode = upstream.status;
            upstream.headers.forEach((value, name) => {
              if (
                name === "content-type" ||
                name === "retry-after" ||
                name.startsWith("x-ratelimit-") ||
                name.startsWith("x-codex-")
              )
                response.setHeader(name, value);
            });
            if (!upstream.body) response.end();
            else
              await NodeStreamPromises.pipeline(NodeStream.Readable.from(upstream.body), response, {
                signal: controller.signal,
              });
          } catch {
            if (response.headersSent || response.destroyed) response.destroy();
            else deny(controller.signal.aborted ? 401 : 502);
          } finally {
            requests.delete(controller);
          }
        };
        const server = NodeHttp.createServer((request, response) => void serve(request, response));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          throw new Error("Workflow Codex proxy could not bind.");
        }
        return {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          permit,
          bindPeer: (verify: WorkflowCodexPeerVerifier) => {
            if (state !== "waiting" || verifyPeer) throw new Error("Codex peer is already bound.");
            verifyPeer = verify;
          },
          activate: () => {
            if (state === "waiting" && verifyPeer) state = "active";
          },
          revoke,
          close: () => {
            revoke();
            server.close();
            server.closeAllConnections();
          },
        };
      },
      catch: () => new WorkflowCodexProxyError(),
    }),
    (proxy) => Effect.sync(proxy.close),
  );
