import { assertWorkflowThreadReleased } from "../persistence/WorkflowThreadOwnership.ts";
import {
  assertThreadTransferRuntime,
  ThreadTransferNativeRuntime as NativeRuntime,
} from "../persistence/ThreadTransferRuntime.ts";
import * as NodeCrypto from "node:crypto";
import { ModelSelection, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderAdapterProbeError } from "../provider/Errors.ts";
import {
  checkpointPortableCodexAfterProbe,
  verifyPortableCodexProbeCheckpoint,
} from "../provider/Drivers/PortableCodexHome.ts";
import { captureThreadTransferSetupOutput } from "./ThreadTransferSetupOutput.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";

const decodeNative = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(NativeRuntime)),
);
const decodeModel = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const decodeMode = Schema.decodeUnknownEffect(RuntimeMode);
const decodeProject = Schema.decodeEffect(T3ProjectFileFromJson);
const isNativeCursor = Schema.is(
  Schema.Struct({
    threadId: NativeRuntime.fields.threadId,
    resumePolicy: NativeRuntime.fields.resumePolicy,
    portableStateId: NativeRuntime.fields.portableStateId,
  }),
);
const encodeSetup = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      script: Schema.NullOr(Schema.String),
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
    }),
  ),
);
const encodeProbeRuntime = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)])),
);
export class ThreadTransferReadinessError extends Schema.TaggedError<ThreadTransferReadinessError>()(
  "ThreadTransferReadinessError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadTransferReadinessError({ message });
const isProviderProbeError = Schema.is(ProviderAdapterProbeError);

type ThreadTransferPreparationIdentity = {
  readonly threadId: ThreadId;
  readonly operationId: string;
  readonly generation: number;
  readonly manifestSha256: string;
  readonly environmentId?: string;
  readonly relayUrl?: string;
  readonly projectId?: string;
};

const portableProbeIdentity = (
  input: { readonly stateDir: string; readonly threadId: string },
  native: typeof NativeRuntime.Type,
) => ({
  stateDir: input.stateDir,
  threadId: input.threadId,
  providerInstanceId: native.providerInstanceId,
  nativeThreadId: native.threadId,
  portableStateId: native.portableStateId,
});

/** Validate an installed baseline without starting provider work or reinstalling it. */
export const readThreadTransferInstallation = Effect.fn("readThreadTransferInstallation")(
  function* (input: ThreadTransferPreparationIdentity) {
    const sql = yield* SqlClient.SqlClient;
    yield* assertWorkflowThreadReleased(sql, input.threadId).pipe(
      Effect.mapError((error) => fail(error.message)),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const claims = makeThreadCheckoutClaims(sql);
    const claim = yield* claims.get(input.operationId);
    if (
      !claim ||
      claim.threadId !== input.threadId ||
      claim.generation !== input.generation ||
      claim.manifestSha256 !== input.manifestSha256 ||
      claim.phase !== "installed"
    )
      return yield* fail("The moved checkout has not finished installation.");
    yield* claims.verifyLocation(input.operationId);
    if ((yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath)
      return yield* fail("The moved checkout path changed before setup.");
    const readBaseline = Effect.gen(function* () {
      const [baseline] = yield* sql<{
        nativeRuntime: string | null;
        model: string;
        runtimeMode: string;
      }>`
        SELECT b.native_runtime_json AS "nativeRuntime", t.model_selection_json AS model, t.runtime_mode AS "runtimeMode"
        FROM thread_transfer_baselines b JOIN thread_execution_fences f USING(thread_id)
          JOIN projection_threads t USING(thread_id)
          JOIN thread_checkout_claims c ON c.operation_id = b.operation_id
        WHERE b.operation_id = ${input.operationId} AND b.thread_id = ${input.threadId}
          AND b.generation = ${input.generation} AND b.manifest_sha256 = ${input.manifestSha256}
          AND f.operation_id = b.operation_id AND f.generation = b.generation AND f.phase = 'frozen'
          AND f.project_id = ${claim.projectId}
          AND (${input.environmentId ?? null} IS NULL OR f.environment_id = ${input.environmentId ?? null})
          AND (${input.relayUrl ?? null} IS NULL OR f.relay_url = ${input.relayUrl ?? null})
          AND (${input.projectId ?? null} IS NULL OR c.project_id = ${input.projectId ?? null})
          AND c.phase = 'installed' AND c.manifest_sha256 = b.manifest_sha256
          AND t.project_id = ${claim.projectId} AND t.deleted_at IS NULL`;
      if (!baseline || baseline.nativeRuntime === null)
        return yield* fail("Complete conversation installation is required before setup.");
      yield* assertThreadTransferRuntime(sql, input.operationId);
      return { ...baseline, nativeRuntime: baseline.nativeRuntime };
    });
    const baseline = yield* readBaseline;
    const native = yield* decodeNative(baseline.nativeRuntime);
    const modelSelection = yield* decodeModel(baseline.model);
    const runtimeMode = yield* decodeMode(baseline.runtimeMode);
    if (native && native.providerInstanceId !== modelSelection.instanceId)
      return yield* fail("The installed native conversation belongs to another provider instance.");
    const configFile = path.join(claim.checkoutPath, "t3.json");
    let script: string | null = null;
    if (yield* fs.exists(configFile)) {
      const actual = yield* fs.realPath(configFile);
      const stat = yield* fs.stat(actual);
      if (
        !actual.startsWith(`${claim.checkoutPath}${path.sep}`) ||
        stat.type !== "File" ||
        stat.size > 1024 * 1024
      )
        return yield* fail("The destination setup file is outside the checkout or too large.");
      const config = yield* decodeProject(yield* fs.readFileString(actual));
      script = config.scripts?.find((entry) => entry.runOnWorktreeCreate)?.command ?? null;
    }
    const setupSha256 = NodeCrypto.createHash("sha256")
      .update(yield* encodeSetup({ script, modelSelection, runtimeMode }))
      .digest("hex");
    return {
      claim,
      baseline,
      native,
      modelSelection,
      runtimeMode,
      script,
      setupSha256,
      readBaseline,
    };
  },
);

/** Check an already-ready frozen activation without revisiting checkout setup or auth. */
export const assertThreadTransferProbeCheckpoint = Effect.fn("assertThreadTransferProbeCheckpoint")(
  function* (input: { readonly operationId: string; readonly stateDir: string }) {
    const sql = yield* SqlClient.SqlClient;
    const [ready] = yield* sql<{
      threadId: string;
      nativeRuntime: string;
      fingerprint: string | null;
    }>`SELECT b.thread_id AS "threadId",b.native_runtime_json AS "nativeRuntime",
        r.native_probe_fingerprint AS fingerprint
      FROM thread_transfer_readiness r JOIN thread_transfer_baselines b USING(operation_id)
      WHERE r.operation_id=${input.operationId} AND r.manifest_sha256=b.manifest_sha256
        AND r.native_runtime_json=b.native_runtime_json AND r.phase='ready' AND r.setup_succeeded=1
        AND r.setup_output_json IS NOT NULL AND r.provider_probe_attempt_id IS NULL
        AND r.stopped_probe_preflight_fingerprint IS NULL`;
    if (!ready) return yield* fail("Destination readiness no longer matches this move.");
    if (ready.fingerprint === null) return;
    const native = yield* decodeNative(ready.nativeRuntime);
    if (
      !native ||
      ready.fingerprint !==
        (yield* verifyPortableCodexProbeCheckpoint(
          portableProbeIdentity({ ...input, threadId: ready.threadId }, native),
        ))
    )
      return yield* fail("Destination Codex history no longer matches its readiness checkpoint.");
  },
);

/** A matching durable ready receipt recovers relay handoff replies without reopening auth or probes. */
export const assertThreadTransferReady = Effect.fn("assertThreadTransferReady")(
  function* (
    input: ThreadTransferPreparationIdentity & {
      readonly environmentId: string;
      readonly relayUrl: string;
      readonly projectId: string;
      readonly stateDir: string;
    },
  ) {
    const { baseline, setupSha256 } = yield* readThreadTransferInstallation(input);
    const sql = yield* SqlClient.SqlClient;
    const [ready] = yield* sql`SELECT 1 FROM thread_transfer_readiness
      WHERE operation_id=${input.operationId} AND manifest_sha256=${input.manifestSha256}
        AND native_runtime_json=${baseline.nativeRuntime} AND setup_sha256=${setupSha256}
        AND phase='ready' AND setup_succeeded=1 AND setup_output_json IS NOT NULL
        AND provider_probe_attempt_id IS NULL`;
    if (!ready) return yield* fail("Destination readiness no longer matches this move.");
    yield* assertThreadTransferProbeCheckpoint(input);
  },
  Effect.mapError(() => fail("Destination readiness could not be verified for this move.")),
);

/** Internal move worker only. The destination remains frozen throughout setup and
 * native resume validation. An unfinished claim is never an invitation to rerun a
 * script: cancellation/recovery must first prove that its worker has stopped.
 */
export const prepareThreadTransfer = Effect.fn("prepareThreadTransfer")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly operationId: string;
    readonly generation: number;
    readonly manifestSha256: string;
    readonly stateDir: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const claims = makeThreadCheckoutClaims(sql);
    const {
      claim,
      baseline,
      native,
      modelSelection,
      runtimeMode,
      script,
      setupSha256,
      readBaseline,
    } = yield* readThreadTransferInstallation(input);
    const registry = yield* ProviderInstanceRegistry;
    const instance = yield* registry.getInstance(modelSelection.instanceId);
    if (!instance || !instance.enabled || instance.driverKind !== "codex")
      return yield* fail("The destination requires an enabled Codex instance.");
    const probeSession = instance.adapter.probeSession;
    if (!probeSession)
      return yield* fail(
        "The destination cannot validate Codex without publishing provider output.",
      );
    const status = yield* instance.snapshot.refresh;
    if (!status.installed || status.auth.status !== "authenticated")
      return yield* fail(
        "The destination requires Codex to be installed with a configured sign-in.",
      );
    const runtimeKey = NodeCrypto.createHash("sha256")
      .update(
        yield* encodeProbeRuntime([instance.continuationIdentity.continuationKey, status.version]),
      )
      .digest("hex");
    if (yield* instance.adapter.hasSession(input.threadId))
      return yield* fail("A provider session is already using the destination thread.");
    // Check current prerequisites before recording a setup attempt. The receipt still prevents replay.
    const setupState = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* readBaseline;
        const [prior] = yield* sql<{
          manifest: string;
          nativeRuntime: string;
          setup: string;
          succeeded: number;
          probe: string | null;
          stoppedPreflight: string | null;
          stoppedRuntime: string | null;
        }>`
        SELECT manifest_sha256 AS manifest, native_runtime_json AS "nativeRuntime", setup_sha256 AS setup,
          setup_succeeded AS succeeded,provider_probe_attempt_id AS probe,
          stopped_probe_preflight_fingerprint AS "stoppedPreflight",stopped_probe_runtime_key AS "stoppedRuntime"
        FROM thread_transfer_readiness WHERE operation_id = ${input.operationId}`;
        if (prior) {
          if (
            prior.manifest !== input.manifestSha256 ||
            prior.nativeRuntime !== baseline.nativeRuntime ||
            prior.setup !== setupSha256
          )
            return yield* fail("Destination setup intent changed.");
          if (prior.probe !== null && prior.stoppedPreflight === null)
            return yield* fail(
              "Destination native validation has no confirmed exit; cleanup remains held.",
            );
          if (prior.succeeded !== 1)
            return yield* fail(
              "Destination setup has not been confirmed complete; do not replay it.",
            );
          const stopped =
            prior.stoppedPreflight !== null && prior.probe !== null && prior.stoppedRuntime !== null
              ? {
                  attempt: prior.probe,
                  preflight: prior.stoppedPreflight,
                  runtimeKey: prior.stoppedRuntime,
                }
              : null;
          return { complete: true, stopped };
        }
        yield* sql`INSERT INTO thread_transfer_readiness (operation_id, manifest_sha256, native_runtime_json, setup_sha256, phase)
        VALUES (${input.operationId}, ${input.manifestSha256}, ${baseline.nativeRuntime}, ${setupSha256}, 'started')`;
        return { complete: false, stopped: null };
      }),
    );
    if (!setupState.complete) {
      const recordSetupOutput = Effect.gen(function* () {
        const output = yield* captureThreadTransferSetupOutput(claim.checkoutPath);
        const rows = yield* sql`UPDATE thread_transfer_readiness SET setup_output_json=${output}
        WHERE operation_id=${input.operationId} AND phase='started' AND setup_output_json IS NULL RETURNING operation_id`;
        if (!rows.length)
          return yield* fail("Destination setup output changed before its receipt.");
      });
      if (script !== null) {
        const runner = yield* ProcessRunner;
        const started = yield* sql`UPDATE thread_transfer_readiness SET setup_started=1
        WHERE operation_id=${input.operationId} AND phase='started' AND setup_started=0 RETURNING operation_id`;
        if (!started.length)
          return yield* fail("Destination setup already started; do not replay it.");
        const result = yield* runner.run({
          command: "bash",
          args: ["-c", script],
          cwd: claim.checkoutPath,
          env: projectScriptRuntimeEnv({
            project: { cwd: claim.repositoryRoot },
            worktreePath: claim.checkoutPath,
          }),
          timeout: "15 minutes",
          maxOutputBytes: 65536,
          outputMode: "truncate",
        });
        yield* recordSetupOutput;
        if (result.code !== 0 || result.timedOut)
          return yield* fail("Destination project setup failed. The source is still retained.");
      }
      if (script === null) yield* recordSetupOutput;
      const succeeded = yield* sql`UPDATE thread_transfer_readiness SET setup_succeeded=1
        WHERE operation_id=${input.operationId} AND phase='started' AND setup_output_json IS NOT NULL
          AND setup_succeeded=0 RETURNING operation_id`;
      if (!succeeded.length) return yield* fail("Destination setup success could not be recorded.");
    }
    if ((yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath)
      return yield* fail("The moved checkout path changed during setup.");
    let startedAttempt: string | null = null;
    let cleanupConfirmed = false;
    const stopProbe = (cursor: typeof NativeRuntime.Type) =>
      Effect.gen(function* () {
        const attempt = NodeCrypto.randomUUID();
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* readBaseline;
            const claimed =
              yield* sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=${attempt},phase='started',native_probe_fingerprint=NULL
            WHERE operation_id=${input.operationId} AND setup_succeeded=1 AND provider_probe_attempt_id IS NULL
              AND manifest_sha256=${input.manifestSha256} AND native_runtime_json=${baseline.nativeRuntime} AND setup_sha256=${setupSha256}
            RETURNING operation_id`;
            if (!claimed.length)
              return yield* fail(
                "Another native validation owns this destination; cleanup remains held.",
              );
          }),
        );
        startedAttempt = attempt;
        const nativeIdentity = portableProbeIdentity(input, cursor);
        cleanupConfirmed = true;
        const beforeProbe = yield* verifyPortableCodexProbeCheckpoint(nativeIdentity);
        cleanupConfirmed = false;
        // Only a stopped probe can release this exact owner. Crashes, interruptions,
        // and unknown child ownership keep it held; setup success never permits replay.
        const session = yield* probeSession({
          threadId: input.threadId,
          providerInstanceId: instance.instanceId,
          provider: instance.driverKind,
          cwd: claim.checkoutPath,
          modelSelection,
          runtimeMode,
          resumeCursor: {
            threadId: cursor.threadId,
            resumePolicy: cursor.resumePolicy,
            portableStateId: cursor.portableStateId,
          },
        }).pipe(
          Effect.mapError((error) => {
            cleanupConfirmed = isProviderProbeError(error) && error.cleanupConfirmed;
            return fail(`Codex could not resume the transferred conversation: ${error.message}`);
          }),
        );
        cleanupConfirmed = true;
        const resumed = session.resumeCursor;
        if (
          session.threadId !== input.threadId ||
          session.provider !== "codex" ||
          session.status !== "ready" ||
          session.cwd !== claim.checkoutPath ||
          session.activeTurnId !== undefined ||
          !isNativeCursor(resumed) ||
          resumed.threadId !== cursor.threadId ||
          resumed.portableStateId !== cursor.portableStateId
        )
          return yield* fail("Codex did not resume the transferred conversation in an idle state.");
        // Persist positive stop evidence before publishing to the filesystem.
        // A later sweep can finish sealing the same bytes without another probe.
        cleanupConfirmed = false;
        const stopped = yield* sql`UPDATE thread_transfer_readiness SET
              stopped_probe_preflight_fingerprint=${beforeProbe},stopped_probe_runtime_key=${runtimeKey}
              WHERE operation_id=${input.operationId} AND phase='started' AND provider_probe_attempt_id=${attempt}
                AND stopped_probe_preflight_fingerprint IS NULL RETURNING operation_id`.pipe(
          Effect.uninterruptible,
        );
        if (!stopped.length)
          return yield* fail("Destination probe no longer owns its stop record.");
        return { attempt, preflight: beforeProbe, runtimeKey };
      });
    yield* Effect.gen(function* () {
      if (setupState.stopped && !native)
        return yield* fail("Destination probe no longer matches the installed conversation.");
      const stopped = setupState.stopped ?? (native ? yield* stopProbe(native) : null);
      let fingerprint: string | null = null;
      if (native && stopped) {
        fingerprint = yield* checkpointPortableCodexAfterProbe(
          portableProbeIdentity(input, native),
          stopped.preflight,
        );
      }
      if (
        (yield* registry.getInstance(instance.instanceId)) !== instance ||
        (stopped && stopped.runtimeKey !== runtimeKey)
      ) {
        if (stopped) {
          // The old probe's bytes are now verified. A newer runtime can probe
          // them without replaying setup or blessing unknown appended history.
          yield* sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=NULL,
            stopped_probe_preflight_fingerprint=NULL,stopped_probe_runtime_key=NULL
            WHERE operation_id=${input.operationId} AND provider_probe_attempt_id=${stopped.attempt}
              AND stopped_probe_preflight_fingerprint=${stopped.preflight}`;
        }
        return yield* fail("The configured provider changed during destination setup.");
      }
      yield* claims.verifyLocation(input.operationId);
      if ((yield* fs.realPath(claim.checkoutPath)) !== claim.checkoutPath)
        return yield* fail("The moved checkout path changed during setup.");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* readBaseline;
          if (
            current.nativeRuntime !== baseline.nativeRuntime ||
            current.model !== baseline.model ||
            current.runtimeMode !== baseline.runtimeMode
          )
            return yield* fail("Destination conversation changed during setup.");
          const ready =
            yield* sql`UPDATE thread_transfer_readiness SET phase='ready',provider_probe_attempt_id=NULL,
          native_probe_fingerprint=${fingerprint},stopped_probe_preflight_fingerprint=NULL,stopped_probe_runtime_key=NULL
        WHERE operation_id=${input.operationId} AND setup_succeeded=1 AND provider_probe_attempt_id IS ${stopped?.attempt ?? null}
          AND stopped_probe_preflight_fingerprint IS ${stopped?.preflight ?? null} RETURNING operation_id`;
          if (!ready.length)
            return yield* fail("Destination setup no longer owns its completion record.");
        }),
      );
    }).pipe(
      Effect.tapError(() =>
        cleanupConfirmed && startedAttempt !== null
          ? sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=NULL
          WHERE operation_id=${input.operationId} AND provider_probe_attempt_id=${startedAttempt}
            AND stopped_probe_preflight_fingerprint IS NULL`.pipe(Effect.asVoid)
          : Effect.void,
      ),
    );
  },
  Effect.mapError((error) =>
    error._tag === "ThreadTransferReadinessError" || error._tag === "PortableCodexProbeHistoryError"
      ? error
      : fail("Destination setup or native continuation could not be verified."),
  ),
);
