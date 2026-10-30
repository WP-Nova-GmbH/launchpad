import { Sandbox, SandboxNotFoundError, type SandboxOpts, type SandboxInfo } from "e2b";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { makeE2BRestoreClient, matchesSnapshotAlias } from "./E2BRestoreClient.ts";
import { restoreBootOperationId, threadVmOperationMatches } from "./E2BThreadVmRestoreAttempt.ts";

export interface ThreadVmCreated {
  readonly sandboxId: string;
  readonly trafficAccessToken?: Redacted.Redacted<string>;
}
export interface ThreadVmKnownIdentity {
  readonly allocationId: string;
  readonly operationId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly templateId: string;
}

/** Defense in depth alongside the required host firewall, including its public addresses. */
export const THREAD_VM_BLOCKED_NETWORKS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;

function ipv4Range(network: string) {
  const [, address, prefixText] =
    /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?:\/(0|[1-9]\d?))?$/.exec(network) ?? [];
  if (address === undefined) return null;
  const octets = address.split(".").map(Number);
  const prefix = Number(prefixText ?? "32");
  if (prefix > 32 || octets.some((octet) => octet > 255)) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(octets.reduce((value, octet) => value * 256 + octet, 0) / size) * size;
  return { start, end: start + size - 1 };
}

function normalizeDenyOut(networks: ReadonlyArray<string>) {
  const entries = [...new Set(networks)].map((network) => ({ network, range: ipv4Range(network) }));
  // Stock E2B's nftables interval set rejects overlapping IPv4 ranges in one update.
  // ponytail: quadratic scan for the small host-address list; sort ranges if that list grows large.
  return entries
    .filter(
      ({ range }, index) =>
        range === null ||
        !entries.some(
          ({ range: other }, otherIndex) =>
            other !== null &&
            other.start <= range.start &&
            other.end >= range.end &&
            (other.start < range.start || other.end > range.end || otherIndex < index),
        ),
    )
    .map(({ network }) => network);
}

export interface E2BThreadVmSettings {
  readonly apiUrl: string;
  readonly sandboxUrl: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly templateId: string;
  readonly hostAddresses: ReadonlyArray<string>;
  /** Infrastructure lease, renewed by the host independently of relay connectivity. */
  readonly timeoutMs: number;
}

export class ThreadVmComputeError extends Schema.TaggedError<ThreadVmComputeError>()(
  "ThreadVmComputeError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    connectUncertain: Schema.optional(Schema.Boolean),
  },
) {}

