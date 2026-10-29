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
export class ThreadTransferReadinessError extends Schema.TaggedError<ThreadTransferReadinessError>()(
  "ThreadTransferReadinessError",
  { message: Schema.String },
) {}
const fail = (message: string) => new ThreadTransferReadinessError({ message });
const isProviderProbeError = Schema.is(ProviderAdapterProbeError);

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
  }) {
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
    if (yield* instance.adapter.hasSession(input.threadId))
      return yield* fail("A provider session is already using the destination thread.");
    // Check current prerequisites before recording a setup attempt. The receipt still prevents replay.
    const setupComplete = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* readBaseline;
        const [prior] = yield* sql<{
          manifest: string;
          nativeRuntime: string;
          setup: string;
          phase: string;
          succeeded: number;
          probe: string | null;
        }>`
        SELECT manifest_sha256 AS manifest, native_runtime_json AS "nativeRuntime", setup_sha256 AS setup, phase,
          setup_succeeded AS succeeded,provider_probe_attempt_id AS probe
        FROM thread_transfer_readiness WHERE operation_id = ${input.operationId}`;
        if (prior) {
          if (
            prior.manifest !== input.manifestSha256 ||
            prior.nativeRuntime !== baseline.nativeRuntime ||
            prior.setup !== setupSha256
          )
            return yield* fail("Destination setup intent changed.");
          if (prior.probe !== null)
            return yield* fail(
              "Destination native validation has no confirmed exit; cleanup remains held.",
            );
          if (prior.succeeded !== 1)
            return yield* fail(
              "Destination setup has not been confirmed complete; do not replay it.",
            );
          return true;
        }
        yield* sql`INSERT INTO thread_transfer_readiness (operation_id, manifest_sha256, native_runtime_json, setup_sha256, phase)
        VALUES (${input.operationId}, ${input.manifestSha256}, ${baseline.nativeRuntime}, ${setupSha256}, 'started')`;
        return false;
      }),
    );
    if (!setupComplete) {
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
    // A setup receipt can be reused; compatibility must be checked against the
    // current provider runtime again before committing destination ownership.
    let probeAttempt: string | null = null;
    let cleanupConfirmed = false;
    yield* Effect.gen(function* () {
      if (native) {
        const attempt = NodeCrypto.randomUUID();
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* readBaseline;
            const claimed =
              yield* sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=${attempt},phase='started'
            WHERE operation_id=${input.operationId} AND setup_succeeded=1 AND provider_probe_attempt_id IS NULL
              AND manifest_sha256=${input.manifestSha256} AND native_runtime_json=${baseline.nativeRuntime} AND setup_sha256=${setupSha256}
            RETURNING operation_id`;
            if (!claimed.length)
              return yield* fail(
                "Another native validation owns this destination; cleanup remains held.",
              );
          }),
        );
        probeAttempt = attempt;
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
            threadId: native.threadId,
            resumePolicy: native.resumePolicy,
            portableStateId: native.portableStateId,
          },
        }).pipe(
          Effect.mapError((error) => {
            cleanupConfirmed = isProviderProbeError(error) && error.cleanupConfirmed;
            return fail(`Codex could not resume the transferred conversation: ${error.message}`);
          }),
        );
        cleanupConfirmed = true;
        const cursor = session.resumeCursor;
        if (
          session.threadId !== input.threadId ||
          session.provider !== "codex" ||
          session.status !== "ready" ||
          session.cwd !== claim.checkoutPath ||
          session.activeTurnId !== undefined ||
          !isNativeCursor(cursor) ||
          cursor.threadId !== native.threadId ||
          cursor.portableStateId !== native.portableStateId
        )
          return yield* fail("Codex did not resume the transferred conversation in an idle state.");
      }
      if ((yield* registry.getInstance(instance.instanceId)) !== instance)
        return yield* fail("The configured provider changed during destination setup.");
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
            yield* sql`UPDATE thread_transfer_readiness SET phase = 'ready',provider_probe_attempt_id=NULL
        WHERE operation_id = ${input.operationId} AND setup_succeeded=1 AND provider_probe_attempt_id IS ${probeAttempt} RETURNING operation_id`;
          if (!ready.length)
            return yield* fail("Destination setup no longer owns its completion record.");
        }),
      );
    }).pipe(
      Effect.tapError(() =>
        cleanupConfirmed && probeAttempt !== null
          ? sql`UPDATE thread_transfer_readiness SET provider_probe_attempt_id=NULL
          WHERE operation_id=${input.operationId} AND provider_probe_attempt_id=${probeAttempt}`.pipe(
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );
  },
  Effect.mapError((error) =>
    error._tag === "ThreadTransferReadinessError"
      ? error
      : fail("Destination setup or native continuation could not be verified."),
  ),
);
