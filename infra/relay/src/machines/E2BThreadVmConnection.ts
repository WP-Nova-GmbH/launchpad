import { threadVmOperationMatches } from "./E2BThreadVmRestoreAttempt.ts";
import type { Sandbox } from "e2b";
import type { RelayThreadVmBootstrap } from "@t3tools/contracts/relay";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { E2BThreadVmSettings } from "./E2BThreadVmCompute.ts";

/** Internal adapter identity; the image pin is not a credential claim or client input. */
export type E2BThreadVmIdentity = Pick<RelayThreadVmBootstrap, "scope" | "operationId"> & {
  readonly templateId?: string;
};

const decodePreviewCapability = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.Literal(1), privatePreviewHeaderBoundary: Schema.Literal(true) }),
);

const decodeConnection = Schema.decodeUnknownSync(
  Schema.Struct({
    sandboxID: Schema.String,
    templateID: Schema.NonEmptyString,
    state: Schema.Literal("running"),
    envdVersion: Schema.String,
    envdAccessToken: Schema.NonEmptyString,
    trafficAccessToken: Schema.optional(Schema.NonEmptyString),
    network: Schema.optional(Schema.Struct({ allowPublicTraffic: Schema.Literal(false) })),
    domain: Schema.optional(Schema.NullOr(Schema.String)),
    metadata: Schema.Record(Schema.String, Schema.String),
    lifecycle: Schema.Struct({ autoResume: Schema.Literal(false) }),
  }),
);

/** Inspect only. Connecting through the SDK's static helper could resume a paused VM. */
async function inspectThreadVm(
  settings: E2BThreadVmSettings,
  sandboxId: string,
  identity: E2BThreadVmIdentity,
  transport: typeof fetch,
  signal: AbortSignal,
) {
  for (const endpoint of [settings.apiUrl, settings.sandboxUrl]) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid self-hosted endpoint");
  }
  const response = await transport(
    `${settings.apiUrl.replace(/\/$/u, "")}/sandboxes/${encodeURIComponent(sandboxId)}`,
    {
      headers: { "X-API-Key": Redacted.value(settings.apiKey) },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("VM is unavailable");
  }
  const info = decodeConnection(await response.json());
  const m = info.metadata;
  // The configured template selects future allocations. Existing guests retain
  // their admitted image; their exact allocation/operation/generation identifies
  // them after a template rollout, as it does for restored guest disks.
  if (
    info.sandboxID !== sandboxId ||
    (info.templateID !== (identity.templateId ?? settings.templateId).split(":")[0] &&
      !(m["launchpad.restore"] === "v1" && info.templateID === sandboxId)) ||
    m["launchpad.managed"] !== "thread-vm-v1" ||
    m["launchpad.allocation_id"] !== identity.scope.allocationId ||
    !threadVmOperationMatches(m, identity.operationId) ||
    m["launchpad.thread_id"] !== identity.scope.threadId ||
    m["launchpad.generation"] !== String(identity.scope.generation)
  )
    throw new Error("VM identity differs");
  return info;
}

/** Inspect only. The constructor below does not invoke the SDK's waking connect helper. */
export async function inspectE2BThreadVmConnection(
  settings: E2BThreadVmSettings,
  sandboxId: string,
  identity: E2BThreadVmIdentity,
  transport: typeof fetch,
  signal: AbortSignal,
): Promise<ConstructorParameters<typeof Sandbox>[0]> {
  const info = await inspectThreadVm(settings, sandboxId, identity, transport, signal);
  return {
    sandboxId,
    envdVersion: info.envdVersion,
    envdAccessToken: info.envdAccessToken,
    ...(info.domain ? { sandboxDomain: info.domain } : {}),
    apiUrl: settings.apiUrl,
    sandboxUrl: settings.sandboxUrl,
    apiKey: Redacted.value(settings.apiKey),
    requestTimeoutMs: 30_000,
  };
}

/** Private routing material stays in the relay; no compute or envd credential leaves this adapter. */
export async function inspectE2BThreadVmIngress(
  settings: E2BThreadVmSettings,
  sandboxId: string,
  identity: E2BThreadVmIdentity,
  transport: typeof fetch,
  signal: AbortSignal,
) {
  const info = await inspectThreadVm(settings, sandboxId, identity, transport, signal);
  if (!info.trafficAccessToken || !info.network)
    throw new Error("Private VM ingress is unavailable; read-only token inspection is required.");
  const capability = await transport(
    `${settings.apiUrl.replace(/\/$/u, "")}/extensions/launchpad/v1/capabilities`,
    {
      headers: { "X-API-Key": Redacted.value(settings.apiKey) },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  );
  if (!capability.ok) {
    await capability.body?.cancel();
    throw new Error("Private preview runtime capability is unavailable.");
  }
  decodePreviewCapability(await capability.json());
  return {
    origin: settings.sandboxUrl,
    sandboxId,
    trafficAccessToken: Redacted.make(info.trafficAccessToken),
  };
}
