import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1));
const UUID = Schema.String.check(Schema.isUUID());
const Capabilities = Schema.Struct({
  version: Schema.Literal(1),
  diskRestore: Schema.Literal(true),
  quiescedSnapshots: Schema.Literal(true),
  renewableLifetime: Schema.Boolean,
  durableCreationIdentity: Schema.optionalKey(Schema.Boolean),
  pausedSnapshots: Schema.optionalKey(Schema.Boolean),
  certifiedPauses: Schema.optionalKey(Schema.Boolean),
  executionRetention: Schema.optionalKey(Schema.Boolean),
});
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const E2BColdProbeReceipt = Schema.Struct({
  version: Schema.Literal(1),
  preparedBuildID: UUID,
  rootfsSHA256: Sha256,
  initSHA256: Sha256,
  physicalStopConfirmed: Schema.Literal(true),
  mountOnly: Schema.Literal(true),
});
export const E2BRestoreStatus = Schema.Struct({
  coldProbe: Schema.optionalKey(E2BColdProbeReceipt),
  operationID: UUID,
  generation: Identifier,
  sandboxID: Identifier,
  executionID: UUID,
  preparedBuildID: UUID,
  state: Schema.Literals([
    "preparing",
    "prepared",
    "activating",
    "active",
    "cancelling",
    "cancelled",
    "failed",
  ]),
  manifestSHA256: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
/** A completed infrastructure boot remains active in the restore catalog after
 * its execution is retired. Preserve that status and its separate stop proof. */
export const E2BStoppedRestoreBoot = Schema.Struct({
  ...E2BRestoreStatus.fields,
  physicallyStopped: Schema.Literal(true),
});
export type E2BStoppedRestoreBoot = typeof E2BStoppedRestoreBoot.Type;
const PhysicalStop = Schema.Struct({
  sandboxID: Identifier,
  physicallyStopped: Schema.Literal(true),
});
export const E2BExecutionRetentionCandidate = Schema.Struct({
  sandboxID: Identifier,
  executionID: UUID,
  buildID: Schema.NullOr(UUID),
  metadata: Schema.Record(Schema.String, Schema.String),
  disposition: Schema.Literals(["ready_tip", "no_current_tip"]),
});
export type E2BExecutionRetentionCandidate = typeof E2BExecutionRetentionCandidate.Type;
export const E2BExecutionRetentionReceipt = Schema.Struct({
  ...E2BExecutionRetentionCandidate.fields,
  version: Schema.Literal(1),
  kind: Schema.Literal("retained_for_stop"),
  recoveryOperationID: UUID,
  retainedTemplateID: Schema.NullOr(Identifier),
  retainedBuildIDs: Schema.Array(UUID),
  requestSHA256: Sha256,
});
export type E2BExecutionRetentionReceipt = typeof E2BExecutionRetentionReceipt.Type;
const decodeRetentionCandidate = Schema.decodeUnknownEffect(E2BExecutionRetentionCandidate);
const decodeRetentionReceipt = Schema.decodeUnknownEffect(E2BExecutionRetentionReceipt);
export const sameRetentionCandidate = (
  a: E2BExecutionRetentionCandidate,
  b: E2BExecutionRetentionCandidate,
) =>
  a.sandboxID === b.sandboxID &&
  a.executionID === b.executionID &&
  a.buildID === b.buildID &&
  a.disposition === b.disposition &&
  Object.keys(a.metadata).length === Object.keys(b.metadata).length &&
  Object.entries(a.metadata).every(([key, value]) => b.metadata[key] === value);
const TemplateBuilds = Schema.Struct({
  templateID: Schema.String,
  builds: Schema.Array(Schema.Struct({ buildID: UUID, status: Schema.String })),
});
const decodePhysicalStop = Schema.decodeUnknownEffect(PhysicalStop);
const decodeStatus = Schema.decodeUnknownEffect(E2BRestoreStatus);
const decodeCapabilities = Schema.decodeUnknownEffect(Capabilities);
const decodeTemplate = Schema.decodeUnknownEffect(TemplateBuilds);
const decodeNamedTemplate = Schema.decodeUnknownEffect(
  Schema.Struct({ ...TemplateBuilds.fields, names: Schema.Array(Identifier) }),
);
const decodeAlias = Schema.decodeUnknownEffect(Schema.Struct({ templateID: Identifier }));
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.Struct({ snapshotID: Identifier, names: Schema.Array(Identifier) }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const E2BBackupColdProof = Schema.Struct({
  operationID: UUID,
  generation: Identifier,
  preparedBuildID: UUID,
  manifestSHA256: Sha256,
  coldProbe: E2BColdProbeReceipt,
});
export type E2BBackupColdProof = typeof E2BBackupColdProof.Type;
export type E2BRestoreStatus = typeof E2BRestoreStatus.Type;
export interface E2BRestoreRequest {
  readonly sourceTemplateID: string;
  readonly sourceBuildID: string;
  readonly generation: string;
  /** Omit for a verification-only preparation, which cannot boot. */
  readonly bootstrap?: Readonly<Record<string, unknown>> & { readonly version: 1 };
  readonly metadata?: Readonly<Record<string, string>>;
  readonly leaseSeconds: number;
}
export class E2BRestoreError extends Schema.TaggedError<E2BRestoreError>()("E2BRestoreError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "configuration",
    "transport",
    "http",
    "response",
    "identity",
    "unsupported",
  ]),
  status: Schema.optionalKey(Schema.Number),
  nativeCode: Schema.optionalKey(Schema.Literal("retention_candidate_changed")),
}) {}