export interface ThreadVmCreateInput {
  readonly allocationId: string;
  readonly operationId: string;
  readonly threadId: string;
  readonly generation: number;
  /** Thread-scoped bootstrap material only; never the compute-management API key. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface ThreadVmSnapshotCreateInput extends ThreadVmCreateInput {
  readonly sourceTemplateId: string;
  readonly sourceBuildId: string;
  readonly restoreOperationId: string;
  readonly bootAttempt: number;
}

interface E2BComputeClient {
  readonly create: (
    template: string,
    options: SandboxOpts,
  ) => Promise<{ sandboxId: string; trafficAccessToken?: string }>;
  readonly getInfo: typeof Sandbox.getInfo;
  readonly kill: typeof Sandbox.kill;
  readonly pause: typeof Sandbox.pause;
  readonly connect: (
    ...args: Parameters<typeof Sandbox.connect>
  ) => Promise<{ sandboxId: string; trafficAccessToken?: string }>;
  readonly createSnapshot: typeof Sandbox.createSnapshot;
  readonly listSnapshots: (
    ...args: Parameters<typeof Sandbox.listSnapshots>
  ) => Pick<ReturnType<typeof Sandbox.listSnapshots>, "hasNext" | "nextItems">;
  readonly deleteSnapshot: typeof Sandbox.deleteSnapshot;
  readonly list: (
    ...args: Parameters<typeof Sandbox.list>
  ) => Pick<ReturnType<typeof Sandbox.list>, "hasNext" | "nextItems">;
}

export const makeE2BThreadVmCompute = (
  settings: E2BThreadVmSettings,
  client: E2BComputeClient = Sandbox,
  transport: typeof fetch = fetch,
) => {
  const denyOut = normalizeDenyOut([...THREAD_VM_BLOCKED_NETWORKS, ...settings.hostAddresses]);
  const options = {
    apiUrl: settings.apiUrl,
    sandboxUrl: settings.sandboxUrl,
    apiKey: Redacted.value(settings.apiKey),
    requestTimeoutMs: 60_000,
    retries: 0,
  };
  const configurationError = (() => {
    for (const value of [settings.apiUrl, settings.sandboxUrl]) {
      try {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          return "E2B requires explicit HTTP(S) URLs without embedded credentials or query strings.";
      } catch {
        return "Both self-hosted E2B endpoints must be configured; cloud fallback is disabled.";
      }
    }
    if (!Redacted.value(settings.apiKey).trim() || !settings.templateId.trim()) {
      return "An E2B management key and verified Launchpad template are required.";
    }
    if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs <= 0) {
      return "The E2B infrastructure lease must be a positive number of milliseconds.";
    }
    return null;
  })();
  const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
    configurationError !== null
      ? Effect.fail(
          new ThreadVmComputeError({
            operation: "configuration",
            message: configurationError,
          }),
        )
      : Effect.tryPromise({
          try: run,
          catch: () =>
            new ThreadVmComputeError({
              operation,
              message: `E2B ${operation} failed. Reconcile the operation before retrying.`,
            }),
        });

  const inspect = (sandboxId: string) =>
    request("inspect", async (signal): Promise<SandboxInfo | null> => {
      try {
        return await client.getInfo(sandboxId, { ...options, signal });
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      }
    });

  const restore = makeE2BRestoreClient(settings, transport);
  const create = Effect.fn("E2BThreadVmCompute.create")(function* (
    input: ThreadVmCreateInput,
    templateId = settings.templateId,
    restoreMetadata: Readonly<Record<string, string>> = {},
  ) {
    if (configurationError !== null)
      return yield* new ThreadVmComputeError({
        operation: "configuration",
        message: configurationError,
      });
    return yield* request("create", async (signal) => {
      const sandbox = await client.create(templateId, {
        ...options,
        // Cold boots can use the host's five-minute budget plus recovery time.
        requestTimeoutMs: 420_000,
        signal,
        timeoutMs: settings.timeoutMs,
        secure: true,
        metadata: {
          "launchpad.managed": "thread-vm-v1",
          "launchpad.allocation_id": input.allocationId,
          "launchpad.operation_id": input.operationId,
          "launchpad.thread_id": input.threadId,
          "launchpad.generation": String(input.generation),
          ...restoreMetadata,
        },
        envs: { ...input.environment },
        network: {
          denyOut,
          allowPublicTraffic: false,
        },
        lifecycle: { onTimeout: { action: "pause", mode: "full" }, autoResume: false },
      });
      return {
        sandboxId: sandbox.sandboxId,
        ...(sandbox.trafficAccessToken?.trim()
          ? { trafficAccessToken: Redacted.make(sandbox.trafficAccessToken) }
          : {}),
      };
    });
  });
  return {
    restore,
    pausedSnapshotsSupported: Effect.succeed(true),
    create: (input: ThreadVmCreateInput) => create(input),
    /** Native restore starts executing immediately; callers must commit ownership first. */
    createFromSnapshot: Effect.fn("E2BThreadVmCompute.createFromSnapshot")(function* (
      input: ThreadVmSnapshotCreateInput,
    ) {
      if (
        !Number.isSafeInteger(input.bootAttempt) ||
        input.bootAttempt < 0 ||
        input.bootAttempt > 999_999_999 ||
        restoreBootOperationId(input.restoreOperationId, input.bootAttempt) !== input.operationId
      )
        return yield* new ThreadVmComputeError({
          operation: "restore",
          message: "The restore boot attempt does not match its durable operation.",
        });
      yield* restore.resolveSource(input.sourceTemplateId, input.sourceBuildId);
      // Snapshot templates have one immutable build. Native create accepts that
      // template ID, not a fabricated tag derived from the build UUID.
      return yield* create(input, input.sourceTemplateId, {
        "launchpad.restore": "v1",
        "launchpad.restore_parent_operation_id": input.restoreOperationId,
        "launchpad.restore_boot_attempt": String(input.bootAttempt),
      });
    }),
    inspect,
    /** Explicit provisioning recovery only: connecting can resume this exact inert VM. */
    recoverIngress: Effect.fn("E2BThreadVmCompute.recoverIngress")(function* (
      sandboxId: string,
      identity: ThreadVmKnownIdentity,
    ) {
      if (configurationError !== null)
        return yield* new ThreadVmComputeError({
          operation: "configuration",
          message: configurationError,
          connectUncertain: false,
        });
      // This state belongs to one execution. A lost native connect reply must
      // retain the durable recovery marker even if this claim later expires.
      let connectUncertain = false;
      return yield* Effect.tryPromise({
        try: async (signal): Promise<ThreadVmCreated> => {
          const verify = async () => {
            const info = await client.getInfo(sandboxId, { ...options, signal });
            if (
              info.sandboxId !== sandboxId ||
              info.templateId !== identity.templateId.split(":")[0] ||
              info.metadata["launchpad.managed"] !== "thread-vm-v1" ||
              info.metadata["launchpad.allocation_id"] !== identity.allocationId ||
              !threadVmOperationMatches(info.metadata, identity.operationId) ||
              info.metadata["launchpad.thread_id"] !== identity.threadId ||
              info.metadata["launchpad.generation"] !== String(identity.generation) ||
              info.network?.allowPublicTraffic !== false ||
              info.lifecycle?.autoResume !== false
            )
              throw new Error("VM identity or private ingress differs");
            return info;
          };
          await verify();
          connectUncertain = true;
          const sandbox = await client.connect(sandboxId, {
            ...options,
            signal,
            timeoutMs: settings.timeoutMs,
            requestTimeoutMs: 420_000,
          });
          if (sandbox.sandboxId !== sandboxId)
            throw new Error("VM ingress recovery returned another identity");
          connectUncertain = false;
          if (!sandbox.trafficAccessToken?.trim())
            throw new Error("VM ingress recovery returned no token");
          const info = await verify();
          if (info.state !== "running") throw new Error("VM ingress is not running");
          return { sandboxId, trafficAccessToken: Redacted.make(sandbox.trafficAccessToken) };
        },
        catch: () =>
          new ThreadVmComputeError({
            operation: "recover ingress",
            message: "E2B recover ingress failed. Reconcile the operation before retrying.",
            connectUncertain,
          }),
      });
    }),
    /** Listing is read-only. In particular it must not connect to paused sandboxes. */
    findOperation: (operationId: string) =>
      request("find operation", async () => {
        const paginator = client.list({
          ...options,
          query: {
            state: ["running", "paused"],
            metadata: { "launchpad.operation_id": operationId },
          },
        });
        const matches: Array<SandboxInfo> = [];
        while (paginator.hasNext) matches.push(...(await paginator.nextItems()));
        return matches;
      }),
    pause: (sandboxId: string) =>
      request("pause", (signal) => client.pause(sandboxId, { ...options, signal, mode: "full" })),
    /** Call only for an explicitly admitted wake, never for status or history reads. */
    resume: (sandboxId: string) =>
      request("resume", async (signal) => {
        const sandbox = await client.connect(sandboxId, {
          ...options,
          // Cold boots can use the host's five-minute budget plus recovery time.
          requestTimeoutMs: 420_000,
          signal,
          timeoutMs: settings.timeoutMs,
        });
        return {
          sandboxId: sandbox.sandboxId,
          ...(sandbox.trafficAccessToken?.trim()
            ? { trafficAccessToken: Redacted.make(sandbox.trafficAccessToken) }
            : {}),
        };
      }),
    /** Call after the managed source has stopped and sealed its independent checkpoint. */
    snapshot: (sandboxId: string, name?: string) =>
      request("snapshot", (signal) =>
        client.createSnapshot(sandboxId, {
          ...options,
          signal,
          mode: "full",
          ...(name ? { name } : {}),
        }),
      ),
    /** Reconcile an uncertain named capture without issuing another snapshot request. */
    findSnapshot: (sandboxId: string, name: string) =>
      request("find snapshot", async () => {
        const paginator = client.listSnapshots({ ...options, sandboxId, name });
        const matches: Array<{ snapshotId: string; names: string[] }> = [];
        while (paginator.hasNext) {
          for (const snapshot of await paginator.nextItems()) {
            // The SDK/server filter is only a hint. Never reconcile an uncertain
            // capture to a different snapshot returned by a broad or stale list.
            if (snapshot.names.some((candidate) => matchesSnapshotAlias(candidate, name)))
              matches.push(snapshot);
          }
        }
        return matches.length === 1 ? matches[0]! : null;
      }),
    deleteSnapshot: (snapshotId: string) =>
      request("delete snapshot", (signal) =>
        client.deleteSnapshot(snapshotId, { ...options, signal }),
      ),
    /** Native acknowledgement for one durable ID; it is not a physical-stop certificate. */
    destroy: (sandboxId: string) =>
      request("destroy", async (signal) => {
        try {
          await client.kill(sandboxId, { ...options, signal });
        } catch (error) {
          if (!(error instanceof SandboxNotFoundError)) throw error;
        }
      }),
  };
};

export class E2BThreadVmCompute extends Context.Service<
  E2BThreadVmCompute,
  ReturnType<typeof makeE2BThreadVmCompute>
>()("launchpad-relay/machines/E2BThreadVmCompute") {}

export const layer = (settings: E2BThreadVmSettings) =>
  Layer.succeed(E2BThreadVmCompute, makeE2BThreadVmCompute(settings));
