import { EnvironmentHttpApi } from "@t3tools/contracts";
import {
  RelayCloudMintCredentialRequest,
  RelayEnvironmentMintResponse,
  RelayEnvironmentHealthResponse,
  type RelayThreadVmBootstrap,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";
import { inspectE2BThreadVmIngress } from "./E2BThreadVmConnection.ts";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RelayCloudMintCredentialRequest));
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayEnvironmentMintResponse),
);

const decodeHealthResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayEnvironmentHealthResponse),
);

async function readBoundedResponse(response: Response) {
  if (!response.body) throw new ThreadVmEndpointError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) throw new ThreadVmEndpointError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export class ThreadVmEndpointError extends Schema.TaggedError<ThreadVmEndpointError>()(
  "ThreadVmEndpointError",
  {},
) {
  override get message() {
    return "The private VM connection is unavailable.";
  }
}

async function postProof(
  url: URL,
  proof: string,
  headers: Record<string, string>,
  transport: typeof fetch,
  signal: AbortSignal,
  path: string = EnvironmentHttpApi.groups.connect.endpoints.t3MintCredential.path,
) {
  url.pathname = path;
  const response = await transport(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeRequest({ proof }),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ThreadVmEndpointError();
  }
  return readBoundedResponse(response);
}

function managedOrigin(origin: string) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ThreadVmEndpointError();
  return url;
}

/** The caller resolves this origin from the relay's managed allocation, never from a client request. */
export const makeManagedThreadVmEndpoint = (origin: string, transport: typeof fetch = fetch) => ({
  mintCredential: (
    _sandboxId: string,
    _identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    proof: string,
  ) =>
    Effect.tryPromise({
      try: (signal) => {
        const url = managedOrigin(origin);
        return postProof(url, proof, {}, transport, signal).then(decodeResponse);
      },
      catch: () => new ThreadVmEndpointError(),
    }),
  health: (proof: string) =>
    Effect.tryPromise({
      try: (signal) =>
        postProof(
          managedOrigin(origin),
          proof,
          {},
          transport,
          signal,
          EnvironmentHttpApi.groups.connect.endpoints.health.path,
        ).then(decodeHealthResponse),
      catch: () => new ThreadVmEndpointError(),
    }),
});

const privateProof = (
  settings: E2BThreadVmSettings,
  transport: typeof fetch,
  sandboxId: string,
  identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
  proof: string,
  path?: string,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const ingress = await inspectE2BThreadVmIngress(
        settings,
        sandboxId,
        identity,
        transport,
        signal,
      );
      return postProof(
        new URL(ingress.origin),
        proof,
        {
          "E2b-Sandbox-Id": ingress.sandboxId,
          "E2b-Sandbox-Port": "3773",
          "e2b-traffic-access-token": Redacted.value(ingress.trafficAccessToken),
        },
        transport,
        signal,
        path,
      );
    },
    // Transport exceptions and response bodies can contain credentials. Never retain them in errors.
    catch: () => new ThreadVmEndpointError(),
  });

/** Relay control request, never a user-selected port or URL. The guest verifies the signed proof. */
export const makeE2BThreadVmEndpoint = (
  settings: E2BThreadVmSettings,
  transport: typeof fetch = fetch,
) => ({
  mintCredential: (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    proof: string,
  ) =>
    privateProof(settings, transport, sandboxId, identity, proof).pipe(
      Effect.flatMap((text) =>
        Effect.try({ try: () => decodeResponse(text), catch: () => new ThreadVmEndpointError() }),
      ),
    ),
});

/** Private status uses the same inspected ingress and signed guest proof as credential minting. */
export const makeE2BThreadVmHealth =
  (settings: E2BThreadVmSettings, transport: typeof fetch = fetch) =>
  (
    sandboxId: string,
    identity: Pick<RelayThreadVmBootstrap, "scope" | "operationId">,
    proof: string,
  ) =>
    privateProof(
      settings,
      transport,
      sandboxId,
      identity,
      proof,
      EnvironmentHttpApi.groups.connect.endpoints.health.path,
    ).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => decodeHealthResponse(text),
          catch: () => new ThreadVmEndpointError(),
        }),
      ),
    );
