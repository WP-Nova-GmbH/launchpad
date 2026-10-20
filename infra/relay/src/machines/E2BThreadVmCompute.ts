import { Sandbox, SandboxNotFoundError, type SandboxOpts, type SandboxInfo } from "e2b";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { E2BRestoreError, makeE2BRestoreClient, matchesSnapshotAlias } from "./E2BRestoreClient.ts";

const decodePhysicalStopReceipt = Schema.decodeUnknownSync(
  Schema.Struct({ sandboxID: Schema.String, physicallyStopped: Schema.Literal(true) }),
);
const decodeCreationIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    operationID: Schema.String,
    sandboxID: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
    metadata: Schema.Record(Schema.String, Schema.String),
    cancelled: Schema.Boolean,
  }),
);

const decodeCreationStopReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    operationID: Schema.String,
    sandboxID: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
    metadata: Schema.Record(Schema.String, Schema.String),
    cancelled: Schema.Literal(true),
    physicallyStopped: Schema.Literal(true),
  }),
);
export interface ThreadVmCreationStopReceipt {
  readonly operationId: string;
  readonly computeRef: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface ThreadVmCreationIdentity {
  readonly operationId: string;
  readonly computeRef: string | null;
  readonly metadata: Readonly<Record<string, string>>;
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

interface E2BComputeClient {
  readonly create: (template: string, options: SandboxOpts) => Promise<{ sandboxId: string }>;
  readonly getInfo: typeof Sandbox.getInfo;
  readonly pause: typeof Sandbox.pause;
  readonly connect: (...args: Parameters<typeof Sandbox.connect>) => Promise<{ sandboxId: string }>;
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
  const options = {
    apiUrl: settings.apiUrl,
    sandboxUrl: settings.sandboxUrl,
    apiKey: Redacted.value(settings.apiKey),
    requestTimeoutMs: 60_000,
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
          catch: (cause) =>
            new ThreadVmComputeError({
              operation,
              message: `E2B ${operation} failed. Reconcile the operation before retrying.`,
              cause,
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
  const requirePausedSnapshots = Effect.gen(function* () {
    const capabilities = yield* restore.capabilities();
    if (capabilities.pausedSnapshots !== true || capabilities.certifiedPauses !== true)
      return yield* new E2BRestoreError({ operation: "paused snapshot", reason: "unsupported" });
  });
  return {
    restore,
    pausedSnapshotsSupported: restore.capabilities().pipe(
      Effect.map(
        (capabilities) =>
          capabilities.pausedSnapshots === true && capabilities.certifiedPauses === true,
      ),
      Effect.catch(() => Effect.succeed(false)),
    ),
    create: Effect.fn("E2BThreadVmCompute.create")(function* (input: ThreadVmCreateInput) {
      if (configurationError !== null)
        return yield* new ThreadVmComputeError({
          operation: "configuration",
          message: configurationError,
        });
      const capabilities = yield* restore.capabilities().pipe(
        Effect.mapError(
          () =>
            new ThreadVmComputeError({
              operation: "create",
              message: "Durable creation identity is unavailable. VM creation was not sent.",
            }),
        ),
      );
      if (capabilities.durableCreationIdentity !== true)
        return yield* new ThreadVmComputeError({
          operation: "create",
          message: "The compute runtime cannot safely recover failed VM creation.",
        });
      return yield* request("create", async (signal) => {
        const sandbox = await client.create(settings.templateId, {
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
          },
          envs: { ...input.environment },
          network: {
            denyOut: [...THREAD_VM_BLOCKED_NETWORKS, ...settings.hostAddresses],
            allowPublicTraffic: false,
          },
          lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
        });
        return { sandboxId: sandbox.sandboxId };
      });
    }),
    inspect,
    /** Original control-plane identity survives a failed pause and lost routing. */
    inspectCreation: (operationId: string) =>
      request("inspect creation", async (signal): Promise<ThreadVmCreationIdentity | null> => {
        const response = await transport(
          `${settings.apiUrl.replace(/\/$/u, "")}/extensions/launchpad/v1/creations/${encodeURIComponent(operationId)}`,
          {
            method: "GET",
            headers: { "X-API-Key": Redacted.value(settings.apiKey) },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 404) return null;
          throw new Error("Managed creation identity is unavailable. Retain the allocation.");
        }
        let receipt: ReturnType<typeof decodeCreationIdentity>;
        try {
          receipt = decodeCreationIdentity(await response.json());
        } catch {
          throw new Error("Invalid managed creation identity. Retain the allocation.");
        }
        if (receipt.operationID !== operationId)
          throw new Error("Managed creation identity belongs to another operation.");
        return { operationId, computeRef: receipt.sandboxID, metadata: receipt.metadata };
      }),
    /** Listing is read-only. In particular it must not connect to paused sandboxes. */
    findOperation: (operationId: string) =>
      request("find operation", async () => {
        const paginator = client.list({
          ...options,
          query: { metadata: { "launchpad.operation_id": operationId } },
        });
        const matches: Array<SandboxInfo> = [];
        while (paginator.hasNext) matches.push(...(await paginator.nextItems()));
        return matches;
      }),
    pause: (sandboxId: string) =>
      requirePausedSnapshots.pipe(
        Effect.mapError(
          () =>
            new ThreadVmComputeError({
              operation: "pause",
              message: "This host cannot retain a paused recovery disk. Keep the VM running.",
            }),
        ),
        Effect.andThen(
          request("pause", (signal) =>
            client.pause(sandboxId, { ...options, signal, keepMemory: false }),
          ),
        ),
      ),
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
        return { sandboxId: sandbox.sandboxId };
      }),
    /** Managed recovery capture freezes and flushes the guest filesystem, then thaws it. */
    snapshot: (sandboxId: string, name?: string) =>
      Effect.gen(function* () {
        yield* restore.capabilities();
        return yield* request("snapshot", (signal) =>
          client.createSnapshot(sandboxId, { ...options, signal, ...(name ? { name } : {}) }),
        );
      }),
    /** Retain the immutable pause disk through the patched host; never connect or wake. */
    snapshotPaused: (sandboxId: string, name: string) =>
      requirePausedSnapshots.pipe(Effect.andThen(restore.retainPausedSnapshot(sandboxId, name))),
    retentionCandidate: restore.retentionCandidate,
    requireExecutionRetention: restore.requireExecutionRetention,
    retainForStop: restore.retainForStop,
    stopRetained: restore.stopRetained,
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
    cancelCreate: (operationId: string) =>
      request("cancel create", async (signal): Promise<ThreadVmCreationStopReceipt> => {
        const response = await transport(
          `${settings.apiUrl.replace(/\/$/u, "")}/extensions/launchpad/v1/creations/${encodeURIComponent(operationId)}`,
          {
            method: "DELETE",
            headers: { "X-API-Key": Redacted.value(settings.apiKey) },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Creation stop is unconfirmed. Retain capacity and retry.");
        }
        let receipt: ReturnType<typeof decodeCreationStopReceipt>;
        try {
          receipt = decodeCreationStopReceipt(await response.json());
        } catch {
          throw new Error("Invalid creation stop receipt. Retain capacity.");
        }
        if (receipt.operationID !== operationId)
          throw new Error("Creation stop receipt belongs to another operation. Retain capacity.");
        return { operationId, computeRef: receipt.sandboxID, metadata: receipt.metadata };
      }),
    destroy: (sandboxId: string) =>
      request("destroy", async (signal) => {
        const response = await transport(
          `${settings.apiUrl.replace(/\/$/u, "")}/extensions/launchpad/v1/executions/${encodeURIComponent(sandboxId)}`,
          {
            method: "DELETE",
            headers: { "X-API-Key": Redacted.value(settings.apiKey) },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Physical stop is unconfirmed. Retain the allocation and retry.");
        }
        let receipt: { sandboxID: string; physicallyStopped: true };
        try {
          receipt = decodePhysicalStopReceipt(await response.json());
        } catch {
          throw new Error("Invalid physical stop receipt. Retain the allocation.");
        }
        if (receipt.sandboxID !== sandboxId) {
          throw new Error("Physical stop receipt belongs to another VM. Retain the allocation.");
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