/** The owning API may include its team namespace and the default tag in snapshot aliases. */
export function matchesSnapshotAlias(candidate: string, name: string): boolean {
  const alias = candidate.split("/").at(-1);
  return alias === name || alias === `${name}:default`;
}

/** Calls the opt-in runtime extension. Never falls back to a booting template build. */
export function makeE2BRestoreClient(
  settings: { readonly apiUrl: string; readonly apiKey: Redacted.Redacted<string> },
  transport: typeof fetch = fetch,
) {
  const validConfiguration = (() => {
    try {
      const url = new URL(settings.apiUrl);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !!Redacted.value(settings.apiKey).trim()
      );
    } catch {
      return false;
    }
  })();
  const base = settings.apiUrl.replace(/\/$/u, "");
  const request = Effect.fn("E2BRestoreClient.request")(function* (
    operation: string,
    path: string,
    method: string,
    body?: unknown,
  ) {
    if (!validConfiguration)
      return yield* new E2BRestoreError({ operation, reason: "configuration" });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        transport(`${base}${path}`, {
          method,
          headers: {
            "X-API-Key": Redacted.value(settings.apiKey),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: encodeJson(body) }),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        }),
      // Transport and parse exceptions can contain credentials. Keep them out of receipts/logs.
      catch: () => new E2BRestoreError({ operation, reason: "transport" }),
    });
    if (!response.ok) {
      if (operation === "retain for stop" && response.status === 409) {
        const code = yield* Effect.tryPromise({
          try: async () => {
            const body: unknown = await response.json();
            return typeof body === "object" &&
              body !== null &&
              "code" in body &&
              body.code === "retention_candidate_changed"
              ? ("retention_candidate_changed" as const)
              : undefined;
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        return yield* new E2BRestoreError({
          operation,
          reason: "http",
          status: 409,
          ...(code ? { nativeCode: code } : {}),
        });
      }
      yield* Effect.tryPromise({
        try: () => response.body?.cancel() ?? Promise.resolve(),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      return yield* new E2BRestoreError({ operation, reason: "http", status: response.status });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new E2BRestoreError({ operation, reason: "response" }),
    });
  });
  const operationPath = (id: string) =>
    `/extensions/launchpad/v1/restores/${encodeURIComponent(id)}`;
  const operation = Effect.fn("E2BRestoreClient.operation")(function* (
    name: string,
    operationID: string,
    generation: string,
    method: string,
    body?: E2BRestoreRequest,
    suffix = "",
  ) {
    const raw = yield* request(name, operationPath(operationID) + suffix, method, body);
    const result = yield* decodeStatus(raw).pipe(
      Effect.mapError(() => new E2BRestoreError({ operation: name, reason: "response" })),
    );
    if (
      result.operationID !== operationID ||
      result.generation !== generation ||
      (result.coldProbe !== undefined &&
        result.coldProbe.preparedBuildID !== result.preparedBuildID)
    ) {
      return yield* new E2BRestoreError({ operation: name, reason: "identity" });
    }
    return result;
  });
  // Resolve each unique snapshot once, then retain its immutable build pair.
  const resolveSnapshot = Effect.fn("E2BRestoreClient.resolveSnapshot")(function* (
    snapshotID: string,
  ) {
    const templateID = snapshotID.replace(/:default$/u, "");
    const raw = yield* request("snapshot", `/templates/${encodeURIComponent(templateID)}`, "GET");
    const template = yield* decodeTemplate(raw).pipe(
      Effect.mapError(() => new E2BRestoreError({ operation: "snapshot", reason: "response" })),
    );
    const ready = template.builds.filter((build) => build.status === "ready");
    if (template.templateID !== templateID || template.builds.length !== 1 || ready.length !== 1) {
      return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
    }
    return { sourceTemplateID: templateID, sourceBuildID: ready[0]!.buildID };
  });
  return {
    requireExecutionRetention: Effect.fn("E2BRestoreClient.requireExecutionRetention")(
      function* () {
        const raw = yield* request(
          "execution retention capability",
          "/extensions/launchpad/v1/capabilities",
          "GET",
        );
        const capabilities = yield* decodeCapabilities(raw).pipe(
          Effect.mapError(
            () =>
              new E2BRestoreError({
                operation: "execution retention capability",
                reason: "unsupported",
              }),
          ),
        );
        if (capabilities.executionRetention !== true)
          return yield* new E2BRestoreError({
            operation: "execution retention capability",
            reason: "unsupported",
          });
        return yield* Effect.void;
      },
    ),
    retentionCandidate: Effect.fn("E2BRestoreClient.retentionCandidate")(function* (
      sandboxID: string,
    ) {
      const raw = yield* request(
        "retention candidate",
        `/extensions/launchpad/v1/executions/${encodeURIComponent(sandboxID)}/retention-candidate`,
        "GET",
      );
      const candidate = yield* decodeRetentionCandidate(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "retention candidate", reason: "response" }),
        ),
      );
      if (
        candidate.sandboxID !== sandboxID ||
        (candidate.buildID === null) !== (candidate.disposition === "no_current_tip")
      )
        return yield* new E2BRestoreError({ operation: "retention candidate", reason: "identity" });
      return candidate;
    }),
    retainForStop: Effect.fn("E2BRestoreClient.retainForStop")(function* (
      recoveryOperationID: string,
      candidate: E2BExecutionRetentionCandidate,
    ) {
      const raw = yield* request(
        "retain for stop",
        `/extensions/launchpad/v1/executions/${encodeURIComponent(candidate.sandboxID)}/retentions/${encodeURIComponent(recoveryOperationID)}`,
        "PUT",
        {
          executionID: candidate.executionID,
          buildID: candidate.buildID,
          metadata: candidate.metadata,
        },
      );
      const receipt = yield* decodeRetentionReceipt(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "retain for stop", reason: "response" }),
        ),
      );
      if (
        receipt.recoveryOperationID !== recoveryOperationID ||
        !sameRetentionCandidate(receipt, candidate) ||
        (receipt.retainedTemplateID === null) !== (candidate.buildID === null) ||
        (candidate.buildID !== null && !receipt.retainedBuildIDs.includes(candidate.buildID)) ||
        (candidate.buildID === null && receipt.retainedBuildIDs.length !== 0)
      )
        return yield* new E2BRestoreError({ operation: "retain for stop", reason: "identity" });
      return receipt;
    }),
    stopRetained: Effect.fn("E2BRestoreClient.stopRetained")(function* (
      receipt: E2BExecutionRetentionReceipt,
    ) {
      const raw = yield* request(
        "stop retained execution",
        `/extensions/launchpad/v1/executions/${encodeURIComponent(receipt.sandboxID)}`,
        "DELETE",
      );
      const stopped = yield* decodePhysicalStop(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "stop retained execution", reason: "response" }),
        ),
      );
      if (stopped.sandboxID !== receipt.sandboxID)
        return yield* new E2BRestoreError({
          operation: "stop retained execution",
          reason: "identity",
        });
      return { ...receipt, physicallyStopped: stopped.physicallyStopped };
    }),
    /** The managed host retains its immutable paused disk without connecting or resuming it. */
    retainPausedSnapshot: Effect.fn("E2BRestoreClient.retainPausedSnapshot")(function* (
      sandboxID: string,
      name: string,
    ) {
      const raw = yield* request(
        "paused snapshot",
        `/sandboxes/${encodeURIComponent(sandboxID)}/snapshots`,
        "POST",
        { name },
      );
      const snapshot = yield* decodeSnapshot(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "paused snapshot", reason: "response" }),
        ),
      );
      if (!snapshot.names.some((candidate) => matchesSnapshotAlias(candidate, name)))
        return yield* new E2BRestoreError({ operation: "paused snapshot", reason: "identity" });
      return { snapshotId: snapshot.snapshotID, names: [...snapshot.names] };
    }),
    /** Missing catalog state requests exact stop reconciliation; it is never physical-stop proof. */
    sandboxExists: (sandboxID: string) =>
      request("inspect sandbox", `/sandboxes/${encodeURIComponent(sandboxID)}`, "GET").pipe(
        Effect.as(true),
        Effect.catchTag("E2BRestoreError", (error) =>
          error.reason === "http" && error.status === 404
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    stopBoot: Effect.fn("E2BRestoreClient.stopBoot")(function* (receipt: E2BRestoreStatus) {
      const raw = yield* request(
        "stop restore boot",
        `/extensions/launchpad/v1/executions/${encodeURIComponent(receipt.sandboxID)}`,
        "DELETE",
      );
      const stopped = yield* decodePhysicalStop(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "stop restore boot", reason: "response" }),
        ),
      );
      if (stopped.sandboxID !== receipt.sandboxID)
        return yield* new E2BRestoreError({ operation: "stop restore boot", reason: "identity" });
      return { ...receipt, physicallyStopped: stopped.physicallyStopped };
    }),
    capabilities: Effect.fn("E2BRestoreClient.capabilities")(function* () {
      const raw = yield* request("capabilities", "/extensions/launchpad/v1/capabilities", "GET");
      return yield* decodeCapabilities(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "capabilities", reason: "unsupported" }),
        ),
      );
    }),
    resolveSnapshot,
    /** Only a sealed, physically stopped source's explicit deletion may use this.
     * A missing alias proves no named root, never physical process absence. */
    resolveStoppedNamedSnapshot: Effect.fn("E2BRestoreClient.resolveStoppedNamedSnapshot")(
      function* (name: string) {
        const alias = yield* request(
          "stopped snapshot alias",
          `/templates/aliases/${encodeURIComponent(name)}`,
          "GET",
        ).pipe(
          Effect.flatMap((raw) =>
            decodeAlias(raw).pipe(
              Effect.mapError(
                () =>
                  new E2BRestoreError({ operation: "stopped snapshot alias", reason: "response" }),
              ),
            ),
          ),
          Effect.catchTag("E2BRestoreError", (error) =>
            error.operation === "stopped snapshot alias" &&
            error.reason === "http" &&
            error.status === 404
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        if (!alias) return null;
        const raw = yield* request(
          "stopped snapshot",
          `/templates/${encodeURIComponent(alias.templateID)}`,
          "GET",
        );
        const template = yield* decodeNamedTemplate(raw).pipe(
          Effect.mapError(
            () => new E2BRestoreError({ operation: "stopped snapshot", reason: "response" }),
          ),
        );
        if (
          template.templateID !== alias.templateID ||
          template.names.filter((candidate) => matchesSnapshotAlias(candidate, name)).length !==
            1 ||
          template.builds.length !== 1 ||
          !["ready", "error"].includes(template.builds[0]!.status)
        )
          return yield* new E2BRestoreError({ operation: "stopped snapshot", reason: "identity" });
        return {
          snapshotId: template.templateID,
          sourceTemplateID: template.templateID,
          sourceBuildID: template.builds[0]!.buildID,
        };
      },
    ),
    resolveNamedSnapshot: Effect.fn("E2BRestoreClient.resolveNamedSnapshot")(function* (
      name: string,
    ) {
      const raw = yield* request(
        "snapshot alias",
        `/templates/aliases/${encodeURIComponent(name)}`,
        "GET",
      );
      const alias = yield* decodeAlias(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "snapshot alias", reason: "response" }),
        ),
      );
      return yield* resolveSnapshot(alias.templateID);
    }),
    /** Snapshot listing hides failed builds. Their unique alias still records a
     * terminal capture failure without inspecting or waking the source VM. */
    resolveFailedNamedSnapshot: Effect.fn("E2BRestoreClient.resolveFailedNamedSnapshot")(function* (
      name: string,
    ) {
      const rawAlias = yield* request(
        "failed snapshot alias",
        `/templates/aliases/${encodeURIComponent(name)}`,
        "GET",
      );
      const alias = yield* decodeAlias(rawAlias).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "failed snapshot alias", reason: "response" }),
        ),
      );
      const raw = yield* request(
        "failed snapshot",
        `/templates/${encodeURIComponent(alias.templateID)}`,
        "GET",
      );
      const template = yield* decodeNamedTemplate(raw).pipe(
        Effect.mapError(
          () => new E2BRestoreError({ operation: "failed snapshot", reason: "response" }),
        ),
      );
      if (
        template.templateID !== alias.templateID ||
        template.builds.length !== 1 ||
        template.names.filter((candidate) => matchesSnapshotAlias(candidate, name)).length !== 1
      )
        return yield* new E2BRestoreError({ operation: "failed snapshot", reason: "identity" });
      if (template.builds[0]!.status !== "error") return null;
      return {
        snapshotId: template.templateID,
        sourceTemplateID: template.templateID,
        sourceBuildID: template.builds[0]!.buildID,
      };
    }),
    prepare: (operationID: string, input: E2BRestoreRequest) =>
      operation("prepare", operationID, input.generation, "PUT", input),
    inspect: (operationID: string, generation: string) =>
      operation("inspect", operationID, generation, "GET"),
    /** Caller must durably commit execution ownership before activation. */
    activate: (operationID: string, generation: string) =>
      operation("activate", operationID, generation, "POST", undefined, "/activate"),
    cancel: (operationID: string, generation: string) =>
      operation("cancel", operationID, generation, "DELETE"),
  };
}
